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
    console.log('Starting D&D Beyond full character migration...\n');

    const alterations = [
        // Core D&D Beyond fields
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS subclass VARCHAR(100) DEFAULT NULL AFTER class",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS species VARCHAR(50) DEFAULT NULL AFTER subclass",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS background VARCHAR(100) DEFAULT NULL AFTER species",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS alignment VARCHAR(50) DEFAULT NULL AFTER background",

        // Combat stats
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS armor_class INT DEFAULT 10 AFTER charisma",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS speed VARCHAR(100) DEFAULT '30 ft.' AFTER armor_class",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS initiative INT DEFAULT 0 AFTER speed",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS proficiency_bonus INT DEFAULT 2 AFTER initiative",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS hit_dice VARCHAR(50) DEFAULT NULL AFTER proficiency_bonus",

        // Saving throws (store as JSON - which ones are proficient)
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS saving_throws JSON DEFAULT NULL AFTER hit_dice",

        // Skills proficiencies (JSON array of proficient skills)
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS skill_proficiencies JSON DEFAULT NULL AFTER saving_throws",

        // Languages and proficiencies
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS languages JSON DEFAULT NULL AFTER skill_proficiencies",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS weapon_proficiencies JSON DEFAULT NULL AFTER languages",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS armor_proficiencies JSON DEFAULT NULL AFTER weapon_proficiencies",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS tool_proficiencies JSON DEFAULT NULL AFTER armor_proficiencies",

        // Features and traits (JSON array of features)
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS features JSON DEFAULT NULL AFTER tool_proficiencies",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS racial_traits JSON DEFAULT NULL AFTER features",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS class_features JSON DEFAULT NULL AFTER racial_traits",

        // Spellcasting
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS spellcasting_ability VARCHAR(20) DEFAULT NULL AFTER class_features",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS spell_save_dc INT DEFAULT NULL AFTER spellcasting_ability",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS spell_attack_bonus INT DEFAULT NULL AFTER spell_save_dc",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS spell_slots JSON DEFAULT NULL AFTER spell_attack_bonus",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS spells_known JSON DEFAULT NULL AFTER spell_slots",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS cantrips JSON DEFAULT NULL AFTER spells_known",

        // Sorcery points, ki, etc.
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS class_resource VARCHAR(50) DEFAULT NULL AFTER cantrips",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS class_resource_max INT DEFAULT 0 AFTER class_resource",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS class_resource_current INT DEFAULT 0 AFTER class_resource_max",

        // Character details / roleplay
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS personality_traits TEXT DEFAULT NULL AFTER class_resource_current",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS ideals TEXT DEFAULT NULL AFTER personality_traits",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS bonds TEXT DEFAULT NULL AFTER ideals",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS flaws TEXT DEFAULT NULL AFTER bonds",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS backstory TEXT DEFAULT NULL AFTER flaws",

        // Physical description
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS age VARCHAR(50) DEFAULT NULL AFTER backstory",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS height VARCHAR(50) DEFAULT NULL AFTER age",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS weight VARCHAR(50) DEFAULT NULL AFTER height",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS eyes VARCHAR(50) DEFAULT NULL AFTER weight",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS skin VARCHAR(50) DEFAULT NULL AFTER eyes",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS hair VARCHAR(50) DEFAULT NULL AFTER skin",

        // Defenses and conditions
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS resistances JSON DEFAULT NULL AFTER hair",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS immunities JSON DEFAULT NULL AFTER resistances",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS vulnerabilities JSON DEFAULT NULL AFTER immunities",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS senses JSON DEFAULT NULL AFTER vulnerabilities",

        // Actions (attacks, etc.)
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS attacks JSON DEFAULT NULL AFTER senses",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS actions JSON DEFAULT NULL AFTER attacks",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS bonus_actions JSON DEFAULT NULL AFTER actions",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS reactions JSON DEFAULT NULL AFTER bonus_actions",

        // Player name from PDF
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS player_name VARCHAR(100) DEFAULT NULL AFTER character_name",

        // Equipment (JSON for detailed equipment from PDF)
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS equipment JSON DEFAULT NULL AFTER reactions",

        // Currency breakdown
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS copper INT DEFAULT 0 AFTER gold",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS silver INT DEFAULT 0 AFTER copper",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS electrum INT DEFAULT 0 AFTER silver",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS platinum INT DEFAULT 0 AFTER electrum",

        // Temp HP and death saves
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS temp_hp INT DEFAULT 0 AFTER max_health",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS death_save_successes INT DEFAULT 0 AFTER platinum",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS death_save_failures INT DEFAULT 0 AFTER death_save_successes",

        // Heroic Inspiration
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS inspiration BOOLEAN DEFAULT FALSE AFTER death_save_failures",

        // Multiclass support (JSON array of {class, subclass, level})
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS multiclass JSON DEFAULT NULL AFTER class",

        // PDF import metadata
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS imported_from VARCHAR(50) DEFAULT NULL AFTER created_at",
        "ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS import_data JSON DEFAULT NULL AFTER imported_from"
    ];

    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const sql of alterations) {
        try {
            // Check if column exists first
            const columnMatch = sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/);
            if (columnMatch) {
                const columnName = columnMatch[1];
                const [existing] = await pool.execute(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'dnd_characters' AND COLUMN_NAME = ?",
                    [process.env.DB_NAME, columnName]
                );

                if (existing.length > 0) {
                    console.log(`  ⏭️  Column '${columnName}' already exists, skipping`);
                    skipped++;
                    continue;
                }
            }

            // Remove "IF NOT EXISTS" since MySQL doesn't support it for columns
            const cleanSql = sql.replace(' IF NOT EXISTS', '');
            await pool.execute(cleanSql);

            const columnMatch2 = cleanSql.match(/ADD COLUMN (\w+)/);
            console.log(`  ✅ Added column '${columnMatch2 ? columnMatch2[1] : 'unknown'}'`);
            success++;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME') {
                const columnMatch = sql.match(/ADD COLUMN (?:IF NOT EXISTS )?(\w+)/);
                console.log(`  ⏭️  Column '${columnMatch ? columnMatch[1] : 'unknown'}' already exists`);
                skipped++;
            } else {
                console.error(`  ❌ Error: ${error.message}`);
                console.error(`     SQL: ${sql.substring(0, 80)}...`);
                failed++;
            }
        }
    }

    console.log('\n--- Migration Summary ---');
    console.log(`  Added: ${success}`);
    console.log(`  Skipped (already exist): ${skipped}`);
    console.log(`  Failed: ${failed}`);

    // Show updated schema
    console.log('\n--- Updated Schema ---');
    const [columns] = await pool.execute('DESCRIBE dnd_characters');
    columns.forEach(col => {
        console.log(`  ${col.Field}: ${col.Type}`);
    });

    await pool.end();
    console.log('\nMigration complete!');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
