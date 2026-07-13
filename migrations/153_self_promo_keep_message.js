// Self-promo: let the promo post actually STAY in the channel.
//
// The original design treats the self-promo channel purely as a SIGNUP box: you drop your
// stream link, the bot subscribes you and then deletes the message ("Always delete in
// self-promo channel"). Combined with `delete_invalid`, the net effect is that a member can
// post nothing at all — every message they write disappears, which reads as the bot eating
// the channel.
//
// Some servers (Kabster's Shit Cunts) want the opposite: a real self-promo channel where
// people post their own stuff and it stays up, with auto-tracking as a silent bonus.
// `keep_message` is the master switch for that: when set, the handler never deletes anything
// in the channel, and confirms a successful subscription with a reaction + DM instead.
//
// Defaults to 0, so no existing guild changes behaviour.

async function hasColumn(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return Number(rows[0].n) > 0;
}

export async function up(db) {
  if (!(await hasColumn(db, 'self_promo_config', 'keep_message'))) {
    await db.execute(
      `ALTER TABLE self_promo_config
         ADD COLUMN keep_message TINYINT(1) NOT NULL DEFAULT 0`);
  }
}

export async function down(db) {
  if (await hasColumn(db, 'self_promo_config', 'keep_message')) {
    await db.execute('ALTER TABLE self_promo_config DROP COLUMN keep_message');
  }
}
