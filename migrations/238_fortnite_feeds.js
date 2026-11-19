export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fortnite_feeds (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            guild_id     VARCHAR(20) NOT NULL,
            channel_id   VARCHAR(20) NOT NULL,
            sources      TEXT NOT NULL,
            enabled      TINYINT(1) NOT NULL DEFAULT 1,
            posted_from  TIMESTAMP NULL,
            last_checked TIMESTAMP NULL,
            created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_guild_channel (guild_id, channel_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS fortnite_feed_seen (
            guild_id VARCHAR(20)  NOT NULL,
            source   VARCHAR(32)  NOT NULL,
            item_id  VARCHAR(255) NOT NULL,
            seen_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, source, item_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}
export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS fortnite_feed_seen');
    await db.execute('DROP TABLE IF EXISTS fortnite_feeds');
}
