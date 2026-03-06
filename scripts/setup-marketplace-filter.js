/**
 * Setup marketplace account age filter
 */

import pool from '../utils/db.js';
import 'dotenv/config';

async function setup() {
    console.log('🔧 Setting up marketplace filter...\n');

    // Create table
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS marketplace_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            account_age_filter TINYINT DEFAULT 1,
            min_account_age_days INT DEFAULT 7,
            trader_role_bypass TINYINT DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_guild (guild_id)
        )
    `);
    console.log('✅ Created marketplace_settings table');

    // Insert default for Growmies server
    await pool.execute(`
        INSERT IGNORE INTO marketplace_settings (guild_id, account_age_filter, min_account_age_days, trader_role_bypass)
        VALUES ('1452972683867459657', 1, 7, 1)
    `);
    console.log('✅ Added Growmies server settings (7 day minimum)');

    console.log('\n🎉 Marketplace filter ready!');
    console.log('• New accounts (<7 days) blocked from marketplace channels');
    console.log('• Messages deleted + user warned');
    console.log('• Actions logged to mod-log channel');

    process.exit(0);
}

setup().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
