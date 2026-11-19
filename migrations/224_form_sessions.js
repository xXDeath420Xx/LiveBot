/*
 * In-progress form answers, so a form can be asked one question at a time instead of crammed into
 * a modal.
 *
 * WHY THE MODAL HAD TO GO. A Discord modal field shows a 45-character label and a 100-character
 * description, and a modal holds five fields. Those are hard platform caps. A 263-character
 * consent question cannot be displayed in one, however the text is arranged — every "fix" was just
 * a different way of hiding part of the question. A MESSAGE has 4096 characters of embed
 * description and no five-field limit, so the form is now asked as a sequence of ephemeral
 * messages: one question at a time, in full, with its answer control underneath.
 *
 * That needs somewhere to keep the answers between steps. Not an in-memory Map: a restart
 * mid-application would silently lose what somebody had already typed, and this bot restarts
 * often. One row per in-flight attempt, deleted on submit.
 *
 * UNIQUE (form_id, user_id): a person has one attempt at a form at a time. Clicking the panel
 * again resumes where they left off rather than starting a second, competing session.
 */

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return rows.length > 0;
}

export async function up(db) {
  if (await tableExists(db, 'form_sessions')) return;
  await db.execute(`
    CREATE TABLE form_sessions (
      session_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      form_id INT NOT NULL,
      guild_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      step INT NOT NULL DEFAULT 0,
      answers TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_form_session (form_id, user_id),
      INDEX idx_form_sessions_stale (updated_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS form_sessions');
}
