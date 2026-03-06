import pool from '../utils/db.js';

export async function up() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rank_card_settings (
      guild_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      background_type ENUM('gradient','solid','image','preset') NOT NULL DEFAULT 'gradient',
      background_value TEXT DEFAULT NULL,
      overlay_opacity FLOAT NOT NULL DEFAULT 0.6,
      progress_bar_color_start VARCHAR(7) NOT NULL DEFAULT '#667eea',
      progress_bar_color_end VARCHAR(7) NOT NULL DEFAULT '#764ba2',
      username_color VARCHAR(7) NOT NULL DEFAULT '#ffffff',
      xp_text_color VARCHAR(7) NOT NULL DEFAULT '#b9bbbe',
      level_color VARCHAR(7) NOT NULL DEFAULT '#ffffff',
      rank_color VARCHAR(7) NOT NULL DEFAULT '#ffd700',
      avatar_border_color VARCHAR(7) NOT NULL DEFAULT '#3498db',
      avatar_border_enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('[Migration 037] rank_card_settings table created');
}

export async function down() {
  await pool.execute('DROP TABLE IF EXISTS rank_card_settings');
  console.log('[Migration 037] rank_card_settings table dropped');
}
