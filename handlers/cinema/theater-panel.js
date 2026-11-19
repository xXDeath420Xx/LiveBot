// handlers/cinema/theater-panel.js
// /watch panel create|delete + the panel's click-only Browse dropdown and the
// optional typed Search. Discord cannot do type-ahead inside a component, so
// Browse pages through real titles (25/page) with zero typing, and Search is a
// fallback modal for when typing a title is faster.
import {
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import pool from '../../utils/db.js';
import * as jf from '../../utils/jellyfin.js';
import { presentSelection } from './panel.js';
import { TheaterPanel, startTheaterUpdater } from '../../core/theater-panel.js';

export async function handleTheaterPanelCreate(interaction) {
  const guildId = interaction.guildId;
  const [existing] = await pool.execute('SELECT * FROM theater_panels WHERE guild_id = ?', [guildId]);
  if (existing.length) {
    return interaction.reply({ content: 'A theater panel already exists here. Use `/watch panel delete` first.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    startTheaterUpdater(interaction.client);
    if (!interaction.client.theaterPanelManager) interaction.client.theaterPanelManager = new Map();
    const panel = new TheaterPanel(interaction.client, guildId);
    const msg = await panel.createPanel(interaction.channel);
    await pool.execute(
      'INSERT INTO theater_panels (guild_id, channel_id, message_id) VALUES (?,?,?)',
      [guildId, interaction.channel.id, msg.id]
    );
    interaction.client.theaterPanelManager.set(guildId, panel);
    return interaction.editReply({ content: 'Theater panel created. Use the Browse dropdown on it to pick something with no typing.' });
  } catch (e) {
    return interaction.editReply({ content: `Could not create the theater panel: ${e.message}` });
  }
}

export async function handleTheaterPanelDelete(interaction) {
  const guildId = interaction.guildId;
  await interaction.deferReply({ ephemeral: true });
  const [rows] = await pool.execute('SELECT * FROM theater_panels WHERE guild_id = ?', [guildId]);
  if (!rows.length) return interaction.editReply({ content: 'No theater panel to delete.' });
  try {
    const ch = await interaction.client.channels.fetch(rows[0].channel_id).catch(() => null);
    if (ch) { const m = await ch.messages.fetch(rows[0].message_id).catch(() => null); if (m) await m.delete().catch(() => {}); }
  } catch { /* best effort */ }
  await pool.execute('DELETE FROM theater_panels WHERE guild_id = ?', [guildId]);
  interaction.client.theaterPanelManager?.delete(guildId);
  return interaction.editReply({ content: 'Theater panel deleted.' });
}

// --- Browse dropdown (click-only) ---
const TYPE_ICON = { Movie: '🎬', Series: '📺', Season: '📀', Episode: '▶️' };

function buildBrowsePayload(kind, res) {
  const kindLabel = kind === 'series' ? 'TV Shows' : 'Movies';
  if (!res.items.length) return { content: `No ${kindLabel.toLowerCase()} found.`, components: [] };
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`theater_pick:${kind}`)
    .setPlaceholder(`Pick a ${kind === 'series' ? 'show' : 'movie'} to play`)
    .addOptions(res.items.map((i) => ({
      label: i.name.slice(0, 100), value: i.id, emoji: TYPE_ICON[i.type] || undefined,
    })));
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (res.pages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`theater_bpage:${kind}:${res.page - 1}`)
        .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(res.page <= 0),
      new ButtonBuilder().setCustomId(`theater_bpage:${kind}:${res.page + 1}`)
        .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(res.page >= res.pages - 1),
    ));
  }
  return {
    content: `Browse ${kindLabel} — page ${res.page + 1}/${res.pages} (${res.total} total). Pick one:`,
    components,
  };
}

// The panel's browse/search select: Movies, TV Shows, or Search-by-title.
export async function handleTheaterBrowse(interaction) {
  if (interaction.customId !== 'theater_browse') return false;
  const choice = interaction.values[0];
  if (choice === 'search') {
    const modal = new ModalBuilder().setCustomId('theater_search_modal').setTitle('Search the library');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('q').setLabel('Movie, show, or episode title')
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(2).setMaxLength(100)));
    await interaction.showModal(modal);
    return true;
  }
  const kind = choice === 'series' ? 'series' : 'movies';
  await interaction.deferReply({ ephemeral: true });
  let res;
  try { res = await jf.browseLibrary(kind, 0); }
  catch { return interaction.editReply({ content: 'Could not load the library. Try again.' }); }
  return interaction.editReply(buildBrowsePayload(kind, res));
}

export async function handleTheaterBrowsePage(interaction) {
  if (!interaction.customId.startsWith('theater_bpage:')) return false;
  const [, kind, pageStr] = interaction.customId.split(':');
  await interaction.deferUpdate();
  let res;
  try { res = await jf.browseLibrary(kind, Number(pageStr) || 0); }
  catch { return interaction.editReply({ content: 'Could not load that page.', components: [] }); }
  return interaction.editReply(buildBrowsePayload(kind, res));
}

export async function handleTheaterPick(interaction) {
  if (!interaction.customId.startsWith('theater_pick:')) return false;
  await interaction.deferUpdate();
  await presentSelection(interaction, interaction.values[0]);
  return true;
}

// --- Typed search (fallback) ---
export async function handleTheaterSearchModal(interaction) {
  if (interaction.customId !== 'theater_search_modal') return false;
  const q = (interaction.fields.getTextInputValue('q') || '').trim();
  await interaction.deferReply({ ephemeral: true });
  let results;
  try { results = await jf.search(q); }
  catch { return interaction.editReply({ content: 'Search failed — please try again.' }); }
  if (!results.length) return interaction.editReply({ content: `No results for **${q}**.` });
  const menu = new StringSelectMenuBuilder()
    .setCustomId('theater_result')
    .setPlaceholder('Pick a result to play')
    .addOptions(results.slice(0, 25).map((r) => ({
      label: r.name.slice(0, 100), value: r.id, description: r.type, emoji: TYPE_ICON[r.type] || undefined,
    })));
  return interaction.editReply({ content: `Results for **${q}** — pick one:`, components: [new ActionRowBuilder().addComponents(menu)] });
}

export async function handleTheaterResultSelect(interaction) {
  if (interaction.customId !== 'theater_result') return false;
  await interaction.deferUpdate();
  await presentSelection(interaction, interaction.values[0]);
  return true;
}
