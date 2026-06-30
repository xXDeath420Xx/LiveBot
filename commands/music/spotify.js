import { SlashCommandBuilder } from 'discord.js';
// discord-player re-exports @discordjs/voice (the SAME instance it uses), so importing
// from here shares its voice registry — no dual-connection conflict.
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
} from 'discord-player';
import { parseSpotifyUrl } from '../../core/spotify-resolver.js';
import {
  pickSession, acquire, release, play as glrPlay, pause as glrPause,
  resume as glrResume, stop as glrStop, getStatus, openPcmStream,
} from '../../core/spotify-connect-manager.js';
import logger from '../../utils/logger.js';

// guildId -> { connection, player, ff, session, channelId }
const live = new Map();

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
  try { s.player?.stop(true); } catch {}
  try { s.ff?.kill('SIGKILL'); } catch {}
  try { s.connection?.destroy(); } catch {}
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
    .addSubcommand(s => s.setName('nowplaying').setDescription('What\'s playing on Spotify')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'stop')   { await teardown(guildId); return interaction.reply({ content: '⏹️ Stopped Spotify playback.', ephemeral: true }); }
    if (sub === 'pause')  { const s = live.get(guildId); if (s) { await glrPause(s.session); s.player.pause(); } return interaction.reply({ content: '⏸️ Paused.', ephemeral: true }); }
    if (sub === 'resume') { const s = live.get(guildId); if (s) { await glrResume(s.session); s.player.unpause(); } return interaction.reply({ content: '▶️ Resumed.', ephemeral: true }); }
    if (sub === 'nowplaying') {
      const s = live.get(guildId);
      if (!s) return interaction.reply({ content: 'Nothing playing via Spotify-direct here.', ephemeral: true });
      const st = await getStatus(s.session).catch(() => null);
      const t = st?.track;
      return interaction.reply({ content: t ? `🎵 **${t.name}** — ${(t.artist_names || []).join(', ')}` : 'Loading…', ephemeral: true });
    }

    // play
    const url = interaction.options.getString('url');
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return interaction.reply({ content: 'That doesn\'t look like a Spotify link.', ephemeral: true });

    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

    await interaction.deferReply();

    const session = pickSession(interaction.user.id);
    if (!session) return interaction.editReply('No Spotify account is linked to the bot yet.');
    if (!acquire(session, guildId)) {
      return interaction.editReply('The shared Spotify account is busy in another server right now. (Link your own with `/spotify` once that\'s live.)');
    }

    try {
      // Fresh start for this guild
      await teardown(guildId);
      acquire(session, guildId);

      // 1) tell go-librespot to play; 2) open the audio pipe (ffmpeg blocks on read
      //    until go-librespot opens the write side, so order is play → open).
      const pr = await glrPlay(session, uriFor(parsed));
      if (pr.code >= 400) { release(session, guildId); return interaction.editReply('Spotify wouldn\'t start that link (is it valid/public?).'); }

      const ff = openPcmStream(session);
      const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
      const player = createAudioPlayer();
      const connection = joinVoiceChannel({
        channelId: vc.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true,
      });
      try { await waitReady(connection, 20000); }
      catch (e) { await teardown(guildId); return interaction.editReply('Couldn\'t connect to the voice channel.'); }

      connection.subscribe(player);
      player.play(resource);

      player.on('error', err => logger.error(`[SpotifyConnect] player error in ${guildId}: ${err.message}`));
      connection.on('stateChange', (_o, ns) => { if (ns.status === 'disconnected' || ns.status === 'destroyed') teardown(guildId); });

      live.set(guildId, { connection, player, ff, session, channelId: vc.id });

      // brief settle, then report what Spotify says is playing
      await new Promise(r => setTimeout(r, 1500));
      const st = await getStatus(session).catch(() => null);
      const t = st?.track;
      return interaction.editReply(t
        ? `🎧 **Spotify-direct** now playing **${t.name}** — ${(t.artist_names || []).join(', ')}\n_Real Spotify audio. \`/spotify stop\` to end._`
        : `🎧 Spotify-direct started. _If you don't hear audio in a few seconds, \`/spotify stop\` and retry._`);
    } catch (err) {
      logger.error(`[SpotifyConnect] play failed in ${guildId}: ${err.message}`);
      await teardown(guildId);
      return interaction.editReply(`Couldn't start Spotify playback: ${err.message}`);
    }
  },
};
