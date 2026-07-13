export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_cached_profiles (
            throne_username VARCHAR(100) PRIMARY KEY,
            display_name VARCHAR(200) DEFAULT NULL,
            bio TEXT DEFAULT NULL,
            birthday VARCHAR(20) DEFAULT NULL,
            picture_url TEXT DEFAULT NULL,
            background_url TEXT DEFAULT NULL,
            platform VARCHAR(50) DEFAULT NULL,
            social_links JSON DEFAULT NULL,
            interests JSON DEFAULT NULL,
            profile_url VARCHAR(255) DEFAULT NULL,
            created_at_throne BIGINT DEFAULT NULL,
            last_fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            fetch_status ENUM('pending', 'ok', 'error') DEFAULT 'pending'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS throne_cached_wishlists (
            throne_username VARCHAR(100) NOT NULL,
            item_id VARCHAR(100) NOT NULL,
            item_name VARCHAR(255) DEFAULT NULL,
            price_formatted VARCHAR(50) DEFAULT NULL,
            price_raw DOUBLE DEFAULT 0,
            currency VARCHAR(10) DEFAULT 'USD',
            quantity INT DEFAULT 1,
            is_digital TINYINT(1) DEFAULT 0,
            is_available TINYINT(1) DEFAULT 1,
            not_in_stock TINYINT(1) DEFAULT 0,
            is_featured TINYINT(1) DEFAULT 0,
            image_url TEXT DEFAULT NULL,
            link TEXT DEFAULT NULL,
            collection_ids JSON DEFAULT NULL,
            total_contribution_formatted VARCHAR(50) DEFAULT NULL,
            created_at_throne BIGINT DEFAULT NULL,
            PRIMARY KEY (throne_username, item_id),
            INDEX idx_username (throne_username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS throne_cached_wishlists');
    await db.execute('DROP TABLE IF EXISTS throne_cached_profiles');
}
