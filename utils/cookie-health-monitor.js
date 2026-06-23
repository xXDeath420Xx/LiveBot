import logger from './logger.js';

let primaryClient = null;
let lastAlertedAt = 0;
const ALERT_DEBOUNCE_MS = 12 * 60 * 60 * 1000;

export function setPrimaryClient(client) {
  primaryClient = client;
}

export async function notifyCookieRotation(context = {}) {
  const now = Date.now();
  if (now - lastAlertedAt < ALERT_DEBOUNCE_MS) return;
  lastAlertedAt = now;

  const ownerId = process.env.BOT_OWNER_ID;
  if (!ownerId) {
    logger.error('[CookieHealth] YouTube cookies rotated but BOT_OWNER_ID is not set in env');
    return;
  }
  if (!primaryClient) {
    logger.error('[CookieHealth] YouTube cookies rotated but no primary client registered for DM');
    return;
  }

  try {
    const user = await primaryClient.users.fetch(ownerId);
    const contextLine = context.source
      ? `Detected in: \`${context.source}\`${context.query ? ` (query: \`${String(context.query).substring(0, 80)}\`)` : ''}`
      : 'Detected from yt-dlp stderr';

    await user.send({
      embeds: [{
        title: '⚠️ YouTube challenged a request (bot-detection)',
        description:
          'YouTube returned "Sign in to confirm you\'re not a bot" for a request. ' +
          '**This is almost always the server\'s IP being rate-limited/flagged — NOT a cookie problem.** ' +
          'Refreshing `cookies.txt` will not fix it (the bot already uses a PO-token provider, and the ' +
          'challenge persists with fresh cookies, no cookies, and every player client). Some videos still ' +
          'play; others get challenged intermittently.\n\n' +
          '**What actually helps:**\n' +
          '• A residential/rotating **proxy** for YouTube (the durable fix for a flagged datacenter IP) — set `YTDLP_PROXY`.\n' +
          '• Lower request volume / let the IP cool down.\n' +
          '• The bgutil **PO-token provider** is already running (PM2: `bgutil-provider`) — keep it up.\n\n' +
          '_Only refresh cookies if you specifically see `cookies are no longer valid` in logs — a true rotation is rare._',
        color: 0xffaa00,
        footer: { text: contextLine },
        timestamp: new Date().toISOString(),
      }],
    });
    logger.warn(`[CookieHealth] Notified owner ${ownerId} of a YouTube bot-detection challenge (IP-level, not cookies)`);
  } catch (err) {
    logger.error(`[CookieHealth] Failed to DM owner about cookie rotation: ${err.message}`);
  }
}
