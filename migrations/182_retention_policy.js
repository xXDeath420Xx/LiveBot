/**
 * Migration 182: Data retention policy, and indexes the cleanup needs
 *
 * The database is 1.41 GB and has never had a retention policy. A
 * `log_retention_policy` table exists and is empty — planned, never wired.
 *
 * What is actually there:
 *
 *   cfx_worker_logs      2,971,986 rows   469 MB  — a debug log for a minigame
 *                                                   with 5 active players. A
 *                                                   third of the database.
 *   audit_logs             189,443 rows   271 MB
 *   throne_price_history   720,446 rows   113 MB
 *   tokes_web_sessions     100,708 rows    96 MB  — sessions, never pruned
 *   message_logs           175,632 rows    65 MB
 *   uptime_events           39,606 rows     9 MB
 *
 * Note this does NOT reuse `log_retention_policy`. That table already exists
 * with a (guild_id, event_type, retention_days) shape — it is a per-guild
 * user-facing setting ("keep my mod logs 30 days"), which is a genuinely
 * different concept from operational per-table retention. Overloading one table
 * with both would make "retention" mean two things depending on which columns
 * were populated. This uses `data_retention_policy` instead.
 *
 * This seeds the policy table with per-table retention windows and adds the
 * indexes the delete queries need. Without those indexes each nightly cleanup
 * is a full scan — on cfx_worker_logs that is 3M rows every night, which is how
 * a retention job ends up costing more than the data it removes.
 *
 * Nothing is deleted here. The migration installs the policy; jobs/retention-
 * sweeper.js enforces it, in bounded batches, so the first run cannot lock a
 * 469 MB table for minutes.
 */

/**
 * table, timestamp column, days to keep, reason.
 *
 * Column names are per-table and were read off the live schema rather than
 * assumed — they are variously created_at, performed_at, timestamp, log_date
 * and stat_date. A policy naming a column that does not exist would make the
 * nightly sweeper throw, so up() verifies each one before seeding it.
 *
 * Windows are chosen per table rather than globally: an audit log is evidence
 * and keeps a year, a debug log for a 5-player minigame keeps a fortnight.
 */
const POLICIES = [
    // table                     column           days   reason
    ['cfx_worker_logs', 'performed_at', 14, 'Minigame debug log — 3M rows, 5 players'],
    ['cfx_worker_action_log', 'created_at', 30, 'Minigame action log'],
    ['cfx_market_price_history', 'recorded_at', 90, 'Minigame market history'],
    ['throne_price_history', 'recorded_at', 90, 'Wishlist price tracking — 131MB, and 180d retained 100% of it'],
    ['steam_price_history', 'recorded_at', 180, 'Steam price tracking'],
    ['message_logs', 'timestamp', 90, 'Moderation context'],
    ['audit_logs', 'timestamp', 365, 'Moderation evidence — keep a year'],
    ['activity_logs', 'log_date', 180, 'Activity analytics'],
    ['uptime_events', 'timestamp', 90, 'Uptime history'],
    ['invite_tracker_logs', 'timestamp', 180, 'Invite attribution'],
    ['tokes_web_sessions', 'expires_at', 1, 'Web sessions — prune on expiry, not age: 103k of them accumulated in under a month, so an age window never catches up'],
    ['global_ban_action_log', 'created_at', 365, 'Ban evidence — keep a year'],
    ['emoji_usage', 'stat_date', 180, 'Emoji stats'],
];

export async function up(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS data_retention_policy (
            table_name      VARCHAR(64)  NOT NULL,
            timestamp_column VARCHAR(64) NOT NULL,
            retain_days     INT          NOT NULL,
            enabled         TINYINT(1)   NOT NULL DEFAULT 1,
            notes           VARCHAR(255) DEFAULT NULL,
            last_swept_at   TIMESTAMP    NULL DEFAULT NULL,
            last_deleted    INT          NOT NULL DEFAULT 0,
            PRIMARY KEY (table_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [[{ schema }]] = await pool.execute('SELECT DATABASE() AS `schema`');
    let seeded = 0;
    let indexed = 0;
    const skipped = [];

    for (const [table, column, days, notes] of POLICIES) {
        // Only seed a policy for a table/column that actually exists — a policy
        // pointing at a missing column would make the sweeper throw every night.
        const [cols] = await pool.execute(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
            [schema, table, column]
        );
        if (!cols.length) { skipped.push(`${table}.${column}`); continue; }

        await pool.execute(
            `INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, notes)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE timestamp_column = VALUES(timestamp_column),
                                     retain_days = VALUES(retain_days),
                                     notes = VALUES(notes)`,
            [table, column, days, notes]
        );
        seeded++;

        // The sweep is `DELETE ... WHERE <column> < ?`. Without an index that is
        // a full scan; on cfx_worker_logs that is 3M rows, nightly.
        const indexName = `idx_retention_${column}`;
        const [existing] = await pool.execute(
            `SELECT 1 FROM information_schema.statistics
              WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1`,
            [schema, table, indexName]
        );
        if (!existing.length) {
            try {
                await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (\`${column}\`)`);
                indexed++;
            } catch (error) {
                console.warn(`[Migration 182] Could not index ${table}.${column}: ${error.message}`);
            }
        }
    }

    // phishing_domains' own cleanup (`DELETE ... WHERE last_seen_at < ... AND
    // source != 'manual'`) scans all 385k rows for want of this.
    try {
        const [existing] = await pool.execute(
            `SELECT 1 FROM information_schema.statistics
              WHERE table_schema = ? AND table_name = 'phishing_domains'
                AND index_name = 'idx_last_seen_source' LIMIT 1`,
            [schema]
        );
        if (!existing.length) {
            await pool.query('ALTER TABLE phishing_domains ADD INDEX idx_last_seen_source (last_seen_at, source)');
            indexed++;
        }
    } catch (error) {
        console.warn(`[Migration 182] Could not index phishing_domains: ${error.message}`);
    }

    console.log(`[Migration 182] Seeded ${seeded} retention policies, added ${indexed} index(es)`);
    if (skipped.length) console.log(`[Migration 182] Skipped (no such column): ${skipped.join(', ')}`);
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS data_retention_policy');
    console.log('[Migration 182] Dropped data_retention_policy (indexes left in place — they are harmless and re-adding costs a table rebuild)');
}
