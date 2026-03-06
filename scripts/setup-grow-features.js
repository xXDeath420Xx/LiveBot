/**
 * Setup grow community features - strain database, seedbanks, grow timers, etc.
 */

import pool from '../utils/db.js';
import 'dotenv/config';

async function setup() {
    console.log('🌱 Setting up grow community features...\n');

    // Strain Database
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS strain_database (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32),
            user_id VARCHAR(32) NOT NULL,
            name VARCHAR(100) NOT NULL,
            breeder VARCHAR(100) NOT NULL,
            type ENUM('indica', 'sativa', 'hybrid', 'indica_dominant', 'sativa_dominant') NOT NULL,
            flower_days INT NOT NULL,
            difficulty TINYINT NOT NULL,
            effects VARCHAR(255),
            flavors VARCHAR(255),
            thc_range VARCHAR(20),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild (guild_id),
            INDEX idx_name (name)
        )
    `);
    console.log('✅ Created strain_database table');

    // Seed Bank Directory
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS seedbank_directory (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32),
            user_id VARCHAR(32) NOT NULL,
            name VARCHAR(100) NOT NULL,
            website VARCHAR(255),
            ships_to VARCHAR(255),
            payment_methods VARCHAR(255),
            rating TINYINT DEFAULT 5,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild (guild_id),
            INDEX idx_name (name)
        )
    `);
    console.log('✅ Created seedbank_directory table');

    // Grow Timers
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS grow_timers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            user_id VARCHAR(32) NOT NULL,
            strain_name VARCHAR(100) NOT NULL,
            start_date DATE NOT NULL,
            flip_date DATE,
            expected_harvest DATE,
            stage ENUM('seedling', 'veg', 'flower', 'harvest', 'complete') DEFAULT 'seedling',
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user (user_id),
            INDEX idx_guild (guild_id)
        )
    `);
    console.log('✅ Created grow_timers table');

    // Mentor System
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS mentors (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            user_id VARCHAR(32) NOT NULL,
            specialties VARCHAR(255),
            available TINYINT DEFAULT 1,
            mentee_count INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_mentor (guild_id, user_id)
        )
    `);
    console.log('✅ Created mentors table');

    // Grow Competitions
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS grow_competitions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            channel_id VARCHAR(32) NOT NULL,
            message_id VARCHAR(32),
            title VARCHAR(100) NOT NULL,
            description TEXT,
            start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            end_date TIMESTAMP NOT NULL,
            is_active TINYINT DEFAULT 1,
            winner_user_id VARCHAR(32),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('✅ Created grow_competitions table');

    // Competition Entries
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS competition_entries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            competition_id INT NOT NULL,
            user_id VARCHAR(32) NOT NULL,
            image_url VARCHAR(500) NOT NULL,
            description TEXT,
            votes INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_entry (competition_id, user_id),
            FOREIGN KEY (competition_id) REFERENCES grow_competitions(id) ON DELETE CASCADE
        )
    `);
    console.log('✅ Created competition_entries table');

    // Scheduled Tips
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS grow_tips (
            id INT AUTO_INCREMENT PRIMARY KEY,
            category VARCHAR(50) NOT NULL,
            title VARCHAR(100) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('✅ Created grow_tips table');

    // Insert some default grow tips
    const tips = [
        ['watering', 'The Lift Test', 'Lift your pots to judge when to water. A light pot needs water, a heavy pot can wait. This prevents overwatering - the #1 newbie mistake!'],
        ['nutrients', 'Less is More', 'Start at 1/4 strength nutrients and work up. You can always add more, but you can\'t take it back. Watch for burnt tips!'],
        ['environment', 'VPD Matters', 'Vapor Pressure Deficit affects how your plants drink. Use /grow vpd to calculate yours. Ideal VPD = happy plants!'],
        ['lighting', 'DLI Over PPFD', 'Daily Light Integral (total light per day) matters more than peak intensity. Use /grow dli to optimize your light schedule.'],
        ['training', 'Top Early', 'Topping during veg creates multiple colas. Wait until the plant has 5-6 nodes, then cut above the 3rd or 4th.'],
        ['harvest', 'Check Trichomes', 'Milky trichomes = peak THC. Amber trichomes = more body/couch lock. Get a jeweler\'s loupe or digital microscope!'],
        ['drying', 'Low and Slow', 'Dry at 60°F/60% humidity for 10-14 days. Rushing the dry ruins months of work. Patience pays off!'],
        ['curing', 'Burp Those Jars', 'Cure in mason jars at 62% RH. Burp 2-3x daily for week 1, then once daily. Minimum 2-4 week cure for best results.'],
        ['ph', 'pH is Everything', 'Most deficiencies are actually pH lockout. Soil: 6.0-7.0, Hydro/Coco: 5.5-6.5. Check every feeding!'],
        ['genetics', 'Start with Good Genetics', 'You can\'t grow fire from mid seeds. Invest in quality genetics from reputable breeders.']
    ];

    for (const [category, title, content] of tips) {
        await pool.execute(
            'INSERT IGNORE INTO grow_tips (category, title, content) VALUES (?, ?, ?)',
            [category, title, content]
        ).catch(() => {});
    }
    console.log('✅ Added default grow tips');

    // Server Stats
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS server_stats (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            date DATE NOT NULL,
            member_count INT DEFAULT 0,
            message_count INT DEFAULT 0,
            new_members INT DEFAULT 0,
            active_users INT DEFAULT 0,
            UNIQUE KEY unique_day (guild_id, date)
        )
    `);
    console.log('✅ Created server_stats table');

    console.log('\n🎉 All grow features ready!');
    process.exit(0);
}

setup().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
