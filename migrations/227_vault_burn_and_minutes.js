/*
 * Vault: burn-after-download, sub-day expiry, and richer download records.
 *
 * WHY retention_minutes RATHER THAN REUSING retention_days
 * -------------------------------------------------------
 * The original column could not express "delete this in 20 minutes" — the smallest value it
 * held was 1, meaning a day. Rather than redefine what the existing column's numbers mean
 * (a silent reinterpretation that would make every old row wrong), this adds a column at the
 * granularity actually needed. `retention_days` stays for rows written before this migration;
 * completeUpload prefers minutes and falls back to days.
 *
 * delete_on_download lives on BOTH tables: it is chosen at upload time (vault_uploads) and has
 * to survive onto the finished file (vault_files), where it is also editable afterwards.
 *
 * The audit gains bytes/completed because "downloaded" and "started downloading and gave up at
 * 12%" are different events, and only the first one may burn a file. Recording the distinction
 * is also the only way to answer "did they actually get it?" after the fact.
 */

async function columnExists(db, table, column) {
  const [rows] = await db.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return rows.length > 0;
}

async function addColumn(db, table, column, definition) {
  if (await columnExists(db, table, column)) return;
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export async function up(db) {
  await addColumn(db, 'vault_uploads', 'retention_minutes', 'INT NULL AFTER retention_days');
  await addColumn(db, 'vault_uploads', 'delete_on_download', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn(db, 'vault_files', 'delete_on_download', 'TINYINT(1) NOT NULL DEFAULT 0');

  // How much actually went over the wire, and whether the transfer reached the end of the file.
  await addColumn(db, 'vault_audit', 'bytes', 'BIGINT UNSIGNED NULL');
  await addColumn(db, 'vault_audit', 'completed', 'TINYINT(1) NULL');
}

export async function down(db) {
  for (const [table, column] of [
    ['vault_uploads', 'retention_minutes'],
    ['vault_uploads', 'delete_on_download'],
    ['vault_files', 'delete_on_download'],
    ['vault_audit', 'bytes'],
    ['vault_audit', 'completed']
  ]) {
    if (await columnExists(db, table, column)) {
      await db.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
}
