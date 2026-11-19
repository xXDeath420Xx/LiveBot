import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getMusicHealth } from '../core/music-health-monitor.js';

let primaryClient = null;
// This fires from server1's LOCAL yt-dlp, which is only the fallback behind the residential
// resolver on server2 — so a challenge here is routine. At most one DM a day, and none at all while
// the resolver is healthy (the music health monitor reports resolver problems itself). The
// timestamp is PERSISTED so restarts don't re-arm it.
const ALERT_DEBOUNCE_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.youtube-alert-state.json');

function readLastAlertedAt() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastAlertedAt || 0; } catch { return 0; }
}
function writeLastAlertedAt(ts) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastAlertedAt: ts })); } catch (e) { logger.warn(`[CookieHealth] could not persist alert state: ${e.message}`); }
}

export function setPrimaryClient(client) {
  primaryClient = client;
}

/**
 * @param {object} context  { source, query, stderr } — stderr is yt-dlp's output, used to say
 *                          whether the cookie jar itself died or the IP was challenged.
 */
export async function notifyCookieRotation(context = {}) {
  // Checked before the debounce so a suppressed event doesn't use up the day's alert.
  if (getMusicHealth().resolverHealthy) {
    logger.debug(`[CookieHealth] local yt-dlp challenged (${context.source || 'unknown'}) — not alerting, residential resolver is healthy`);
    return;
  }
  const now = Date.now();
  if (now - readLastAlertedAt() < ALERT_DEBOUNCE_MS) return;
  writeLastAlertedAt(now);

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

    const cookiesDead = /cookies are no longer valid/i.test(context.stderr || '');
    await user.send({
      embeds: [{
        title: cookiesDead ? '⚠️ YouTube cookies rejected on server1' : '⚠️ YouTube is challenging server1',
        description:
          'The residential resolver on server2 is **not** healthy right now, so YouTube plays are falling back to ' +
          'server1\'s own yt-dlp — and YouTube is refusing it. Spotify tracks are unaffected.\n\n' +
          (cookiesDead
            ? 'yt-dlp says the cookies are **no longer valid**. They are synced from Firefox on the workstation by the ' +
              '`CertiFried-Music-Cookie-Sync` scheduled task — make sure Firefox is still signed into YouTube.\n'
            : 'YouTube answered "Sign in to confirm you\'re not a bot": the OVH IP is flagged. Fresh cookies don\'t fix ' +
              'that — getting the server2 resolver back up does (see the music health DM).\n') +
          '\n_At most one of these a day._',
        color: 0xffaa00,
        footer: { text: contextLine },
        timestamp: new Date().toISOString(),
      }],
    });
    logger.warn(`[CookieHealth] Notified owner ${ownerId}: local yt-dlp ${cookiesDead ? 'cookies rejected' : 'bot-walled'} while resolver unhealthy`);
  } catch (err) {
    logger.error(`[CookieHealth] Failed to DM owner about cookie rotation: ${err.message}`);
  }
}
