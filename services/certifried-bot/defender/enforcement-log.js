/**
 * Append-only audit log of defender actions; powers dashboard counts.
 */
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export async function log({ channelId, targetUserId = null, targetUsername, action, reason = null, success = false }) {
    try {
        await pool.execute(
            `INSERT INTO kbd_enforcement_log (channel_id, target_user_id, target_username, action, reason, success)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [channelId, targetUserId, targetUsername, action, reason, success ? 1 : 0]
        );
    } catch (error) {
        // Audit logging must never break the chat pipeline — swallow + record.
        logger.error('[KBD] Failed to write enforcement log', { error: error.message });
    }
}

export async function channelStats(channelId) {
    // Three queries, dashboard-frequency; point-in-time consistency not required.
    const [[banned]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'ban' AND success = 1", [channelId]
    );
    const [[deleted]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'delete' AND success = 1", [channelId]
    );
    const [[dormant]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'detected_no_scope'", [channelId]
    );
    return { banned: Number(banned.n), deleted: Number(deleted.n), dormant: Number(dormant.n) };
}

export function makeListEvents({ pool }) {
    return async function listEvents({ channelId, action = null, limit = 50, offset = 0 }) {
        const where = ['channel_id = ?'];
        const params = [String(channelId)];
        // null / undefined / '' all mean "no action filter".
        if (action) { where.push('action = ?'); params.push(action); }
        const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const off = Math.max(parseInt(offset, 10) || 0, 0);
        params.push(lim, off);
        const [rows] = await pool.execute(
            `SELECT id, channel_id, target_user_id, target_username, action, reason, success, created_at
             FROM kbd_enforcement_log
             WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            params
        );
        return rows;
    };
}

// Real-wired singleton using the module's DB pool (same pool log()/channelStats() use).
export const listEvents = makeListEvents({ pool });

/**
 * Network-wide recent events across ALL channels (admin/manager dashboards),
 * joined to the channel name so the feed reads "channel · action · user".
 */
export function makeListAllEvents({ pool }) {
    return async function listAllEvents({ limit = 50 } = {}) {
        const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const [rows] = await pool.execute(
            `SELECT e.channel_id, e.target_username, e.action, e.reason, e.success, e.created_at,
                    c.channel_name
             FROM kbd_enforcement_log e
             LEFT JOIN tokes_channels c
               ON c.platform = 'kick' AND c.channel_id = e.channel_id
             ORDER BY e.created_at DESC
             LIMIT ?`,
            [lim]
        );
        return rows;
    };
}

export const listAllEvents = makeListAllEvents({ pool });

/**
 * Network-wide totals across all Kick channels (one query) for the main dashboard.
 */
export async function networkStats() {
    const [[r]] = await pool.execute(`
        SELECT
            SUM(action = 'ban'  AND success = 1) AS banned,
            SUM(action = 'delete' AND success = 1) AS deleted,
            SUM(action = 'detected_no_scope')     AS dormant,
            COUNT(*)                              AS total
        FROM kbd_enforcement_log
    `);
    return {
        banned: Number(r.banned || 0),
        deleted: Number(r.deleted || 0),
        dormant: Number(r.dormant || 0),
        total: Number(r.total || 0)
    };
}

/**
 * Densify a sparse list of {date:'YYYY-MM-DD', ...counts} rows into a continuous
 * day-by-day series ending today, back `days` days, with zero-filled gaps. Pure
 * (no DB) so it's unit-testable. `todayIso` lets tests pin "now".
 */
export function fillDailySeries(rows, days, todayIso) {
    const byDate = new Map(rows.map(r => [String(r.date), r]));
    const end = new Date(todayIso + 'T00:00:00Z');
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(end);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        const row = byDate.get(iso);
        out.push({
            date: iso,
            banned: Number(row?.banned || 0),
            deleted: Number(row?.deleted || 0),
            dormant: Number(row?.dormant || 0)
        });
    }
    return out;
}

/**
 * Daily activity counts for a time-series chart. Optionally scoped to one
 * channel (broadcaster channel_id). Returns a continuous zero-filled series.
 */
export function makeDailyActivity({ pool }) {
    return async function dailyActivity({ channelId = null, days = 14, todayIso } = {}) {
        const n = Math.min(Math.max(parseInt(days, 10) || 14, 1), 90);
        const params = [n - 1];
        let scope = '';
        if (channelId) { scope = 'AND channel_id = ?'; params.push(String(channelId)); }
        const [rows] = await pool.execute(
            `SELECT DATE(created_at) AS date,
                    SUM(action = 'ban'    AND success = 1) AS banned,
                    SUM(action = 'delete' AND success = 1) AS deleted,
                    SUM(action = 'detected_no_scope')      AS dormant
             FROM kbd_enforcement_log
             WHERE created_at >= (CURDATE() - INTERVAL ? DAY) ${scope}
             GROUP BY DATE(created_at)
             ORDER BY date ASC`,
            params
        );
        const today = todayIso || new Date().toISOString().slice(0, 10);
        // Normalize the DATE() value (may be a Date object) to YYYY-MM-DD.
        const norm = rows.map(r => ({
            date: (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10)),
            banned: r.banned, deleted: r.deleted, dormant: r.dormant
        }));
        return fillDailySeries(norm, n, today);
    };
}

export const dailyActivity = makeDailyActivity({ pool });
