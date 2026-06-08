// jobs/cinema-panel-reaper.js
// Keeps the cinema control panel in sync with the live session:
//  - while playing: re-render the panel every cycle so the Position field tracks.
//  - when the session ends (row cleared): edit the panel to "ended".
// The panel may be owned by the MAIN bot OR a custom bot (the one serving the
// host guild), so we resolve the correct client via botManager.getClientForGuild —
// only the bot that posted a message can edit it.
import pool from '../utils/db.js';
import { buildPanel } from '../handlers/cinema/panel.js';

let lastPanel = null; // { channelId, messageId, guildId } — for the ended edit after the row is gone
export function rememberPanel(channelId, messageId, guildId) {
  lastPanel = { channelId, messageId, guildId };
}

// The bot that owns the panel in this guild (custom bot or main); fall back to
// the client the reaper was started with if botManager can't resolve one.
function clientFor(guildId, fallback) {
  return globalThis.botManager?.getClientForGuild?.(guildId) || fallback;
}

export function startCinemaPanelReaper(fallbackClient) {
  setInterval(async () => {
    try {
      const [rows] = await pool.execute('SELECT * FROM cinema_state WHERE id = 1');
      const state = rows[0];

      if (state && state.panel_message_id && state.channel_id) {
        // Playing/paused: refresh the panel so Position (and play/pause state) track.
        lastPanel = { channelId: state.channel_id, messageId: state.panel_message_id, guildId: state.guild_id };
        const c = clientFor(state.guild_id, fallbackClient);
        const ch = await c.channels.fetch(state.channel_id).catch(() => null);
        const msg = ch ? await ch.messages.fetch(state.panel_message_id).catch(() => null) : null;
        if (msg) await msg.edit(buildPanel(state)).catch(() => {});
      } else if (!state && lastPanel) {
        // Ended: mark the dangling panel and clear the cache.
        const c = clientFor(lastPanel.guildId, fallbackClient);
        const ch = await c.channels.fetch(lastPanel.channelId).catch(() => null);
        const msg = ch ? await ch.messages.fetch(lastPanel.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ content: '⏹ Movie ended.', embeds: [], components: [] }).catch(() => {});
        lastPanel = null;
      }
    } catch { /* ignore */ }
  }, 15_000); // matches the cinema service's position-mirror cadence
}
