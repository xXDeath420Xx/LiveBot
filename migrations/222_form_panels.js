/*
 * Track the panel messages a form has posted, so they can be edited instead of re-posted.
 *
 * Until now `POST /forms/create-panel` sent a message and forgot it. Nothing recorded the channel
 * or the message id, so "change the wording" or "I added a question" had exactly one remedy:
 * post a second panel and delete the first by hand. Worse, a panel embeds the form's questions
 * (the "What you will be asked" block), so every question edit silently made every already-posted
 * panel wrong, with no way to tell and no way to fix it.
 *
 * message_id IS NULLABLE, DELIBERATELY. Migration 200 made this exact mistake on reaction-role
 * panels — a NOT NULL message_id meant a panel whose message had been deleted could not be
 * represented at all, which broke Repost. A row here is the CONFIGURATION; the message is just its
 * current incarnation. Message deleted in Discord -> message_id goes NULL and Repost puts it back
 * with the same settings.
 *
 * UNIQUE (guild_id, form_id, channel_id): one panel per form per channel. A second post to the
 * same channel is an update of the first, not a duplicate — which is precisely the mess this is
 * here to prevent.
 */

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return rows.length > 0;
}

export async function up(db) {
  if (await tableExists(db, 'form_panels')) return;

  await db.execute(`
    CREATE TABLE form_panels (
      panel_id INT AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      form_id INT NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      message_id VARCHAR(20) NULL,
      panel_title VARCHAR(256) NULL,
      panel_description TEXT NULL,
      button_text VARCHAR(80) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_form_panel_channel (guild_id, form_id, channel_id),
      INDEX idx_form_panels_form (form_id),
      CONSTRAINT fk_form_panels_form FOREIGN KEY (form_id)
        REFERENCES ticket_forms (form_id) ON DELETE CASCADE
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS form_panels');
}
