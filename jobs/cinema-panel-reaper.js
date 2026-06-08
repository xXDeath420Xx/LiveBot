// jobs/cinema-panel-reaper.js
// If cinema_state has been cleared but we still hold a panel message reference,
// edit that message to "ended". The reference is set in-memory when the panel is
// posted (handleCinemaStart -> rememberPanel); it's lost on a main-bot restart,
// which is acceptable (worst case: a stale panel survives until the next press).
import pool from '../utils/db.js';

let lastPanel = null; // { channelId, messageId }
export function rememberPanel(channelId, messageId) { lastPanel = { channelId, messageId }; }

export function startCinemaPanelReaper(client) {
  setInterval(async () => {
    try {
      const [rows] = await pool.execute('SELECT id FROM cinema_state WHERE id = 1');
      if (rows.length === 0 && lastPanel) {
        const ch = await client.channels.fetch(lastPanel.channelId).catch(() => null);
        const msg = ch ? await ch.messages.fetch(lastPanel.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ content: '⏹ Movie ended.', embeds: [], components: [] }).catch(() => {});
        lastPanel = null;
      }
    } catch { /* ignore */ }
  }, 30_000);
}
