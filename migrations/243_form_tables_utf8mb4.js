/*
 * Convert the form tables to utf8mb4. Without this, an emoji anywhere in the feature throws.
 *
 * THE DATABASE DEFAULT IS utf8mb3. Every CREATE TABLE in migrations 221–226 omitted a charset, so
 * all five inherited three-byte utf8 — which cannot store any character outside the BMP. Emoji are
 * outside the BMP. The failure is not a mangled string, it is a hard error:
 *
 *   Incorrect string value: '\xF0\x9F\x8E\x89...' for column 'body'
 *
 * The blast radius was wider than the reply bodies that surfaced it. `form_sessions.answers` holds
 * a member's typed answers mid-form, so ONE EMOJI IN A PARAGRAPH ANSWER would have failed their
 * submission with no explanation. form_panels holds a panel title, form_dm_deliveries an error
 * string, form_replies both halves of a conversation between real people.
 *
 * The older tables (ticket_forms, ticket_form_questions, form_submissions) are already utf8mb4 —
 * migrations 179 and 184 fixed exactly this, for exactly this reason. A new table has to ask for
 * it explicitly or it silently inherits the old default again, which is what happened here.
 *
 * CONVERT TO rewrites the data, so it is safe on populated tables and idempotent on converted ones.
 */

const TABLES = [
  'form_panels',
  'form_sessions',
  'form_dm_deliveries',
  'form_reply_templates',
  'form_replies',
];

export async function up(db) {
  for (const table of TABLES) {
    const [[row]] = await db.execute(
      `SELECT TABLE_COLLATION AS collation_name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    if (!row) continue;
    if (String(row.collation_name).startsWith('utf8mb4')) continue;
    await db.execute(`ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`[229] ${table}: ${row.collation_name} -> utf8mb4_unicode_ci`);
  }
}

export async function down() {
  // Deliberately not reversible. Going back to utf8mb3 would mean destroying any character that
  // only fits in utf8mb4, which is the whole reason this migration exists.
}
