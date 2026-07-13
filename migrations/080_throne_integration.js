export async function up(db) {
    // User-level: link Discord user to Throne username (global, not per-guild)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_user_links (
            user_id VARCHAR(20) PRIMARY KEY,
            throne_username VARCHAR(100) NOT NULL,
            linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_throne_username (throne_username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Guild-level: featured Throne wishlist
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_guild_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            featured_username VARCHAR(100) NOT NULL,
            set_by VARCHAR(20) NOT NULL,
            set_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Per-guild notification tracking: which Throne users to monitor and where to post
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            throne_username VARCHAR(100) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            notify_new_items TINYINT(1) DEFAULT 1,
            notify_gifts TINYINT(1) DEFAULT 1,
            notify_contributions TINYINT(1) DEFAULT 1,
            added_by VARCHAR(20) NOT NULL,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_guild_throne (guild_id, throne_username),
            INDEX idx_throne_username (throne_username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Track seen wishlist items to detect new additions
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_seen_items (
            throne_username VARCHAR(100) NOT NULL,
            item_id VARCHAR(100) NOT NULL,
            item_name VARCHAR(255) DEFAULT NULL,
            first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (throne_username, item_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Track seen gifts to detect new purchases and contribution changes
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_seen_gifts (
            throne_username VARCHAR(100) NOT NULL,
            gift_id VARCHAR(100) NOT NULL,
            gift_name VARCHAR(255) DEFAULT NULL,
            status VARCHAR(50) DEFAULT NULL,
            is_crowdfunded TINYINT(1) DEFAULT 0,
            contributor_count INT DEFAULT 0,
            first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (throne_username, gift_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS throne_seen_gifts');
    await db.execute('DROP TABLE IF EXISTS throne_seen_items');
    await db.execute('DROP TABLE IF EXISTS throne_notifications');
    await db.execute('DROP TABLE IF EXISTS throne_guild_config');
    await db.execute('DROP TABLE IF EXISTS throne_user_links');
}
