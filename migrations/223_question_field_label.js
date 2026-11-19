/*
 * Let the author write the short heading a Discord modal field needs.
 *
 * A modal field has two pieces of text: a LABEL capped at 45 characters, and a description capped
 * at 100. A question longer than 45 therefore cannot be the label. Until now the builder coped by
 * trimming the question at a word boundary for the label and repeating the whole question in the
 * description, which renders as:
 *
 *     WOULD YOU BE WILLING TO PROVIDE FEEDBACK /
 *     Would you be willing to provide feedback / report bugs as you find them?
 *     [ dropdown ]
 *
 * — the same sentence twice, the first copy visibly chopped. It looks like a bug because it reads
 * like one. Nothing about the question was too long for the FORM; only for the heading.
 *
 * The heading and the question are genuinely different things: Discord's own modals put a short
 * field name on top ("Nickname", "Reason") and the explanatory text underneath. The only source of
 * a good short name is the person writing the question, so this column asks them for it.
 *
 * NULL keeps the old auto-trim, so every existing question renders exactly as it does today and
 * nothing has to be filled in retroactively.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  if (!await hasColumn(db, 'ticket_form_questions', 'field_label')) {
    // 45 is Discord's cap, enforced in the column so an over-long value cannot reach the builder.
    await db.execute(
      'ALTER TABLE ticket_form_questions ADD COLUMN field_label VARCHAR(45) NULL AFTER question_text');
  }
}

export async function down(db) {
  if (await hasColumn(db, 'ticket_form_questions', 'field_label')) {
    await db.execute('ALTER TABLE ticket_form_questions DROP COLUMN field_label');
  }
}
