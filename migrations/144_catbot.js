// Cat Bot — clean-room. Cats spawn on a per-channel timer; first person to type
// "cat" catches it. See /LICENSE-CATBOT-NOTICE.md.
export async function up(db) {
  // One row per channel where spawning is enabled.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_channels (
      channel_id     VARCHAR(20) PRIMARY KEY,
      guild_id       VARCHAR(20) NOT NULL,
      enabled        TINYINT(1) NOT NULL DEFAULT 1,
      spawn_min      INT NOT NULL DEFAULT 60,
      spawn_max      INT NOT NULL DEFAULT 600,
      -- live spawn state; cat_message_id NULL = no cat currently out
      cat_message_id VARCHAR(20) DEFAULT NULL,
      cat_type       VARCHAR(16) DEFAULT NULL,
      spawned_at     BIGINT NOT NULL DEFAULT 0,
      yet_to_spawn   BIGINT NOT NULL DEFAULT 0,
      rain_left      INT NOT NULL DEFAULT 0,
      appear_msg     TEXT DEFAULT NULL,
      caught_msg     TEXT DEFAULT NULL,
      KEY idx_guild (guild_id),
      KEY idx_due (enabled, cat_message_id, yet_to_spawn)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Normalized catch counts: one row per (guild, user, type). Keeps the Value
  // leaderboard a plain aggregate instead of 22 columns.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_catches (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      cat_type VARCHAR(16) NOT NULL,
      count    INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, cat_type),
      KEY idx_guild_type (guild_id, cat_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Per-user scalar stats.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_profiles (
      guild_id      VARCHAR(20) NOT NULL,
      user_id       VARCHAR(20) NOT NULL,
      total_catches INT UNSIGNED NOT NULL DEFAULT 0,
      fastest_ms    INT UNSIGNED DEFAULT NULL,
      slowest_ms    INT UNSIGNED DEFAULT NULL,
      last_catch_at BIGINT NOT NULL DEFAULT 0,
      last_channel  VARCHAR(20) DEFAULT NULL,
      PRIMARY KEY (guild_id, user_id),
      KEY idx_guild_total (guild_id, total_catches DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_settings (
      guild_id                VARCHAR(20) PRIMARY KEY,
      only_setupped_channels  TINYINT(1) NOT NULL DEFAULT 0,
      do_reactions            TINYINT(1) NOT NULL DEFAULT 1,
      do_responses            TINYINT(1) NOT NULL DEFAULT 1,
      do_rain                 TINYINT(1) NOT NULL DEFAULT 1,
      mute_achievements       TINYINT(1) NOT NULL DEFAULT 0,
      auto_delete_catches     TINYINT(1) NOT NULL DEFAULT 0,
      anti_double_catch       TINYINT(1) NOT NULL DEFAULT 0,
      legacy_catching         TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Prestige: craft by spending one of every cat type.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_prisms (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      guild_id        VARCHAR(20) NOT NULL,
      creator_id      VARCHAR(20) NOT NULL,
      name            VARCHAR(64) NOT NULL,
      created_at      BIGINT NOT NULL,
      catches_boosted INT UNSIGNED NOT NULL DEFAULT 0,
      KEY idx_guild (guild_id),
      KEY idx_creator (guild_id, creator_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  for (const t of ['catbot_prisms', 'catbot_settings', 'catbot_profiles', 'catbot_catches', 'catbot_channels']) {
    await db.execute(`DROP TABLE IF EXISTS ${t}`);
  }
}
