/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Ports upstream OwO Bot's `pray`/`curse` (src/commands/commandList/social/pray.js) and
 * `cookie`/`rep` (social/cookie.js), Copyright (C) Christopher Thai, per server.
 *
 *   pray / curse  owo_luck.lcount   luck points (upstream deltas, shared 5-minute cooldown in
 *                                   owo_cooldowns under command 'pray')
 *                 owo_user_pray     who prayed for / cursed whom (count = prays, curses = curses)
 *   cookie        owo_rep           count = cookies received; lasttime on the SENDER's row = when
 *                                   they last gave one (one cookie per day, reset at midnight)
 */
import pool from '../../utils/db.js';
import { withTx, claimCooldownTx, OwoUserError, formatWait } from './tx.js';
import {
    PRAY_COOLDOWN_MS, PRAY_LINES, CURSE_LINES, prayDeltas, isNewDay, untilMidnightText,
} from './social-math.js';

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

async function addLuckTx(conn, guildId, userId, delta) {
    if (!delta) return;
    await conn.execute(
        `INSERT INTO owo_luck (guild_id, id, lcount) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE lcount = lcount + VALUES(lcount)`,
        [guildId, userId, delta]
    );
}

/**
 * Pray or curse — yourself (no target) or another member.
 * @param {'pray'|'curse'} kind
 * @returns {Promise<{kind, line, luck: number, targetLuck: number|null}>}
 * @throws OwoUserError on cooldown
 */
export async function prayOrCurse(guildId, userId, targetId, kind) {
    const target = targetId && String(targetId) !== String(userId) ? String(targetId) : null;
    const deltas = prayDeltas(kind, !!target);
    return withTx(async (conn) => {
        const wait = await claimCooldownTx(conn, guildId, userId, 'pray', PRAY_COOLDOWN_MS);
        if (wait > 0) throw new OwoUserError(`Slow down~ you can ${kind} again in **${formatWait(wait)}**.`, 'cooldown');

        await addLuckTx(conn, guildId, userId, deltas.author);
        if (target) {
            await addLuckTx(conn, guildId, target, deltas.target);
            await conn.execute(
                `INSERT INTO owo_user_pray (guild_id, sender, receiver, count, curses, latest)
                 VALUES (?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE count = count + VALUES(count), curses = curses + VALUES(curses), latest = NOW()`,
                [guildId, String(userId), target, kind === 'pray' ? 1 : 0, kind === 'curse' ? 1 : 0]
            );
        }
        const [rows] = await conn.execute(
            `SELECT id, lcount FROM owo_luck WHERE guild_id = ? AND id IN (?, ?)`,
            [guildId, String(userId), target ?? String(userId)]
        );
        const luckOf = id => Number(rows.find(r => String(r.id) === String(id))?.lcount) || 0;
        return {
            kind,
            target,
            line: pick(kind === 'pray' ? PRAY_LINES : CURSE_LINES),
            luck: luckOf(userId),
            targetLuck: target ? luckOf(target) : null,
        };
    }, { label: 'pray' });
}

/**
 * Give someone a cookie. One per day per giver; the window resets at midnight.
 * @returns {Promise<{received: number}>} the receiver's new cookie count
 */
export async function giveCookie(guildId, fromId, toId) {
    if (String(fromId) === String(toId)) throw new OwoUserError("You can't give yourself a cookie, silly!");
    return withTx(async (conn) => {
        // The giver's row carries their last-given timestamp; create it at 0 cookies if new.
        await conn.execute(
            `INSERT IGNORE INTO owo_rep (guild_id, id, count, lasttime) VALUES (?, ?, 0, '2017-01-01 18:10:10')`,
            [guildId, fromId]
        );
        const [[giver]] = await conn.execute(
            'SELECT lasttime FROM owo_rep WHERE guild_id = ? AND id = ? FOR UPDATE',
            [guildId, fromId]
        );
        if (!isNewDay(giver?.lasttime)) {
            throw new OwoUserError(`Nu! You need to wait **${untilMidnightText()}** to give another cookie.`, 'cooldown');
        }
        await conn.execute('UPDATE owo_rep SET lasttime = NOW() WHERE guild_id = ? AND id = ?', [guildId, fromId]);
        await conn.execute(
            `INSERT INTO owo_rep (guild_id, id, count, lasttime) VALUES (?, ?, 1, '2017-01-01 18:10:10')
             ON DUPLICATE KEY UPDATE count = count + 1`,
            [guildId, toId]
        );
        const [[recv]] = await conn.execute('SELECT count FROM owo_rep WHERE guild_id = ? AND id = ?', [guildId, toId]);
        return { received: Number(recv?.count) || 0 };
    }, { label: 'cookie' });
}

/** Cookie count + whether today's cookie is still available. */
export async function cookieStatus(guildId, userId) {
    const [[row]] = await pool.execute('SELECT count, lasttime FROM owo_rep WHERE guild_id = ? AND id = ?', [guildId, userId]);
    const ready = isNewDay(row?.lasttime);
    return { count: Number(row?.count) || 0, ready, waitText: ready ? null : untilMidnightText() };
}

/** Everything social a profile shows, in one round of queries. */
export async function getSocialSummary(guildId, userId) {
    const [[[luck]], [[rep]], [[pray]]] = await Promise.all([
        pool.execute('SELECT lcount FROM owo_luck WHERE guild_id = ? AND id = ?', [guildId, userId]),
        pool.execute('SELECT count FROM owo_rep WHERE guild_id = ? AND id = ?', [guildId, userId]),
        pool.execute(
            'SELECT COALESCE(SUM(count), 0) AS prays, COALESCE(SUM(curses), 0) AS curses FROM owo_user_pray WHERE guild_id = ? AND receiver = ?',
            [guildId, userId]
        ),
    ]);
    return {
        luck: Number(luck?.lcount) || 0,
        cookies: Number(rep?.count) || 0,
        praysReceived: Number(pray?.prays) || 0,
        cursesReceived: Number(pray?.curses) || 0,
    };
}

export const LEADERBOARD_TYPES = ['cookies', 'luck', 'curse'];

/**
 * Server rankings (upstream `owo top cookie|luck|curse`).
 * @param {'cookies'|'luck'|'curse'} type
 * @returns {Promise<{rows: Array<{userId: string, value: number}>, you: {rank: number, value: number}|null}>}
 */
export async function getSocialLeaderboard(guildId, type, userId = null, limit = 10) {
    const n = Math.max(1, Math.min(25, Math.trunc(Number(limit) || 10)));
    let sql; let rankSql;
    if (type === 'cookies') {
        sql = `SELECT id, count AS value FROM owo_rep WHERE guild_id = ? AND count > 0 ORDER BY count DESC, id LIMIT ${n}`;
        rankSql = `SELECT r.count AS value,
                          (SELECT COUNT(*) + 1 FROM owo_rep o WHERE o.guild_id = r.guild_id AND o.count > r.count) AS place
                   FROM owo_rep r WHERE r.guild_id = ? AND r.id = ?`;
    } else if (type === 'luck') {
        sql = `SELECT id, lcount AS value FROM owo_luck WHERE guild_id = ? AND lcount > 0 ORDER BY lcount DESC, id LIMIT ${n}`;
        rankSql = `SELECT l.lcount AS value,
                          (SELECT COUNT(*) + 1 FROM owo_luck o WHERE o.guild_id = l.guild_id AND o.lcount > l.lcount) AS place
                   FROM owo_luck l WHERE l.guild_id = ? AND l.id = ?`;
    } else if (type === 'curse') {
        sql = `SELECT id, lcount AS value FROM owo_luck WHERE guild_id = ? AND lcount < 0 ORDER BY lcount ASC, id LIMIT ${n}`;
        rankSql = `SELECT l.lcount AS value,
                          (SELECT COUNT(*) + 1 FROM owo_luck o WHERE o.guild_id = l.guild_id AND o.lcount < l.lcount) AS place
                   FROM owo_luck l WHERE l.guild_id = ? AND l.id = ?`;
    } else {
        throw new OwoUserError(`Unknown leaderboard. Pick one of: ${LEADERBOARD_TYPES.join(', ')}.`);
    }
    const [rows] = await pool.execute(sql, [guildId]);
    let you = null;
    if (userId) {
        const [[me]] = await pool.execute(rankSql, [guildId, userId]);
        if (me) you = { rank: Number(me.place), value: Number(me.value) || 0 };
    }
    return { rows: rows.map(r => ({ userId: String(r.id), value: Number(r.value) || 0 })), you };
}
