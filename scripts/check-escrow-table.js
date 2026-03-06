import pool from '../utils/db.js';

async function checkTables() {
    try {
        const [tables] = await pool.execute("SHOW TABLES LIKE 'trade_escrow'");

        if (tables.length === 0) {
            console.log('Creating trade_escrow table...');
            await pool.execute(`
                CREATE TABLE trade_escrow (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(32) NOT NULL,
                    seller_id VARCHAR(32) NOT NULL,
                    buyer_id VARCHAR(32) NOT NULL,
                    trade_description TEXT NOT NULL,
                    seller_offering TEXT NOT NULL,
                    buyer_offering TEXT NOT NULL,
                    agreed_terms TEXT,
                    status ENUM('pending', 'seller_confirmed', 'buyer_confirmed', 'both_confirmed', 'completed', 'cancelled', 'disputed') DEFAULT 'pending',
                    seller_confirmed BOOLEAN DEFAULT FALSE,
                    buyer_confirmed BOOLEAN DEFAULT FALSE,
                    dispute_reason TEXT,
                    resolved_by VARCHAR(32),
                    resolution_notes TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    completed_at DATETIME,
                    INDEX idx_guild (guild_id),
                    INDEX idx_seller (seller_id),
                    INDEX idx_buyer (buyer_id),
                    INDEX idx_status (status)
                )
            `);
            console.log('trade_escrow table created!');
        } else {
            console.log('trade_escrow table already exists');
        }

        // Check for trade_reviews table
        const [reviewTables] = await pool.execute("SHOW TABLES LIKE 'trade_reviews'");

        if (reviewTables.length === 0) {
            console.log('Creating trade_reviews table...');
            await pool.execute(`
                CREATE TABLE trade_reviews (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    trade_id INT NOT NULL,
                    reviewer_id VARCHAR(32) NOT NULL,
                    reviewed_user_id VARCHAR(32) NOT NULL,
                    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
                    review_text TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_review (trade_id, reviewer_id),
                    INDEX idx_reviewed_user (reviewed_user_id),
                    FOREIGN KEY (trade_id) REFERENCES trade_escrow(id) ON DELETE CASCADE
                )
            `);
            console.log('trade_reviews table created!');
        } else {
            console.log('trade_reviews table already exists');
        }

        console.log('Done!');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTables();
