/**
 * Data for the dashboard's Modmail page (views/partials/manage/modmail.ejs).
 *
 * Wired as LOADERS.modmail in dashboard/services/manage-sections.js, so it runs only when
 * ?page=modmail is viewed. Returns the keys the partial reads:
 *   modmailConfig, modmailStats, modmailThreads (open), modmailHistory (closed), modmailBlockedUsers
 * Names come from the guild caches only — no API calls while rendering.
 */
import pool from '../../utils/db.js';
import { humanDuration } from '../../core/modmail-format.js';

async function rows(sql, params) {
    const [r] = await pool.execute(sql, params);
    return r;
}

function nameOf(guild, id) {
    if (!id) return null;
    const member = guild?.members?.cache?.get(String(id));
    if (member) return member.user?.tag || member.displayName || null;
    const user = guild?.client?.users?.cache?.get(String(id));
    return user ? user.tag : null;
}

export async function loadModmailSection(guildId, guild) {
    const [config, open, history, blocked, totals, firstResponse] = await Promise.all([
        rows(`SELECT guild_id, enabled, category_id, log_channel_id, staff_role_id, greeting_message,
                     close_message, anonymous_replies
                FROM modmail_config WHERE guild_id = ?`, [guildId]),
        rows(`SELECT t.id, t.user_id, t.channel_id, t.status, t.created_at, t.last_activity_at,
                     (SELECT COUNT(*) FROM modmail_messages m
                       WHERE m.thread_id = t.id AND m.author_type <> 'system') AS message_count
                FROM modmail_threads t
               WHERE t.guild_id = ? AND t.status = 'open'
               ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC
               LIMIT 100`, [guildId]),
        rows(`SELECT t.id, t.user_id, t.created_at, t.closed_at, t.closed_by, t.close_reason,
                     TIMESTAMPDIFF(SECOND, t.created_at, t.closed_at) AS duration_seconds,
                     (SELECT COUNT(*) FROM modmail_messages m
                       WHERE m.thread_id = t.id AND m.author_type <> 'system') AS message_count
                FROM modmail_threads t
               WHERE t.guild_id = ? AND t.status = 'closed'
               ORDER BY t.closed_at DESC
               LIMIT 50`, [guildId]),
        rows(`SELECT id, user_id, reason, blocked_by, blocked_at
                FROM modmail_blocked_users WHERE guild_id = ? ORDER BY blocked_at DESC`, [guildId]),
        rows(`SELECT COUNT(*) AS total_threads,
                     COALESCE(SUM(status = 'open'), 0) AS active_threads,
                     AVG(CASE WHEN status = 'closed' THEN TIMESTAMPDIFF(SECOND, created_at, closed_at) END) AS avg_resolution
                FROM modmail_threads WHERE guild_id = ?`, [guildId]),
        // Time from a thread opening to the first staff reply the member actually received.
        rows(`SELECT AVG(TIMESTAMPDIFF(SECOND, t.created_at, fr.first_reply)) AS avg_first_response
                FROM modmail_threads t
                JOIN (SELECT m.thread_id, MIN(m.timestamp) AS first_reply
                        FROM modmail_messages m
                        JOIN modmail_threads tt ON tt.id = m.thread_id AND tt.guild_id = ?
                       WHERE m.author_type = 'staff' AND m.is_internal = 0
                       GROUP BY m.thread_id) fr ON fr.thread_id = t.id
               WHERE t.guild_id = ?`, [guildId, guildId]),
    ]);

    const stats = totals[0] || {};
    const avgResolution = stats.avg_resolution === null || stats.avg_resolution === undefined ? null : Number(stats.avg_resolution);
    const avgFirst = firstResponse[0]?.avg_first_response;

    return {
        modmailConfig: config[0] || {},
        modmailStats: {
            total_threads: Number(stats.total_threads) || 0,
            active_threads: Number(stats.active_threads) || 0,
            avg_response_time: avgFirst === null || avgFirst === undefined ? '—' : humanDuration(Number(avgFirst)),
            avg_resolution_time: avgResolution === null ? '—' : humanDuration(avgResolution),
        },
        modmailThreads: open.map(t => ({
            ...t,
            user_tag: nameOf(guild, t.user_id),
            last_activity: t.last_activity_at || t.created_at,
            message_count: Number(t.message_count) || 0,
            channel_exists: !!guild?.channels?.cache?.has(String(t.channel_id)),
        })),
        modmailHistory: history.map(t => ({
            ...t,
            user_tag: nameOf(guild, t.user_id),
            closed_by_tag: nameOf(guild, t.closed_by) || (t.closed_by ? t.closed_by : null),
            duration: t.duration_seconds === null ? null : humanDuration(Number(t.duration_seconds)),
            message_count: Number(t.message_count) || 0,
        })),
        modmailBlockedUsers: blocked.map(b => ({
            ...b,
            user_tag: nameOf(guild, b.user_id),
            blocked_by_tag: nameOf(guild, b.blocked_by) || b.blocked_by || null,
        })),
    };
}

export default { loadModmailSection };
