import pool from '../utils/db.js';

async function checkTables() {
    try {
        const [tables] = await pool.execute("SHOW TABLES LIKE 'grow_harvest_stats'");

        if (tables.length === 0) {
            console.log('Creating grow_harvest_stats table...');
            await pool.execute(`
                CREATE TABLE grow_harvest_stats (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(32) NOT NULL,
                    user_id VARCHAR(32) NOT NULL,
                    journal_id INT,
                    strain_name VARCHAR(128),
                    wet_weight VARCHAR(64),
                    dry_weight VARCHAR(64),
                    quality_rating INT,
                    notes TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_guild (guild_id),
                    INDEX idx_user (user_id),
                    UNIQUE KEY unique_journal (journal_id)
                )
            `);
            console.log('grow_harvest_stats table created!');
        } else {
            console.log('grow_harvest_stats table already exists');
        }

        console.log('Done!');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTables();
