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
    console.log('Starting AI Dungeon Master Migration (Phase 10)...\n');

    const migrations = [
        // Campaign Management
        {
            name: 'dnd_campaigns table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_campaigns (
                campaign_id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                campaign_name VARCHAR(100) NOT NULL,
                dm_user_id VARCHAR(20),
                campaign_type ENUM('homebrew', 'official', 'hybrid') DEFAULT 'homebrew',
                module_id VARCHAR(100) NULL,
                setting VARCHAR(255) DEFAULT 'Forgotten Realms',
                theme VARCHAR(255) DEFAULT 'classic fantasy',
                difficulty ENUM('easy', 'normal', 'hard', 'deadly') DEFAULT 'normal',
                current_chapter INT DEFAULT 1,
                session_count INT DEFAULT 0,
                status ENUM('setup', 'active', 'paused', 'completed', 'abandoned') DEFAULT 'setup',
                max_players INT DEFAULT 4,
                world_seed TEXT,
                ai_personality TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_session_at TIMESTAMP NULL,
                INDEX idx_guild (guild_id),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Campaign World State
        {
            name: 'dnd_world_state table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_world_state (
                state_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                state_key VARCHAR(100) NOT NULL,
                state_value JSON NOT NULL,
                state_type ENUM('location', 'npc', 'faction', 'quest', 'event', 'item', 'secret', 'custom') NOT NULL,
                is_revealed BOOLEAN DEFAULT FALSE,
                importance ENUM('minor', 'moderate', 'major', 'critical') DEFAULT 'moderate',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_campaign (campaign_id),
                INDEX idx_type (state_type),
                UNIQUE KEY uk_campaign_key (campaign_id, state_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Campaign NPCs
        {
            name: 'dnd_campaign_npcs table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_campaign_npcs (
                npc_id INT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                npc_name VARCHAR(100) NOT NULL,
                npc_type ENUM('ally', 'neutral', 'hostile', 'merchant', 'quest_giver', 'boss', 'companion') DEFAULT 'neutral',
                race VARCHAR(50),
                occupation VARCHAR(100),
                personality JSON,
                appearance TEXT,
                backstory TEXT,
                stats JSON,
                location VARCHAR(255),
                relationship_scores JSON,
                knowledge JSON,
                is_alive BOOLEAN DEFAULT TRUE,
                is_active BOOLEAN DEFAULT TRUE,
                dialogue_history JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_campaign (campaign_id),
                INDEX idx_type (npc_type),
                INDEX idx_location (location)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Campaign Players
        {
            name: 'dnd_campaign_players table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_campaign_players (
                id INT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                character_id INT NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                role ENUM('player', 'co_dm') DEFAULT 'player',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                story_notes TEXT,
                personal_quests JSON,
                INDEX idx_campaign (campaign_id),
                INDEX idx_character (character_id),
                INDEX idx_user (user_id),
                UNIQUE KEY uk_campaign_character (campaign_id, character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Sessions
        {
            name: 'dnd_sessions table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_sessions (
                session_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                session_number INT NOT NULL,
                title VARCHAR(255),
                summary TEXT,
                story_context JSON,
                current_location VARCHAR(255),
                current_scene TEXT,
                active_quests JSON,
                combat_state JSON,
                environment JSON,
                status ENUM('active', 'paused', 'ended') DEFAULT 'active',
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP NULL,
                message_count INT DEFAULT 0,
                INDEX idx_campaign (campaign_id),
                INDEX idx_status (status),
                INDEX idx_campaign_session (campaign_id, session_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Session Messages
        {
            name: 'dnd_session_messages table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_session_messages (
                message_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                session_id BIGINT NOT NULL,
                message_type ENUM('dm_narration', 'player_action', 'player_dialogue', 'combat', 'roll_result', 'system', 'ooc') NOT NULL,
                character_id INT NULL,
                user_id VARCHAR(20) NULL,
                content TEXT NOT NULL,
                metadata JSON,
                is_important BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_session (session_id),
                INDEX idx_type (message_type),
                INDEX idx_session_time (session_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Campaign Quests
        {
            name: 'dnd_campaign_quests table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_campaign_quests (
                quest_id INT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                quest_name VARCHAR(255) NOT NULL,
                quest_type ENUM('main', 'side', 'personal', 'hidden', 'faction') DEFAULT 'main',
                description TEXT,
                objectives JSON,
                rewards JSON,
                giver_npc_id INT NULL,
                location VARCHAR(255),
                difficulty ENUM('easy', 'medium', 'hard', 'deadly') DEFAULT 'medium',
                status ENUM('unknown', 'available', 'active', 'completed', 'failed', 'abandoned') DEFAULT 'unknown',
                progress INT DEFAULT 0,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL,
                INDEX idx_campaign (campaign_id),
                INDEX idx_status (status),
                INDEX idx_type (quest_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Campaign Modules (Official Adventures)
        {
            name: 'dnd_campaign_modules table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_campaign_modules (
                module_id VARCHAR(100) PRIMARY KEY,
                module_name VARCHAR(255) NOT NULL,
                description TEXT,
                min_level INT DEFAULT 1,
                max_level INT DEFAULT 5,
                estimated_sessions INT DEFAULT 10,
                setting VARCHAR(100) DEFAULT 'Forgotten Realms',
                content JSON,
                is_active BOOLEAN DEFAULT TRUE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Combat Encounters (for AI DM managed battles)
        {
            name: 'dnd_dm_encounters table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_dm_encounters (
                encounter_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                session_id BIGINT NOT NULL,
                campaign_id INT NOT NULL,
                encounter_name VARCHAR(255),
                encounter_type ENUM('combat', 'social', 'exploration', 'puzzle', 'trap', 'boss') DEFAULT 'combat',
                enemies JSON,
                allies JSON,
                environment TEXT,
                initiative_order JSON,
                current_round INT DEFAULT 0,
                current_turn INT DEFAULT 0,
                status ENUM('setup', 'active', 'victory', 'defeat', 'fled', 'resolved') DEFAULT 'setup',
                loot JSON,
                exp_reward INT DEFAULT 0,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP NULL,
                INDEX idx_session (session_id),
                INDEX idx_campaign (campaign_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Locations (generated/tracked locations)
        {
            name: 'dnd_campaign_locations table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_campaign_locations (
                location_id INT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                location_name VARCHAR(255) NOT NULL,
                location_type ENUM('city', 'town', 'village', 'dungeon', 'wilderness', 'building', 'room', 'landmark') DEFAULT 'town',
                parent_location_id INT NULL,
                description TEXT,
                atmosphere TEXT,
                notable_features JSON,
                npcs_present JSON,
                connections JSON,
                is_discovered BOOLEAN DEFAULT FALSE,
                is_safe BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_campaign (campaign_id),
                INDEX idx_parent (parent_location_id),
                INDEX idx_type (location_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // Add campaign_id to characters for tracking
        {
            name: 'active_campaign_id column on characters',
            sql: `ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS active_campaign_id INT NULL`
        },

        // Seed official campaign modules
        {
            name: 'seed Lost Mine of Phandelver module',
            sql: `INSERT IGNORE INTO dnd_campaign_modules (module_id, module_name, description, min_level, max_level, estimated_sessions, setting, content) VALUES
                ('lmop', 'Lost Mine of Phandelver', 'The classic D&D Starter Set adventure. Explore the town of Phandalin and uncover the secrets of Wave Echo Cave.', 1, 5, 8, 'Sword Coast', '{"chapters": ["Goblin Arrows", "Phandalin", "The Spider\\'s Web", "Wave Echo Cave"], "starting_location": "Neverwinter", "villain": "The Black Spider"}'),
                ('doip', 'Dragon of Icespire Peak', 'Face the threat of a young white dragon terrorizing the region around Phandalin.', 1, 6, 10, 'Sword Coast', '{"chapters": ["Phandalin Quests", "Follow-Up Quests", "Icespire Peak"], "starting_location": "Phandalin", "villain": "Cryovain"}'),
                ('cos', 'Curse of Strahd', 'Gothic horror adventure in the dark realm of Barovia, ruled by the vampire lord Strahd von Zarovich.', 1, 10, 20, 'Barovia', '{"chapters": ["Into the Mists", "Village of Barovia", "Vallaki", "Castle Ravenloft"], "starting_location": "Village of Barovia", "villain": "Strahd von Zarovich"}'),
                ('toa', 'Tomb of Annihilation', 'Journey through the deadly jungles of Chult to stop a death curse affecting the entire world.', 1, 11, 25, 'Chult', '{"chapters": ["Port Nyanzaru", "The Jungle", "Omu", "Tomb of the Nine Gods"], "starting_location": "Port Nyanzaru", "villain": "Acererak"}')`
        }
    ];

    let success = 0;
    let failed = 0;
    let skipped = 0;

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
                    skipped++;
                    continue;
                }
            }

            // Check if column exists for ALTER TABLE ADD COLUMN
            if (migration.sql.includes('ADD COLUMN IF NOT EXISTS')) {
                const columnMatch = migration.sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/);
                if (columnMatch) {
                    const columnName = columnMatch[1];
                    const tableMatch = migration.sql.match(/ALTER TABLE (\w+)/);
                    const tableName = tableMatch ? tableMatch[1] : 'dnd_characters';
                    const [existing] = await pool.execute(
                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                        [process.env.DB_NAME, tableName, columnName]
                    );
                    if (existing.length > 0) {
                        console.log(`  ⏭️  Column '${columnName}' already exists, skipping`);
                        skipped++;
                        continue;
                    }
                    migration.sql = migration.sql.replace(' IF NOT EXISTS', '');
                }
            }

            await pool.execute(migration.sql);
            console.log(`  ✅ ${migration.name}`);
            success++;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_TABLE_EXISTS_ERROR' || error.code === 'ER_DUP_ENTRY') {
                console.log(`  ⏭️  ${migration.name} already exists`);
                skipped++;
            } else {
                console.error(`  ❌ ${migration.name}: ${error.message}`);
                failed++;
            }
        }
    }

    console.log('\n--- Migration Summary ---');
    console.log(`  Success: ${success}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Failed: ${failed}`);

    // Show new tables
    console.log('\n--- AI DM Tables Created ---');
    const aiDmTables = [
        'dnd_campaigns', 'dnd_world_state', 'dnd_campaign_npcs',
        'dnd_campaign_players', 'dnd_sessions', 'dnd_session_messages',
        'dnd_campaign_quests', 'dnd_campaign_modules', 'dnd_dm_encounters',
        'dnd_campaign_locations'
    ];

    for (const table of aiDmTables) {
        try {
            const [rows] = await pool.execute(`SELECT COUNT(*) as count FROM ${table}`);
            console.log(`  ${table}: ${rows[0].count} rows`);
        } catch (e) {
            console.log(`  ${table}: not found`);
        }
    }

    await pool.end();
    console.log('\nAI DM Migration complete!');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
