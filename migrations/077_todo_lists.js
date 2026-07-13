export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS todo_lists (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            message_id VARCHAR(20) DEFAULT NULL,
            title VARCHAR(200) NOT NULL DEFAULT 'Task List',
            created_by VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild_channel (guild_id, channel_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS todo_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            list_id INT NOT NULL,
            task TEXT NOT NULL,
            completed TINYINT(1) NOT NULL DEFAULT 0,
            position INT NOT NULL DEFAULT 0,
            added_by VARCHAR(20) NOT NULL,
            completed_by VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP NULL DEFAULT NULL,
            FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
            INDEX idx_list_position (list_id, position)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS todo_items');
    await db.execute('DROP TABLE IF EXISTS todo_lists');
}
