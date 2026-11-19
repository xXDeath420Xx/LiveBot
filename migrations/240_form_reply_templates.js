/*
 * Reply to a form submission as the bot, from the DM that announced it.
 *
 * A response notification is a dead end today: it tells the owner somebody applied and leaves them
 * to go and find that person in Discord to say anything back. The answers usually decide the reply
 * — a Steam player needs the branch access code, an Epic player needs the patcher instead — so the
 * reply is both predictable and easy to get wrong by hand.
 *
 * TWO TABLES, DIFFERENT LIFETIMES:
 *
 *   form_reply_templates — the canned replies an owner writes once. Optionally conditional: a
 *   template can name a question and a substring, and it is offered only when that submission's
 *   answer contains it. That is what makes "Steam" and "Epic" two different buttons rather than the
 *   sender having to remember which is which at 2am.
 *
 *   form_replies — what was actually sent, to whom, by whom, and whether it landed. A DM can fail
 *   silently (closed DMs, a member who left), and the sender is clicking a button in their own DMs
 *   with nowhere for an error to surface. Without a log, "did they ever get it?" is unanswerable,
 *   which is the same hole form_dm_deliveries exists to close on the other side of the flow.
 *
 * body is TEXT: replies carry instructions, links and access codes, and Discord allows 4096
 * characters in an embed description. A VARCHAR would silently amputate the useful half.
 */

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return rows.length > 0;
}

export async function up(db) {
  if (!await tableExists(db, 'form_reply_templates')) {
    await db.execute(`
      CREATE TABLE form_reply_templates (
        template_id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        form_id INT NOT NULL,
        name VARCHAR(80) NOT NULL,
        body TEXT NOT NULL,
        match_question_id INT NULL,
        match_contains VARCHAR(255) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_form_reply_templates_form (form_id, sort_order),
        CONSTRAINT fk_form_reply_templates_form FOREIGN KEY (form_id)
          REFERENCES ticket_forms (form_id) ON DELETE CASCADE
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }

  if (!await tableExists(db, 'form_replies')) {
    // No FK to form_submissions: a reply is evidence of what was said and should outlive the
    // submission row being cleared out.
    await db.execute(`
      CREATE TABLE form_replies (
        reply_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        submission_id BIGINT NULL,
        form_id INT NOT NULL,
        guild_id VARCHAR(20) NOT NULL,
        sender_id VARCHAR(20) NOT NULL,
        recipient_id VARCHAR(20) NOT NULL,
        template_id INT NULL,
        body TEXT NOT NULL,
        status ENUM('sent','failed') NOT NULL,
        error VARCHAR(255) NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_form_replies_submission (submission_id),
        INDEX idx_form_replies_form (form_id, sent_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS form_replies');
  await db.execute('DROP TABLE IF EXISTS form_reply_templates');
}
