/*
 * Make form_replies hold the whole conversation, not just our half of it.
 *
 * The bot DMs an applicant; the applicant hits reply. That message lands in the bot's own DMs and
 * nothing reads it — so the person who asked the question never hears the answer, and the
 * applicant is talking to a wall while believing they are talking to the server.
 *
 * Forwarding it needs somewhere to record it, and the natural place is beside the message it is
 * replying to. One column turns this table from an outbox into a thread: the dashboard can show a
 * response, what was said to them, and what they said back, in order, without a second table and a
 * union query to read it.
 *
 * DEFAULT 'out' is what makes this safe to add: every existing row was a reply we sent.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  if (!await hasColumn(db, 'form_replies', 'direction')) {
    await db.execute(
      "ALTER TABLE form_replies ADD COLUMN direction ENUM('out','in') NOT NULL DEFAULT 'out' AFTER template_id");
  }
  // An inbound message has no recipient in the way an outbound one does; it is addressed to the
  // form's owners as a group, which is a list, not a column.
  const [cols] = await db.execute('SHOW COLUMNS FROM form_replies');
  const recipient = cols.find(c => c.Field === 'recipient_id');
  if (recipient && recipient.Null === 'NO') {
    await db.execute('ALTER TABLE form_replies MODIFY COLUMN recipient_id VARCHAR(20) NULL');
  }
  const [idx] = await db.execute("SHOW INDEX FROM form_replies WHERE Key_name = 'idx_form_replies_inbound'");
  if (idx.length === 0) {
    // The forwarder's hot query: "has this person been replied to recently, and about what?"
    await db.execute('CREATE INDEX idx_form_replies_inbound ON form_replies (recipient_id, sent_at)');
  }
}

export async function down(db) {
  if (await hasColumn(db, 'form_replies', 'direction')) {
    await db.execute("DELETE FROM form_replies WHERE direction = 'in'");
    await db.execute('ALTER TABLE form_replies DROP COLUMN direction');
  }
}
