/**
 * Wave 390 — cached per-account results from CommanderRoot's known-bot list (integrity indicator D).
 * Rows are rechecked after 7 days; the sweeper drops anything not touched in 120 days.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_known_bot_checks (
            user_id VARCHAR(20) NOT NULL PRIMARY KEY,
            listed TINYINT(1) NOT NULL,
            checked_at DATETIME NOT NULL,
            KEY idx_checked (checked_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('twitch_known_bot_checks', 'checked_at', 120, 1, 'CommanderRoot known-bot list lookups (integrity indicator D).')`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS twitch_known_bot_checks');
    await pool.query(`DELETE FROM data_retention_policy WHERE table_name = 'twitch_known_bot_checks'`);
}
