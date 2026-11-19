/*
 * Let a form deliver its responses to a person, not just to a channel and the dashboard.
 *
 * The existing destinations both require somebody to go and look: the dashboard needs a visit,
 * and a submit channel needs the right channel to be open. A form that gets one response a week
 * is exactly the case where neither happens. A DM arrives.
 *
 * Stored as a JSON array of user ids on the form rather than a join table: the list is short (a
 * form has one or two owners, not hundreds), it is always read and written whole, and it is
 * always read at the same moment as the rest of the form row.
 *
 * A recipient is checked against the guild's membership when it is SAVED, not when a DM is sent —
 * a form's answers should never be shipped to an arbitrary snowflake that has nothing to do with
 * the server. See the dashboard route.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  if (!await hasColumn(db, 'ticket_forms', 'dm_user_ids')) {
    await db.execute('ALTER TABLE ticket_forms ADD COLUMN dm_user_ids TEXT NULL AFTER submit_channel_id');
  }

  // Why a delivery log: a DM is the one destination that can fail permanently and silently —
  // closed DMs, a blocked bot, a departed member — and the sender is a background handler with
  // nobody to report to. Without a record, "I never got a DM" is unanswerable. One row per
  // attempt per recipient, so the dashboard can say exactly which ones landed.
  const [existing] = await db.execute(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_dm_deliveries'");
  if (existing.length === 0) {
    await db.execute(`
      CREATE TABLE form_dm_deliveries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        submission_id BIGINT NULL,
        form_id INT NOT NULL,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        status ENUM('sent','failed') NOT NULL,
        error VARCHAR(255) NULL,
        attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_form_dm_form (form_id, attempted_at),
        INDEX idx_form_dm_submission (submission_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS form_dm_deliveries');
  if (await hasColumn(db, 'ticket_forms', 'dm_user_ids')) {
    await db.execute('ALTER TABLE ticket_forms DROP COLUMN dm_user_ids');
  }
}
