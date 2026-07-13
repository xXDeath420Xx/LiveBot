// Counting: per-channel behaviour modes.
//
// The original implementation only knew one ruleset — a wrong number resets the count to
// zero. Several servers (Kabster's Shit Cunts) run the opposite: wrong numbers are simply
// deleted and the count never resets ("infinite attempts"). Everything that used to be
// hardcoded is now a per-channel flag, defaulting to the old behaviour so no existing
// guild changes.
async function hasColumn(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return Number(rows[0].n) > 0;
}

const COLUMNS = [
  // 'reset'  → wrong number wipes the count (legacy default)
  // 'delete' → wrong number is deleted, count untouched, anyone may retry
  ["fail_mode", "ENUM('reset','delete') NOT NULL DEFAULT 'reset'"],
  // Whether one person may count twice in a row.
  ['allow_same_user', 'TINYINT(1) NOT NULL DEFAULT 0'],
  // React ✅ on every valid count.
  ['react_on_valid', 'TINYINT(1) NOT NULL DEFAULT 1'],
  // Milestone embeds + economy payouts at 25/50/100/200/500…
  ['announce_milestones', 'TINYINT(1) NOT NULL DEFAULT 1'],
  // In delete mode: also delete non-numeric chatter posted in the channel.
  ['delete_chatter', 'TINYINT(1) NOT NULL DEFAULT 0'],
];

export async function up(db) {
  for (const [name, def] of COLUMNS) {
    if (!await hasColumn(db, 'counting_channels', name)) {
      await db.execute(`ALTER TABLE counting_channels ADD COLUMN ${name} ${def}`);
    }
  }
  // A channel can only be configured once; make that a real constraint rather than a
  // SELECT-then-INSERT check that races.
  const [idx] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'counting_channels' AND INDEX_NAME = 'uniq_channel'`);
  if (!Number(idx[0].n)) {
    await db.execute('ALTER TABLE counting_channels ADD UNIQUE KEY uniq_channel (channel_id)').catch(() => {});
  }
}

export async function down(db) {
  for (const [name] of COLUMNS) {
    if (await hasColumn(db, 'counting_channels', name)) {
      await db.execute(`ALTER TABLE counting_channels DROP COLUMN ${name}`);
    }
  }
}
