/**
 * CommanderRoot known-bot list (twitch-tools.rootonline.de), checked per account and cached.
 *
 * The list (~95M Twitch user IDs, updated daily) is served 10,000 IDs per page in descending order,
 * and the paging cursor is a user ID, so `after=<id+1>` returns the page containing <id>. We never
 * mirror the list: we only look up accounts we actually saw in chat, one request per second, and
 * every page fetched settles every one of our IDs that falls inside its range. Results are cached in
 * twitch_known_bot_checks and rechecked after RECHECK_DAYS.
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[KnownBots]';
const LIST_URL = 'https://twitch-tools.rootonline.de/blocklist_manager.php?preset=known_bot_users&list';
const UA = 'CertiFried/1.0 (+https://certifriedmultitool.com) known-bot lookup';
export const RECHECK_DAYS = 7;
const REQUEST_GAP_MS = 1000;
const DAY = 24 * 60 * 60 * 1000;

/** CommanderRoot's list opened at one account: a listed account's ID is the first one returned. */
export const knownBotListUrl = (userId) => `${LIST_URL}&after=${BigInt(userId) + 1n}`;

/** Cached results: Map userId(string) -> listed(boolean), only for checks newer than RECHECK_DAYS. */
export async function knownBotStatus(userIds) {
    const ids = Array.from(new Set(userIds.map(String).filter(id => /^\d{1,20}$/.test(id))));
    const out = new Map();
    const fresh = new Date(Date.now() - RECHECK_DAYS * DAY);
    for (let i = 0; i < ids.length; i += 1000) {
        const [rows] = await pool.query(
            'SELECT user_id, listed FROM twitch_known_bot_checks WHERE user_id IN (?) AND checked_at >= ?',
            [ids.slice(i, i + 1000), fresh]);
        for (const r of rows) out.set(String(r.user_id), !!r.listed);
    }
    return out;
}

/** Map userId -> first date we found it on the list. */
export async function knownBotFirstListed(userIds) {
    const ids = Array.from(new Set(userIds.map(String).filter(id => /^\d{1,20}$/.test(id))));
    const out = new Map();
    for (let i = 0; i < ids.length; i += 1000) {
        const [rows] = await pool.query(
            'SELECT user_id, first_listed_at FROM twitch_known_bot_checks WHERE user_id IN (?) AND first_listed_at IS NOT NULL',
            [ids.slice(i, i + 1000)]);
        for (const r of rows) out.set(String(r.user_id), r.first_listed_at);
    }
    return out;
}

/**
 * Stream history evidence, for accounts whose check is older than RECHECK_DAYS. Twitch has no
 * last-live field, so this gathers what the official API does keep (app token, bounded per run):
 * newest past broadcast (expires after 7–60 days), newest highlight and a clip (both kept until
 * deleted; a clip can only be cut from a stream). Three or four Helix calls per account.
 */
const CLIP_RECENT_DAYS = 60;
export async function checkStreamHistory(logins, { max = 200 } = {}) {
    if (!logins.length) return 0;
    const stale = new Date(Date.now() - RECHECK_DAYS * DAY);
    const [rows] = await pool.query(
        `SELECT login, user_id FROM twitch_account_cache
          WHERE login IN (?) AND exists_on_twitch = 1 AND user_id IS NOT NULL
            AND (vod_checked_at IS NULL OR vod_checked_at < ?)
          ORDER BY vod_checked_at IS NOT NULL, vod_checked_at LIMIT ?`, [logins, stale, max]);
    if (!rows.length) return 0;
    const { getAccessToken } = await import('../utils/platforms/twitch-api.js');
    const token = await getAccessToken();
    const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
    const helix = async (path, params) => {
        const r = await axios.get(`https://api.twitch.tv/helix/${path}`, { headers, params, timeout: 15_000 });
        await new Promise(res => setTimeout(res, 120));
        return r.data?.data?.[0] || null;
    };
    let done = 0;
    for (const r of rows) {
        try {
            const vod = await helix('videos', { user_id: r.user_id, type: 'archive', first: 1, sort: 'time' });
            const hl = await helix('videos', { user_id: r.user_id, type: 'highlight', first: 1, sort: 'time' });
            // Clips come back most-viewed first, so look in the recent window before all time.
            let clip = await helix('clips', { broadcaster_id: r.user_id, first: 1,
                started_at: new Date(Date.now() - CLIP_RECENT_DAYS * DAY).toISOString(), ended_at: new Date().toISOString() });
            if (!clip) clip = await helix('clips', { broadcaster_id: r.user_id, first: 1 });
            await pool.query(
                `UPDATE twitch_account_cache
                    SET has_vod = ?, last_vod_at = ?, has_highlight = ?, last_highlight_at = ?,
                        has_clip = ?, last_clip_at = ?, vod_checked_at = NOW()
                  WHERE login = ?`,
                [vod ? 1 : 0, vod ? new Date(vod.created_at) : null,
                 hl ? 1 : 0, hl ? new Date(hl.created_at) : null,
                 clip ? 1 : 0, clip ? new Date(clip.created_at) : null, r.login]);
            done++;
        } catch (e) {
            logger.warn(`${LOG} stream history for ${r.login} failed: ${e.response?.status || e.message}`);
        }
    }
    return done;
}

/**
 * Our own "last live" record. Twitch's API never says when an account last streamed, so every
 * 10 minutes (the analytics cron's due-job tick) we ask /streams (official, app token, 100 IDs per call) which of the accounts we track
 * are live, and stamp live_seen_at. This only knows what happened since we started watching.
 */
let livePolling = false;
export async function pollTrackedLive() {
    if (livePolling) return 0;
    livePolling = true;
    try {
        const [rows] = await pool.query(
            `SELECT user_id FROM twitch_account_cache
              WHERE exists_on_twitch = 1 AND user_id IS NOT NULL AND fetched_at >= NOW() - INTERVAL 90 DAY`);
        const ids = rows.map(r => String(r.user_id)).filter(id => /^\d{1,20}$/.test(id));
        if (!ids.length) return 0;
        const { getAccessToken } = await import('../utils/platforms/twitch-api.js');
        const token = await getAccessToken();
        const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
        let seen = 0;
        for (let i = 0; i < ids.length; i += 100) {
            const params = new URLSearchParams({ first: '100', type: 'live' });
            for (const id of ids.slice(i, i + 100)) params.append('user_id', id);
            try {
                const r = await axios.get(`https://api.twitch.tv/helix/streams?${params}`, { headers, timeout: 15_000 });
                for (const s of r.data?.data || []) {
                    await pool.query(
                        'UPDATE twitch_account_cache SET live_seen_at = NOW(), live_started_at = ? WHERE user_id = ?',
                        [s.started_at ? new Date(s.started_at) : null, s.user_id]);
                    seen++;
                }
            } catch (e) {
                logger.warn(`${LOG} live poll batch failed: ${e.response?.status || e.message}`);
            }
            await new Promise(res => setTimeout(res, 200));
        }
        return seen;
    } finally {
        livePolling = false;
    }
}

let running = false;
/**
 * Look up the IDs that have no fresh result. Bounded by maxRequests per call; anything left over is
 * picked up on the next call. Returns { checked, requests, remaining }.
 */
export async function checkKnownBots(userIds, { maxRequests = 300 } = {}) {
    if (running) return { checked: 0, requests: 0, remaining: null };
    running = true;
    try { return await rangeLookup(userIds, maxRequests); } finally { running = false; }
}

// Lookups for accounts that just appeared in a live chat (ban on sight). A separate lock, so the
// hourly sweep never holds them up.
let liveRunning = false;
export async function checkKnownBotsLive(userIds, { maxRequests = 10 } = {}) {
    if (liveRunning) return { checked: 0, requests: 0, remaining: null };
    liveRunning = true;
    try { return await rangeLookup(userIds, maxRequests); } finally { liveRunning = false; }
}

async function rangeLookup(userIds, maxRequests) {
    const cached = await knownBotStatus(userIds);
    const todo = Array.from(new Set(userIds.map(String)))
        .filter(id => /^\d{1,20}$/.test(id) && !cached.has(id))
        .map(Number).sort((a, b) => b - a);
    let requests = 0, checked = 0, coveredLow = Infinity, i = 0;
    for (; i < todo.length && requests < maxRequests; i++) {
        const id = todo[i];
        if (id >= coveredLow) continue;
        if (requests) await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
        const res = await axios.get(`${LIST_URL}&after=${id + 1}`, { headers: { 'User-Agent': UA }, timeout: 30_000 });
        requests++;
        const page = Array.isArray(res.data?.user_ids) ? res.data.user_ids.map(Number) : null;
        if (!page) throw new Error('unexpected response shape');
        // An empty page means nothing at or below this ID is listed.
        const low = page.length ? Math.min(...page) : 0;
        const listed = new Set(page);
        const settled = todo.filter(x => x <= id && x >= low);
        const now = new Date();
        if (settled.length) {
            await pool.query(
                `INSERT INTO twitch_known_bot_checks (user_id, listed, checked_at, first_listed_at) VALUES ?
                 ON DUPLICATE KEY UPDATE first_listed_at = COALESCE(first_listed_at, VALUES(first_listed_at)),
                     listed = VALUES(listed), checked_at = VALUES(checked_at)`,
                [settled.map(x => [String(x), listed.has(x) ? 1 : 0, now, listed.has(x) ? now : null])]);
            checked += settled.length;
        }
        coveredLow = low;
        if (!page.length) break;
    }
    const remaining = todo.filter(x => x < coveredLow).length;
    if (requests) logger.info(`${LOG} checked ${checked} accounts in ${requests} requests (${remaining} left)`);
    return { checked, requests, remaining };
}

/**
 * Background sweep: every account seen in chat in the last 90 days on channels with chatter lists.
 * Logins are resolved to IDs through the integrity report's account cache (Helix /users).
 */
export async function runKnownBotSweep() {
    const { accountAges } = await import('./twitch-integrity-report.js');
    const [chans] = await pool.query(
        `SELECT DISTINCT broadcaster_id FROM twitch_chatters_snapshots WHERE recorded_at >= NOW() - INTERVAL 90 DAY`);
    const logins = new Set();
    for (const c of chans) {
        const [snaps] = await pool.query(
            `SELECT chatter_logins_json FROM twitch_chatters_snapshots
              WHERE broadcaster_id = ? AND recorded_at >= NOW() - INTERVAL 90 DAY`, [c.broadcaster_id]);
        for (const s of snaps) {
            try { for (const l of JSON.parse(s.chatter_logins_json || '[]')) logins.add(String(l).toLowerCase()); }
            catch { /* skip malformed */ }
        }
    }
    if (!logins.size) return;
    // Re-fetching profiles weekly is also how removals are caught: a flagged account that stops
    // coming back from Helix gets gone_at stamped.
    const lookup = await accountAges(Array.from(logins), { maxAgeDays: RECHECK_DAYS });
    const ids = Array.from(lookup.values()).map(a => a.id).filter(Boolean);
    await checkKnownBots(ids);
    const n = await checkStreamHistory(Array.from(lookup.keys()));
    if (n) logger.info(`${LOG} stream history checked for ${n} accounts`);
}
