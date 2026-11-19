// Greenhouse Tycoon (cfx v2): records the last run of each scheduled job in gh_job_runs, and provides a
// cross-process lock so two copies of the service (e.g. during a pm2 reload) never run the same job at
// once. The lock is a MariaDB named lock (GET_LOCK) held on one dedicated pooled connection for the
// duration of the run; it is released when the run ends or the connection drops.

export function createJobRuns({ db, t, prefix }) {
    async function record(name, { status, startedAt, finishedAt, durationMs, error = null }) {
        const failed = status === 'error' || status === 'timeout' ? 1 : 0;
        const skipped = status === 'skipped' ? 1 : 0;
        const ran = skipped ? 0 : 1;
        await db.query(
            `INSERT INTO ${t.job_runs} (name, last_started_at, last_finished_at, last_status, last_duration_ms, last_error, runs, failures, skips)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE last_started_at = VALUES(last_started_at), last_finished_at = VALUES(last_finished_at),
               last_status = VALUES(last_status), last_duration_ms = VALUES(last_duration_ms), last_error = VALUES(last_error),
               runs = runs + VALUES(runs), failures = failures + VALUES(failures), skips = skips + VALUES(skips)`,
            [name, startedAt ? new Date(startedAt) : null, finishedAt ? new Date(finishedAt) : null, status,
                durationMs == null ? null : Math.max(0, Math.min(4_294_967_295, Math.round(durationMs))),
                error ? String(error).slice(0, 255) : null, ran, failed, skipped]);
    }

    /** Try to take the named lock without waiting. Returns a release function, or null if it is held. */
    async function acquire(jobName) {
        const lockName = `${prefix}job:${jobName}`.slice(0, 64);
        const conn = await db.getConnection();
        try {
            const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [lockName]);
            if (Number(rows[0].got) !== 1) {
                conn.release();
                return null;
            }
        } catch (err) {
            conn.release();
            throw err;
        }
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } finally { conn.release(); }
        };
    }

    async function list() {
        const [rows] = await db.query(`SELECT * FROM ${t.job_runs} ORDER BY name`);
        return rows;
    }

    return { record, acquire, list };
}
