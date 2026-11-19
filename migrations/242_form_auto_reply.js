/*
 * Let a form answer the person who filled it in, immediately, instead of only telling the owner.
 *
 * Some forms exist to collect applications somebody will review. Others exist only to ask ONE
 * thing so the right information can be handed back — "which store is your copy on?" — and making
 * that person wait for a human to notice and reply is pure friction when the answer is already
 * written down and public.
 *
 * When this is on, submitting runs the same saved-reply matching the notification DM uses: the
 * template whose rule fits their answer is shown on the confirmation screen AND copied to their
 * DMs, and recorded in form_replies exactly as a hand-sent reply would be. The owner still gets
 * the submission and the notification — knowing who asked is the other half of the point.
 *
 * DEFAULT 0: an existing form that suddenly started DMing its applicants a template would be a
 * surprise, and surprises here are messages to real people.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  if (!await hasColumn(db, 'ticket_forms', 'auto_reply')) {
    await db.execute('ALTER TABLE ticket_forms ADD COLUMN auto_reply TINYINT(1) NOT NULL DEFAULT 0');
  }
}

export async function down(db) {
  if (await hasColumn(db, 'ticket_forms', 'auto_reply')) {
    await db.execute('ALTER TABLE ticket_forms DROP COLUMN auto_reply');
  }
}
