/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Port of upstream OwO Bot's cowoncy give limits (src/commands/commandList/economy/utils/cowoncyUtils.js,
 * Copyright (C) Christopher Thai) adapted to per-server cowoncy.
 *
 * Daily send / receive caps (owo_cowoncy_limit) and the transfer audit log (owo_transaction).
 * Every cowoncy movement between members goes through here: `owo give`, battle bets (loser ->
 * winner), and cowoncy drops (member -> floor -> member). The caps reset at midnight, like every
 * other OwO daily window.
 *
 * owo_transaction.sender / reciever are BIGINT UNSIGNED — snowflakes are written as strings and
 * read back with CAST(... AS CHAR) so they never round through a JS double. 0 means "the floor"
 * (a cowoncy drop).
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { giveLimitsForLevel, usedToday, checkAllowance, isNewDay, untilMidnightText } from './social-math.js';
import { OwoUserError } from './tx.js';

/** The account id used in owo_transaction for cowoncy dropped on / picked up from a channel floor. */
export const FLOOR_ID = '0';

/**
 * The member's server level (user_levels). Upstream keys the caps off OwO's own level; this bot's
 * equivalent is the server level. 0 when the server has no leveling or the lookup fails.
 */
export async function getServerLevel(guildId, userId, conn = pool) {
    try {
        const [[row]] = await conn.execute(
            'SELECT MAX(level) AS level FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );
        return Number(row?.level) || 0;
    } catch (e) {
        logger.warn('[OwO] give-limit level lookup failed; using level 0', { guildId, userId, err: e.message });
        return 0;
    }
}

export async function getLimits(guildId, userId, conn = pool) {
    return giveLimitsForLevel(await getServerLevel(guildId, userId, conn));
}

function fmt(n) { return Number(n).toLocaleString('en-US'); }

function limitMessage(field, remaining, name) {
    if (field === 'send') {
        return remaining > 0
            ? `You can only send **${fmt(remaining)}** more cowoncy today!`
            : 'You cannot send any more cowoncy today.';
    }
    const who = name ? `**${name}**` : 'They';
    return remaining > 0
        ? `${who} can only receive **${fmt(remaining)}** more cowoncy today!`
        : `${who} cannot receive any more cowoncy today.`;
}

/** Lock the limit rows of several members in a fixed order (avoids A->B / B->A deadlocks). */
export async function lockLimitRowsTx(conn, guildId, userIds) {
    const ids = [...new Set(userIds.map(String))].sort();
    if (!ids.length) return;
    await conn.execute(
        `SELECT id FROM owo_cowoncy_limit WHERE guild_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
        [guildId, ...ids]
    );
}

/**
 * Check `amount` against the member's daily `field` cap and book it, inside the caller's
 * transaction. Throws OwoUserError when it would go over — unless `enforce` is false, which only
 * books the usage (a battle bet settling: the caps were checked when the bet went into escrow, and
 * a payout must never fail half-way).
 * @param {'send'|'receive'} field
 */
export async function bookAllowanceTx(conn, guildId, userId, field, amount, { name = null, enforce = true } = {}) {
    if (field !== 'send' && field !== 'receive') throw new Error(`bad limit field ${field}`);
    const [[row]] = await conn.execute(
        'SELECT send, receive, reset FROM owo_cowoncy_limit WHERE guild_id = ? AND id = ? FOR UPDATE',
        [guildId, userId]
    );
    const limit = (await getLimits(guildId, userId, conn))[field];
    const used = usedToday(row, field);
    const { ok, remaining } = checkAllowance({ used, amount, limit });
    if (!ok && enforce) throw new OwoUserError(limitMessage(field, remaining, name), `${field}_limit`);

    if (!row || isNewDay(row.reset)) {
        // New day: this booking is the whole of today's usage on both sides.
        await conn.execute(
            `INSERT INTO owo_cowoncy_limit (guild_id, id, send, receive, reset) VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE send = VALUES(send), receive = VALUES(receive), reset = NOW()`,
            [guildId, userId, field === 'send' ? amount : 0, field === 'receive' ? amount : 0]
        );
    } else if (field === 'send') {
        await conn.execute('UPDATE owo_cowoncy_limit SET send = send + ? WHERE guild_id = ? AND id = ?', [amount, guildId, userId]);
    } else {
        await conn.execute('UPDATE owo_cowoncy_limit SET receive = receive + ? WHERE guild_id = ? AND id = ?', [amount, guildId, userId]);
    }
    return { used: used + amount, limit, remaining: Math.max(0, remaining - amount) };
}

/** Read-only allowance check (used before a battle bet is put in escrow). */
export async function remainingAllowance(guildId, userId, field) {
    const [[row]] = await pool.execute(
        'SELECT send, receive, reset FROM owo_cowoncy_limit WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    const limit = (await getLimits(guildId, userId))[field];
    return Math.max(0, limit - usedToday(row, field));
}

/** Throws OwoUserError if `amount` would not fit in today's caps (no booking). */
export async function assertAllowance(guildId, userId, field, amount, name = null) {
    const remaining = await remainingAllowance(guildId, userId, field);
    if (amount > remaining) throw new OwoUserError(limitMessage(field, remaining, name), `${field}_limit`);
}

/** Audit row for a cowoncy movement. */
export async function logTransferTx(conn, guildId, senderId, receiverId, amount) {
    await conn.execute(
        'INSERT INTO owo_transaction (guild_id, sender, reciever, amount) VALUES (?, ?, ?, ?)',
        [guildId, String(senderId), String(receiverId), amount]
    );
}

/** Today's usage and caps, for `owo limits`. */
export async function getLimitStatus(guildId, userId) {
    const [[row]] = await pool.execute(
        'SELECT send, receive, reset FROM owo_cowoncy_limit WHERE guild_id = ? AND id = ?',
        [guildId, userId]
    );
    const limits = await getLimits(guildId, userId);
    return {
        level: await getServerLevel(guildId, userId),
        send: { used: usedToday(row, 'send'), limit: limits.send },
        receive: { used: usedToday(row, 'receive'), limit: limits.receive },
        resetsIn: untilMidnightText(),
    };
}

/**
 * Most recent transfers in a server, optionally only those involving one member.
 * @returns {Promise<Array<{tid:number, sender:string, receiver:string, amount:number, time:Date}>>}
 */
export async function listTransactions(guildId, { userId = null, limit = 15 } = {}) {
    const n = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 15)));
    const params = [guildId];
    let where = 'guild_id = ?';
    if (userId) { where += ' AND (sender = ? OR reciever = ?)'; params.push(String(userId), String(userId)); }
    const [rows] = await pool.execute(
        `SELECT tid, CAST(sender AS CHAR) AS sender, CAST(reciever AS CHAR) AS receiver, amount, time
         FROM owo_transaction WHERE ${where} ORDER BY tid DESC LIMIT ${n}`,
        params
    );
    return rows.map(r => ({ tid: Number(r.tid), sender: r.sender, receiver: r.receiver, amount: Number(r.amount), time: r.time }));
}
