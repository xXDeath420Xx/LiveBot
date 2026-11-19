/**
 * Wave 416 — daily health digest (jobs/health-digest.js).
 *
 * Warnings and errors are counted in-process as they are logged (utils/logger.js onWarnError), grouped
 * by a normalised "signature" (ids/numbers/usernames blanked), and flushed here hourly. Once a day the
 * owner gets a DM listing only what is new or has grown sharply since the day before.
 *
 * Why: on 2026-11-18 the audit found Kick chat had been failing ~6,000 times a day for 4+ days and
 * one custom bot had stalled overnight, with nobody told. Logs were ~1.6 GB/day, too big to read.
 *
 *   day        DATE         UTC day
 *   level      ENUM         warn | error
 *   signature  VARCHAR(200) normalised message
 *   count      INT          occurrences that day
 *
 * Kept 30 days (data_retention_policy row below). Apply directly: import { up } and call up(pool).
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS health_log_signatures (
            day        DATE NOT NULL,
            level      ENUM('warn','error') NOT NULL,
            signature  VARCHAR(200) NOT NULL,
            count      INT UNSIGNED NOT NULL DEFAULT 0,
            sample     VARCHAR(400) DEFAULT NULL,
            PRIMARY KEY (day, level, signature)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `);
    try {
        const [[has]] = await pool.query("SELECT COUNT(*) n FROM data_retention_policy WHERE table_name = 'health_log_signatures'");
        if (!Number(has.n)) {
            await pool.query(`INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled)
                              VALUES ('health_log_signatures', 'day', 30, 1)`);
        }
    } catch { /* retention table shape differs: the digest still works, rows just are not swept */ }
}

export async function down(pool) {
    await pool.query("DELETE FROM data_retention_policy WHERE table_name = 'health_log_signatures'").catch(() => {});
    await pool.query('DROP TABLE IF EXISTS health_log_signatures');
}
