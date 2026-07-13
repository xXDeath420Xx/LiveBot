export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS birthday_cards (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            birthday_month INT NOT NULL,
            birthday_day INT NOT NULL,
            share_token VARCHAR(32) NOT NULL UNIQUE,
            card_theme VARCHAR(50) DEFAULT 'birthday',
            card_background_url TEXT,
            is_posted TINYINT(1) DEFAULT 0,
            posted_message_id VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild_user (guild_id, user_id),
            INDEX idx_share_token (share_token),
            INDEX idx_birthday (birthday_month, birthday_day)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS birthday_card_signatures (
            id INT AUTO_INCREMENT PRIMARY KEY,
            card_id INT NOT NULL,
            signer_user_id VARCHAR(20) NOT NULL,
            signer_username VARCHAR(100),
            signer_avatar_url VARCHAR(512),
            message TEXT NOT NULL,
            gif_url VARCHAR(512),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (card_id) REFERENCES birthday_cards(id) ON DELETE CASCADE,
            UNIQUE KEY unique_signer (card_id, signer_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[Migration 068] Created birthday_cards and birthday_card_signatures tables');
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS birthday_card_signatures');
    await db.execute('DROP TABLE IF EXISTS birthday_cards');
    console.log('[Migration 068] Dropped birthday card tables');
}
