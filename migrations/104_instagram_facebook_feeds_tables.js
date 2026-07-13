/**
 * Migration 104: Create instagram_feeds and facebook_feeds tables
 *
 * Migration 074 added `social_feed_posts` plus the `instagram_feed_notifications`
 * / `facebook_feed_notifications` columns on `subscriptions`, but never created
 * the standalone `instagram_feeds` / `facebook_feeds` tables that
 * `core/instagram-feed.js`, `core/facebook-feed.js`, and the dashboard
 * "Add Instagram/Facebook feed" routes already SELECT/INSERT/UPDATE against.
 *
 * Result: the dashboard form throws on INSERT and the per-username feed
 * pollers silently return on ER_NO_SUCH_TABLE. This migration unblocks both.
 *
 * Idempotent (whitelist-based hasTable).
 */

async function tableExists(db, table) {
    const allowed = new Set(['instagram_feeds', 'facebook_feeds']);
    if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'instagram_feeds'))) {
        await db.execute(`
            CREATE TABLE instagram_feeds (
                id                 INT AUTO_INCREMENT PRIMARY KEY,
                guild_id           VARCHAR(20)  NOT NULL,
                instagram_username VARCHAR(100) NOT NULL,
                ig_user_id         VARCHAR(50)  NULL,
                channel_id         VARCHAR(20)  NOT NULL,
                last_post_id       VARCHAR(100) NULL,
                filter_reels       TINYINT(1)   NOT NULL DEFAULT 0,
                custom_message     TEXT         NULL,
                updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_guild_user (guild_id, instagram_username),
                INDEX idx_guild (guild_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'facebook_feeds'))) {
        await db.execute(`
            CREATE TABLE facebook_feeds (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                guild_id         VARCHAR(20)  NOT NULL,
                facebook_page_id VARCHAR(50)  NOT NULL,
                page_name        VARCHAR(150) NULL,
                channel_id       VARCHAR(20)  NOT NULL,
                last_post_id     VARCHAR(100) NULL,
                custom_message   TEXT         NULL,
                updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_guild_page (guild_id, facebook_page_id),
                INDEX idx_guild (guild_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS facebook_feeds');
    await db.execute('DROP TABLE IF EXISTS instagram_feeds');
}
