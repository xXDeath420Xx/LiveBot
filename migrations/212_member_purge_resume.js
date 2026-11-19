/*
 * Make a purge resumable.
 *
 * A full-history run on a five-year server is hours of work, and until now any restart threw all of
 * it away — the job was marked cancelled and the next attempt started again from channel one. On a
 * bot that gets restarted for unrelated reasons, a multi-hour job that cannot survive one is a job
 * that never finishes.
 *
 *   phase          which pass it is on: finding who has left, or erasing them
 *   done_channels  channel ids already finished in the CURRENT pass, so a resume skips them
 *   target_ids     the result of pass one, so a resume never repeats the expensive part
 */
export async function up(db) {
  const add = async (name, ddl) => {
    const [c] = await db.execute(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'member_purge_jobs' AND column_name = ?`, [name]);
    if (!c.length) await db.execute(`ALTER TABLE member_purge_jobs ADD COLUMN ${ddl}`);
  };

  await add('phase', "phase ENUM('find','purge') NOT NULL DEFAULT 'find' AFTER status");
  await add('done_channels', 'done_channels MEDIUMTEXT NULL AFTER phase');
  await add('target_ids', 'target_ids MEDIUMTEXT NULL AFTER done_channels');

  // 'interrupted' is not 'cancelled': one can be resumed, the other was a decision.
  await db.execute(
    `ALTER TABLE member_purge_jobs
       MODIFY COLUMN status ENUM('planned','running','interrupted','complete','cancelled','failed')
       NOT NULL DEFAULT 'planned'`);
}

export async function down(db) {
  for (const c of ['phase', 'done_channels', 'target_ids']) {
    await db.execute(`ALTER TABLE member_purge_jobs DROP COLUMN ${c}`).catch(() => {});
  }
}

export default { up, down };
