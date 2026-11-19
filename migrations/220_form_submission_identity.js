/*
 * Record WHO submitted a form, not just their snowflake.
 *
 * form_submissions stored `user_id` alone, so the dashboard could only ever show
 * "User: 365905620060340224". Resolving that to a name at read time is possible but wrong as the
 * only mechanism: a member can leave the server, be banned, or change their handle, and then the
 * answer to "who filled this in?" is permanently lost. A submission is a point-in-time record, so
 * it stores the identity it was made under.
 *
 * The live lookup is still used, but only as a BACKFILL for rows written before this column
 * existed — the dashboard resolves those once through the bot and writes the result here, so the
 * cost is paid once rather than on every page view.
 *
 * Nullable with no default on purpose: NULL means "never captured", which is what tells the
 * backfill which rows to look up. An empty string would be indistinguishable from a real miss.
 */

async function hasColumn(db, table, column) {
  const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\``);
  return cols.some(c => c.Field === column);
}

export async function up(db) {
  // Discord caps a username and a global display name at 32 characters each; 64 leaves room for
  // the legacy name#discriminator form still held by unmigrated accounts.
  if (!await hasColumn(db, 'form_submissions', 'username')) {
    await db.execute('ALTER TABLE form_submissions ADD COLUMN username VARCHAR(64) NULL AFTER user_id');
  }
  if (!await hasColumn(db, 'form_submissions', 'display_name')) {
    await db.execute('ALTER TABLE form_submissions ADD COLUMN display_name VARCHAR(64) NULL AFTER username');
  }
  if (!await hasColumn(db, 'form_submissions', 'avatar_url')) {
    await db.execute('ALTER TABLE form_submissions ADD COLUMN avatar_url VARCHAR(255) NULL AFTER display_name');
  }
}

export async function down(db) {
  for (const col of ['username', 'display_name', 'avatar_url']) {
    if (await hasColumn(db, 'form_submissions', col)) {
      await db.execute(`ALTER TABLE form_submissions DROP COLUMN \`${col}\``);
    }
  }
}
