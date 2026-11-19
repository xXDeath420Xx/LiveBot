/**
 * Migration 425 — a use counter for custom commands.
 *
 * custom_commands (core/custom-command-handler.js, partials/manage/custom-commands.ejs)
 *     use_count     INT UNSIGNED NOT NULL DEFAULT 0   +1 each time the command runs successfully
 *     last_used_at  TIMESTAMP NULL                    when it last ran
 *
 * The dashboard shows the count as the "Uses" column (Dyno and Carl-bot show the same) and can
 * sort by it. The handler's UPDATE is fire-and-forget, so before this runs it fails quietly.
 *
 * Idempotent: every step checks information_schema first.
 */

async function hasTable(db, table) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'custom_commands'))) return;
    if (!(await hasColumn(db, 'custom_commands', 'use_count'))) {
        await db.query('ALTER TABLE custom_commands ADD COLUMN use_count INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!(await hasColumn(db, 'custom_commands', 'last_used_at'))) {
        await db.query('ALTER TABLE custom_commands ADD COLUMN last_used_at TIMESTAMP NULL DEFAULT NULL');
    }
}

export async function down(db) {
    if (!(await hasTable(db, 'custom_commands'))) return;
    if (await hasColumn(db, 'custom_commands', 'last_used_at')) {
        await db.query('ALTER TABLE custom_commands DROP COLUMN last_used_at');
    }
    if (await hasColumn(db, 'custom_commands', 'use_count')) {
        await db.query('ALTER TABLE custom_commands DROP COLUMN use_count');
    }
}
