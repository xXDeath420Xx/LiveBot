// handlers/cinema/panel.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig, canControl, setPanelMessageId } from './state.js';
import * as jf from '../../utils/jellyfin.js';

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

export function buildPanel(state) {
  const embed = new EmbedBuilder()
    .setTitle(`🎬 Now Playing: ${state.item_name}`)
    .setColor(state.status === 'paused' ? 0xf1c40f : 0x2ecc71)
    .setDescription(state.status === 'paused' ? '⏸ Paused' : '▶ Playing')
    .addFields({ name: 'Position', value: fmt(state.position_secs), inline: true })
    .setFooter({ text: `Started by <@${state.started_by}> • click Watch Stream in the voice channel` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cinema_pause').setEmoji('⏸').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cinema_resume').setEmoji('▶').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cinema_seek').setEmoji('⏩').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cinema_stop').setEmoji('⏹').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function guard(interaction) {
  const state = await getActiveState();
  if (!state) { await interaction.reply({ content: 'No movie is playing.', ephemeral: true }); return null; }
  // cinema_state is a GLOBAL singleton; the movie plays in exactly one host guild.
  // Controls must originate from that host guild — otherwise a member of any other
  // guild the shared account is in could forge a static-customId button and drive
  // playback. Gate on the host guild, and evaluate permissions against IT.
  if (interaction.guildId !== state.guild_id) {
    await interaction.reply({ content: 'No movie is playing in this server.', ephemeral: true });
    return null;
  }
  const config = await getConfig(state.guild_id);
  if (!canControl(interaction.member, state, config)) {
    await interaction.reply({ content: 'Only the host or a mod can control playback.', ephemeral: true });
    return null;
  }
  return state;
}

export async function handleCinemaButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('cinema_')) return false;

  if (id === 'cinema_seek') {
    // Gate BEFORE showing the modal (a modal must be the first ack). guard()
    // applies the host-guild + canControl checks and replies ephemerally on denial.
    const state = await guard(interaction);
    if (!state) return true;
    const modal = new ModalBuilder().setCustomId('cinema_seek_modal').setTitle('Seek to timestamp');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ts').setLabel('HH:MM:SS or seconds')
        .setStyle(TextInputStyle.Short).setRequired(true)));
    await interaction.showModal(modal);
    return true;
  }

  const state = await guard(interaction);
  if (!state) return true;

  if (id === 'cinema_pause') await cinema.pause();
  else if (id === 'cinema_resume') await cinema.resume();
  else if (id === 'cinema_stop') await cinema.stop();

  await refreshPanel(interaction);
  return true;
}

export async function handleCinemaSeekModal(interaction) {
  if (interaction.customId !== 'cinema_seek_modal') return false;
  // Re-authorize on submit (state may have changed since the modal opened, and a
  // crafted submit must not bypass the gate). guard() enforces host-guild + role.
  const state = await guard(interaction);
  if (!state) return true;
  const raw = interaction.fields.getTextInputValue('ts').trim();
  const secs = raw.includes(':')
    ? raw.split(':').reverse().reduce((a, p, i) => a + Number(p) * 60 ** i, 0)
    : Number(raw);
  if (!Number.isFinite(secs) || secs < 0) {
    await interaction.reply({ content: 'Invalid timestamp — use seconds or HH:MM:SS.', ephemeral: true });
    return true;
  }
  await cinema.seek(secs);
  await refreshPanel(interaction);
  return true;
}

async function refreshPanel(interaction) {
  await new Promise((r) => setTimeout(r, 400));
  const state = await getActiveState();
  const payload = state
    ? buildPanel(state)
    : { content: '⏹ Movie ended.', embeds: [], components: [] };
  if (interaction.deferred || interaction.replied) await interaction.message.edit(payload).catch(() => {});
  else await interaction.update(payload).catch(async () => { await interaction.message.edit(payload).catch(() => {}); });
}

// --- pending track selections (keyed by userId) for the /movie play picker ---
const pending = new Map(); // userId -> { itemId, audioIndex, subIndex }

export async function handleCinemaSelect(interaction) {
  const [kind, itemId] = interaction.customId.split(':');
  if (kind !== 'cinema_audio' && kind !== 'cinema_sub') return false;
  const cur = pending.get(interaction.user.id) || { itemId, audioIndex: null, subIndex: null };
  cur.itemId = itemId;
  const val = Number(interaction.values[0]);
  if (kind === 'cinema_audio') cur.audioIndex = val === -1 ? null : val;
  else cur.subIndex = val === -1 ? null : val;
  pending.set(interaction.user.id, cur);
  await interaction.deferUpdate();
  return true;
}

export async function handleCinemaStart(interaction) {
  if (!interaction.customId.startsWith('cinema_start:')) return false;
  try {
    const itemId = interaction.customId.split(':')[1];
    const sel = pending.get(interaction.user.id) || { itemId, audioIndex: null, subIndex: null };
    const vc = interaction.member?.voice?.channel;
    if (!vc) { await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true }); return true; }

    // Re-check the global lock right before starting (TOCTOU guard).
    if (await getActiveState()) {
      await interaction.update({ content: '🎬 Cinema just became busy — try again shortly.', components: [] });
      return true;
    }

    const item = await jf.getItem(itemId);
    const r = await cinema.play({
      guildId: interaction.guildId, voiceChannelId: vc.id, channelId: interaction.channelId,
      itemId, itemName: item.Name, startedBy: interaction.user.id,
      audioIndex: sel.audioIndex, subIndex: sel.subIndex,
    });
    pending.delete(interaction.user.id);
    if (!r.ok) {
      console.error('[cinema:start] play failed', r.status, r.data?.error);
      const reason = r.status === 409 ? 'Cinema is busy right now.' : 'Could not start the movie. Please try again.';
      await interaction.update({ content: `🎬 ${reason}`, components: [] });
      return true;
    }
    await interaction.update({ content: `🎬 Starting **${item.Name}** — opening the control panel…`, components: [] });

    const state = await getActiveState();
    const panel = await interaction.channel.send(buildPanel(state));
    await setPanelMessageId(panel.id);
    (await import('../../jobs/cinema-panel-reaper.js')).rememberPanel(panel.channelId, panel.id, interaction.guildId);
    return true;
  } catch (e) {
    // Log full detail internally; the error may embed the Jellyfin URL incl. api_key.
    console.error('[cinema:start] unexpected error', e);
    const msg = { content: '🎬 Could not start the movie. Please try again later.', components: [] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.update(msg).catch(() => interaction.reply({ ...msg, ephemeral: true }).catch(() => {}));
    return true;
  }
}
