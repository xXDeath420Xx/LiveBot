/*
 * Every arrival in every server, kept for good: what the join gate's rejoin limit counts.
 *
 * Why a table of its own: the other places a join is noted (audit_logs, invite_tracker_logs) are pruned
 * after 365 / 180 days, which would quietly reset a lifetime count. One row per join; a safety record
 * (core/privacy-tables.js), so it is neither exported nor removed by /privacy delete.
 *
 * Recorded on every join in every server whether or not the limit is on, so a server that switches it
 * on later counts real history. backfillGuild() fills in what came before the table existed.
 */
import { MessageType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { newJoins, countFrom, TOLERANCE_MS } from '../utils/join-history-logic.js';

/** Note an arrival. Idempotent: two bots in one server, or a replayed event, write one row. */
export async function recordJoin(member) {
    await pool.execute(
        "INSERT IGNORE INTO member_join_history (guild_id, user_id, joined_at, source) VALUES (?, ?, ?, 'live')",
        [member.guild.id, member.id, member.joinedAt || new Date()]);
}

/** "Count from here", by staff or by an unban. */
export async function addReset(guildId, userId, reason, resetBy = null) {
    await pool.execute(
        'INSERT INTO join_rejoin_resets (guild_id, user_id, reason, reset_by) VALUES (?, ?, ?, ?)',
        [guildId, userId, reason, resetBy]);
}

export async function latestReset(guildId, userId) {
    const [[row]] = await pool.execute(
        `SELECT reset_at, reason, reset_by FROM join_rejoin_resets
          WHERE guild_id = ? AND user_id = ? ORDER BY reset_at DESC, id DESC LIMIT 1`, [guildId, userId]);
    return row || null;
}

/**
 * How many times a member has joined since counting began for them (the latest reset, approval or
 * window start). Includes the join being decided, which is recorded before the gate runs.
 */
export async function countJoins(guildId, userId, { windowDays = 0, approvedAt = null } = {}) {
    const reset = await latestReset(guildId, userId);
    const since = countFrom({ resetAt: reset?.reset_at, approvedAt, windowDays });
    const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM member_join_history WHERE guild_id = ? AND user_id = ?${since ? ' AND joined_at > ?' : ''}`,
        since ? [guildId, userId, since] : [guildId, userId]);
    return { count: Number(row.n) || 0, since, reset };
}

/** A member's joins, newest first, plus the total. */
export async function joinHistory(guildId, userId, limit = 25) {
    const n = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 25));
    const [rows] = await pool.query(
        `SELECT joined_at, source FROM member_join_history WHERE guild_id = ? AND user_id = ?
          ORDER BY joined_at DESC LIMIT ${n}`, [guildId, userId]);
    const [[total]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM member_join_history WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return { joins: rows, total: Number(total.n) || 0 };
}

const backfilling = new Set();

/** Is a backfill running for this server right now (dashboard shows "counting…")? */
export function isBackfilling(guildId) {
    return backfilling.has(guildId);
}

/**
 * Fill in joins from before this table existed, from three sources:
 *   - Discord's own "X joined" messages in the system channel: back to the server's first day if they
 *     were switched on (each one is authored by the member who joined)
 *   - audit_logs GUILD_MEMBER_JOIN and invite_tracker_logs joins: our own records, pruned at 365/180 days
 * Joins already known, and the same join reported by several sources, are counted once (TOLERANCE_MS).
 * Messages deleted from the system channel, or joins while those messages were switched off, cannot be
 * recovered; the summary says how far back the channel went.
 */
export async function backfillGuild(guild, { maxPages = 2000 } = {}) {
    const guildId = guild.id;
    if (backfilling.has(guildId)) return { alreadyRunning: true };
    backfilling.add(guildId);
    try {
        const found = new Map(); // userId -> [{ at, source }]
        const add = (userId, at, source) => {
            if (!userId || !at) return;
            if (!found.has(userId)) found.set(userId, []);
            found.get(userId).push({ at: new Date(at).getTime(), source });
        };

        const [audit] = await pool.query(
            "SELECT user_id, timestamp FROM audit_logs WHERE guild_id = ? AND event_type = 'GUILD_MEMBER_JOIN'", [guildId]);
        for (const r of audit) add(r.user_id, r.timestamp, 'audit_log');
        const [invites] = await pool.query(
            "SELECT user_id, timestamp FROM invite_tracker_logs WHERE guild_id = ? AND event_type = 'join'", [guildId]);
        for (const r of invites) add(r.user_id, r.timestamp, 'invite_log');

        let scanned = 0, systemJoins = 0, pages = 0, oldest = null, problem = null;
        const channel = guild.systemChannelId
            ? await guild.channels.fetch(guild.systemChannelId).catch(e => { problem = e.message; return null; })
            : null;
        if (!guild.systemChannelId) problem = 'the server has no system channel';
        if (channel?.messages) {
            let before;
            while (pages < maxPages) {
                const batch = await channel.messages.fetch({ limit: 100, cache: false, ...(before ? { before } : {}) })
                    .catch(e => { problem = e.message; return null; });
                if (!batch?.size) break;
                pages++;
                scanned += batch.size;
                for (const m of batch.values()) {
                    if (m.type === MessageType.UserJoin) { systemJoins++; add(m.author?.id, m.createdAt, 'system_message'); }
                }
                const last = batch.last();
                before = last.id;
                oldest = last.createdAt;
            }
            if (pages >= maxPages) problem = `stopped after ${scanned} messages; older ones were not read`;
        }

        const [existingRows] = await pool.query(
            'SELECT user_id, joined_at FROM member_join_history WHERE guild_id = ?', [guildId]);
        const existing = new Map();
        for (const r of existingRows) {
            if (!existing.has(r.user_id)) existing.set(r.user_id, []);
            existing.get(r.user_id).push(r.joined_at);
        }

        const rows = [];
        for (const [userId, list] of found) {
            for (const t of newJoins(existing.get(userId) || [], list.map(x => x.at))) {
                // Credit the join to its earliest source: Discord's own message when there is one.
                const source = list.filter(x => Math.abs(x.at - t) <= TOLERANCE_MS)
                    .sort((a, b) => a.at - b.at)[0]?.source || 'audit_log';
                rows.push([guildId, userId, new Date(t), source]);
            }
        }
        for (let i = 0; i < rows.length; i += 500) {
            await pool.query(
                'INSERT IGNORE INTO member_join_history (guild_id, user_id, joined_at, source) VALUES ?', [rows.slice(i, i + 500)]);
        }
        await pool.execute('UPDATE join_gate_config SET rejoin_backfilled_at = NOW() WHERE guild_id = ?', [guildId]);

        const summary = {
            added: rows.length, members: found.size, scanned, systemJoins,
            auditJoins: audit.length, inviteJoins: invites.length, oldest, problem,
        };
        logger.info(`[JoinHistory] backfilled ${guildId}: +${rows.length} joins for ${found.size} members `
            + `(system channel ${scanned} msgs back to ${oldest?.toISOString?.() || 'n/a'}, ${systemJoins} join messages; `
            + `audit ${audit.length}, invites ${invites.length})${problem ? ` — ${problem}` : ''}`);
        return summary;
    } finally {
        backfilling.delete(guildId);
    }
}

export default { recordJoin, addReset, latestReset, countJoins, joinHistory, backfillGuild, isBackfilling };
