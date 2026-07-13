export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS custom_embeds (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) DEFAULT NULL,
            title VARCHAR(256),
            description TEXT,
            color VARCHAR(7) DEFAULT '#a78bfa',
            thumbnail_url VARCHAR(2048),
            image_url VARCHAR(2048),
            footer_text VARCHAR(2048),
            author_name VARCHAR(256),
            author_icon_url VARCHAR(2048),
            url VARCHAR(2048),
            created_by VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_guild (guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[Migration 066] Created custom_embeds table');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS custom_embeds');
    console.log('[Migration 066] Dropped custom_embeds table');
}
