/**
 * Migration 467: Discord Activities (docs/activities.md).
 *
 *   cinema_config.watch_mode           'stream' (the old Go Live stream, the default until the switch-over) or
 *                                      'activity' (Watch Together, the Discord Activity)
 *   cinema_config.jellyfin_library_id  the Jellyfin library the server may watch from; NULL = every video library
 *   activity_watch_sessions            Watch Together sessions (core/activities/watch/store.js): kept so a restart
 *                                      does not end a film; user_id is the host
 *   data_retention_policy              activity_watch_sessions rows go 30 days after their last change
 *
 * Idempotent and guarded: a missing table or an existing column is skipped, never an error.
 */
const TABLES = new Set(['cinema_config', 'activity_watch_sessions', 'data_retention_policy']);

async function tableExists(db, table) {
    if (!TABLES.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table]);
    return Number(rows[0].n) > 0;
}

async function columnExists(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
    return Number(rows[0].n) > 0;
}

export const RETENTION_ROWS = Object.freeze([
    { table: 'activity_watch_sessions', column: 'updated_at', days: 30, notes: 'Watch Together sessions (migration 467): 30 days after the last change' },
]);

export async function up(db) {
    if (await tableExists(db, 'cinema_config')) {
        if (!(await columnExists(db, 'cinema_config', 'watch_mode'))) {
            await db.execute("ALTER TABLE cinema_config ADD COLUMN watch_mode VARCHAR(16) NOT NULL DEFAULT 'stream' AFTER default_vc_id");
        }
        if (!(await columnExists(db, 'cinema_config', 'jellyfin_library_id'))) {
            await db.execute('ALTER TABLE cinema_config ADD COLUMN jellyfin_library_id VARCHAR(64) NULL AFTER watch_mode');
        }
    }
    if (!(await tableExists(db, 'activity_watch_sessions'))) {
        await db.execute(`
            CREATE TABLE activity_watch_sessions (
                id          VARCHAR(32)  NOT NULL,
                instance_id VARCHAR(100) NOT NULL,
                guild_id    VARCHAR(20)  NOT NULL DEFAULT '',
                channel_id  VARCHAR(20)  NOT NULL DEFAULT '',
                user_id     VARCHAR(20)  NOT NULL,
                item_id     VARCHAR(64)  NULL,
                item_name   VARCHAR(255) NULL,
                state_json  MEDIUMTEXT   NULL,
                created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                ended_at    TIMESTAMP    NULL,
                end_reason  VARCHAR(32)  NULL,
                PRIMARY KEY (id),
                KEY idx_aws_instance (instance_id),
                KEY idx_aws_user (user_id),
                KEY idx_aws_active (ended_at, updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
    if (await tableExists(db, 'data_retention_policy')) {
        for (const r of RETENTION_ROWS) {
            await db.execute(
                `INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)
                 ON DUPLICATE KEY UPDATE timestamp_column = VALUES(timestamp_column), retain_days = VALUES(retain_days), notes = VALUES(notes)`,
                [r.table, r.column, r.days, r.notes]);
        }
    }
}

export async function down(db) {
    if (await tableExists(db, 'data_retention_policy')) {
        await db.execute("DELETE FROM data_retention_policy WHERE table_name = 'activity_watch_sessions'");
    }
    await db.execute('DROP TABLE IF EXISTS activity_watch_sessions');
    if (await tableExists(db, 'cinema_config')) {
        if (await columnExists(db, 'cinema_config', 'jellyfin_library_id')) await db.execute('ALTER TABLE cinema_config DROP COLUMN jellyfin_library_id');
        if (await columnExists(db, 'cinema_config', 'watch_mode')) await db.execute('ALTER TABLE cinema_config DROP COLUMN watch_mode');
    }
}

export default { up, down };
