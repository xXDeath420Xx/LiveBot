// OwO "points" counter — saying owo/uwu anywhere earns a point (10s cooldown),
// mirroring upstream OwO's `points` command (user.count + guild.count).
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS owo_points_user (
      user_id    VARCHAR(20) PRIMARY KEY,
      count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
      last_at    BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS owo_points_guild (
      guild_id   VARCHAR(20) PRIMARY KEY,
      count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Per-guild-per-user, so a server leaderboard is possible.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS owo_points_member (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id),
      KEY idx_guild_count (guild_id, count DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS owo_points_member');
  await db.execute('DROP TABLE IF EXISTS owo_points_guild');
  await db.execute('DROP TABLE IF EXISTS owo_points_user');
}
