export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS scheduled_purges (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            purge_time VARCHAR(5) NOT NULL DEFAULT '00:00',
            interval_hours INT DEFAULT NULL,
            enabled TINYINT(1) DEFAULT 1,
            last_purge_at TIMESTAMP NULL,
            created_by VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild_channel (guild_id, channel_id),
            INDEX idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[Migration 067] Created scheduled_purges table');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS scheduled_purges');
    console.log('[Migration 067] Dropped scheduled_purges table');
}
