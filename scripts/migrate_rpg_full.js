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
    console.log('Starting Full RPG System Migration (Phases 2-9)...\n');

    const migrations = [
        // ==================== PHASE 2: ENHANCED COMBAT ====================
        {
            name: 'dnd_combat_sessions table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_combat_sessions (
                combat_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                campaign_id INT NULL,
                session_id BIGINT NULL,
                combat_name VARCHAR(255),
                combat_type ENUM('pve', 'pvp', 'dungeon', 'boss') DEFAULT 'pve',
                initiative_order JSON,
                current_turn INT DEFAULT 0,
                current_round INT DEFAULT 1,
                status ENUM('setup', 'active', 'victory', 'defeat', 'fled', 'ended') DEFAULT 'setup',
                environment TEXT,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP NULL,
                INDEX idx_guild (guild_id),
                INDEX idx_campaign (campaign_id),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_combat_participants table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_combat_participants (
                participant_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                combat_id BIGINT NOT NULL,
                participant_type ENUM('player', 'enemy', 'ally', 'npc') NOT NULL,
                character_id INT NULL,
                enemy_id INT NULL,
                name VARCHAR(100) NOT NULL,
                initiative_roll INT DEFAULT 0,
                initiative_bonus INT DEFAULT 0,
                current_hp INT NOT NULL,
                max_hp INT NOT NULL,
                temp_hp INT DEFAULT 0,
                armor_class INT DEFAULT 10,
                turn_order INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                conditions JSON,
                action_used BOOLEAN DEFAULT FALSE,
                bonus_action_used BOOLEAN DEFAULT FALSE,
                reaction_used BOOLEAN DEFAULT FALSE,
                movement_used INT DEFAULT 0,
                concentration_spell_id INT NULL,
                death_saves_success INT DEFAULT 0,
                death_saves_failure INT DEFAULT 0,
                INDEX idx_combat (combat_id),
                INDEX idx_character (character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_combat_log table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_combat_log (
                log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                combat_id BIGINT NOT NULL,
                round INT NOT NULL,
                turn INT NOT NULL,
                actor_id BIGINT NOT NULL,
                action_type ENUM('attack', 'spell', 'ability', 'item', 'move', 'dodge', 'dash', 'disengage', 'help', 'hide', 'ready', 'other') NOT NULL,
                target_ids JSON,
                description TEXT,
                roll_data JSON,
                damage_dealt INT DEFAULT 0,
                healing_done INT DEFAULT 0,
                conditions_applied JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_combat (combat_id),
                INDEX idx_round (combat_id, round)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // ==================== PHASE 3: CONDITIONS ====================
        {
            name: 'dnd_conditions table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_conditions (
                condition_id INT AUTO_INCREMENT PRIMARY KEY,
                condition_name VARCHAR(50) UNIQUE NOT NULL,
                description TEXT,
                mechanical_effects JSON,
                icon_emoji VARCHAR(50),
                is_custom BOOLEAN DEFAULT FALSE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_active_conditions table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_active_conditions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NULL,
                participant_id BIGINT NULL,
                condition_id INT NOT NULL,
                combat_id BIGINT NULL,
                source VARCHAR(255),
                stacks INT DEFAULT 1,
                duration_rounds INT NULL,
                duration_minutes INT NULL,
                save_dc INT NULL,
                save_type VARCHAR(20) NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NULL,
                INDEX idx_character (character_id),
                INDEX idx_participant (participant_id),
                INDEX idx_combat (combat_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'seed standard D&D conditions',
            sql: `INSERT IGNORE INTO dnd_conditions (condition_name, description, mechanical_effects, icon_emoji) VALUES
                ('blinded', 'A blinded creature can\\'t see and automatically fails any ability check that requires sight.', '{"attack_disadvantage": true, "attacks_against_advantage": true, "auto_fail_sight_checks": true}', '🙈'),
                ('charmed', 'A charmed creature can\\'t attack the charmer or target the charmer with harmful abilities or magical effects.', '{"cannot_attack_source": true, "source_has_advantage_on_social": true}', '💕'),
                ('deafened', 'A deafened creature can\\'t hear and automatically fails any ability check that requires hearing.', '{"auto_fail_hearing_checks": true}', '🔇'),
                ('frightened', 'A frightened creature has disadvantage on ability checks and attack rolls while the source of its fear is within line of sight.', '{"attack_disadvantage": true, "ability_check_disadvantage": true, "cannot_willingly_move_closer": true}', '😨'),
                ('grappled', 'A grappled creature\\'s speed becomes 0, and it can\\'t benefit from any bonus to its speed.', '{"speed_zero": true}', '🤼'),
                ('incapacitated', 'An incapacitated creature can\\'t take actions or reactions.', '{"no_actions": true, "no_reactions": true}', '😵'),
                ('invisible', 'An invisible creature is impossible to see without the aid of magic or a special sense.', '{"attack_advantage": true, "attacks_against_disadvantage": true, "auto_fail_sight_checks_against": true}', '👻'),
                ('paralyzed', 'A paralyzed creature is incapacitated and can\\'t move or speak.', '{"incapacitated": true, "speed_zero": true, "no_speech": true, "auto_fail_str_dex_saves": true, "attacks_against_advantage": true, "melee_attacks_auto_crit": true}', '⚡'),
                ('petrified', 'A petrified creature is transformed into a solid inanimate substance.', '{"incapacitated": true, "speed_zero": true, "unaware": true, "resistance_all": true, "immune_poison_disease": true}', '🗿'),
                ('poisoned', 'A poisoned creature has disadvantage on attack rolls and ability checks.', '{"attack_disadvantage": true, "ability_check_disadvantage": true}', '🤢'),
                ('prone', 'A prone creature\\'s only movement option is to crawl. The creature has disadvantage on attack rolls.', '{"attack_disadvantage": true, "melee_attacks_against_advantage": true, "ranged_attacks_against_disadvantage": true, "crawl_only": true}', '🛏️'),
                ('restrained', 'A restrained creature\\'s speed becomes 0, and it can\\'t benefit from any bonus to its speed.', '{"speed_zero": true, "attack_disadvantage": true, "attacks_against_advantage": true, "dex_save_disadvantage": true}', '⛓️'),
                ('stunned', 'A stunned creature is incapacitated, can\\'t move, and can speak only falteringly.', '{"incapacitated": true, "speed_zero": true, "auto_fail_str_dex_saves": true, "attacks_against_advantage": true}', '💫'),
                ('unconscious', 'An unconscious creature is incapacitated, can\\'t move or speak, and is unaware of its surroundings.', '{"incapacitated": true, "speed_zero": true, "no_speech": true, "drop_held": true, "prone": true, "auto_fail_str_dex_saves": true, "attacks_against_advantage": true, "melee_attacks_auto_crit": true}', '💤'),
                ('exhaustion_1', 'Exhaustion Level 1: Disadvantage on ability checks.', '{"ability_check_disadvantage": true, "exhaustion_level": 1}', '😓'),
                ('exhaustion_2', 'Exhaustion Level 2: Speed halved.', '{"ability_check_disadvantage": true, "speed_halved": true, "exhaustion_level": 2}', '😰'),
                ('exhaustion_3', 'Exhaustion Level 3: Disadvantage on attack rolls and saving throws.', '{"ability_check_disadvantage": true, "speed_halved": true, "attack_disadvantage": true, "save_disadvantage": true, "exhaustion_level": 3}', '🥵'),
                ('exhaustion_4', 'Exhaustion Level 4: Hit point maximum halved.', '{"ability_check_disadvantage": true, "speed_halved": true, "attack_disadvantage": true, "save_disadvantage": true, "hp_max_halved": true, "exhaustion_level": 4}', '🤒'),
                ('exhaustion_5', 'Exhaustion Level 5: Speed reduced to 0.', '{"ability_check_disadvantage": true, "speed_zero": true, "attack_disadvantage": true, "save_disadvantage": true, "hp_max_halved": true, "exhaustion_level": 5}', '🛌'),
                ('exhaustion_6', 'Exhaustion Level 6: Death.', '{"death": true, "exhaustion_level": 6}', '💀'),
                ('concentrating', 'Maintaining concentration on a spell.', '{"concentration": true}', '🎯'),
                ('raging', 'Barbarian rage - advantage on STR checks/saves, bonus rage damage, resistance to physical damage.', '{"str_check_advantage": true, "str_save_advantage": true, "rage_damage_bonus": true, "resistance_physical": true}', '😤'),
                ('blessed', 'Add 1d4 to attack rolls and saving throws.', '{"attack_bonus_d4": true, "save_bonus_d4": true}', '✨'),
                ('hexed', 'Take extra 1d6 necrotic damage from caster\\'s attacks, disadvantage on one ability check type.', '{"extra_damage_d6_necrotic": true, "ability_check_disadvantage_type": true}', '🔮')`
        },

        // ==================== PHASE 4: SPELLCASTING ====================
        {
            name: 'dnd_spells table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_spells (
                spell_id INT AUTO_INCREMENT PRIMARY KEY,
                spell_name VARCHAR(100) UNIQUE NOT NULL,
                spell_level INT NOT NULL DEFAULT 0,
                school ENUM('abjuration', 'conjuration', 'divination', 'enchantment', 'evocation', 'illusion', 'necromancy', 'transmutation') NOT NULL,
                casting_time VARCHAR(50) NOT NULL,
                range_type ENUM('self', 'touch', 'ranged', 'sight', 'unlimited') DEFAULT 'ranged',
                range_distance INT NULL,
                components VARCHAR(20),
                material_components TEXT,
                duration VARCHAR(100),
                concentration BOOLEAN DEFAULT FALSE,
                ritual BOOLEAN DEFAULT FALSE,
                description TEXT,
                higher_levels TEXT,
                damage_dice VARCHAR(50),
                damage_type VARCHAR(50),
                healing_dice VARCHAR(50),
                save_type ENUM('str', 'dex', 'con', 'int', 'wis', 'cha') NULL,
                save_effect VARCHAR(100),
                attack_type ENUM('melee', 'ranged') NULL,
                conditions_applied JSON,
                area_type ENUM('cone', 'cube', 'cylinder', 'line', 'sphere', 'square') NULL,
                area_size INT NULL,
                class_list JSON,
                is_srd BOOLEAN DEFAULT TRUE,
                INDEX idx_level (spell_level),
                INDEX idx_school (school)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_character_spells table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_character_spells (
                id INT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NOT NULL,
                spell_id INT NOT NULL,
                spell_source ENUM('class', 'race', 'feat', 'item', 'other') DEFAULT 'class',
                is_prepared BOOLEAN DEFAULT FALSE,
                is_always_prepared BOOLEAN DEFAULT FALSE,
                UNIQUE KEY uk_char_spell (character_id, spell_id),
                INDEX idx_character (character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_spell_slots table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_spell_slots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NOT NULL,
                slot_level INT NOT NULL,
                total_slots INT NOT NULL DEFAULT 0,
                used_slots INT NOT NULL DEFAULT 0,
                UNIQUE KEY uk_char_level (character_id, slot_level),
                INDEX idx_character (character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'add spellcasting columns to characters',
            sql: `ALTER TABLE dnd_characters
                ADD COLUMN IF NOT EXISTS concentration_spell_id INT NULL,
                ADD COLUMN IF NOT EXISTS last_short_rest TIMESTAMP NULL,
                ADD COLUMN IF NOT EXISTS last_long_rest TIMESTAMP NULL`
        },

        // ==================== PHASE 5: CLASS RESOURCES ====================
        {
            name: 'dnd_class_resources table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_class_resources (
                id INT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                resource_name VARCHAR(100) NOT NULL,
                current_value INT DEFAULT 0,
                max_value INT NOT NULL,
                temp_bonus INT DEFAULT 0,
                recharge_on ENUM('short_rest', 'long_rest', 'dawn', 'turn', 'manual') DEFAULT 'long_rest',
                dice_type VARCHAR(20) NULL,
                UNIQUE KEY uk_char_resource (character_id, resource_type),
                INDEX idx_character (character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_class_features table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_class_features (
                feature_id INT AUTO_INCREMENT PRIMARY KEY,
                class_name VARCHAR(50) NOT NULL,
                subclass_name VARCHAR(100) NULL,
                feature_name VARCHAR(100) NOT NULL,
                level_required INT NOT NULL DEFAULT 1,
                description TEXT,
                mechanics JSON,
                resource_type VARCHAR(50) NULL,
                is_passive BOOLEAN DEFAULT FALSE,
                INDEX idx_class (class_name),
                INDEX idx_level (level_required)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // ==================== PHASE 6: PARTY SYSTEM ====================
        {
            name: 'dnd_parties table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_parties (
                party_id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                party_name VARCHAR(100) NOT NULL,
                leader_user_id VARCHAR(20) NOT NULL,
                max_members INT DEFAULT 6,
                status ENUM('forming', 'active', 'in_combat', 'in_dungeon', 'disbanded') DEFAULT 'forming',
                shared_gold INT DEFAULT 0,
                current_activity VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_guild (guild_id),
                INDEX idx_leader (leader_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_party_members table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_party_members (
                id INT AUTO_INCREMENT PRIMARY KEY,
                party_id INT NOT NULL,
                character_id INT NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                role ENUM('leader', 'member') DEFAULT 'member',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uk_party_char (party_id, character_id),
                INDEX idx_party (party_id),
                INDEX idx_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_party_invites table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_party_invites (
                invite_id INT AUTO_INCREMENT PRIMARY KEY,
                party_id INT NOT NULL,
                invited_user_id VARCHAR(20) NOT NULL,
                invited_by_user_id VARCHAR(20) NOT NULL,
                status ENUM('pending', 'accepted', 'declined', 'expired') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NULL,
                INDEX idx_party (party_id),
                INDEX idx_invited (invited_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'add party_id to characters',
            sql: `ALTER TABLE dnd_characters ADD COLUMN IF NOT EXISTS party_id INT NULL`
        },

        // ==================== PHASE 7: DUNGEONS ====================
        {
            name: 'dnd_dungeons table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_dungeons (
                dungeon_id INT AUTO_INCREMENT PRIMARY KEY,
                dungeon_name VARCHAR(100) NOT NULL,
                description TEXT,
                min_level INT DEFAULT 1,
                max_level INT DEFAULT 20,
                recommended_party_size INT DEFAULT 4,
                total_rooms INT NOT NULL,
                difficulty ENUM('easy', 'medium', 'hard', 'deadly') DEFAULT 'medium',
                theme VARCHAR(100),
                reward_exp_base INT DEFAULT 100,
                reward_gold_base INT DEFAULT 50,
                cooldown_hours INT DEFAULT 24,
                is_active BOOLEAN DEFAULT TRUE,
                INDEX idx_level (min_level)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_dungeon_rooms table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_dungeon_rooms (
                room_id INT AUTO_INCREMENT PRIMARY KEY,
                dungeon_id INT NOT NULL,
                room_number INT NOT NULL,
                room_name VARCHAR(100),
                room_type ENUM('entrance', 'combat', 'puzzle', 'trap', 'treasure', 'rest', 'boss', 'exit') NOT NULL,
                description TEXT,
                enemies JSON,
                puzzle_data JSON,
                trap_data JSON,
                loot_table JSON,
                skill_checks JSON,
                INDEX idx_dungeon (dungeon_id),
                UNIQUE KEY uk_dungeon_room (dungeon_id, room_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_dungeon_runs table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_dungeon_runs (
                run_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                dungeon_id INT NOT NULL,
                party_id INT NULL,
                character_id INT NULL,
                guild_id VARCHAR(20) NOT NULL,
                current_room INT DEFAULT 1,
                rooms_cleared JSON,
                status ENUM('active', 'completed', 'failed', 'abandoned') DEFAULT 'active',
                total_exp INT DEFAULT 0,
                total_gold INT DEFAULT 0,
                loot_collected JSON,
                deaths INT DEFAULT 0,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP NULL,
                INDEX idx_dungeon (dungeon_id),
                INDEX idx_party (party_id),
                INDEX idx_character (character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // ==================== PHASE 8: PVP ====================
        {
            name: 'dnd_pvp_matches table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_pvp_matches (
                match_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                challenger_id INT NOT NULL,
                defender_id INT NOT NULL,
                challenger_user_id VARCHAR(20) NOT NULL,
                defender_user_id VARCHAR(20) NOT NULL,
                match_type ENUM('duel', 'ranked', 'tournament') DEFAULT 'duel',
                wager_gold INT DEFAULT 0,
                status ENUM('pending', 'accepted', 'declined', 'active', 'completed', 'cancelled') DEFAULT 'pending',
                winner_id INT NULL,
                combat_id BIGINT NULL,
                elo_change INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP NULL,
                ended_at TIMESTAMP NULL,
                INDEX idx_guild (guild_id),
                INDEX idx_challenger (challenger_id),
                INDEX idx_defender (defender_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_pvp_stats table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_pvp_stats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NOT NULL,
                guild_id VARCHAR(20) NOT NULL,
                elo_rating INT DEFAULT 1000,
                wins INT DEFAULT 0,
                losses INT DEFAULT 0,
                draws INT DEFAULT 0,
                win_streak INT DEFAULT 0,
                best_streak INT DEFAULT 0,
                total_damage_dealt BIGINT DEFAULT 0,
                total_damage_taken BIGINT DEFAULT 0,
                total_gold_won INT DEFAULT 0,
                total_gold_lost INT DEFAULT 0,
                UNIQUE KEY uk_char_guild (character_id, guild_id),
                INDEX idx_elo (guild_id, elo_rating DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },

        // ==================== PHASE 9: LEADERBOARDS & ACHIEVEMENTS ====================
        {
            name: 'dnd_leaderboards table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_leaderboards (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                character_id INT NOT NULL,
                leaderboard_type ENUM('total_exp', 'total_gold', 'monsters_killed', 'dungeons_cleared',
                    'pvp_wins', 'pvp_elo', 'quests_completed', 'bosses_killed', 'deaths',
                    'damage_dealt', 'healing_done', 'crits_rolled') NOT NULL,
                score BIGINT DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_guild_char_type (guild_id, character_id, leaderboard_type),
                INDEX idx_leaderboard (guild_id, leaderboard_type, score DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_achievements table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_achievements (
                achievement_id INT AUTO_INCREMENT PRIMARY KEY,
                achievement_key VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                category ENUM('combat', 'exploration', 'social', 'collection', 'pvp', 'dungeon', 'class', 'general') NOT NULL,
                tier ENUM('bronze', 'silver', 'gold', 'platinum', 'legendary') DEFAULT 'bronze',
                requirement_type VARCHAR(50) NOT NULL,
                requirement_value INT NOT NULL,
                reward_gold INT DEFAULT 0,
                reward_exp INT DEFAULT 0,
                reward_title VARCHAR(100) NULL,
                icon_emoji VARCHAR(50),
                is_hidden BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'dnd_character_achievements table',
            sql: `CREATE TABLE IF NOT EXISTS dnd_character_achievements (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                character_id INT NOT NULL,
                achievement_id INT NOT NULL,
                progress INT DEFAULT 0,
                completed BOOLEAN DEFAULT FALSE,
                completed_at TIMESTAMP NULL,
                UNIQUE KEY uk_char_achievement (character_id, achievement_id),
                INDEX idx_character (character_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        },
        {
            name: 'add tracking columns to characters',
            sql: `ALTER TABLE dnd_characters
                ADD COLUMN IF NOT EXISTS total_monsters_killed INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS total_damage_dealt BIGINT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS total_healing_done BIGINT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS dungeons_completed INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS bosses_killed INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS deaths INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS crits_rolled INT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS active_title VARCHAR(100) NULL`
        },

        // Seed some achievements
        {
            name: 'seed achievements',
            sql: `INSERT IGNORE INTO dnd_achievements (achievement_key, name, description, category, tier, requirement_type, requirement_value, reward_exp, reward_gold, icon_emoji) VALUES
                ('first_blood', 'First Blood', 'Defeat your first enemy', 'combat', 'bronze', 'monsters_killed', 1, 50, 10, '⚔️'),
                ('monster_slayer', 'Monster Slayer', 'Defeat 50 enemies', 'combat', 'silver', 'monsters_killed', 50, 200, 50, '🗡️'),
                ('legendary_hunter', 'Legendary Hunter', 'Defeat 500 enemies', 'combat', 'gold', 'monsters_killed', 500, 1000, 250, '🏆'),
                ('dungeon_explorer', 'Dungeon Explorer', 'Complete your first dungeon', 'dungeon', 'bronze', 'dungeons_completed', 1, 100, 25, '🏰'),
                ('dungeon_master', 'Dungeon Master', 'Complete 10 dungeons', 'dungeon', 'silver', 'dungeons_completed', 10, 500, 150, '👑'),
                ('boss_slayer', 'Boss Slayer', 'Defeat your first boss', 'combat', 'silver', 'bosses_killed', 1, 250, 100, '💀'),
                ('pvp_victor', 'PvP Victor', 'Win your first PvP match', 'pvp', 'bronze', 'pvp_wins', 1, 100, 50, '🥊'),
                ('arena_champion', 'Arena Champion', 'Win 25 PvP matches', 'pvp', 'gold', 'pvp_wins', 25, 750, 300, '🏅'),
                ('critical_striker', 'Critical Striker', 'Roll 10 critical hits', 'combat', 'bronze', 'crits_rolled', 10, 75, 20, '💥'),
                ('lucky_roller', 'Lucky Roller', 'Roll 100 critical hits', 'combat', 'gold', 'crits_rolled', 100, 500, 200, '🎲'),
                ('wealthy', 'Wealthy', 'Accumulate 1000 gold', 'collection', 'silver', 'total_gold', 1000, 0, 100, '💰'),
                ('dragon_hoard', 'Dragon Hoard', 'Accumulate 10000 gold', 'collection', 'platinum', 'total_gold', 10000, 500, 0, '🐉'),
                ('level_5', 'Apprentice Adventurer', 'Reach level 5', 'general', 'bronze', 'level', 5, 100, 50, '📈'),
                ('level_10', 'Seasoned Adventurer', 'Reach level 10', 'general', 'silver', 'level', 10, 300, 150, '⭐'),
                ('level_20', 'Legendary Hero', 'Reach level 20', 'general', 'legendary', 'level', 20, 2000, 1000, '🌟'),
                ('survivor', 'Survivor', 'Die and be resurrected', 'general', 'bronze', 'deaths', 1, 50, 0, '💫'),
                ('unkillable', 'Unkillable', 'Reach level 10 without dying', 'general', 'gold', 'deathless_level', 10, 500, 250, '🛡️')`
        },

        // Seed some sample dungeons
        {
            name: 'seed dungeons',
            sql: `INSERT IGNORE INTO dnd_dungeons (dungeon_id, dungeon_name, description, min_level, max_level, total_rooms, difficulty, theme, reward_exp_base, reward_gold_base) VALUES
                (1, 'Goblin Caves', 'A network of caves infested with goblins. A good starting dungeon for new adventurers.', 1, 3, 5, 'easy', 'caves', 150, 75),
                (2, 'Bandit Hideout', 'An abandoned mine now used as a hideout by bandits.', 2, 5, 6, 'medium', 'mine', 250, 150),
                (3, 'Undead Crypt', 'An ancient crypt where the dead do not rest peacefully.', 4, 7, 7, 'medium', 'undead', 400, 200),
                (4, 'Dragon\\'s Lair', 'The lair of a young dragon. Only the brave should enter.', 6, 10, 8, 'hard', 'dragon', 750, 500),
                (5, 'Demon Portal', 'A rift to the abyss has opened. Close it before it\\'s too late.', 10, 15, 10, 'deadly', 'demon', 1500, 1000)`
        },

        // Seed dungeon rooms for Goblin Caves
        {
            name: 'seed goblin caves rooms',
            sql: `INSERT IGNORE INTO dnd_dungeon_rooms (dungeon_id, room_number, room_name, room_type, description, enemies, trap_data, loot_table) VALUES
                (1, 1, 'Cave Entrance', 'entrance', 'The mouth of the cave yawns before you, the smell of smoke and unwashed goblin wafting out.', NULL, NULL, NULL),
                (1, 2, 'Guard Post', 'combat', 'Two goblins stand watch here, playing dice by a small fire.', '[{"name": "Goblin", "hp": 7, "ac": 15, "damage": "1d6+2", "count": 2}]', NULL, '{"gold": [5, 15]}'),
                (1, 3, 'Trapped Corridor', 'trap', 'The corridor narrows. You notice thin wires strung across the floor.', NULL, '{"type": "tripwire_alarm", "dc": 12, "effect": "alerts_next_room", "damage": null}', NULL),
                (1, 4, 'Goblin Barracks', 'combat', 'Several goblins are sleeping on crude bedrolls. Some are awake and gambling.', '[{"name": "Goblin", "hp": 7, "ac": 15, "damage": "1d6+2", "count": 4}]', NULL, '{"gold": [10, 30], "items": ["potion_healing"]}'),
                (1, 5, 'Goblin Boss Chamber', 'boss', 'A larger goblin sits on a throne of bones, surrounded by his guards.', '[{"name": "Goblin Boss", "hp": 21, "ac": 17, "damage": "1d8+2", "count": 1, "is_boss": true}, {"name": "Goblin", "hp": 7, "ac": 15, "damage": "1d6+2", "count": 2}]', NULL, '{"gold": [50, 100], "items": ["potion_healing", "shortsword_1"]}')`
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
                    console.log(`  ⏭️  Table '${tableName}' already exists`);
                    skipped++;
                    continue;
                }
            }

            // Check columns for ALTER TABLE
            if (migration.sql.includes('ADD COLUMN IF NOT EXISTS')) {
                // Handle multiple columns in one ALTER
                const columnMatches = migration.sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g);
                let allExist = true;
                const tableMatch = migration.sql.match(/ALTER TABLE (\w+)/);
                const tableName = tableMatch ? tableMatch[1] : 'dnd_characters';

                for (const match of columnMatches) {
                    const columnName = match[1];
                    const [existing] = await pool.execute(
                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                        [process.env.DB_NAME, tableName, columnName]
                    );
                    if (existing.length === 0) {
                        allExist = false;
                        break;
                    }
                }

                if (allExist) {
                    console.log(`  ⏭️  ${migration.name} - columns already exist`);
                    skipped++;
                    continue;
                }
                migration.sql = migration.sql.replace(/ IF NOT EXISTS/g, '');
            }

            await pool.execute(migration.sql);
            console.log(`  ✅ ${migration.name}`);
            success++;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_TABLE_EXISTS_ERROR' || error.code === 'ER_DUP_ENTRY') {
                console.log(`  ⏭️  ${migration.name} - already exists`);
                skipped++;
            } else {
                console.error(`  ❌ ${migration.name}: ${error.message}`);
                failed++;
            }
        }
    }

    console.log('\n========================================');
    console.log('Migration Summary');
    console.log('========================================');
    console.log(`  ✅ Success: ${success}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  ❌ Failed: ${failed}`);

    await pool.end();
    console.log('\nFull RPG Migration complete!');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
