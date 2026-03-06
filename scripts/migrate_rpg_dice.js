import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function migrate() {
    console.log('Starting RPG Dice System Migration (Phase 1)...\n');

    const migrations = [
        // Dice roll history table
        {
            name: 'dnd_dice_rolls table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_dice_rolls (
                roll_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NULL,
                user_id VARCHAR(20) NOT NULL,
                guild_id VARCHAR(20) NOT NULL,
                roll_type ENUM('attack', 'damage', 'saving_throw', 'skill_check', 'initiative', 'spell', 'ability', 'custom') NOT NULL DEFAULT 'custom',
                dice_notation VARCHAR(50) NOT NULL,
                individual_rolls JSON NOT NULL,
                modifier INT DEFAULT 0,
                total_result INT NOT NULL,
                advantage_status ENUM('normal', 'advantage', 'disadvantage') DEFAULT 'normal',
                is_critical BOOLEAN DEFAULT FALSE,
                is_fumble BOOLEAN DEFAULT FALSE,
                dc INT NULL,
                success BOOLEAN NULL,
                context VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_character (character_id),
                INDEX idx_user (user_id),
                INDEX idx_guild (guild_id),
                INDEX idx_type (roll_type),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Add passive skill columns to characters if not exists
        {
            name: 'passive_perception column',
            sql: `ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS passive_perception INT DEFAULT 10 AFTER senses`
        },
        {
            name: 'passive_insight column',
            sql: `ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS passive_insight INT DEFAULT 10 AFTER passive_perception`
        },
        {
            name: 'passive_investigation column',
            sql: `ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS passive_investigation INT DEFAULT 10 AFTER passive_insight`
        }
    ];

    let success = 0;
    let failed = 0;

    for (const migration of migrations) {
        try {
            // Check if table exists for CREATE TABLE
            if (migration.sql.includes('CREATE TABLE IF NOT EXISTS')) {
                const tableName = migration.sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1];
                const [existing] = await pool.execute(
                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                    [process.env.DB_NAME, tableName]
                );
                if (existing.length > 0) {
                    console.log(`  ⏭️  Table '${tableName}' already exists, skipping`);
                    continue;
                }
            }

            // Check if column exists for ALTER TABLE ADD COLUMN
            if (migration.sql.includes('ADD COLUMN IF NOT EXISTS')) {
                const columnMatch = migration.sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/);
                if (columnMatch) {
                    const columnName = columnMatch[1];
                    const [existing] = await pool.execute(
                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'dnd_characters' AND COLUMN_NAME = ?",
                        [process.env.DB_NAME, columnName]
                    );
                    if (existing.length > 0) {
                        console.log(`  ⏭️  Column '${columnName}' already exists, skipping`);
                        continue;
                    }
                    // Remove IF NOT EXISTS for MySQL compatibility
                    migration.sql = migration.sql.replace(' IF NOT EXISTS', '');
                }
            }

            await pool.execute(migration.sql);
            console.log(`  ✅ ${migration.name}`);
            success++;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_TABLE_EXISTS_ERROR') {
                console.log(`  ⏭️  ${migration.name} already exists`);
            } else {
                console.error(`  ❌ ${migration.name}: ${error.message}`);
                failed++;
            }
        }
    }

    console.log('\n--- Migration Summary ---');
    console.log(`  Success: ${success}`);
    console.log(`  Failed: ${failed}`);

    // Show dice_rolls table structure
    try {
        const [columns] = await pool.execute('DESCRIBE dnd_dice_rolls');
        console.log('\n--- dnd_dice_rolls Schema ---');
        columns.forEach(col => {
            console.log(`  ${col.Field}: ${col.Type}`);
        });
    } catch (e) {
        console.log('\nCould not describe dnd_dice_rolls table');
    }

    await pool.end();
    console.log('\nMigration complete!');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
