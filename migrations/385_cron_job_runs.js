/**
 * Wave 385 — last-run ledger for scheduled jobs. The analytics cron used to fire daily jobs
 * only if its hourly timer (which restarts with the process) happened to land in the target
 * hour; with frequent pm2 restarts, follower churn and clip snapshots effectively never ran.
 * Jobs now run when due and record the run here, so restarts neither skip nor repeat them.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cron_job_runs (
            job_key VARCHAR(64) NOT NULL PRIMARY KEY,
            last_started_at DATETIME NULL,
            last_finished_at DATETIME NULL,
            last_ok TINYINT(1) NULL,
            last_error VARCHAR(500) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS cron_job_runs');
}
