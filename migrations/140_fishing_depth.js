/**
 * Migration 140: Fishing depth update — collection, progression, social, events.
 *   fishing_records            — PERMANENT bestiary (survives selling): per-species count + best weight.
 *   fishing_guild_stats        — per-guild tally for server-scoped leaderboards.
 *   fishing_tournaments        — timed per-guild contests (biggest catch / most catches).
 *   fishing_tournament_entries — a player's running score in an active tournament.
 *   + new fishing_players columns: xp, level, locked_keys, pets, autofisher, shiny_caught.
 * Idempotent (whitelisted table + column existence checks).
 */
async function tableExists(db, table) {
  const allowed = new Set(['fishing_players', 'fishing_records', 'fishing_guild_stats', 'fishing_tournaments', 'fishing_tournament_entries']);
  if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
  );
  return rows[0].n > 0;
}
async function columnExists(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0].n > 0;
}
async function addCol(db, table, column, ddl) {
  if (!(await columnExists(db, table, column))) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export async function up(db) {
  // ── New columns on fishing_players ──
  await addCol(db, 'fishing_players', 'xp', 'xp BIGINT NOT NULL DEFAULT 0');
  await addCol(db, 'fishing_players', 'level', 'level INT NOT NULL DEFAULT 1');
  await addCol(db, 'fishing_players', 'locked_keys', 'locked_keys JSON NULL');
  await addCol(db, 'fishing_players', 'current_pet', 'current_pet VARCHAR(32) NULL');
  await addCol(db, 'fishing_players', 'owned_pets', 'owned_pets JSON NULL');
  await addCol(db, 'fishing_players', 'autofisher_level', 'autofisher_level INT NOT NULL DEFAULT 0');
  await addCol(db, 'fishing_players', 'autofisher_claimed_at', 'autofisher_claimed_at BIGINT NOT NULL DEFAULT 0');
  await addCol(db, 'fishing_players', 'shiny_caught', 'shiny_caught INT NOT NULL DEFAULT 0');

  // ── Permanent bestiary records (NOT cleared on sell) ──
  if (!(await tableExists(db, 'fishing_records'))) {
    await db.execute(`
      CREATE TABLE fishing_records (
        user_id      VARCHAR(20) NOT NULL,
        fish_key     VARCHAR(72) NOT NULL,
        times_caught BIGINT NOT NULL DEFAULT 0,
        best_weight  DECIMAL(12,3) NOT NULL DEFAULT 0,
        first_caught TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_caught  TIMESTAMP NULL,
        PRIMARY KEY (user_id, fish_key),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // ── Per-guild tally for server-scoped leaderboards ──
  if (!(await tableExists(db, 'fishing_guild_stats'))) {
    await db.execute(`
      CREATE TABLE fishing_guild_stats (
        guild_id VARCHAR(20) NOT NULL,
        user_id  VARCHAR(20) NOT NULL,
        catches  BIGINT NOT NULL DEFAULT 0,
        earned   BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id),
        INDEX idx_guild_catches (guild_id, catches),
        INDEX idx_guild_earned (guild_id, earned)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // ── Tournaments ──
  if (!(await tableExists(db, 'fishing_tournaments'))) {
    await db.execute(`
      CREATE TABLE fishing_tournaments (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        guild_id   VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        type       ENUM('biggest','most') NOT NULL DEFAULT 'biggest',
        prize      BIGINT NOT NULL DEFAULT 0,
        status     ENUM('active','ended') NOT NULL DEFAULT 'active',
        started_by VARCHAR(20) NULL,
        winner_id  VARCHAR(20) NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ends_at    DATETIME NOT NULL,
        INDEX idx_active (status, ends_at),
        INDEX idx_guild (guild_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  if (!(await tableExists(db, 'fishing_tournament_entries'))) {
    await db.execute(`
      CREATE TABLE fishing_tournament_entries (
        tournament_id INT NOT NULL,
        user_id       VARCHAR(20) NOT NULL,
        score         DECIMAL(16,3) NOT NULL DEFAULT 0,
        catches       INT NOT NULL DEFAULT 0,
        best_key      VARCHAR(72) NULL,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (tournament_id, user_id),
        INDEX idx_tourn_score (tournament_id, score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS fishing_tournament_entries');
  await db.execute('DROP TABLE IF EXISTS fishing_tournaments');
  await db.execute('DROP TABLE IF EXISTS fishing_guild_stats');
  await db.execute('DROP TABLE IF EXISTS fishing_records');
  for (const c of ['xp', 'level', 'locked_keys', 'current_pet', 'owned_pets', 'autofisher_level', 'autofisher_claimed_at', 'shiny_caught']) {
    await db.execute(`ALTER TABLE fishing_players DROP COLUMN ${c}`).catch(() => {});
  }
}
