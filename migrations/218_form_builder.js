/*
 * Give forms a real question builder — and collapse the dead twin schema behind it.
 *
 * THE TWIN. Two parallel form schemas existed. The Discord side (ticket panels, the Stream Team
 * signup page, /support forms) reads `ticket_forms` + `ticket_form_questions` — 5 forms, 13
 * questions, live. The dashboard's Forms page wrote to `forms` + `form_questions` — 0 rows, ever,
 * because nothing else in the codebase reads them. Creating a form on the dashboard therefore
 * produced a row no ticket panel could ever use, and the page's "View Questions" list was
 * permanently empty by construction. Both dead tables are dropped here (guarded on being empty)
 * and every dashboard route is repointed at the live pair.
 *
 * `form_submissions` is NOT dead weight and is kept: it becomes the store for standalone form
 * panels — a form posted as its own button, answered by anyone, with no ticket channel created.
 * Ticket-attached forms keep writing their answers into `tickets.form_responses` as before.
 *
 * WHY THE TYPE ENUM GROWS. question_type was ENUM('text','paragraph') because a Discord modal
 * could only hold text inputs when this was written. It can now hold select menus (the Label
 * component, discord.js >= 14.24), so a question can genuinely be a dropdown, a multi-select, or
 * a user/role/channel picker. The two original values keep their exact spelling and stay first,
 * so every existing row and every existing read path is untouched.
 *
 * question_order is backfilled from question_id so the existing forms keep the order they already
 * render in — every current reader sorts by question_id, so seeding order = id preserves it
 * exactly, and only a deliberate reorder in the dashboard can change it afterwards.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

async function tableExists(db, table) {
  // Not `SHOW TABLES LIKE ?` — MariaDB's prepared-statement protocol rejects a placeholder there.
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return rows.length > 0;
}

export async function up(db) {
  // ── ticket_forms: description + where submissions get announced ──────────────
  if (!await hasColumn(db, 'ticket_forms', 'form_description')) {
    await db.execute('ALTER TABLE ticket_forms ADD COLUMN form_description TEXT NULL AFTER form_name');
  }
  if (!await hasColumn(db, 'ticket_forms', 'submit_channel_id')) {
    await db.execute('ALTER TABLE ticket_forms ADD COLUMN submit_channel_id VARCHAR(20) NULL AFTER form_description');
  }
  if (!await hasColumn(db, 'ticket_forms', 'created_at')) {
    await db.execute('ALTER TABLE ticket_forms ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
  }

  // ── ticket_form_questions: the actual builder fields ─────────────────────────
  // Widening an ENUM is safe: the two original members keep their positions, so stored rows and
  // any code comparing === 'paragraph' behave identically.
  await db.execute(`
    ALTER TABLE ticket_form_questions
      MODIFY COLUMN question_type
        ENUM('text','paragraph','number','select','multiselect','user','role','channel')
        NOT NULL DEFAULT 'text'`);

  if (!await hasColumn(db, 'ticket_form_questions', 'question_options')) {
    // JSON array of choice labels, for select/multiselect. NULL for every other type.
    await db.execute('ALTER TABLE ticket_form_questions ADD COLUMN question_options TEXT NULL');
  }
  if (!await hasColumn(db, 'ticket_form_questions', 'is_required')) {
    // Existing questions were unconditionally required in ticket_create.js, so 1 is the
    // order-preserving default here too.
    await db.execute('ALTER TABLE ticket_form_questions ADD COLUMN is_required TINYINT(1) NOT NULL DEFAULT 1');
  }
  if (!await hasColumn(db, 'ticket_form_questions', 'placeholder')) {
    await db.execute('ALTER TABLE ticket_form_questions ADD COLUMN placeholder VARCHAR(100) NULL');
  }
  if (!await hasColumn(db, 'ticket_form_questions', 'question_order')) {
    await db.execute('ALTER TABLE ticket_form_questions ADD COLUMN question_order INT NOT NULL DEFAULT 0');
    // Seed order = id: identical to what every current reader (ORDER BY question_id) shows.
    await db.execute('UPDATE ticket_form_questions SET question_order = question_id');
  }

  // ── form_submissions: reused as the standalone-panel answer store ────────────
  if (!await tableExists(db, 'form_submissions')) {
    await db.execute(`
      CREATE TABLE form_submissions (
        submission_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        form_id BIGINT NOT NULL,
        guild_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        submission_data TEXT NOT NULL,
        submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  }
  const [subIdx] = await db.execute("SHOW INDEX FROM form_submissions WHERE Key_name = 'idx_form_submissions_form'");
  if (subIdx.length === 0) {
    await db.execute('CREATE INDEX idx_form_submissions_form ON form_submissions (form_id, submitted_at)');
  }

  // Its form_id pointed at the dead `forms` table by foreign key, which is both why `forms` could
  // not be dropped and why a submission against a real (ticket_forms) form would have been
  // rejected outright. Repoint it — the table is empty, so widening/narrowing the column is free.
  const [fks] = await db.execute(`
    SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_submissions'
       AND REFERENCED_TABLE_NAME IS NOT NULL`);
  const alreadyRepointed = fks.some(fk => fk.CONSTRAINT_NAME === 'fk_form_submissions_ticket_form');
  if (!alreadyRepointed) {
    for (const fk of fks) {
      await db.execute(`ALTER TABLE form_submissions DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
    }
  }
  const [[{ formIdType }]] = await db.execute(`
    SELECT COLUMN_TYPE AS formIdType FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_submissions' AND COLUMN_NAME = 'form_id'`);
  if (!/^int/i.test(formIdType)) {
    // Must match ticket_forms.form_id exactly for the foreign key to be accepted.
    await db.execute('ALTER TABLE form_submissions MODIFY COLUMN form_id INT(11) NOT NULL');
  }
  if (!alreadyRepointed) {
    await db.execute(`
      ALTER TABLE form_submissions
        ADD CONSTRAINT fk_form_submissions_ticket_form
        FOREIGN KEY (form_id) REFERENCES ticket_forms (form_id) ON DELETE CASCADE`);
  }

  // ── drop the twins, but only if they really are empty ────────────────────────
  for (const dead of ['form_questions', 'forms']) {
    if (!await tableExists(db, dead)) continue;
    const [[{ n }]] = await db.execute(`SELECT COUNT(*) AS n FROM \`${dead}\``);
    if (n > 0) {
      // Never silently discard data somebody managed to write. Leave it and say so.
      console.warn(`[218] ${dead} has ${n} row(s) — NOT dropping. Migrate them into ticket_forms first.`);
      continue;
    }
    await db.execute(`DROP TABLE \`${dead}\``);
  }
}

export async function down(db) {
  const [fks] = await db.execute(`
    SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'form_submissions'
       AND CONSTRAINT_NAME = 'fk_form_submissions_ticket_form'`);
  for (const fk of fks) {
    await db.execute('ALTER TABLE form_submissions DROP FOREIGN KEY fk_form_submissions_ticket_form');
  }

  // The dropped twins were empty by definition (up() refuses otherwise), so recreating the shape
  // fully restores them.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS forms (
      form_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(255) NOT NULL,
      form_name VARCHAR(255) NOT NULL,
      form_description TEXT NULL,
      submit_channel_id VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS form_questions (
      question_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      form_id BIGINT NOT NULL,
      question_text TEXT NOT NULL,
      question_type ENUM('short_text','long_text','number','select') NOT NULL DEFAULT 'short_text',
      question_options TEXT NULL,
      is_required TINYINT(1) NOT NULL DEFAULT 0,
      question_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  // Rows using a widened type would break the narrow ENUM, so fold them back to the nearest
  // original before shrinking it.
  await db.execute("UPDATE ticket_form_questions SET question_type = 'paragraph' WHERE question_type = 'multiselect'");
  await db.execute("UPDATE ticket_form_questions SET question_type = 'text' WHERE question_type NOT IN ('text','paragraph')");
  await db.execute("ALTER TABLE ticket_form_questions MODIFY COLUMN question_type ENUM('text','paragraph') NOT NULL DEFAULT 'text'");

  for (const col of ['question_options', 'is_required', 'placeholder', 'question_order']) {
    if (await hasColumn(db, 'ticket_form_questions', col)) {
      await db.execute(`ALTER TABLE ticket_form_questions DROP COLUMN \`${col}\``);
    }
  }
  for (const col of ['form_description', 'submit_channel_id', 'created_at']) {
    if (await hasColumn(db, 'ticket_forms', col)) {
      await db.execute(`ALTER TABLE ticket_forms DROP COLUMN \`${col}\``);
    }
  }
}
