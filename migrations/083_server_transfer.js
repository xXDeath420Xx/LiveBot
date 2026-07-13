export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS server_transfers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            from_bot_id VARCHAR(20) NOT NULL,
            to_bot_id VARCHAR(20) NOT NULL,
            status ENUM('pending','validating','transferring','cleaning','completed','failed','aborted') DEFAULT 'pending',
            initiated_by VARCHAR(20) NOT NULL,
            progress JSON DEFAULT NULL,
            error_message TEXT DEFAULT NULL,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP DEFAULT NULL,
            INDEX idx_guild (guild_id),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS server_transfers');
}
