/**
 * Ban on sight: accounts on CommanderRoot's known-bot list that show up in a live channel's chat
 * are banned through the broadcaster's write grant. Off by default
 * (twitch_analytics_alerts_config.known_bot_autoban_enabled).
 *
 * It fails safe. Nobody is banned in a minute where we can't rule out a real community member:
 * chat sampling must be on (so we know who has ever chatted here), and mods, VIPs and subscribers
 * are checked live against Twitch before every batch. Accounts staff unban from the dashboard are
 * recorded as 'exempt' and never auto-banned again.
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isChatBot } from '../utils/twitch-chat-bots.js';
import { knownBotStatus, checkKnownBotsLive } from './twitch-known-bots.js';
import { getTierBAuth, banUser, unbanUser } from './twitch-write.js';
import { getBroadcasterAccessToken } from './twitch-broadcaster-auth.js';

const LOG = '[KnownBotBan]';
const HELIX = 'https://api.twitch.tv/helix';
const MAX_BANS_PER_MINUTE = 20;
const LOOKUPS_PER_MINUTE = 10;   // CommanderRoot range lookups for accounts not cached yet
const MAX_ATTEMPTS = 3;
export const BAN_REASON = "Known bot account (listed on CommanderRoot's known-bot list). Automatic ban by CertiFried; if this is a mistake, send an unban request.";
const ACTOR = { triggeredByDiscordUsername: 'CertiFried known-bot ban' };

const inFlight = new Set();
const lastWarn = new Map();
function warnHourly(bid, msg) {
    const key = `${bid}:${msg}`;
    if (Date.now() - (lastWarn.get(key) || 0) < 60 * 60 * 1000) return;
    lastWarn.set(key, Date.now());
    logger.warn(`${LOG} ${bid}: ${msg}`);
}

/** A token holding any of `scopes`: the write grant first, then the read grant. Null if neither has one. */
async function tokenWith(bid, scopes) {
    const tb = await getTierBAuth(bid).catch(() => null);
    if (tb && scopes.some(s => tb.scopes.has(s))) return tb.accessToken;
    const [[cfg]] = await pool.execute(
        'SELECT token_scopes FROM twitch_role_sync_config WHERE broadcaster_twitch_id = ? AND enabled = 1 LIMIT 1', [bid]);
    const granted = String(cfg?.token_scopes || '').split(/[\s,]+/);
    if (scopes.some(s => granted.includes(s))) return getBroadcasterAccessToken({ broadcasterId: bid });
    return null;
}

/** IDs among `ids` that are mods, VIPs or subscribers right now. Null when any of the three can't be checked. */
async function communityRoles(bid, ids) {
    const checks = [
        { path: '/moderation/moderators', scopes: ['moderation:read', 'channel:manage:moderators'] },
        { path: '/channels/vips', scopes: ['channel:read:vips', 'channel:manage:vips'] },
        { path: '/subscriptions', scopes: ['channel:read:subscriptions'] },
    ];
    const found = new Set();
    for (const c of checks) {
        const token = await tokenWith(bid, c.scopes);
        if (!token) return null;
        for (let i = 0; i < ids.length; i += 100) {
            const params = new URLSearchParams({ broadcaster_id: bid });
            for (const id of ids.slice(i, i + 100)) params.append('user_id', id);
            try {
                const r = await axios.get(`${HELIX}${c.path}?${params}`, {
                    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` }, timeout: 10_000 });
                for (const row of r.data?.data || []) found.add(String(row.user_id));
            } catch (e) {
                warnHourly(bid, `${c.path} check failed (${e.response?.status || e.message}); no bans this minute`);
                return null;
            }
        }
    }
    return found;
}

/** Called from the per-minute chatter poll with that minute's {id, login} list. Never throws. */
export async function banKnownBotsOnSight(bid, identities) {
    bid = String(bid);
    if (inFlight.has(bid)) return;
    inFlight.add(bid);
    try {
        const [[cfg]] = await pool.execute(
            `SELECT known_bot_autoban_enabled, chat_sampling_enabled FROM twitch_analytics_alerts_config
              WHERE broadcaster_id = ? LIMIT 1`, [bid]);
        if (!cfg || Number(cfg.known_bot_autoban_enabled) !== 1) return;
        if (Number(cfg.chat_sampling_enabled) !== 1) { warnHourly(bid, 'ban on sight is on but chat sampling is off; no bans'); return; }

        const seen = identities.filter(c => /^\d{1,20}$/.test(String(c.id)) && String(c.id) !== bid
                                            && !isChatBot(String(c.login || '').toLowerCase()));
        if (!seen.length) return;
        const ids = seen.map(c => String(c.id));
        const [done] = await pool.query(
            `SELECT user_id FROM twitch_known_bot_bans
              WHERE broadcaster_id = ? AND user_id IN (?) AND (status IN ('banned', 'exempt') OR attempts >= ?)`,
            [bid, ids, MAX_ATTEMPTS]);
        const handled = new Set(done.map(r => String(r.user_id)));
        const fresh = ids.filter(id => !handled.has(id));
        if (!fresh.length) return;

        let status = await knownBotStatus(fresh);
        const unknown = fresh.filter(id => !status.has(id));
        if (unknown.length) {
            await checkKnownBotsLive(unknown, { maxRequests: LOOKUPS_PER_MINUTE })
                .catch(e => warnHourly(bid, `known-bot lookup failed: ${e.message}`));
            status = await knownBotStatus(fresh);
        }
        let targets = fresh.filter(id => status.get(id) === true);
        if (!targets.length) return;

        // Anyone who has ever chatted here takes part in the community; only silent accounts are banned.
        const [spoke] = await pool.query(
            'SELECT DISTINCT chatter_user_id FROM twitch_chat_message_samples WHERE broadcaster_id = ? AND chatter_user_id IN (?)',
            [bid, targets]);
        const spoken = new Set(spoke.map(r => String(r.chatter_user_id)));
        targets = targets.filter(id => !spoken.has(id));
        if (!targets.length) return;

        const roles = await communityRoles(bid, targets);
        if (!roles) { warnHourly(bid, 'could not check mods, VIPs and subscribers; no bans'); return; }
        targets = targets.filter(id => !roles.has(id)).slice(0, MAX_BANS_PER_MINUTE);

        const loginOf = new Map(seen.map(c => [String(c.id), c.login ? String(c.login).toLowerCase().slice(0, 25) : null]));
        let banned = 0;
        for (const id of targets) {
            const r = await banUser(bid, id, BAN_REASON, null, ACTOR);
            if (r.error === 'tier_b_not_granted' || r.error === 'scope_not_granted') {
                warnHourly(bid, 'write permission with moderator:manage:banned_users is missing; bans paused');
                return;
            }
            const ok = r.ok || /already banned/i.test(r.error || '');
            if (ok) banned++;
            await pool.query(
                `INSERT INTO twitch_known_bot_bans (broadcaster_id, user_id, login, status, error, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE login = COALESCE(VALUES(login), login), status = VALUES(status),
                     error = VALUES(error), attempts = attempts + 1, updated_at = NOW()`,
                [bid, id, loginOf.get(id) || null, ok ? 'banned' : 'failed', ok ? null : String(r.error || '').slice(0, 255)]);
        }
        if (banned) logger.info(`${LOG} ${bid}: banned ${banned} known-bot account${banned === 1 ? '' : 's'}`);
    } catch (e) {
        logger.warn(`${LOG} ${bid}: ${e.message}`);
    } finally {
        inFlight.delete(bid);
    }
}

/** Staff unban from the dashboard. The account becomes exempt from future automatic bans. */
export async function unbanKnownBot(bid, userId, actor) {
    bid = String(bid);
    const r = await unbanUser(bid, userId, actor);
    const ok = r.ok || /not banned/i.test(r.error || '');
    if (ok) {
        await pool.query(
            `UPDATE twitch_known_bot_bans SET status = 'exempt', error = NULL, updated_at = NOW()
              WHERE broadcaster_id = ? AND user_id = ?`, [bid, String(userId)]);
    }
    return { ...r, ok };
}

/** Totals and the most recent rows for the dashboard. */
export async function recentKnownBotBans(bid, limit = 25) {
    const [counts] = await pool.query(
        'SELECT status, COUNT(*) AS n FROM twitch_known_bot_bans WHERE broadcaster_id = ? GROUP BY status', [String(bid)]);
    const [recent] = await pool.query(
        `SELECT user_id, login, status, error, attempts, created_at, updated_at FROM twitch_known_bot_bans
          WHERE broadcaster_id = ? ORDER BY updated_at DESC LIMIT ?`, [String(bid), limit]);
    return { counts: Object.fromEntries(counts.map(c => [c.status, Number(c.n)])), recent };
}
