/**
 * Migration 340 — Weekly Recap configuration.
 *
 * Per-guild opt-in. Fires once per week at the configured day+hour (UTC in v1 — timezone
 * support can come with a dashboard UI). Default day_of_week = 1 (Monday), hour = 9.
 *
 * last_posted_at prevents double-posting if the scheduler fires twice within the window
 * (ops reload, scheduler restart). The weekly job treats last_posted_at >= start-of-this-week
 * as "already posted".
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (await hasTable(db, 'weekly_recap_config')) return;
    await db.execute(`CREATE TABLE weekly_recap_config (
        guild_id VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        day_of_week TINYINT(1) NOT NULL DEFAULT 1,   -- 0=Sun ... 6=Sat (JS getUTCDay)
        hour TINYINT(2) NOT NULL DEFAULT 9,          -- UTC
        last_posted_at TIMESTAMP NULL,
        created_by VARCHAR(20) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
}

export async function down(db) {
    try { await db.execute('DROP TABLE IF EXISTS weekly_recap_config'); } catch { /* ok */ }
}
