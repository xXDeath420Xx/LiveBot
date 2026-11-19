/*
 * Separate "who hears about this form" from "ping them on every submission".
 *
 * `dm_user_ids` was doing both jobs, and they are not the same job. A form that answers people
 * automatically does not need to interrupt its owner every time somebody uses it — but the moment
 * one of those people REPLIES to the bot, that is a human talking, and it has to reach somebody.
 *
 * Clearing the recipient list to silence the per-submission notification would have silently
 * broken that: core/form-inbox.js forwards an applicant's reply to dm_user_ids, so an empty list
 * means their question is recorded and then nobody is told. The person would be writing to a bot
 * that already answered them, getting nothing back, with no way to know why.
 *
 * So the list stays, and this column controls only the notification:
 *   dm_user_ids    — who to contact about this form (also who inbound replies forward to)
 *   dm_on_submit   — whether a new submission pings them at all
 *
 * DEFAULT 1 keeps every existing form behaving exactly as it does today.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  if (!await hasColumn(db, 'ticket_forms', 'dm_on_submit')) {
    await db.execute('ALTER TABLE ticket_forms ADD COLUMN dm_on_submit TINYINT(1) NOT NULL DEFAULT 1');
  }
}

export async function down(db) {
  if (await hasColumn(db, 'ticket_forms', 'dm_on_submit')) {
    await db.execute('ALTER TABLE ticket_forms DROP COLUMN dm_on_submit');
  }
}
