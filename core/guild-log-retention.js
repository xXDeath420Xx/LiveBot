/*
 * Per-guild log retention — the rules, kept free of DB/Discord imports so they are unit-tested.
 *
 * Two layers decide how long a server's logs live:
 *
 *   data_retention_policy  bot-wide, per table (message_logs 90d, audit_logs 365d …) — the CAP.
 *                          Enforced nightly by jobs/retention-sweeper.js for every row.
 *   log_retention_policy   per guild, optional, SHORTER only. A server sets it on the dashboard
 *                          ("Log retention" card). One row per guild with event_type = 'guild'
 *                          (migration 288) holding message_logs_days / audit_logs_days.
 *
 * A guild can never keep data longer than the cap: a value at or above the cap is simply ignored
 * (the bot-wide sweep already deletes sooner), and blank means "use the bot-wide window".
 */

export const GUILD_RETENTION_EVENT_TYPE = 'guild';
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

/**
 * What a guild can shorten. `field` is the log_retention_policy column, `table`/`column` the
 * rows it deletes (both tables carry guild_id). message_logs rows take their
 * message_attachments with them (ON DELETE CASCADE).
 */
export const RETENTION_CATEGORIES = Object.freeze({
    messages: Object.freeze({ field: 'message_logs_days', table: 'message_logs', column: 'timestamp', label: 'Message logs (deleted/edited message cache)' }),
    audit: Object.freeze({ field: 'audit_logs_days', table: 'audit_logs', column: 'timestamp', label: 'Moderation & audit logs' }),
});

/**
 * The window a guild override actually applies, or null when it changes nothing.
 * @param {number|null} guildDays   the guild's setting (null/0/blank = unset)
 * @param {number|null} globalDays  the bot-wide retain_days for that table, null if no enabled policy
 */
export function effectiveRetentionDays(guildDays, globalDays) {
    if (guildDays === null || guildDays === undefined || guildDays === '') return null;
    const g = Number(guildDays);
    if (!Number.isFinite(g) || g < MIN_RETENTION_DAYS) return null;
    const days = Math.min(Math.floor(g), MAX_RETENTION_DAYS);
    const cap = Number(globalDays);
    if (globalDays !== null && globalDays !== undefined && Number.isFinite(cap) && cap > 0 && days >= cap) return null;
    return days;
}

/**
 * Turn override rows into concrete sweeps.
 * @param {Array<{guild_id: string, message_logs_days?: number, audit_logs_days?: number}>} overrides
 * @param {Array<{table_name: string, retain_days: number}>} globalPolicies enabled data_retention_policy rows
 * @returns {Array<{guildId: string, category: string, table: string, column: string, days: number}>}
 */
export function planGuildSweeps(overrides, globalPolicies) {
    const caps = new Map((globalPolicies || []).map(p => [p.table_name, Number(p.retain_days)]));
    const plan = [];
    for (const row of overrides || []) {
        if (!row?.guild_id) continue;
        for (const [category, def] of Object.entries(RETENTION_CATEGORIES)) {
            const days = effectiveRetentionDays(row[def.field], caps.has(def.table) ? caps.get(def.table) : null);
            if (days !== null) {
                plan.push({ guildId: String(row.guild_id), category, table: def.table, column: def.column, days });
            }
        }
    }
    return plan;
}
