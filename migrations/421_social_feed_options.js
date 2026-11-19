/**
 * Wave 421 — social feed options and go-live filters.
 *
 * Per-feed message, ping and filters for the Social feeds page (dashboard/routes/api/features/feeds.js,
 * partials/manage/feeds.ejs), applied by core/reddit-feed.js, core/youtube-feed.js,
 * core/twitter-feed.js and core/bluesky-feed.js through core/feed-message.js:
 *
 *   reddit_feeds.custom_message   TEXT          message template ({subreddit} {title} {author} {flair} {url})
 *   reddit_feeds.ping_role_id     VARCHAR(20)   role id, 'everyone', or NULL for no ping
 *   reddit_feeds.title_include    VARCHAR(500)  comma-separated; post only titles containing one
 *   reddit_feeds.title_exclude    VARCHAR(500)  comma-separated; skip titles containing one
 *   reddit_feeds.flair_filter     VARCHAR(255)  comma-separated; post only these flairs
 *   youtube_feeds.custom_message  TEXT          message template ({channel} {title} {type} {url})
 *   youtube_feeds.include_videos  TINYINT(1) 1  post regular uploads
 *   youtube_feeds.include_shorts  TINYINT(1) 1  post Shorts
 *   youtube_feeds.include_live    TINYINT(1) 1  post live streams and premieres
 *   twitter_feeds.ping_role_id    VARCHAR(20)
 *   bluesky_feeds.ping_role_id    VARCHAR(20)
 *
 * Per-subscription go-live filters for stream alerts (core/stream-alert-filters.js, edit-streamer dialog):
 *
 *   subscriptions.filter_categories      VARCHAR(500)  announce only these categories
 *   subscriptions.filter_title_keywords  VARCHAR(500)  announce only titles/tags containing one of these
 *
 * Every new column is NULL or defaults to "on", so existing rows behave exactly as before. The code
 * reads them tolerantly and works (without the options) until this has run.
 * Apply directly: import { up } and call up(pool).
 */
async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

const COLUMNS = [
    ['reddit_feeds', 'custom_message', 'TEXT NULL DEFAULT NULL'],
    ['reddit_feeds', 'ping_role_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['reddit_feeds', 'title_include', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['reddit_feeds', 'title_exclude', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['reddit_feeds', 'flair_filter', 'VARCHAR(255) NULL DEFAULT NULL'],
    ['youtube_feeds', 'custom_message', 'TEXT NULL DEFAULT NULL'],
    ['youtube_feeds', 'include_videos', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['youtube_feeds', 'include_shorts', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['youtube_feeds', 'include_live', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['twitter_feeds', 'ping_role_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['bluesky_feeds', 'ping_role_id', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['subscriptions', 'filter_categories', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['subscriptions', 'filter_title_keywords', 'VARCHAR(500) NULL DEFAULT NULL'],
];

export async function up(pool) {
    for (const [table, column, def] of COLUMNS) {
        if (!(await hasColumn(pool, table, column))) {
            await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
        }
    }
}

export async function down(pool) {
    for (const [table, column] of [...COLUMNS].reverse()) {
        if (await hasColumn(pool, table, column)) {
            await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
