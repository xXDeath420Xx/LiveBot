/**
 * Wave 389 — monthly integrity snapshots DM'd to the bot owner. One ledger row per
 * (broadcaster, 30-day period) so a period is sent at most once.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_integrity_snapshots_sent (
            broadcaster_id VARCHAR(64) NOT NULL,
            period_n INT NOT NULL,
            guild_id VARCHAR(32) NOT NULL,
            due_at DATETIME NOT NULL,
            attempts TINYINT NOT NULL DEFAULT 0,
            sent_at DATETIME NULL,
            last_error VARCHAR(500) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (broadcaster_id, period_n),
            KEY idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('twitch_integrity_snapshots_sent', 'created_at', 400, 1, 'Ledger of monthly integrity snapshot DMs.')`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS twitch_integrity_snapshots_sent');
    await pool.query(`DELETE FROM data_retention_policy WHERE table_name = 'twitch_integrity_snapshots_sent'`);
}
