// Generic per-game patch-note watcher. Each row = one game in one guild.
// Provider tells the manager how to fetch news (callofduty.com blog scrape, fortnite-api.com, etc.)
// last_seen_id is used to dedupe across polls and is set when a row is created so the
// FIRST posted item is the NEXT-NEW one (not whatever's currently latest).
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS game_patch_watchers (
      id BIGINT(20) AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      role_ping_id VARCHAR(20) DEFAULT NULL,
      provider ENUM('cod-blog','fortnite-api') NOT NULL,
      game_label VARCHAR(80) NOT NULL,
      provider_config JSON DEFAULT NULL,
      last_seen_ids JSON DEFAULT NULL,
      check_interval_minutes INT DEFAULT 15,
      is_enabled TINYINT(1) DEFAULT 1,
      last_checked_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_watcher (guild_id, channel_id, provider, game_label),
      KEY idx_provider_enabled (provider, is_enabled),
      KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS game_patch_watchers');
}
