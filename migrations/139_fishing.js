/**
 * Migration 139: Fishing minigame (VirtualFisher-style).
 *   fishing_players    — one global row per user (coins, gear, location, stats, quest).
 *   fishing_inventory  — per-user / per-species caught counts + biggest catch.
 * GLOBAL (no guild_id): a player's fish/coins/gear follow them across every server,
 * exactly like VirtualFisher. Idempotent (whitelist table-existence checks).
 */
async function tableExists(db, table) {
  const allowed = new Set(['fishing_players', 'fishing_inventory']);
  if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await tableExists(db, 'fishing_players'))) {
    await db.execute(`
      CREATE TABLE fishing_players (
        user_id         VARCHAR(20) NOT NULL,
        coins           BIGINT NOT NULL DEFAULT 0,
        lifetime_earned BIGINT NOT NULL DEFAULT 0,
        total_catches   BIGINT NOT NULL DEFAULT 0,
        current_rod     VARCHAR(32) NOT NULL DEFAULT 'wooden',
        owned_rods      JSON NULL,
        current_bait    VARCHAR(32) NULL,
        bait_uses       INT NOT NULL DEFAULT 0,
        current_location VARCHAR(32) NOT NULL DEFAULT 'pond',
        owned_locations JSON NULL,
        biggest_key     VARCHAR(64) NULL,
        biggest_weight  DECIMAL(12,3) NOT NULL DEFAULT 0,
        daily_streak    INT NOT NULL DEFAULT 0,
        last_daily      DATE NULL,
        quest_json      JSON NULL,
        quest_date      DATE NULL,
        last_cast_at    BIGINT NOT NULL DEFAULT 0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id),
        INDEX idx_coins (coins),
        INDEX idx_catches (total_catches)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  if (!(await tableExists(db, 'fishing_inventory'))) {
    await db.execute(`
      CREATE TABLE fishing_inventory (
        user_id        VARCHAR(20) NOT NULL,
        fish_key       VARCHAR(64) NOT NULL,
        quantity       INT NOT NULL DEFAULT 0,
        biggest_weight DECIMAL(12,3) NOT NULL DEFAULT 0,
        first_caught   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, fish_key),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS fishing_inventory');
  await db.execute('DROP TABLE IF EXISTS fishing_players');
}
