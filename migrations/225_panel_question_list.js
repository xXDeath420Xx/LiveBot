/*
 * Make the panel's question list a setting instead of a side effect.
 *
 * The panel used to carry a "What you will be asked" block, and it was removed along with the
 * modal it was compensating for — a modal could not show a long question, so the panel had to
 * restate everything. Wrong reason, useful feature: seeing what a form asks BEFORE committing to
 * open it is worth having on its own merits, and people want it back.
 *
 * So it returns as something the owner controls, defaulting to ON. 1 for existing forms because
 * that is what they looked like before the removal.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  if (!await hasColumn(db, 'ticket_forms', 'show_questions_on_panel')) {
    await db.execute(
      'ALTER TABLE ticket_forms ADD COLUMN show_questions_on_panel TINYINT(1) NOT NULL DEFAULT 1');
  }
}

export async function down(db) {
  if (await hasColumn(db, 'ticket_forms', 'show_questions_on_panel')) {
    await db.execute('ALTER TABLE ticket_forms DROP COLUMN show_questions_on_panel');
  }
}
