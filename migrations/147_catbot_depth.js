// Cat Bot depth: achievements, packs, and the counters they read.
async function hasColumn(db, table, column) {
  const [rows] = await db.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]);
  return rows.length > 0;
}

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_achievements (
      guild_id  VARCHAR(20) NOT NULL,
      user_id   VARCHAR(20) NOT NULL,
      ach_id    VARCHAR(40) NOT NULL,
      earned_at BIGINT NOT NULL,
      PRIMARY KEY (guild_id, user_id, ach_id),
      KEY idx_guild_ach (guild_id, ach_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS catbot_packs (
      guild_id  VARCHAR(20) NOT NULL,
      user_id   VARCHAR(20) NOT NULL,
      pack_type VARCHAR(16) NOT NULL,
      count     INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, pack_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Counters achievements read that aren't derivable from catbot_catches.
  for (const [col, ddl] of [
    ['packs_opened', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['boosted_catches', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['belated_catches', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  ]) {
    if (!await hasColumn(db, 'catbot_profiles', col)) {
      await db.execute(`ALTER TABLE catbot_profiles ADD COLUMN ${col} ${ddl}`);
    }
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS catbot_achievements');
  await db.execute('DROP TABLE IF EXISTS catbot_packs');
  for (const col of ['packs_opened', 'boosted_catches', 'belated_catches']) {
    if (await hasColumn(db, 'catbot_profiles', col)) {
      await db.execute(`ALTER TABLE catbot_profiles DROP COLUMN ${col}`);
    }
  }
}
