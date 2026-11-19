/*
 * Make `server_stats` match what actually writes to it.
 *
 * events/serverStats.js has, since it was written, run this every midnight UTC for
 * every guild on every bot:
 *
 *   INSERT INTO server_stats (guild_id, date, member_count, message_count,
 *                             new_members, active_users) VALUES (?,?,?,?,?,?)
 *   ON DUPLICATE KEY UPDATE ...
 *
 * The table only ever had (guild_id, date, total_members, online_members,
 * message_count), so every one of those inserts died with
 * "Unknown column 'member_count' in 'INSERT INTO'" — ~240 errors a night across the
 * fleet, and `server_stats` sat at 0 rows for its entire existence. The daily
 * message-count and active-user figures the tracker collects in memory were thrown
 * away every single night.
 *
 * This adds the three columns the writer expects. `total_members` and
 * `online_members` stay: they're NOT NULL DEFAULT 0, so an insert that omits them is
 * fine, and the daily-snapshot equivalents in `server_stats_snapshots` (written by
 * core/server-stats-manager.js, and the table the analytics dashboard actually reads)
 * already cover that ground — there's no reason to churn columns holding no data.
 *
 * The UNIQUE index `guild_date` on (guild_id, date) already exists, so the
 * ON DUPLICATE KEY UPDATE clause works as written once the columns are present.
 *
 * Note this table is still write-only: dashboard/routes/features/statistics.js reads
 * `server_stats_snapshots`, not this. Fixing the write is the prerequisite for ever
 * surfacing message_count / active_users, which snapshots genuinely don't capture.
 */

const COLUMNS = [
    ['member_count', 'INT(11) NOT NULL DEFAULT 0'],
    ['new_members', 'INT(11) NOT NULL DEFAULT 0'],
    ['active_users', 'INT(11) NOT NULL DEFAULT 0'],
];

export async function up(db) {
    const [existing] = await db.execute(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'server_stats'`,
    );
    const have = new Set(existing.map(c => (c.column_name || c.COLUMN_NAME).toLowerCase()));

    for (const [name, definition] of COLUMNS) {
        if (have.has(name)) continue;
        await db.execute(`ALTER TABLE server_stats ADD COLUMN ${name} ${definition}`);
    }
}

export async function down(db) {
    for (const [name] of COLUMNS) {
        const [cols] = await db.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'server_stats' AND column_name = ?`,
            [name],
        );
        if (cols.length) await db.execute(`ALTER TABLE server_stats DROP COLUMN ${name}`);
    }
}
