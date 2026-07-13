/**
 * Migration 141: Soundboard support on the shared per-guild sound library.
 * Adds an optional `emoji` column to vc_sound_files so soundboard panel buttons
 * can show a custom emoji. The on-demand soundboard reuses vc_sound_files +
 * sounds/<guildId>/ (same library the random VC-drop system uses). Idempotent.
 */
async function columnExists(db, table, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await columnExists(db, 'vc_sound_files', 'emoji'))) {
    await db.execute(`ALTER TABLE vc_sound_files ADD COLUMN emoji VARCHAR(64) NULL AFTER name`);
  }
}

export async function down(db) {
  if (await columnExists(db, 'vc_sound_files', 'emoji')) {
    await db.execute('ALTER TABLE vc_sound_files DROP COLUMN emoji');
  }
}
