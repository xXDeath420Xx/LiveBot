export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_connections (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            shop_handle VARCHAR(100) NOT NULL,
            shop_name VARCHAR(255) DEFAULT NULL,
            shop_id VARCHAR(100) DEFAULT NULL,
            api_username VARCHAR(512) NOT NULL,
            api_password TEXT NOT NULL,
            storefront_token VARCHAR(255) DEFAULT NULL,
            connection_token VARCHAR(64) NOT NULL,
            webhook_secret VARCHAR(512) DEFAULT NULL,
            webhook_ids JSON DEFAULT NULL,
            connected_by VARCHAR(20) NOT NULL,
            connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_event_at TIMESTAMP NULL DEFAULT NULL,
            UNIQUE KEY uk_guild_shop (guild_id, shop_handle),
            UNIQUE KEY uk_connection_token (connection_token),
            INDEX idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_event_routing (
            connection_id INT NOT NULL,
            event_category ENUM('orders','donations','memberships','giveaways','promotions','newsletter','thank_you','cart_abandoned') NOT NULL,
            channel_id VARCHAR(20) DEFAULT NULL,
            enabled TINYINT(1) DEFAULT 1,
            PRIMARY KEY (connection_id, event_category),
            FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_guild_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            default_channel_id VARCHAR(20) DEFAULT NULL,
            show_customer_names TINYINT(1) DEFAULT 0,
            show_amounts TINYINT(1) DEFAULT 1,
            embed_color VARCHAR(7) DEFAULT '#FF6B35'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_seen_events (
            event_id VARCHAR(100) PRIMARY KEY,
            connection_id INT NOT NULL,
            event_type VARCHAR(100) NOT NULL,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_received (received_at),
            INDEX idx_connection (connection_id),
            FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // orphan_webhooks intentionally has nullable connection_id and a duplicate
    // copy of encrypted credentials: rows here OUTLIVE their parent connection
    // so the cleanup job can still call FW's DELETE /webhooks/{id} after the
    // connection row has been removed. No FK by design.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_orphan_webhooks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            connection_id INT DEFAULT NULL,
            webhook_id VARCHAR(100) NOT NULL,
            api_username VARCHAR(512) NOT NULL,
            api_password TEXT NOT NULL,
            attempts INT DEFAULT 0,
            last_attempt_at TIMESTAMP NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_undelivered_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            connection_id INT NOT NULL,
            event_id VARCHAR(100) NOT NULL,
            event_type VARCHAR(100) NOT NULL,
            payload JSON NOT NULL,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_connection (connection_id),
            FOREIGN KEY (connection_id) REFERENCES fourthwall_connections(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS fourthwall_undelivered_events');
    await db.execute('DROP TABLE IF EXISTS fourthwall_orphan_webhooks');
    await db.execute('DROP TABLE IF EXISTS fourthwall_seen_events');
    await db.execute('DROP TABLE IF EXISTS fourthwall_guild_config');
    await db.execute('DROP TABLE IF EXISTS fourthwall_event_routing');
    await db.execute('DROP TABLE IF EXISTS fourthwall_connections');
}
