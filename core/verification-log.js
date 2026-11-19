/*
 * Verification activity log — the live side (rules, filters, cursors and CSV are in
 * core/verification-log-logic.js). Read-only: it never writes anything.
 *
 *   readLog(guildId, params, { memberIds })   one page, newest first, of every event the Verification page's
 *              systems record — verification, auto-prune, inactivity prune ('failed' rows included) from
 *              join_gate_events, plus staff "Stop the clock" / "Remove from queue" actions from
 *              temp_access_members. params come from parseLogQuery(): type, range, q, before|since, limit.
 *              `memberIds` are cached members whose name matched q (the route resolves them; the stored
 *              username is searched here). With `since` it returns only rows newer than that cursor
 *              (newest MAX_SINCE, `truncated` when there were more) — what the page polls every 20 s.
 *   logCounts(guildId, params, { memberIds })  counts per filter chip under the same range + search.
 *
 * Both sources are read with LIMIT n + 1 and interleaved in memory, so a page costs two indexed queries
 * (join_gate_events idx_guild_time; temp_access_members idx_guild_kind_status) however long the history.
 */
import pool from '../utils/db.js';
import {
    cursorClause, eventTypeClause, manualKindsFor, rangeHours, searchClause, normaliseEvent, normaliseManual, mergePage,
    countsFrom, markAnsweredWarnings, LOG_EVENT_FILTER, MANUAL_FILTER, FAILED_KIND_SQL, MAX_SINCE, MAX_EXPORT,
} from './verification-log-logic.js';

const rangeSql = (col, hours) => (hours ? `${col} > NOW() - INTERVAL ${Math.floor(hours)} HOUR` : '1=1');

/** Events (join_gate_events) for one page. */
async function eventRows(guildId, p, ids, n) {
    const cur = p.since ? cursorClause('event', p.since, 'since', 'created_at', 'id') : cursorClause('event', p.before, 'before', 'created_at', 'id');
    const search = searchClause('event', p.q, ids);
    const [rows] = await pool.execute(
        `SELECT id, user_id, username, action, detail, dm_delivered, UNIX_TIMESTAMP(created_at) AS ts
           FROM join_gate_events
          WHERE guild_id = ? AND ${eventTypeClause(p.type)} AND ${rangeSql('created_at', rangeHours(p.range))}
            AND ${search.sql} AND ${cur.sql}
          ORDER BY created_at DESC, id DESC LIMIT ${n}`,
        [guildId, ...search.params, ...cur.params]);
    return rows.map(normaliseEvent);
}

/** Staff actions (closed temp_access_members rows) for one page. */
async function manualRows(guildId, p, ids, n) {
    const kinds = manualKindsFor(p.type);
    if (!kinds.length) return [];
    const search = searchClause('manual', p.q, ids);
    if (search.sql === '0=1') return [];
    const cur = p.since ? cursorClause('manual', p.since, 'since', 'resolved_at', 'id') : cursorClause('manual', p.before, 'before', 'resolved_at', 'id');
    const [rows] = await pool.execute(
        `SELECT id, user_id, kind, note, UNIX_TIMESTAMP(resolved_at) AS ts
           FROM temp_access_members
          WHERE guild_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) AND ${MANUAL_FILTER} AND resolved_at IS NOT NULL
            AND ${rangeSql('resolved_at', rangeHours(p.range))} AND ${search.sql} AND ${cur.sql}
          ORDER BY resolved_at DESC, id DESC LIMIT ${n}`,
        [guildId, ...kinds, ...search.params, ...cur.params]);
    return rows.map(normaliseManual);
}

/** Last activity (epoch s) for the members of warning rows, so answered warnings show as cancelled. */
async function answerWarnings(guildId, rows) {
    const ids = [...new Set(rows.filter(r => r.action === 'prune_inactive_warned').map(r => r.userId))];
    if (!ids.length) return;
    try {
        const [act] = await pool.query(
            `SELECT user_id, UNIX_TIMESTAMP(last_message_at) AS msg_sec, last_message_channel_id, last_message_id,
                    UNIX_TIMESTAMP(last_voice_at) AS voice_sec, last_voice_channel_id
               FROM member_activity WHERE guild_id = ? AND user_id IN (?)`, [String(guildId), ids]);
        markAnsweredWarnings(rows, new Map(act.map(a => [String(a.user_id), {
            msgSec: Number(a.msg_sec) || 0, msgChannelId: a.last_message_channel_id, messageId: a.last_message_id,
            voiceSec: Number(a.voice_sec) || 0, voiceChannelId: a.last_voice_channel_id,
        }])));
    } catch { /* the log still reads without it */ }
}

/**
 * One page of the log. Returns { rows, hasMore, nextCursor } — or, with params.since,
 * { rows, truncated, latestCursor }.
 */
export async function readLog(guildId, params, { memberIds = [], export: forExport = false } = {}) {
    const limit = forExport ? MAX_EXPORT : params.since ? MAX_SINCE : params.limit;
    const n = Math.max(1, Math.floor(limit)) + 1;
    const [events, manual] = await Promise.all([eventRows(guildId, params, memberIds, n), manualRows(guildId, params, memberIds, n)]);
    const page = mergePage([events, manual], limit);
    await answerWarnings(guildId, page.rows);
    if (params.since) return { rows: page.rows, truncated: page.hasMore, latestCursor: page.rows[0]?.cursor ?? null };
    return page;
}

/** Counts per filter chip under the request's range + search (type and cursor ignored). */
export async function logCounts(guildId, params, { memberIds = [] } = {}) {
    const hours = rangeHours(params.range);
    const es = searchClause('event', params.q, memberIds);
    const ms = searchClause('manual', params.q, memberIds);
    const [[events], [manual]] = await Promise.all([
        pool.execute(
            `SELECT action, ${FAILED_KIND_SQL} AS detail_kind, COUNT(*) AS n
               FROM join_gate_events
              WHERE guild_id = ? AND ${LOG_EVENT_FILTER} AND ${rangeSql('created_at', hours)} AND ${es.sql}
              GROUP BY action, detail_kind`,
            [guildId, ...es.params]),
        ms.sql === '0=1' ? [[]] : pool.execute(
            `SELECT kind, COUNT(*) AS n FROM temp_access_members
              WHERE guild_id = ? AND kind IN ('verify','prune') AND ${MANUAL_FILTER} AND resolved_at IS NOT NULL
                AND ${rangeSql('resolved_at', hours)} AND ${ms.sql}
              GROUP BY kind`,
            [guildId, ...ms.params]),
    ]);
    return countsFrom(events, manual);
}

export default { readLog, logCounts };
