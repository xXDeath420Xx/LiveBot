// Friend Time-style timezone conversion: per-user zones, per-guild auto-detect, zone board.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tz_users (
      user_id     VARCHAR(20) PRIMARY KEY,
      time_zone   VARCHAR(64) NOT NULL,
      time_format ENUM('12','24') NOT NULL DEFAULT '12',
      private_mode TINYINT(1) NOT NULL DEFAULT 0,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // No row for a guild = feature inert there (opt-in, so we never start reacting
  // to every message in 52 existing guilds without an admin asking for it).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tz_guild_config (
      guild_id    VARCHAR(20) PRIMARY KEY,
      enabled     TINYINT(1) NOT NULL DEFAULT 1,
      time_zone   VARCHAR(64) NULL,
      time_format ENUM('12','24') NOT NULL DEFAULT '12',
      auto_detect ENUM('react','list','off') NOT NULL DEFAULT 'react',
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Up to 10 zones shown in-channel when auto_detect = 'list'.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tz_guild_list (
      guild_id  VARCHAR(20) NOT NULL,
      time_zone VARCHAR(64) NOT NULL,
      position  INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, time_zone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS tz_guild_list');
  await db.execute('DROP TABLE IF EXISTS tz_guild_config');
  await db.execute('DROP TABLE IF EXISTS tz_users');
}
