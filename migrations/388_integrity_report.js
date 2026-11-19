/**
 * Wave 388 — channel integrity report. Caches Twitch account creation dates (Helix /users,
 * app token) so the report can measure bulk-created account clusters without re-fetching,
 * and gives twitch_chatters_snapshots a retention rule (it had none).
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_account_cache (
            login VARCHAR(64) NOT NULL PRIMARY KEY,
            user_id VARCHAR(64) NULL,
            created_at_twitch DATETIME NULL,
            exists_on_twitch TINYINT(1) NOT NULL DEFAULT 1,
            fetched_at DATETIME NOT NULL,
            KEY idx_fetched (fetched_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('twitch_chatters_snapshots', 'recorded_at', 90, 1, 'Per-minute chatter lists; integrity report cohorts.'),
            ('twitch_account_cache', 'fetched_at', 120, 1, 'Twitch account creation dates for integrity reports.')`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS twitch_account_cache');
    await pool.query(`DELETE FROM data_retention_policy WHERE table_name IN ('twitch_chatters_snapshots', 'twitch_account_cache')`);
}
