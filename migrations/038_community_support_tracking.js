import pool from '../utils/db.js';

export async function up() {
  // Config table - per-guild settings for the support tracking system
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS community_support_config (
      guild_id VARCHAR(20) PRIMARY KEY,
      raid_channel_id VARCHAR(20),
      support_channel_id VARCHAR(20),
      shoutout_channel_id VARCHAR(20),
      affiliate_link_channel_id VARCHAR(20),
      non_affiliate_link_channel_id VARCHAR(20),
      raid_affiliate_points INT NOT NULL DEFAULT 5,
      raid_non_affiliate_points INT NOT NULL DEFAULT 10,
      support_points INT NOT NULL DEFAULT 3,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Individual tracking entries - each raid/support action
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS community_support_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      entry_type ENUM('raid', 'support') NOT NULL,
      target_username VARCHAR(100) NOT NULL,
      target_is_affiliate TINYINT(1) NOT NULL DEFAULT 0,
      points_awarded INT NOT NULL,
      message_id VARCHAR(20),
      channel_id VARCHAR(20),
      month_key VARCHAR(7) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_guild_month (guild_id, month_key),
      INDEX idx_user_month (guild_id, user_id, month_key),
      INDEX idx_message (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Monthly shoutout rotation - top supporters each month
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS community_support_shoutouts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      twitch_username VARCHAR(100),
      total_points INT NOT NULL,
      rank_position INT NOT NULL,
      month_key VARCHAR(7) NOT NULL,
      active_until DATE NOT NULL,
      streamer_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_guild_active (guild_id, active_until),
      INDEX idx_guild_month (guild_id, month_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Discord-to-Twitch username mapping cache
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS community_twitch_links (
      guild_id VARCHAR(20) NOT NULL,
      discord_user_id VARCHAR(20) NOT NULL,
      twitch_username VARCHAR(100) NOT NULL,
      is_affiliate TINYINT(1) NOT NULL DEFAULT 0,
      last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, discord_user_id),
      INDEX idx_twitch (twitch_username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('[Migration 038] Community support tracking tables created');
}

export async function down() {
  await pool.execute('DROP TABLE IF EXISTS community_twitch_links');
  await pool.execute('DROP TABLE IF EXISTS community_support_shoutouts');
  await pool.execute('DROP TABLE IF EXISTS community_support_entries');
  await pool.execute('DROP TABLE IF EXISTS community_support_config');
  console.log('[Migration 038] Community support tracking tables dropped');
}
