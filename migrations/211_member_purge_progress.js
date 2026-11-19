/*
 * A running purge needs to say where it is.
 *
 * `channels_done` only advances when a whole channel finishes, and this server has channels holding
 * five years of logs — one of them can take ten minutes, during which the job looks frozen and
 * somebody reasonably concludes it has died. `progress` is a human sentence updated as it goes.
 */
export async function up(db) {
  const [cols] = await db.execute(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'member_purge_jobs' AND column_name = 'progress'`);
  if (!cols.length) {
    await db.execute('ALTER TABLE member_purge_jobs ADD COLUMN progress VARCHAR(190) NULL AFTER status');
  }
  const [cols2] = await db.execute(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'member_purge_jobs' AND column_name = 'messages_scanned'`);
  if (!cols2.length) {
    await db.execute('ALTER TABLE member_purge_jobs ADD COLUMN messages_scanned INT UNSIGNED NOT NULL DEFAULT 0 AFTER progress');
  }
  // How far back a run was told to look, so a truncated scan is never mistaken for a complete one.
  const [cols3] = await db.execute(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'member_purge_jobs' AND column_name = 'max_age_days'`);
  if (!cols3.length) {
    await db.execute('ALTER TABLE member_purge_jobs ADD COLUMN max_age_days INT NULL AFTER dry_run');
  }
}

export async function down(db) {
  for (const c of ['progress', 'messages_scanned', 'max_age_days']) {
    await db.execute(`ALTER TABLE member_purge_jobs DROP COLUMN ${c}`).catch(() => {});
  }
}

export default { up, down };
