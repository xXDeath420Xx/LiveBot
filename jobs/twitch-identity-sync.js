/*
 * Keep tracked Twitch identities correct.
 *
 * Two failure modes, one cause: we stored a NAME where we needed an ID.
 *
 *   1. Legacy setup scripts wrote placeholder platform_user_id values — the username itself, or
 *      "<username>_pending". Those rows cannot survive a rename and cannot be looked up by id.
 *   2. Twitch usernames change. Tracking keyed on the name silently breaks: go-live checks resolve
 *      nothing, the streamer looks permanently offline, and nobody notices because there is no
 *      error — just silence.
 *
 * Resolving by numeric id fixes both. The id never changes, so a rename shows up as "the login for
 * id 12345 is different from what we stored", and we update the name rather than losing the
 * streamer.
 *
 * Read-only against Twitch and write-only to usernames/ids — subscriptions are never touched, so a
 * rename can never cost someone their tracking.
 */
import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

let task = null;
let running = false;

const isNumericId = v => typeof v === 'string' && /^[0-9]+$/.test(v);

/**
 * Give rows that never got a real id one, by resolving their stored username once.
 * @returns {Promise<{fixed:number, gone:string[]}>}
 */
export async function backfillMissingIds({ dryRun = false } = {}) {
  const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');
  const [rows] = await pool.execute(
    `SELECT streamer_id, username, platform_user_id FROM streamers
     WHERE platform = 'twitch'
       AND (platform_user_id IS NULL OR platform_user_id = '' OR platform_user_id NOT REGEXP '^[0-9]+$')`);
  if (!rows.length) return { fixed: 0, gone: [] };

  const logins = [...new Set(rows.map(r => (r.username || '').toLowerCase()).filter(Boolean))];
  const byLogin = new Map();
  for (let i = 0; i < logins.length; i += 100) {
    for (const u of await getTwitchUsers(logins.slice(i, i + 100))) byLogin.set(u.login.toLowerCase(), u);
  }

  let fixed = 0;
  const gone = [];
  for (const r of rows) {
    const u = byLogin.get((r.username || '').toLowerCase());
    if (!u) { gone.push(r.username); continue; }
    if (!dryRun) {
      await pool.execute(
        'UPDATE streamers SET platform_user_id = ?, username = ? WHERE streamer_id = ?',
        [u.id, u.login, r.streamer_id]);
    }
    fixed++;
  }
  return { fixed, gone };
}

/**
 * Re-resolve every id-keyed Twitch streamer and correct any username that has changed.
 * @returns {Promise<{checked:number, renamed:number, missing:string[]}>}
 */
export async function syncUsernames({ dryRun = false } = {}) {
  const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');
  const [rows] = await pool.execute(
    `SELECT streamer_id, username, platform_user_id FROM streamers
     WHERE platform = 'twitch' AND platform_user_id REGEXP '^[0-9]+$'`);
  if (!rows.length) return { checked: 0, renamed: 0, missing: [] };

  const ids = [...new Set(rows.map(r => r.platform_user_id))];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    for (const u of await getTwitchUsers(ids.slice(i, i + 100), 'id')) byId.set(String(u.id), u);
  }

  let renamed = 0;
  const missing = [];
  for (const r of rows) {
    const u = byId.get(String(r.platform_user_id));
    // A id that resolves to nothing means the account was deleted or permanently banned. Left
    // alone deliberately: a Twitch outage would otherwise look identical and mass-delete real
    // streamers. Surfaced for a human instead.
    if (!u) { missing.push(`${r.username} (${r.platform_user_id})`); continue; }
    if (u.login.toLowerCase() === (r.username || '').toLowerCase()) continue;

    logger.info(`[TwitchIdentity] ${r.username} → ${u.login} (id ${r.platform_user_id} unchanged)`, { category: 'streams' });
    if (!dryRun) {
      await pool.execute(
        'UPDATE streamers SET username = ?, normalized_username = ? WHERE streamer_id = ?',
        [u.login, u.login.toLowerCase(), r.streamer_id]);
    }
    renamed++;
  }
  return { checked: rows.length, renamed, missing };
}

async function runOnce() {
  if (running) return logger.warn('[TwitchIdentity] previous run still going, skipping');
  running = true;
  try {
    const back = await backfillMissingIds();
    if (back.fixed) logger.info(`[TwitchIdentity] backfilled ${back.fixed} missing Twitch id(s)`, { category: 'streams' });
    if (back.gone.length) logger.warn(`[TwitchIdentity] ${back.gone.length} tracked name(s) do not resolve on Twitch: ${back.gone.slice(0, 20).join(', ')}`, { category: 'streams' });

    const sync = await syncUsernames();
    logger.info(`[TwitchIdentity] checked ${sync.checked} streamer(s), ${sync.renamed} renamed`, { category: 'streams' });
    if (sync.missing.length) {
      logger.warn(`[TwitchIdentity] ${sync.missing.length} id(s) no longer resolve (deleted or banned) — NOT removed, review manually: ${sync.missing.slice(0, 20).join(', ')}`, { category: 'streams' });
    }
  } catch (error) {
    logger.error('[TwitchIdentity] sync failed', { error: error.message, category: 'streams' });
  } finally {
    running = false;
  }
}

/** Daily at 04:20 — renames are rare, and this is a full sweep of every tracked account. */
export function startTwitchIdentitySync() {
  if (task) return logger.warn('[TwitchIdentity] scheduler already running');
  task = cron.schedule('20 4 * * *', runOnce);
  logger.info('[TwitchIdentity] scheduler started (daily 04:20)');
  setTimeout(() => runOnce().catch(() => {}), 90_000);   // once shortly after boot
}

export function stopTwitchIdentitySync() {
  if (task) { task.stop(); task = null; logger.info('[TwitchIdentity] scheduler stopped'); }
}

export default { startTwitchIdentitySync, stopTwitchIdentitySync, backfillMissingIds, syncUsernames };
