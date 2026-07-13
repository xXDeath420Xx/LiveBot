export async function up(db) {
    // Track announced Instagram/Facebook posts (same pattern as tiktok_video_posts)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS social_feed_posts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            platform ENUM('instagram', 'facebook') NOT NULL,
            streamer_id BIGINT,
            post_id VARCHAR(255) NOT NULL,
            post_url TEXT,
            caption TEXT,
            media_type VARCHAR(50),
            media_url TEXT,
            thumbnail_url TEXT,
            like_count INT DEFAULT 0,
            comment_count INT DEFAULT 0,
            posted_at DATETIME,
            announced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_post (platform, post_id),
            INDEX idx_streamer (streamer_id),
            INDEX idx_platform_posted (platform, posted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Add instagram/facebook feed notification flag to subscriptions
    await db.execute(`ALTER TABLE subscriptions ADD COLUMN instagram_feed_notifications TINYINT(1) DEFAULT 0`);
    await db.execute(`ALTER TABLE subscriptions ADD COLUMN facebook_feed_notifications TINYINT(1) DEFAULT 0`);
    await db.execute(`ALTER TABLE subscriptions ADD COLUMN feed_channel_id VARCHAR(20) DEFAULT NULL`);

    console.log('[Migration 074] Created social_feed_posts table, added feed notification columns to subscriptions');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS social_feed_posts');
    await db.execute('ALTER TABLE subscriptions DROP COLUMN instagram_feed_notifications');
    await db.execute('ALTER TABLE subscriptions DROP COLUMN facebook_feed_notifications');
    await db.execute('ALTER TABLE subscriptions DROP COLUMN feed_channel_id');
    console.log('[Migration 074] Removed social feed tables');
}
