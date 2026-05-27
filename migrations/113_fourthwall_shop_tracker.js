/**
 * Migration 113 — Fourthwall public shop tracker
 *
 * Independent of fourthwall_connections (which is the OWNER/webhook model).
 * Anyone can track any public Fourthwall shop by handle — no auth required.
 * The scheduler scrapes each tracked shop on a cron, diffs the product catalog
 * against the last snapshot, and announces changes to the configured channel.
 */

export async function up(db) {
    // One row per (guild, shop_handle, channel) tracking subscription.
    // A guild can track the same shop in multiple channels with different
    // notification flags (e.g. #new-drops gets new-products only; #deals
    // gets price-drops only).
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_tracked_shops (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            shop_handle VARCHAR(100) NOT NULL,
            shop_name VARCHAR(255) DEFAULT NULL,
            channel_id VARCHAR(20) NOT NULL,
            notify_new_products TINYINT(1) DEFAULT 1,
            notify_price_drops TINYINT(1) DEFAULT 1,
            notify_price_increases TINYINT(1) DEFAULT 0,
            notify_sold_out TINYINT(1) DEFAULT 0,
            notify_restocked TINYINT(1) DEFAULT 1,
            added_by VARCHAR(20) NOT NULL,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_checked_at TIMESTAMP NULL DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            consecutive_failures INT DEFAULT 0,
            UNIQUE KEY uk_guild_shop_channel (guild_id, shop_handle, channel_id),
            INDEX idx_handle (shop_handle),
            INDEX idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Snapshot of every product we've seen across ALL tracked shops.
    // Keyed by (shop_handle, slug) — shared across guilds tracking the same shop,
    // so we only scrape each shop once per cycle regardless of subscriber count.
    // last_status enum captures the most recent observation:
    //   active     — visible in last scrape
    //   sold_out   — visible but marked sold-out (future: parse from page)
    //   removed    — was visible last scrape, now gone
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fourthwall_tracked_products (
            shop_handle VARCHAR(100) NOT NULL,
            slug VARCHAR(200) NOT NULL,
            name VARCHAR(255) DEFAULT NULL,
            image_url TEXT DEFAULT NULL,
            price_minor_units INT DEFAULT NULL,
            currency VARCHAR(8) DEFAULT NULL,
            last_status ENUM('active','sold_out','removed') NOT NULL DEFAULT 'active',
            first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (shop_handle, slug),
            INDEX idx_handle_status (shop_handle, last_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS fourthwall_tracked_products');
    await db.execute('DROP TABLE IF EXISTS fourthwall_tracked_shops');
}
