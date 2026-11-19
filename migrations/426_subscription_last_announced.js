/**
 * Stream alerts: "Last notified" on the dashboard's streamer list.
 *
 *   subscriptions.last_announced_at  DATETIME NULL  when this subscription last made a NEW go-live post
 *
 * Written by core/stream-manager.js after a new announcement is saved (edits of a post that is already
 * up do not count); read by the Streamers page (dashboard/server.js, partials/manage/streaming.ejs and
 * edit-streamer-modal.ejs). The writer and reader both tolerate the column missing until this runs.
 * Backfilled from live_announcements (the posts that are up right now), so streamers live at the
 * time of migrating show a date straight away.
 * Apply directly: import { up } and call up(pool).
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

export async function up(pool) {
    if (!(await hasColumn(pool, 'subscriptions', 'last_announced_at'))) {
        await pool.query('ALTER TABLE `subscriptions` ADD COLUMN `last_announced_at` DATETIME NULL DEFAULT NULL');
    }
    await pool.query(`
        UPDATE subscriptions sub
        JOIN (SELECT guild_id, streamer_id, MAX(created_at) AS at FROM live_announcements GROUP BY guild_id, streamer_id) la
          ON la.guild_id = sub.guild_id AND la.streamer_id = sub.streamer_id
        SET sub.last_announced_at = la.at
        WHERE sub.last_announced_at IS NULL OR sub.last_announced_at < la.at`);
}

export async function down(pool) {
    if (await hasColumn(pool, 'subscriptions', 'last_announced_at')) {
        await pool.query('ALTER TABLE `subscriptions` DROP COLUMN `last_announced_at`');
    }
}
