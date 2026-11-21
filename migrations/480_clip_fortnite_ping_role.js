/**
 * 480 — ping roles for the Twitch clip feeds and the Fortnite feed, like the other feed types (migration 421).
 *
 *   twitch_clip_feeds.ping_role_id  VARCHAR(20)  role id, 'everyone', or NULL for no ping (Twitch clips page, /alerts clips)
 *   fortnite_feeds.ping_role_id     VARCHAR(20)  same, set on the Social feeds page
 *
 * Applied by jobs/twitch-clip-checker.js and jobs/fortnite-feed-checker.js through core/feed-message.js pingFor().
 * NULL keeps the current behaviour (no ping). Idempotent.
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

const COLUMNS = [
    ['twitch_clip_feeds', 'ping_role_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['fortnite_feeds', 'ping_role_id', 'VARCHAR(20) NULL DEFAULT NULL'],
];

export async function up(pool) {
    for (const [table, column, def] of COLUMNS) {
        if (!(await hasColumn(pool, table, column))) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
    }
}

export async function down(pool) {
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(pool, table, column)) await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
}
