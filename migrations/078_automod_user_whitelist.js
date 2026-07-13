export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS automod_user_whitelist (
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            added_by VARCHAR(20) DEFAULT NULL,
            reason VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS automod_user_whitelist');
}
