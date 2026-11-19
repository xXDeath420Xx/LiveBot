/*
 * Migration 282: retry bookkeeping for temporary bans and temporary roles.
 *
 * `timed_moderation` (temporary bans, action_type 'ban') and `temp_roles` already existed but
 * nothing wrote them. `/admin mod ban duration:` and `/admin mod temprole` now do, and
 * jobs/timed-moderation-job.js undoes them when they come due. An expiry can fail for reasons that
 * fix themselves (Discord outage, a permission restored later), so the job retries with backoff
 * and gives up — loudly, in the mod log — after a fixed number of attempts:
 *
 *   timed_moderation.executed_at     TIMESTAMP NULL   when the row was closed (lifted/cancelled/replaced)
 *   timed_moderation.attempts        INT NOT NULL DEFAULT 0
 *   timed_moderation.last_attempt_at TIMESTAMP NULL
 *   timed_moderation.last_error      VARCHAR(255) NULL  also holds the outcome note ("already unbanned" …)
 *   temp_roles.attempts              INT NOT NULL DEFAULT 0
 *   temp_roles.last_attempt_at       TIMESTAMP NULL
 *   temp_roles.last_error            VARCHAR(255) NULL
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['timed_moderation', 'executed_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['timed_moderation', 'attempts', 'INT NOT NULL DEFAULT 0'],
    ['timed_moderation', 'last_attempt_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['timed_moderation', 'last_error', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['temp_roles', 'attempts', 'INT NOT NULL DEFAULT 0'],
    ['temp_roles', 'last_attempt_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ['temp_roles', 'last_error', 'VARCHAR(255) NULL DEFAULT NULL'],
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
