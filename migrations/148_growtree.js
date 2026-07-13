// Grow a Tree — one tree per guild, global per-user levels.
export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gat_trees (
      guild_id        VARCHAR(20) PRIMARY KEY,
      name            VARCHAR(36) NOT NULL,
      size            INT UNSIGNED NOT NULL DEFAULT 0,
      pieces          JSON NOT NULL,
      background      VARCHAR(16) NOT NULL DEFAULT 'Ground',
      last_watered_by VARCHAR(20) DEFAULT NULL,
      last_watered_at BIGINT NOT NULL DEFAULT 0,
      planted_by      VARCHAR(20) NOT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_size (size DESC, guild_id ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS gat_contributors (
      guild_id VARCHAR(20) NOT NULL,
      user_id  VARCHAR(20) NOT NULL,
      count    INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id),
      KEY idx_guild_count (guild_id, count DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Levels are GLOBAL across every server, matching upstream.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gat_players (
      user_id   VARCHAR(20) PRIMARY KEY,
      level     INT UNSIGNED NOT NULL DEFAULT 1,
      xp        INT UNSIGNED NOT NULL DEFAULT 0,
      notify_xp TINYINT(1) NOT NULL DEFAULT 0,
      waters    INT UNSIGNED NOT NULL DEFAULT 0,
      KEY idx_level (level DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function down(db) {
  for (const t of ['gat_contributors', 'gat_players', 'gat_trees']) {
    await db.execute(`DROP TABLE IF EXISTS ${t}`);
  }
}
