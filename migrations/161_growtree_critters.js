// Grow a Tree: the bits that make it a game rather than a button.
//
// The real Grow a Tree does three things we did not:
//   • insects land on the tree, and the first person to hit the bugnet gets its STICKER. You are
//     filling a sticker book.
//   • fruit falls, split across baskets, and you click the basket it is falling into for COINS.
//   • coins go into a community COMPOSTER, which makes the tree grow faster for everyone.
//
// Those are the whole loop: watering alone is a chore, and the encounters are the reason to be
// watching the channel. Kabster's server is losing a 193ft tree to start fresh with ours, so ours
// had better be the better tree.
//
// The race is the point of the mechanic, so it has to be a REAL race: `caught_by` is claimed with a
// single conditional UPDATE, and exactly one clicker can win. Anything softer — read-then-write, or
// trusting the interaction to arrive in order — hands the sticker to whoever Discord happened to
// deliver last.

export async function up(db) {
  // A live encounter. One at a time per guild, enforced by the unique key on (guild_id, active).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gat_encounters (
      id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id     VARCHAR(20)  NOT NULL,
      kind         ENUM('bug','fruit') NOT NULL,
      code         VARCHAR(32)  NOT NULL,   -- which bug, or which fruit
      answer       TINYINT          NULL,   -- fruit only: which basket it is falling into
      channel_id   VARCHAR(20)  NOT NULL,
      message_id   VARCHAR(20)      NULL,
      caught_by    VARCHAR(20)      NULL,   -- NULL until someone wins it
      caught_at    TIMESTAMP        NULL,
      expires_at   TIMESTAMP    NOT NULL,
      spawned_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_live (guild_id, caught_by, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // The sticker book. One row per bug per player — `count` is how many of that bug they have caught,
  // but owning ONE is what fills the book. Global, not per-guild: a sticker book you lose by moving
  // servers is not a collection.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gat_stickers (
      user_id     VARCHAR(20) NOT NULL,
      code        VARCHAR(32) NOT NULL,
      count       INT UNSIGNED NOT NULL DEFAULT 1,
      first_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  if (!(await hasColumn(db, 'gat_players', 'coins'))) {
    await db.execute('ALTER TABLE gat_players ADD COLUMN coins INT UNSIGNED NOT NULL DEFAULT 0');
  }
  if (!(await hasColumn(db, 'gat_players', 'catches'))) {
    await db.execute('ALTER TABLE gat_players ADD COLUMN catches INT UNSIGNED NOT NULL DEFAULT 0');
  }

  // The composter is a property of the TREE, not of a player: everyone's coins go into the same
  // heap and everyone's tree grows faster for it.
  if (!(await hasColumn(db, 'gat_trees', 'compost'))) {
    await db.execute('ALTER TABLE gat_trees ADD COLUMN compost INT UNSIGNED NOT NULL DEFAULT 0');
  }
}

async function hasColumn(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return Number(rows[0].n) > 0;
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS gat_encounters');
  await db.execute('DROP TABLE IF EXISTS gat_stickers');
  await db.execute('ALTER TABLE gat_players DROP COLUMN coins').catch(() => {});
  await db.execute('ALTER TABLE gat_players DROP COLUMN catches').catch(() => {});
  await db.execute('ALTER TABLE gat_trees DROP COLUMN compost').catch(() => {});
}
