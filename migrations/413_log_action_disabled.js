/**
 * Wave 413 — switch off single log actions.
 *
 * The Logging page could switch a whole category off (Voice join, leave and move) but not one action in it
 * (keep voice joins, drop voice leaves). A row here means that action does not post for that server;
 * no row means it posts whenever its category is on. sendLogEmbed checks it (core/log-manager.js).
 * Only actions of categories with more than one action are stored: a one-action category is its own switch.
 *
 *   guild_id  VARCHAR(20)  the server
 *   action    VARCHAR(48)  action key from core/log-actions.js, e.g. 'voiceUpdate.leave'
 *
 * Owner request 2026-11-14 (Logging page: "allow disabling specific logs, not just setting colours").
 * Apply directly: import { up } and call up(pool).
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS log_action_disabled (
            guild_id   VARCHAR(20) NOT NULL,
            action     VARCHAR(48) NOT NULL,
            created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS log_action_disabled');
}
