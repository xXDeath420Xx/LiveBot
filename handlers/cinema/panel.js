// handlers/cinema/panel.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig, canControl } from './state.js';

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
  const config = await getConfig(interaction.guildId);
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
    const modal = new ModalBuilder().setCustomId('cinema_seek_modal').setTitle('Seek to timestamp');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ts').setLabel('HH:MM:SS or seconds')
        .setStyle(TextInputStyle.Short).setRequired(true)));
    const state = await getActiveState();
    const config = await getConfig(interaction.guildId);
    if (!state || !canControl(interaction.member, state, config)) {
      await interaction.reply({ content: 'Only the host or a mod can control playback.', ephemeral: true });
      return true;
    }
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
  const raw = interaction.fields.getTextInputValue('ts').trim();
  const secs = raw.includes(':')
    ? raw.split(':').reverse().reduce((a, p, i) => a + Number(p) * 60 ** i, 0)
    : Number(raw);
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
