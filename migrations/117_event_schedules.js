/**
 * Migration 117 — Self-service event schedules.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_config (
    guild_id VARCHAR(20) PRIMARY KEY,
    is_enabled TINYINT(1) NOT NULL DEFAULT 0,
    mode ENUM('combined','per_user') NOT NULL DEFAULT 'combined',
    channel_id VARCHAR(20) NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    title VARCHAR(100) NOT NULL DEFAULT 'Event Calendar',
    custom_message VARCHAR(500) NULL,
    force_refresh TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    guild_id VARCHAR(20) NOT NULL,
    name VARCHAR(60) NOT NULL,
    emoji VARCHAR(64) NULL,
    color VARCHAR(9) NOT NULL DEFAULT '#3498DB',
    sort_order INT NOT NULL DEFAULT 0,
    KEY idx_guild (guild_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    category_id INT NULL,
    title VARCHAR(120) NOT NULL,
    emoji VARCHAR(64) NULL,
    start_time DATETIME NULL,
    end_time DATETIME NULL,
    recurrence ENUM('none','weekly') NOT NULL DEFAULT 'none',
    recur_dow TINYINT NULL,
    recur_start_min SMALLINT NULL,
    recur_end_min SMALLINT NULL,
    source ENUM('manual','twitch') NOT NULL DEFAULT 'manual',
    source_ref VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_guild (guild_id),
    KEY idx_guild_user (guild_id, user_id),
    KEY idx_source_ref (guild_id, user_id, source_ref)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_posts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NULL,
    channel_id VARCHAR(20) NULL,
    last_message_id VARCHAR(20) NULL,
    schedule_hash VARCHAR(64) NULL,
    change_detected_at DATETIME NULL,
    last_synced DATETIME NULL,
    UNIQUE KEY uniq_post (guild_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS twitch_oauth_accounts (
    discord_user_id VARCHAR(20) PRIMARY KEY,
    twitch_user_id VARCHAR(32) NOT NULL,
    twitch_username VARCHAR(64) NOT NULL,
    access_token TEXT NULL,
    refresh_token TEXT NULL,
    expires_at DATETIME NULL,
    verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
  for (const t of ['event_schedule_posts','event_schedule_events','event_schedule_categories','event_schedule_config','twitch_oauth_accounts']) {
    await db.execute(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
  }
}

/** Default category set seeded when a guild first enables the feature. */
export const DEFAULT_CATEGORIES = [
  { name: 'Streams',     emoji: '🔴', color: '#9146FF', sort_order: 0 },
  { name: 'Tournaments', emoji: '🏆', color: '#F1C40F', sort_order: 1 },
  { name: 'Community',   emoji: '🎉', color: '#2ECC71', sort_order: 2 },
  { name: 'Other',       emoji: '📌', color: '#3498DB', sort_order: 3 },
];
