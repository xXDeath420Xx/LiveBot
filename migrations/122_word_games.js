/**
 * Migration 122: Word games framework.
 *   word_game_channels  — persistent per-channel bindings (one game per channel)
 *   word_game_sessions  — live/in-progress state for rehydration (chain/story/board/grid)
 *   word_game_stats     — per-player/per-guild/per-game counters for leaderboards
 * Idempotent (whitelist table-existence checks).
 */
async function tableExists(db, table) {
  const allowed = new Set(['word_game_channels', 'word_game_sessions', 'word_game_stats']);
  if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await tableExists(db, 'word_game_channels'))) {
    await db.execute(`
      CREATE TABLE word_game_channels (
        guild_id    VARCHAR(20) NOT NULL,
        channel_id  VARCHAR(20) NOT NULL,
        game_type   VARCHAR(32) NOT NULL,
        enabled     TINYINT(1) NOT NULL DEFAULT 1,
        config_json JSON NULL,
        created_by  VARCHAR(20) NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, channel_id),
        INDEX idx_guild (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  if (!(await tableExists(db, 'word_game_sessions'))) {
    await db.execute(`
      CREATE TABLE word_game_sessions (
        id           VARCHAR(36) NOT NULL,
        guild_id     VARCHAR(20) NOT NULL,
        channel_id   VARCHAR(20) NOT NULL,
        game_type    VARCHAR(32) NOT NULL,
        mode         ENUM('persistent','round') NOT NULL,
        status       ENUM('active','ended','abandoned') NOT NULL DEFAULT 'active',
        host_user_id VARCHAR(20) NULL,
        state_json   JSON NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        ended_at     TIMESTAMP NULL,
        PRIMARY KEY (id),
        INDEX idx_channel (channel_id),
        INDEX idx_active (guild_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  if (!(await tableExists(db, 'word_game_stats'))) {
    await db.execute(`
      CREATE TABLE word_game_stats (
        guild_id          VARCHAR(20) NOT NULL,
        user_id           VARCHAR(20) NOT NULL,
        game_type         VARCHAR(32) NOT NULL,
        games_played      INT NOT NULL DEFAULT 0,
        wins              INT NOT NULL DEFAULT 0,
        words_contributed INT NOT NULL DEFAULT 0,
        best_score        INT NOT NULL DEFAULT 0,
        current_streak    INT NOT NULL DEFAULT 0,
        best_streak       INT NOT NULL DEFAULT 0,
        updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id, game_type),
        INDEX idx_leaderboard (guild_id, game_type, best_score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS word_game_stats');
  await db.execute('DROP TABLE IF EXISTS word_game_sessions');
  await db.execute('DROP TABLE IF EXISTS word_game_channels');
}
