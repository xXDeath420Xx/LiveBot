export async function up(db) {
    // Per-guild throne settings (all off by default)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_guild_settings (
            guild_id VARCHAR(20) PRIMARY KEY,

            -- Notification toggles
            notify_item_added TINYINT(1) DEFAULT 0,
            notify_item_removed TINYINT(1) DEFAULT 0,
            notify_gift_received TINYINT(1) DEFAULT 0,
            notify_contribution TINYINT(1) DEFAULT 0,
            notify_price_change TINYINT(1) DEFAULT 0,
            notify_milestone TINYINT(1) DEFAULT 0,
            notify_gift_thankyou TINYINT(1) DEFAULT 0,

            -- Feature toggles
            auto_embed_links TINYINT(1) DEFAULT 0,
            birthday_reminder TINYINT(1) DEFAULT 0,
            monthly_spotlight TINYINT(1) DEFAULT 0,
            wishlist_role_enabled TINYINT(1) DEFAULT 0,

            -- Channel config
            notification_channel_id VARCHAR(20) DEFAULT NULL,
            birthday_channel_id VARCHAR(20) DEFAULT NULL,
            spotlight_channel_id VARCHAR(20) DEFAULT NULL,

            -- Settings
            wishlist_role_id VARCHAR(20) DEFAULT NULL,
            birthday_reminder_days INT DEFAULT 3,
            price_change_threshold INT DEFAULT 10,

            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Price history for tracking changes
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_price_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            throne_username VARCHAR(100) NOT NULL,
            item_id VARCHAR(100) NOT NULL,
            price_raw DOUBLE NOT NULL,
            currency VARCHAR(10) DEFAULT 'USD',
            recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_item (throne_username, item_id),
            INDEX idx_time (recorded_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Notification history log
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_notification_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            throne_username VARCHAR(100) NOT NULL,
            notification_type ENUM('item_added', 'item_removed', 'gift_received', 'contribution', 'price_change', 'milestone', 'gift_thankyou', 'birthday_reminder', 'monthly_spotlight') NOT NULL,
            message_id VARCHAR(20) DEFAULT NULL,
            channel_id VARCHAR(20) DEFAULT NULL,
            details JSON DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild (guild_id),
            INDEX idx_time (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Track previously seen item IDs for removal detection (add flag to existing table)
    await db.execute(`
        ALTER TABLE throne_seen_items ADD COLUMN still_present TINYINT(1) DEFAULT 1
    `);
}

export async function down(db) {
    await db.execute('ALTER TABLE throne_seen_items DROP COLUMN still_present');
    await db.execute('DROP TABLE IF EXISTS throne_notification_log');
    await db.execute('DROP TABLE IF EXISTS throne_price_history');
    await db.execute('DROP TABLE IF EXISTS throne_guild_settings');
}
