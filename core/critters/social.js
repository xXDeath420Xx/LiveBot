/*
 * Social: pray / curse (luck points), daily cookies, the social leaderboards and the owo/uwu points counter.
 */
import { q, T, withTx, CritterError } from './db.js';
import { PRAY_COOLDOWN_MS, POINTS_COOLDOWN_MS } from './data/economy.js';
import { PRAY_SELF, PRAY_OTHER, CURSE_SELF, CURSE_OTHER, pick } from './data/text.js';
import { prayDeltas } from './rules/misc-rules.js';
import { isBeforeToday, msUntilNextMidnight } from './rules/time.js';
import { claimCooldown } from './store.js';

async function addLuck(conn, g, u, delta) {
    await q(`INSERT INTO ${T('luck')} (guild_id, user_id, points, rolls) VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE points = points + VALUES(points)`, [g, u, delta], conn);
    const [r] = await q(`SELECT points FROM ${T('luck')} WHERE guild_id = ? AND user_id = ?`, [g, u], conn);
    return Number(r.points);
}

/**
 * Pray or curse (kind 'pray' | 'curse'), for yourself or a target. Shared cooldown 'pray'.
 * Errors: COOLDOWN, BOT. Returns { kind, targetId, line, luck, targetLuck }.
 * The line has {you} / {them} placeholders for the surface to fill with names.
 */
export async function prayOrCurse(guildId, userId, kind, targetId = null, { targetIsBot = false, rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    if (targetIsBot && targetId && String(targetId) !== u) throw new CritterError('BOT', 'Bots do not need luck.');
    const d = prayDeltas(kind, u, targetId);
    return withTx(async (conn) => {
        const cd = await claimCooldown(conn, g, u, 'pray', PRAY_COOLDOWN_MS, now);
        if (!cd.ok) throw new CritterError('COOLDOWN', `You can ${kind} again in ${Math.ceil(cd.msLeft / 1000)}s.`, cd);
        const luck = await addLuck(conn, g, u, d.self);
        let targetLuck = null;
        if (d.targetId) {
            targetLuck = await addLuck(conn, g, d.targetId, d.target);
            const pr = kind === 'pray' ? 1 : 0;
            await q(`INSERT INTO ${T('prayers')} (guild_id, sender, receiver, prays, curses, last_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE prays = prays + VALUES(prays), curses = curses + VALUES(curses), last_at = VALUES(last_at)`,
                [g, u, d.targetId, pr, 1 - pr, now], conn);
        }
        const list = kind === 'pray' ? (d.targetId ? PRAY_OTHER : PRAY_SELF) : (d.targetId ? CURSE_OTHER : CURSE_SELF);
        return { kind, targetId: d.targetId, line: pick(list, rng), luck, targetLuck };
    });
}

/** Luck summary for profiles: { points, rolls, praysReceived, cursesReceived }. */
export async function getLuck(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const [l] = await q(`SELECT points, rolls FROM ${T('luck')} WHERE guild_id = ? AND user_id = ?`, [g, u]);
    const [p] = await q(`SELECT COALESCE(SUM(prays), 0) AS prays, COALESCE(SUM(curses), 0) AS curses FROM ${T('prayers')} WHERE guild_id = ? AND receiver = ?`, [g, u]);
    return { points: Number(l?.points) || 0, rolls: Number(l?.rolls) || 0, praysReceived: Number(p?.prays) || 0, cursesReceived: Number(p?.curses) || 0 };
}

/** Cookie status: { received, canGive, msUntilNext }. */
export async function cookieStatus(guildId, userId, { now = new Date() } = {}) {
    const [r] = await q(`SELECT received, last_given_at FROM ${T('cookies')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    const canGive = isBeforeToday(r?.last_given_at, now);
    return { received: Number(r?.received) || 0, canGive, msUntilNext: canGive ? 0 : msUntilNextMidnight(now) };
}

/** Give your one cookie of the local day. Errors: SELF, BOT, ALREADY_GIVEN (data.msUntilNext). */
export async function giveCookie(guildId, userId, targetId, { targetIsBot = false, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId); const t = String(targetId);
    if (u === t) throw new CritterError('SELF', 'You cannot give yourself a cookie.');
    if (targetIsBot) throw new CritterError('BOT', 'Bots cannot eat cookies.');
    return withTx(async (conn) => {
        await q(`INSERT IGNORE INTO ${T('cookies')} (guild_id, user_id, received, last_given_at) VALUES (?, ?, 0, NULL)`, [g, u], conn);
        const [me] = await q(`SELECT last_given_at FROM ${T('cookies')} WHERE guild_id = ? AND user_id = ? FOR UPDATE`, [g, u], conn);
        if (!isBeforeToday(me.last_given_at, now)) throw new CritterError('ALREADY_GIVEN', 'You already gave a cookie today.', { msUntilNext: msUntilNextMidnight(now) });
        await q(`UPDATE ${T('cookies')} SET last_given_at = ? WHERE guild_id = ? AND user_id = ?`, [now, g, u], conn);
        await q(`INSERT INTO ${T('cookies')} (guild_id, user_id, received) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE received = received + 1`, [g, t], conn);
        const [r] = await q(`SELECT received FROM ${T('cookies')} WHERE guild_id = ? AND user_id = ?`, [g, t], conn);
        return { targetId: t, targetCookies: Number(r.received) };
    });
}

/**
 * Social boards: type 'cookies' | 'luck' | 'curse'. Rows { userId, value }; plus { you: { value, place } }.
 * luck = positive points, most first; curse = negative points, most negative first.
 */
export async function socialBoard(guildId, type, { userId = null, limit = 10 } = {}) {
    const g = String(guildId);
    const n = Math.max(1, Math.min(25, Math.floor(Number(limit) || 10)));
    let rows; let mine = null; let place = null;
    if (type === 'cookies') {
        rows = await q(`SELECT user_id, received AS v FROM ${T('cookies')} WHERE guild_id = ? AND received > 0 ORDER BY received DESC, user_id LIMIT ?`, [g, n]);
        if (userId) {
            const [m] = await q(`SELECT received AS v FROM ${T('cookies')} WHERE guild_id = ? AND user_id = ?`, [g, String(userId)]);
            mine = Number(m?.v) || 0;
            const [a] = await q(`SELECT COUNT(*) AS n FROM ${T('cookies')} WHERE guild_id = ? AND received > ?`, [g, mine]);
            place = Number(a.n) + 1;
        }
    } else if (type === 'luck' || type === 'curse') {
        const pos = type === 'luck';
        rows = await q(`SELECT user_id, points AS v FROM ${T('luck')} WHERE guild_id = ? AND points ${pos ? '> 0' : '< 0'} ORDER BY points ${pos ? 'DESC' : 'ASC'}, user_id LIMIT ?`, [g, n]);
        if (userId) {
            const [m] = await q(`SELECT points AS v FROM ${T('luck')} WHERE guild_id = ? AND user_id = ?`, [g, String(userId)]);
            mine = Number(m?.v) || 0;
            const [a] = await q(`SELECT COUNT(*) AS n FROM ${T('luck')} WHERE guild_id = ? AND points ${pos ? '>' : '<'} ?`, [g, mine]);
            place = Number(a.n) + 1;
        }
    } else {
        throw new CritterError('BAD_BOARD', 'Pick a board: cookies, luck or curse.');
    }
    return { type, rows: rows.map(r => ({ userId: r.user_id, value: Number(r.v) })), you: userId ? { value: mine, place } : null };
}

/* ----------------------------------------------------------------------------------------------- owo points */

/** True when a message text earns a point (contains owo or uwu, any case). */
export function earnsPoint(text) {
    return /owo|uwu/i.test(String(text || ''));
}

/**
 * Count one point for a guild message that contains owo/uwu. The per-user cooldown is persisted
 * (critter_points_user.last_at), so restarts and other shards share it. Silent; returns true when counted.
 * The caller must already have checked: guild message, not a bot, module enabled.
 */
export async function recordPoint(guildId, userId, text, { now = Date.now() } = {}) {
    if (!earnsPoint(text)) return false;
    const g = String(guildId); const u = String(userId);
    await q(`INSERT IGNORE INTO ${T('points_user')} (user_id, count, last_at) VALUES (?, 0, 0)`, [u]);
    const r = await q(`UPDATE ${T('points_user')} SET count = count + 1, last_at = ? WHERE user_id = ? AND last_at <= ?`, [now, u, now - POINTS_COOLDOWN_MS]);
    if (r.affectedRows !== 1) return false;
    await q(`INSERT INTO ${T('points_guild')} (guild_id, count) VALUES (?, 1) ON DUPLICATE KEY UPDATE count = count + 1`, [g]);
    await q(`INSERT INTO ${T('points_member')} (guild_id, user_id, count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE count = count + 1`, [g, u]);
    return true;
}

/** Points card: { here, rankHere, global, serverTotal }. */
export async function pointsCard(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const [m] = await q(`SELECT count FROM ${T('points_member')} WHERE guild_id = ? AND user_id = ?`, [g, u]);
    const here = Number(m?.count) || 0;
    const [a] = await q(`SELECT COUNT(*) AS n FROM ${T('points_member')} WHERE guild_id = ? AND count > ?`, [g, here]);
    const [gl] = await q(`SELECT count FROM ${T('points_user')} WHERE user_id = ?`, [u]);
    const [s] = await q(`SELECT count FROM ${T('points_guild')} WHERE guild_id = ?`, [g]);
    return { here, rankHere: here > 0 ? Number(a.n) + 1 : null, global: Number(gl?.count) || 0, serverTotal: Number(s?.count) || 0 };
}
