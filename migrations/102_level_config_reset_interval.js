/**
 * Migration 102: Per-guild XP/level reset interval.
 *
 * Adds two columns to `level_config`:
 *   - `reset_interval_days INT UNSIGNED NOT NULL DEFAULT 30`
 *     How often XP/levels reset, in days. Read by
 *     `jobs/leveling-monthly-reset.js`.
 *   - `last_reset_at TIMESTAMP NULL DEFAULT NULL`
 *     Timestamp of the last successful reset for this guild. NULL is
 *     treated as "due" by the job.
 *
 * The job's cron schedule shifts from `'5 0 1 * *'` (monthly) to
 * `'5 0 * * *'` (daily check at 00:05 UTC) and gates per-guild on
 * `TIMESTAMPDIFF(DAY, last_reset_at, NOW()) >= reset_interval_days`.
 *
 * Default of 30 days preserves the previous monthly cadence for any
 * guild that already had `monthly_reset_enabled = 1`.
 *
 * Idempotent.
 */

async function hasColumn(db, table, column) {
    const allowedTables = new Set(['level_config']);
    const allowedColumns = new Set(['reset_interval_days', 'last_reset_at']);
    if (!allowedTables.has(table) || !allowedColumns.has(column)) {
        throw new Error(`Refusing to inspect unknown table/column: ${table}/${column}`);
    }
    const [cols] = await db.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'level_config', 'reset_interval_days'))) {
        await db.execute(`
            ALTER TABLE level_config
            ADD COLUMN reset_interval_days INT UNSIGNED NOT NULL DEFAULT 30
            COMMENT 'How often XP/levels reset, in days. Read by jobs/leveling-monthly-reset.js'
        `);
        console.log('[Migration 102] Added level_config.reset_interval_days');
    }

    if (!(await hasColumn(db, 'level_config', 'last_reset_at'))) {
        await db.execute(`
            ALTER TABLE level_config
            ADD COLUMN last_reset_at TIMESTAMP NULL DEFAULT NULL
            COMMENT 'Timestamp of the last successful reset for this guild; NULL means due on next run'
        `);
        console.log('[Migration 102] Added level_config.last_reset_at');
    }

    console.log('[Migration 102] level_config reset interval columns ready');
}

export async function down(db) {
    if (await hasColumn(db, 'level_config', 'last_reset_at')) {
        await db.execute(`ALTER TABLE level_config DROP COLUMN last_reset_at`);
    }
    if (await hasColumn(db, 'level_config', 'reset_interval_days')) {
        await db.execute(`ALTER TABLE level_config DROP COLUMN reset_interval_days`);
    }
    console.log('[Migration 102] Rolled back - removed reset_interval_days + last_reset_at');
}
