// Smoke circle: puffs taken on the CURRENT turn.
//
// CannaFriend (the bot we replace in Kabster's Shit Cunts) lets you take up to TWO puffs before you
// must pass — and it says so in the reply: "You can take one more or use `/pass`", then "Now you
// must use `/pass`". Reproducing its wording without reproducing that rule would be a lie; the reply
// would promise a second puff we never gated on.
//
// `total_puffs` on the circle is cumulative and `puffs_taken` on the participant is lifetime, so
// neither can answer "how many this turn". This column can, and it resets on every pass.
const MAX_PUFFS_PER_TURN = 2;

async function hasColumn(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return Number(rows[0].n) > 0;
}

export async function up(db) {
  if (!(await hasColumn(db, 'smoke_circles', 'turn_puffs'))) {
    await db.execute(
      'ALTER TABLE smoke_circles ADD COLUMN turn_puffs TINYINT UNSIGNED NOT NULL DEFAULT 0');
  }
}

export async function down(db) {
  if (await hasColumn(db, 'smoke_circles', 'turn_puffs')) {
    await db.execute('ALTER TABLE smoke_circles DROP COLUMN turn_puffs');
  }
}

export { MAX_PUFFS_PER_TURN };
