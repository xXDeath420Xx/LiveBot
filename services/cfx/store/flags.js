// Greenhouse Tycoon (cfx v2): runtime switches stored in gh_config, read without a restart.
//
//   name 'jobs.disabled'   true  -> every scheduled job is skipped
//                          ["season-rollover", ...] -> only those jobs are skipped
// Values are cached for ttlMs. If the table cannot be read, the last good value is used; with no good
// value yet, nothing is disabled (the env switch CFX2_JOBS_DISABLED still applies, see jobs/scheduler.js).

export function createFlags({ db, t, ttlMs = 15_000, now = () => Date.now(), logger = null }) {
    const cache = new Map(); // name -> { value, at }

    async function get(name) {
        const hit = cache.get(name);
        if (hit && now() - hit.at < ttlMs) return hit.value;
        try {
            const [rows] = await db.query(`SELECT value FROM ${t.config} WHERE name = ?`, [name]);
            let value = null;
            if (rows.length && rows[0].value != null) {
                try { value = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value; } catch { value = null; }
            }
            cache.set(name, { value, at: now() });
            return value;
        } catch (err) {
            logger?.warn?.('[cfx2] could not read config flag', { name, error: err.message });
            return hit ? hit.value : null;
        }
    }

    async function set(name, value, updatedBy = null) {
        await db.query(
            `INSERT INTO ${t.config} (name, value, updated_by) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
            [name, JSON.stringify(value), updatedBy]);
        cache.delete(name);
    }

    /** True when the job is switched off in gh_config. */
    async function jobDisabled(jobName) {
        const value = await get('jobs.disabled');
        if (value === true) return true;
        return Array.isArray(value) && value.includes(jobName);
    }

    return { get, set, jobDisabled, clearCache: () => cache.clear() };
}
