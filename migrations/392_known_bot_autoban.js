/**
 * Wave 392 — optional ban-on-sight for accounts on CommanderRoot's known-bot list (off by default),
 * and the per-channel ledger of what it did. 'exempt' rows are accounts staff unbanned: they are
 * never auto-banned again, so the ledger has no retention policy.
 */
export async function up(pool) {
    await pool.query(`
        ALTER TABLE twitch_analytics_alerts_config
            ADD COLUMN IF NOT EXISTS known_bot_autoban_enabled TINYINT(1) NOT NULL DEFAULT 0`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_known_bot_bans (
            broadcaster_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            login VARCHAR(25) NULL,
            status ENUM('banned', 'failed', 'exempt') NOT NULL,
            attempts INT NOT NULL DEFAULT 1,
            error VARCHAR(255) NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY (broadcaster_id, user_id),
            KEY idx_bid_updated (broadcaster_id, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS twitch_known_bot_bans');
    await pool.query('ALTER TABLE twitch_analytics_alerts_config DROP COLUMN IF EXISTS known_bot_autoban_enabled');
}
