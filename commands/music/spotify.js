import { SlashCommandBuilder } from 'discord.js';
// discord-player re-exports @discordjs/voice (the SAME instance it uses), so importing
// from here shares its voice registry — no dual-connection conflict.
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, StreamType,
} from 'discord-player';
import { parseSpotifyUrl } from '../../core/spotify-resolver.js';
import {
  getSessionForUser, acquire, release, play as glrPlay, pause as glrPause,
  resume as glrResume, stop as glrStop, next as glrNext, getStatus, openPcmStream,
  startLink, finishLink, unlink, isLinked, isOwnerUser,
} from '../../core/spotify-connect-manager.js';
import logger from '../../utils/logger.js';

// guildId -> { connection, player, ff, session, channelId }
const live = new Map();

// Nudge the music panel to re-render (spotify-direct has no discord-player events).
function refreshPanel(guildId) {
  try { global.musicPanelManager?.get(guildId)?.updatePanel(); } catch { /* no panel */ }
}

// ── Control/state API consumed by the music panel (core/music-panel.js) ──
export function hasSpotifyDirect(guildId) { return live.has(guildId); }

export async function getSpotifyDirectState(guildId) {
  const s = live.get(guildId);
  if (!s) return null;
  const st = await getStatus(s.session).catch(() => null);
  return { track: st?.track || null, paused: s.player?.state?.status === 'paused' };
}

export async function spotifyDirectToggle(guildId) {
  const s = live.get(guildId);
  if (!s) return null;
  const paused = s.player?.state?.status === 'paused';
  if (paused) { await glrResume(s.session).catch(() => {}); try { s.player.unpause(); } catch {} }
  else        { await glrPause(s.session).catch(() => {});  try { s.player.pause(); } catch {} }
  refreshPanel(guildId);
  return !paused;
}

export async function spotifyDirectSkip(guildId) {
  const s = live.get(guildId);
  if (!s) return false;
  await glrNext(s.session).catch(() => {});
  setTimeout(() => refreshPanel(guildId), 800); // let go-librespot advance, then re-render
  return true;
}

export async function spotifyDirectStop(guildId) {
  if (!live.has(guildId)) return false;
  await teardown(guildId);
  refreshPanel(guildId);
  return true;
}

// Resolve once the voice connection reaches 'ready' (string status avoids needing the
// VoiceConnectionStatus enum, which discord-player doesn't re-export).
function waitReady(connection, ms = 20000) {
  return new Promise((resolve, reject) => {
    if (connection.state.status === 'ready') return resolve();
    const timer = setTimeout(() => { cleanup(); reject(new Error('voice connect timeout')); }, ms);
    const onChange = (_old, ns) => { if (ns.status === 'ready') { cleanup(); resolve(); } };
    function cleanup() { clearTimeout(timer); connection.off('stateChange', onChange); }
    connection.on('stateChange', onChange);
  });
}

function uriFor(parsed) {
  return `spotify:${parsed.type}:${parsed.id}`; // track|playlist|album|artist
}

async function teardown(guildId) {
  const s = live.get(guildId);
  if (!s) return;
  live.delete(guildId);
  try { if (s.onStateChange) s.connection?.off('stateChange', s.onStateChange); } catch {}
  try { s.subscription?.unsubscribe(); } catch {}
  try { s.player?.stop(true); } catch {}
  try { s.ff?.kill('SIGKILL'); } catch {}
  // Only destroy the connection if WE created it — never tear down a 24/7
  // voice-camp connection we merely borrowed.
  if (s.ownsConnection) { try { s.connection?.destroy(); } catch {} }
  if (s.session) { await glrStop(s.session).catch(() => {}); release(s.session, guildId); }
}

export default {
  category: 'music',
  data: new SlashCommandBuilder()
    .setName('spotify')
    .setDescription('Play REAL Spotify audio directly (Premium-backed, no YouTube)')
    .addSubcommand(s => s.setName('play')
      .setDescription('Play a Spotify track / playlist / album link directly')
      .addStringOption(o => o.setName('url').setDescription('Spotify link').setRequired(true)))
    .addSubcommand(s => s.setName('pause').setDescription('Pause Spotify playback'))
    .addSubcommand(s => s.setName('resume').setDescription('Resume Spotify playback'))
    .addSubcommand(s => s.setName('stop').setDescription('Stop and leave'))
    .addSubcommand(s => s.setName('nowplaying').setDescription('What\'s playing on Spotify'))
    .addSubcommand(s => s.setName('link').setDescription('Link YOUR Spotify Premium account so playback uses it'))
    .addSubcommand(s => s.setName('finish')
      .setDescription('Finish linking: paste the http://127.0.0.1… URL your browser landed on')
      .addStringOption(o => o.setName('url').setDescription('The 127.0.0.1 redirect URL from your browser').setRequired(true)))
    .addSubcommand(s => s.setName('unlink').setDescription('Unlink your Spotify account')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'stop')   { await teardown(guildId); refreshPanel(guildId); return interaction.reply({ content: '⏹️ Stopped Spotify playback.', ephemeral: true }); }
    if (sub === 'pause')  { const s = live.get(guildId); if (s) { await glrPause(s.session); s.player.pause(); } refreshPanel(guildId); return interaction.reply({ content: '⏸️ Paused.', ephemeral: true }); }
    if (sub === 'resume') { const s = live.get(guildId); if (s) { await glrResume(s.session); s.player.unpause(); } refreshPanel(guildId); return interaction.reply({ content: '▶️ Resumed.', ephemeral: true }); }
    if (sub === 'nowplaying') {
      const s = live.get(guildId);
      if (!s) return interaction.reply({ content: 'Nothing playing via Spotify-direct here.', ephemeral: true });
      const st = await getStatus(s.session).catch(() => null);
      const t = st?.track;
      return interaction.reply({ content: t ? `🎵 **${t.name}** — ${(t.artist_names || []).join(', ')}` : 'Loading…', ephemeral: true });
    }

    // ── Account linking (Spoticord model) ──
    if (sub === 'link') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const url = await startLink(interaction.user.id);
        return interaction.editReply(
          '**Link your own Spotify Premium** (one-time):\n' +
          '1️⃣ Open this in a browser signed into **your** Spotify:\n' + url + '\n\n' +
          '2️⃣ Click **Agree**. Your browser will then land on a `http://127.0.0.1:…` page that **won\'t load — that\'s expected.**\n' +
          '3️⃣ Copy that full address-bar URL and run **`/spotify finish`** with it.\n\n' +
          '_Premium required for on-demand playback. Your login is stored **encrypted**; `/spotify unlink` removes it._'
        );
      } catch (e) { return interaction.editReply(`Couldn't start linking: ${e.message}`); }
    }
    if (sub === 'finish') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const { username } = await finishLink(interaction.user.id, interaction.options.getString('url'));
        return interaction.editReply(`✅ Linked${username ? ` **${username}**` : ''}! Your Spotify now plays through **your own account**. Just use \`/music play <spotify link>\` or \`/spotify play\`.`);
      } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
    }
    if (sub === 'unlink') {
      await interaction.deferReply({ ephemeral: true });
      await unlink(interaction.user.id);
      return interaction.editReply('Unlinked your Spotify account. You\'ll use the shared account again.');
    }

    // play
    const url = interaction.options.getString('url');
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return interaction.reply({ content: 'That doesn\'t look like a Spotify link.', ephemeral: true });

    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

    await interaction.deferReply();

    const session = await getSessionForUser(interaction.user.id);
    if (!session) return interaction.editReply('No Spotify account is available. Link yours with `/spotify link`.');
    const owner = isOwnerUser(interaction.user.id);
    if (!acquire(session, guildId, { owner, stopHolder: () => teardown(guildId) })) {
      const mine = owner || await isLinked(interaction.user.id);
      return interaction.editReply(mine
        ? 'Your Spotify account is already streaming in another server. One stream per account.'
        : 'The shared Spotify account is busy in another server. **Link your own** with `/spotify link` so you\'re never blocked.');
    }

    try {
      await teardown(guildId);
      acquire(session, guildId);

      // Reader-first ordering: open ffmpeg on the FIFO (it waits for go-librespot to
      // start writing), join the VC, THEN trigger playback — so audio flows from the
      // first sample with no clipped intro.
      const ff = openPcmStream(session);
      const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
      const player = createAudioPlayer();

      // If the bot is already in voice here (24/7 voice-camp holds a discord-player
      // connection), REUSE it. discord-player v7 runs on discord-voip and registers
      // its connection under a non-default group (the bot's id), so a fresh
      // joinVoiceChannel() opens a SECOND, conflicting connection that never reaches
      // 'ready' (bot's already in-channel → no new voice handshake) and times out —
      // which is the "couldn't connect" error in camped guilds. Reuse avoids it.
      const campConn = global.player?.nodes?.get(guildId)?.connection
        || getVoiceConnection(guildId, interaction.client.user?.id)
        || getVoiceConnection(guildId);
      let connection, ownsConnection;
      if (campConn && campConn.state?.status !== 'destroyed') {
        connection = campConn;
        ownsConnection = false;
        // Follow the requester if the camp is parked in a different channel.
        if (connection.joinConfig?.channelId !== vc.id) {
          try { connection.rejoin({ channelId: vc.id, selfDeaf: true, selfMute: false }); } catch {}
        }
      } else {
        connection = joinVoiceChannel({
          channelId: vc.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true,
        });
        ownsConnection = true;
      }
      try { await waitReady(connection, 20000); }
      catch (e) { if (ownsConnection) await teardown(guildId); return interaction.editReply('Couldn\'t connect to the voice channel.'); }

      const subscription = connection.subscribe(player);
      player.play(resource);
      player.on('error', err => logger.error(`[SpotifyConnect] player error in ${guildId}: ${err.message}`));
      const onStateChange = (_o, ns) => { if (ns.status === 'disconnected' || ns.status === 'destroyed') teardown(guildId); };
      connection.on('stateChange', onStateChange);
      live.set(guildId, { connection, player, ff, session, channelId: vc.id, ownsConnection, subscription, onStateChange });

      // Start playback. go-librespot's /player/play returns HTTP 500 EVEN ON SUCCESS,
      // so we ignore the code and confirm via the player STATE instead.
      await glrPlay(session, uriFor(parsed)).catch(() => {});
      let st = null;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 500));
        st = await getStatus(session).catch(() => null);
        if (st && st.track && !st.stopped) break;
      }
      if (!st || !st.track || st.stopped) {
        await teardown(guildId);
        return interaction.editReply('Spotify wouldn\'t start that link (is it valid/public?).');
      }
      const t = st.track;
      refreshPanel(guildId); // reflect the new Spotify-direct track on the music panel
      return interaction.editReply(`🎧 **Spotify-direct** now playing **${t.name}** — ${(t.artist_names || []).join(', ')}\n_Real Spotify audio. \`/spotify stop\` to end._`);
    } catch (err) {
      logger.error(`[SpotifyConnect] play failed in ${guildId}: ${err.message}`);
      await teardown(guildId);
      return interaction.editReply(`Couldn't start Spotify playback: ${err.message}`);
    }
  },
};
