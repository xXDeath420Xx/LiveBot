// jobs/cinema-panel-reaper.js
// Keeps the cinema control panel in sync with the live session:
//  - while playing: re-render the panel every cycle so the Position field tracks
//    (the cinema service writes position_secs to cinema_state; only the main bot
//    can edit its own panel message, so the refresh has to live here).
//  - when the session ends (row cleared): edit the panel to "ended".
// The panel ref comes from cinema_state (panel_message_id + channel_id); we also
// cache it so the "ended" edit still works after the row is gone.
import pool from '../utils/db.js';
import { buildPanel } from '../handlers/cinema/panel.js';

let lastPanel = null; // { channelId, messageId } — last known panel, for the ended edit
export function rememberPanel(channelId, messageId) { lastPanel = { channelId, messageId }; }

export function startCinemaPanelReaper(client) {
  setInterval(async () => {
    try {
      const [rows] = await pool.execute('SELECT * FROM cinema_state WHERE id = 1');
      const state = rows[0];

      if (state && state.panel_message_id && state.channel_id) {
        // Playing/paused: refresh the panel so Position (and play/pause state) track.
        lastPanel = { channelId: state.channel_id, messageId: state.panel_message_id };
        const ch = await client.channels.fetch(state.channel_id).catch(() => null);
        const msg = ch ? await ch.messages.fetch(state.panel_message_id).catch(() => null) : null;
        if (msg) await msg.edit(buildPanel(state)).catch(() => {});
      } else if (!state && lastPanel) {
        // Ended: mark the dangling panel and clear the cache.
        const ch = await client.channels.fetch(lastPanel.channelId).catch(() => null);
        const msg = ch ? await ch.messages.fetch(lastPanel.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ content: '⏹ Movie ended.', embeds: [], components: [] }).catch(() => {});
        lastPanel = null;
      }
    } catch { /* ignore */ }
  }, 15_000); // matches the cinema service's position-mirror cadence
}
