import pool from '../utils/db.js';

async function checkTables() {
    try {
        const [tables] = await pool.execute("SHOW TABLES LIKE 'grow_reminders'");

        if (tables.length === 0) {
            console.log('Creating grow_reminders table...');
            await pool.execute(`
                CREATE TABLE grow_reminders (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(32) NOT NULL,
                    user_id VARCHAR(32) NOT NULL,
                    journal_id INT,
                    reminder_type ENUM('water', 'feed', 'check', 'defoliate', 'train', 'flip', 'harvest', 'custom') NOT NULL,
                    custom_message VARCHAR(256),
                    next_reminder DATETIME NOT NULL,
                    repeat_interval_hours INT,
                    channel_id VARCHAR(32),
                    use_dm BOOLEAN DEFAULT FALSE,
                    is_active BOOLEAN DEFAULT TRUE,
                    last_sent DATETIME,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user (user_id),
                    INDEX idx_next (next_reminder),
                    INDEX idx_active (is_active)
                )
            `);
            console.log('grow_reminders table created!');
        } else {
            console.log('grow_reminders table already exists');
        }

        console.log('Done!');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTables();
