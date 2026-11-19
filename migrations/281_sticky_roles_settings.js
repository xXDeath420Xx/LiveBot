/*
 * Migration 281: sticky roles (core/sticky-roles-manager.js).
 *
 * `guilds.sticky_roles_enabled` and the `role_persistence` table already existed (and the flag is
 * already on in a few guilds) but nothing read or wrote either. The feature needs:
 *
 *   guilds.sticky_roles_retention_days  INT NULL DEFAULT 30
 *       How long a departed member's roles are remembered. NULL (a cleared dashboard field) means
 *       the default, 30 days; the code clamps to 1–365.
 *   guilds.sticky_roles_exclude         LONGTEXT NULL
 *       JSON array of role ids never saved or restored (e.g. a "new member" role, staff roles).
 *   role_persistence.left_at            TIMESTAMP NULL
 *       When the member left. NULL = a snapshot of a current member (kept by guildMemberUpdate, used
 *       when a departing member was not in discord.js's cache). Retention is measured from here —
 *       last_updated has ON UPDATE CURRENT_TIMESTAMP and would reset on any edit.
 *
 * role_persistence already has UNIQUE (guild_id, user_id), which the upserts rely on.
 * Expiry runs hourly in jobs/timed-moderation-job.js (per-guild retention, so it cannot be a single
 * data_retention_policy row).
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['guilds', 'sticky_roles_retention_days', 'INT NULL DEFAULT 30'],
    ['guilds', 'sticky_roles_exclude', 'LONGTEXT NULL DEFAULT NULL'],
    ['role_persistence', 'left_at', 'TIMESTAMP NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }
}

export async function down(db) {
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
