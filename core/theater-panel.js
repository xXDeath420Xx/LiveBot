// core/theater-panel.js
// Persistent, auto-updating "theater" control panel — the movie/TV analogue of
// the music panel. Unlike the music panel (driven by discord-player events), the
// cinema selfbot has no bot-side events, so this panel refreshes on a short poll
// of cinema_state (mirrored by the cinema service) plus whenever a control button
// is clicked. It REUSES the existing cinema_* control buttons (pause/resume/seek/
// skip/stop) already wired to handleCinemaButton, so no new interaction handlers.

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { buildPanel } from '../handlers/cinema/panel.js';
import { getActiveState } from '../handlers/cinema/state.js';

export class TheaterPanel {
  constructor(client, guildId) {
    this.client = client;
    this.guildId = guildId;
    this.message = null;
    this._lastSig = null; // skip edits when nothing visibly changed (avoid rate limits)
  }

  // Build the message payload: the live control panel if THIS guild is the one
  // currently playing, otherwise an idle placeholder.
  // Click-only Browse/Search dropdown right on the panel — pick a category and
  // page through real titles, no typing. "Search by title" opens a modal for
  // those who prefer to type. Wired to handleTheaterBrowse.
  static browseRow() {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('theater_browse')
        .setPlaceholder('▶ Browse or search the library…')
        .addOptions([
          { label: 'Browse Movies', value: 'movies', emoji: '🎬', description: 'Page through every movie' },
          { label: 'Browse TV Shows', value: 'series', emoji: '📺', description: 'Page through every show' },
          { label: 'Search by title', value: 'search', emoji: '🔍', description: 'Type a title to find it' },
        ]),
    );
  }

  async render() {
    let state = null;
    try { state = await getActiveState(); } catch { /* db hiccup → treat as idle */ }
    if (state && state.guild_id === this.guildId) {
      const base = buildPanel(state);
      base.components = [...(base.components || []), TheaterPanel.browseRow()];
      return { payload: base, sig: `${state.item_name}|${state.status}|${state.position_secs}|${state.queue_remaining}` };
    }
    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle('🎬 Theater')
      .setDescription('Nothing is playing right now.\nUse the **Browse** dropdown below to pick a movie or show — click through, no typing — or search by title.')
      .setFooter({ text: 'This panel updates automatically when playback starts.' });
    return { payload: { embeds: [embed], components: [TheaterPanel.browseRow()] }, sig: 'idle' };
  }

  async createPanel(channel) {
    const { payload, sig } = await this.render();
    this.message = await channel.send(payload);
    this._lastSig = sig;
    return this.message;
  }

  async refresh() {
    // Recover the message handle from DB if we lost it (bot restart).
    if (!this.message) {
      try {
        const [rows] = await pool.execute('SELECT channel_id, message_id FROM theater_panels WHERE guild_id = ?', [this.guildId]);
        if (!rows.length) return;
        const ch = await this.client.channels.fetch(rows[0].channel_id).catch(() => null);
        if (!ch) return;
        this.message = await ch.messages.fetch(rows[0].message_id).catch(() => null);
      } catch { /* recovery failed */ }
      if (!this.message) return;
    }
    const { payload, sig } = await this.render();
    if (sig === this._lastSig) return; // nothing changed — skip the edit
    this._lastSig = sig;
    try {
      await this.message.edit(payload);
    } catch (e) {
      if (e.code === 10008) { this.message = null; } // message deleted — will re-recover
      else logger.warn?.(`[TheaterPanel] update failed for guild ${this.guildId}: ${e.message}`);
    }
  }
}

// Single shared updater: rehydrate panels from DB at boot, then poll every 10s.
// Cinema playback is a global singleton, but each panel independently shows
// whether ITS guild is the active one.
export function startTheaterUpdater(client) {
  if (client._theaterUpdaterStarted) return;
  client._theaterUpdaterStarted = true;
  if (!client.theaterPanelManager) client.theaterPanelManager = new Map();

  (async () => {
    try {
      const [rows] = await pool.execute('SELECT * FROM theater_panels');
      for (const r of rows) {
        const p = new TheaterPanel(client, r.guild_id);
        client.theaterPanelManager.set(r.guild_id, p);
      }
      if (rows.length) logger.info?.(`[TheaterPanel] rehydrated ${rows.length} panel(s)`);
    } catch (e) { logger.warn?.(`[TheaterPanel] rehydrate failed: ${e.message}`); }
  })();

  setInterval(() => {
    for (const p of client.theaterPanelManager.values()) p.refresh().catch(() => {});
  }, 10_000);
}

export default TheaterPanel;
