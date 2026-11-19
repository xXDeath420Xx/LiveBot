/**
 * Wave 422 — rss_feeds: generic RSS / Atom feeds (blogs, news, podcasts) on the Social feeds page.
 *
 * Polled by core/rss-feed.js from jobs/social-feed-scheduler.js (every 15 minutes, with Reddit,
 * YouTube and Bluesky); added, edited and removed through dashboard/routes/api/features/feeds.js.
 *
 *   feed_url         the feed address (fetched only through utils/safe-fetch.js)
 *   channel_id       where new items are posted
 *   feed_title       the feed's own title, filled on add / first check
 *   seen_ids         JSON array of hashed item keys already seen (NULL = baseline on the next check)
 *   custom_message   message template ({feed} {title} {author} {url})
 *   ping_role_id     role id, 'everyone', or NULL
 *   title_include / title_exclude   comma-separated keyword filters
 *   failed_count / last_error / suspended_until   5 failures in a row pause the feed for 24 hours
 *
 * Until this runs the poller skips RSS silently and the page shows no RSS feeds; adding one answers
 * that the option is not available yet. Apply directly: import { up } and call up(pool).
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS rss_feeds (
            id INT NOT NULL AUTO_INCREMENT,
            guild_id VARCHAR(20) NOT NULL,
            feed_url VARCHAR(1000) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            feed_title VARCHAR(255) NULL DEFAULT NULL,
            seen_ids TEXT NULL DEFAULT NULL,
            custom_message TEXT NULL DEFAULT NULL,
            ping_role_id VARCHAR(20) NULL DEFAULT NULL,
            title_include VARCHAR(500) NULL DEFAULT NULL,
            title_exclude VARCHAR(500) NULL DEFAULT NULL,
            failed_count INT NOT NULL DEFAULT 0,
            last_error VARCHAR(255) NULL DEFAULT NULL,
            suspended_until DATETIME NULL DEFAULT NULL,
            last_checked DATETIME NULL DEFAULT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_rss_guild_url_channel (guild_id, feed_url(191), channel_id),
            KEY idx_rss_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS rss_feeds');
}
