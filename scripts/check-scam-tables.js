import pool from '../utils/db.js';

async function checkTables() {
    try {
        // Check if scam_reports table exists
        const [tables] = await pool.execute(
            "SHOW TABLES LIKE 'scam_reports'"
        );

        if (tables.length === 0) {
            console.log('Creating scam_reports table...');
            await pool.execute(`
                CREATE TABLE scam_reports (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(32) NOT NULL,
                    reporter_id VARCHAR(32) NOT NULL,
                    reported_user_id VARCHAR(32),
                    reported_user_tag VARCHAR(128),
                    reported_vendor_name VARCHAR(256),
                    reported_vendor_website VARCHAR(512),
                    report_type ENUM('user', 'vendor') NOT NULL,
                    scam_type VARCHAR(64),
                    description TEXT NOT NULL,
                    evidence_urls TEXT,
                    loss_amount VARCHAR(100),
                    status ENUM('pending', 'investigating', 'confirmed', 'dismissed') DEFAULT 'pending',
                    resolved_by VARCHAR(32),
                    resolved_at DATETIME,
                    staff_notes TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_guild (guild_id),
                    INDEX idx_reported_user (reported_user_id),
                    INDEX idx_status (status)
                )
            `);
            console.log('scam_reports table created!');
        } else {
            console.log('scam_reports table already exists');
        }

        // Check if scammer_watchlist table exists
        const [watchlistTables] = await pool.execute(
            "SHOW TABLES LIKE 'scammer_watchlist'"
        );

        if (watchlistTables.length === 0) {
            console.log('Creating scammer_watchlist table...');
            await pool.execute(`
                CREATE TABLE scammer_watchlist (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(32) NOT NULL,
                    entry_type ENUM('user', 'vendor') NOT NULL,
                    discord_id VARCHAR(32),
                    name VARCHAR(256) NOT NULL,
                    website VARCHAR(512),
                    reason TEXT NOT NULL,
                    reported_by VARCHAR(32),
                    report_id INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_user (guild_id, discord_id),
                    INDEX idx_guild (guild_id),
                    INDEX idx_entry_type (entry_type)
                )
            `);
            console.log('scammer_watchlist table created!');
        } else {
            console.log('scammer_watchlist table already exists');
        }

        console.log('All tables verified!');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTables();
