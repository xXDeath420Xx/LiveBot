/**
 * Migration 125: D&D RPG schema.
 *
 * The RPG feature (~13k lines across core/rpg-*.js + commands/games/rpg/) queries
 * 33 `dnd_*` tables that were never created. This migration creates them, with
 * the schema reverse-engineered from every SELECT/INSERT/UPDATE in the manager
 * code (the code is the source of truth). Idempotent — CREATE TABLE IF NOT EXISTS.
 */
const TABLES = [
`CREATE TABLE IF NOT EXISTS dnd_characters (
  character_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(20) NOT NULL, guild_id VARCHAR(20) NOT NULL,
  character_name VARCHAR(255) NOT NULL, player_name VARCHAR(255) DEFAULT NULL,
  class VARCHAR(32) DEFAULT NULL, multiclass VARCHAR(64) DEFAULT NULL, subclass VARCHAR(64) DEFAULT NULL,
  species VARCHAR(64) DEFAULT 'Human', background VARCHAR(64) DEFAULT NULL, alignment VARCHAR(32) DEFAULT NULL,
  level INT NOT NULL DEFAULT 1, experience INT NOT NULL DEFAULT 0,
  health INT NOT NULL DEFAULT 0, max_health INT NOT NULL DEFAULT 0, temp_hp INT NOT NULL DEFAULT 0,
  mana INT NOT NULL DEFAULT 0, max_mana INT NOT NULL DEFAULT 0,
  strength INT NOT NULL DEFAULT 10, dexterity INT NOT NULL DEFAULT 10, constitution INT NOT NULL DEFAULT 10,
  intelligence INT NOT NULL DEFAULT 10, wisdom INT NOT NULL DEFAULT 10, charisma INT NOT NULL DEFAULT 10,
  armor_class INT NOT NULL DEFAULT 10, speed VARCHAR(32) DEFAULT '30 ft.', initiative INT NOT NULL DEFAULT 0,
  proficiency_bonus INT NOT NULL DEFAULT 2, hit_dice VARCHAR(32) DEFAULT NULL,
  saving_throws JSON DEFAULT NULL, skill_proficiencies JSON DEFAULT NULL, languages JSON DEFAULT NULL,
  weapon_proficiencies JSON DEFAULT NULL, armor_proficiencies JSON DEFAULT NULL, tool_proficiencies JSON DEFAULT NULL,
  features JSON DEFAULT NULL, racial_traits JSON DEFAULT NULL, class_features JSON DEFAULT NULL,
  spellcasting_ability VARCHAR(32) DEFAULT NULL, spell_save_dc INT DEFAULT NULL, spell_attack_bonus INT DEFAULT NULL,
  spell_slots JSON DEFAULT NULL, spells_known JSON DEFAULT NULL, cantrips JSON DEFAULT NULL,
  class_resource VARCHAR(64) DEFAULT NULL, class_resource_max INT NOT NULL DEFAULT 0, class_resource_current INT NOT NULL DEFAULT 0,
  personality_traits TEXT DEFAULT NULL, ideals TEXT DEFAULT NULL, bonds TEXT DEFAULT NULL, flaws TEXT DEFAULT NULL, backstory TEXT DEFAULT NULL,
  age VARCHAR(32) DEFAULT NULL, height VARCHAR(32) DEFAULT NULL, weight VARCHAR(32) DEFAULT NULL,
  eyes VARCHAR(32) DEFAULT NULL, skin VARCHAR(32) DEFAULT NULL, hair VARCHAR(32) DEFAULT NULL,
  resistances JSON DEFAULT NULL, immunities JSON DEFAULT NULL, vulnerabilities JSON DEFAULT NULL, senses JSON DEFAULT NULL,
  attacks JSON DEFAULT NULL, actions JSON DEFAULT NULL, bonus_actions JSON DEFAULT NULL, reactions JSON DEFAULT NULL,
  equipment JSON DEFAULT NULL,
  gold INT NOT NULL DEFAULT 0, copper INT NOT NULL DEFAULT 0, silver INT NOT NULL DEFAULT 0, electrum INT NOT NULL DEFAULT 0, platinum INT NOT NULL DEFAULT 0,
  death_save_successes INT NOT NULL DEFAULT 0, death_save_failures INT NOT NULL DEFAULT 0, exhaustion_level INT NOT NULL DEFAULT 0, inspiration TINYINT(1) NOT NULL DEFAULT 0,
  concentration_spell_id INT DEFAULT NULL, concentration_started TIMESTAMP NULL DEFAULT NULL,
  current_zone VARCHAR(255) DEFAULT 'town', active_campaign_id INT DEFAULT NULL,
  imported_from VARCHAR(32) DEFAULT NULL, import_data JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_char_user_guild (user_id, guild_id), KEY idx_char_user (user_id), KEY idx_char_guild (guild_id), KEY idx_char_active_campaign (active_campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_campaigns (
  campaign_id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, campaign_name VARCHAR(255) NOT NULL,
  dm_user_id VARCHAR(20) DEFAULT NULL, campaign_type VARCHAR(32) NOT NULL DEFAULT 'homebrew', module_id VARCHAR(64) DEFAULT NULL,
  setting VARCHAR(255) DEFAULT 'Forgotten Realms', theme VARCHAR(255) DEFAULT 'classic fantasy', difficulty VARCHAR(32) DEFAULT 'normal',
  max_players INT NOT NULL DEFAULT 4, ai_personality VARCHAR(32) DEFAULT 'classic', status VARCHAR(32) NOT NULL DEFAULT 'setup',
  channel_id VARCHAR(20) DEFAULT NULL, session_count INT NOT NULL DEFAULT 0, last_session_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_camp_guild (guild_id), KEY idx_camp_status (status), KEY idx_camp_channel (channel_id), KEY idx_camp_module (module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_campaign_players (
  id INT AUTO_INCREMENT PRIMARY KEY, campaign_id INT NOT NULL, character_id INT NOT NULL, user_id VARCHAR(20) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'player', joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_campaign_user (campaign_id, user_id), KEY idx_cp_campaign (campaign_id), KEY idx_cp_character (character_id), KEY idx_cp_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_campaign_modules (
  module_id VARCHAR(64) PRIMARY KEY, module_name VARCHAR(255) NOT NULL, description TEXT DEFAULT NULL, setting VARCHAR(255) DEFAULT NULL,
  min_level INT NOT NULL DEFAULT 1, max_level INT NOT NULL DEFAULT 20, estimated_sessions INT NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_mod_active (is_active), KEY idx_mod_min_level (min_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_sessions (
  session_id INT AUTO_INCREMENT PRIMARY KEY, campaign_id INT NOT NULL, session_number INT NOT NULL DEFAULT 1, title VARCHAR(255) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active', current_scene TEXT DEFAULT NULL, current_location VARCHAR(255) DEFAULT NULL, active_quests JSON DEFAULT NULL,
  summary TEXT DEFAULT NULL, message_count INT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TIMESTAMP NULL DEFAULT NULL,
  KEY idx_sess_campaign (campaign_id), KEY idx_sess_status (status), KEY idx_sess_campaign_status (campaign_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_session_messages (
  message_id INT AUTO_INCREMENT PRIMARY KEY, session_id INT NOT NULL, message_type VARCHAR(32) NOT NULL, character_id INT DEFAULT NULL,
  content TEXT NOT NULL, metadata JSON DEFAULT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_msg_session (session_id), KEY idx_msg_session_created (session_id, created_at), KEY idx_msg_character (character_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_combat_sessions (
  combat_id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, campaign_id VARCHAR(36) DEFAULT NULL, session_id VARCHAR(36) DEFAULT NULL,
  combat_name VARCHAR(255) DEFAULT 'Combat', combat_type VARCHAR(32) NOT NULL DEFAULT 'pve', environment VARCHAR(255) DEFAULT NULL, status VARCHAR(32) NOT NULL DEFAULT 'setup',
  initiative_order JSON DEFAULT NULL, current_turn INT NOT NULL DEFAULT 0, current_round INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_guild (guild_id), INDEX idx_campaign (campaign_id), INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_combat_participants (
  participant_id INT AUTO_INCREMENT PRIMARY KEY, combat_id INT NOT NULL, participant_type VARCHAR(32) NOT NULL, character_id INT DEFAULT NULL, enemy_id INT DEFAULT NULL,
  name VARCHAR(255) NOT NULL, current_hp INT NOT NULL DEFAULT 0, max_hp INT NOT NULL DEFAULT 0, armor_class INT NOT NULL DEFAULT 10,
  initiative_bonus INT NOT NULL DEFAULT 0, initiative_roll INT DEFAULT NULL, turn_order INT DEFAULT NULL, conditions JSON DEFAULT NULL,
  action_used TINYINT(1) NOT NULL DEFAULT 0, bonus_action_used TINYINT(1) NOT NULL DEFAULT 0, reaction_used TINYINT(1) NOT NULL DEFAULT 0, movement_used INT NOT NULL DEFAULT 0,
  death_saves_success INT NOT NULL DEFAULT 0, death_saves_failure INT NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1,
  INDEX idx_combat (combat_id), INDEX idx_character (character_id), INDEX idx_enemy (enemy_id), INDEX idx_combat_active (combat_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_battles (
  battle_id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, enemy_id INT NOT NULL, character_health INT NOT NULL DEFAULT 0, enemy_health INT NOT NULL DEFAULT 0,
  turn INT NOT NULL DEFAULT 1, status VARCHAR(32) NOT NULL DEFAULT 'ongoing', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_character (character_id), INDEX idx_enemy (enemy_id), INDEX idx_character_status (character_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_combat_log (
  log_id INT AUTO_INCREMENT PRIMARY KEY, combat_id INT NOT NULL, round INT NOT NULL DEFAULT 1, turn INT NOT NULL DEFAULT 0, actor_id INT DEFAULT NULL,
  action_type VARCHAR(32) NOT NULL, target_ids JSON DEFAULT NULL, description TEXT DEFAULT NULL, roll_data JSON DEFAULT NULL, damage_dealt INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_combat (combat_id), INDEX idx_actor (actor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_enemies (
  enemy_id INT AUTO_INCREMENT PRIMARY KEY, enemy_name VARCHAR(255) NOT NULL, health INT NOT NULL DEFAULT 1, damage INT NOT NULL DEFAULT 1, min_level INT NOT NULL DEFAULT 1,
  zone VARCHAR(255) DEFAULT NULL, reward_exp INT NOT NULL DEFAULT 0, reward_gold INT NOT NULL DEFAULT 0, reward_item_id INT DEFAULT NULL,
  INDEX idx_zone (zone), INDEX idx_min_level (min_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_dice_rolls (
  roll_id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(20) NOT NULL, guild_id VARCHAR(20) NOT NULL, character_id INT DEFAULT NULL,
  roll_type VARCHAR(32) NOT NULL DEFAULT 'custom', dice_notation VARCHAR(255) NOT NULL DEFAULT '1d20', individual_rolls JSON DEFAULT NULL, modifier INT NOT NULL DEFAULT 0,
  total_result INT NOT NULL, advantage_status VARCHAR(32) NOT NULL DEFAULT 'normal', is_critical TINYINT(1) NOT NULL DEFAULT 0, is_fumble TINYINT(1) NOT NULL DEFAULT 0,
  dc INT DEFAULT NULL, success TINYINT(1) DEFAULT NULL, context VARCHAR(255) DEFAULT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_guild (user_id, guild_id), INDEX idx_character (character_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_pvp_matches (
  match_id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, match_type VARCHAR(32) NOT NULL DEFAULT 'duel', arena_type VARCHAR(32) NOT NULL DEFAULT 'standard',
  challenger_user_id VARCHAR(20) NOT NULL, challenger_character_id INT NOT NULL, defender_user_id VARCHAR(20) DEFAULT NULL, defender_character_id INT DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', combat_state JSON DEFAULT NULL, winner_user_id VARCHAR(20) DEFAULT NULL, end_method VARCHAR(32) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMP NULL DEFAULT NULL, ended_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_guild_status (guild_id, status), INDEX idx_challenger (challenger_user_id), INDEX idx_defender (defender_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_pvp_stats (
  user_id VARCHAR(20) NOT NULL, guild_id VARCHAR(20) NOT NULL, elo_rating INT NOT NULL DEFAULT 1000, wins INT NOT NULL DEFAULT 0, losses INT NOT NULL DEFAULT 0,
  matches_played INT NOT NULL DEFAULT 0, current_streak INT NOT NULL DEFAULT 0, best_streak INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, guild_id), INDEX idx_guild_elo (guild_id, elo_rating)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_items (
  item_id INT AUTO_INCREMENT PRIMARY KEY, item_name VARCHAR(255) NOT NULL, item_type VARCHAR(32) NOT NULL, rarity VARCHAR(32) NOT NULL DEFAULT 'common', value INT NOT NULL DEFAULT 0,
  description TEXT, damage_bonus INT NOT NULL DEFAULT 0, defense_bonus INT NOT NULL DEFAULT 0, heal_amount INT NOT NULL DEFAULT 0, mana_amount INT NOT NULL DEFAULT 0, stat_bonuses JSON DEFAULT NULL,
  INDEX idx_items_type (item_type), INDEX idx_items_rarity (rarity), INDEX idx_items_name (item_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_inventory (
  inventory_id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, item_id INT NOT NULL, quantity INT NOT NULL DEFAULT 1, equipped TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_inv_char_item (character_id, item_id), INDEX idx_inv_character (character_id), INDEX idx_inv_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_shops (
  shop_id INT AUTO_INCREMENT PRIMARY KEY, zone VARCHAR(64) NOT NULL, item_id INT NOT NULL, price INT NOT NULL DEFAULT 0, stock INT NOT NULL DEFAULT -1,
  UNIQUE KEY uniq_shop_zone_item (zone, item_id), INDEX idx_shop_zone (zone), INDEX idx_shop_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_spells (
  spell_id INT AUTO_INCREMENT PRIMARY KEY, spell_name VARCHAR(255) NOT NULL, spell_level INT NOT NULL DEFAULT 0, school VARCHAR(32) NOT NULL, description TEXT,
  components JSON DEFAULT NULL, concentration TINYINT(1) NOT NULL DEFAULT 0, damage_dice JSON DEFAULT NULL, damage_type VARCHAR(32) DEFAULT NULL, healing_dice JSON DEFAULT NULL,
  attack_type VARCHAR(32) DEFAULT NULL, save_type VARCHAR(32) DEFAULT NULL,
  UNIQUE KEY uniq_spell_name (spell_name), INDEX idx_spells_level (spell_level), INDEX idx_spells_school (school)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_character_spells (
  id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, spell_id INT NOT NULL, source VARCHAR(32) NOT NULL DEFAULT 'class', prepared TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_char_spell (character_id, spell_id), INDEX idx_cs_character (character_id), INDEX idx_cs_spell (spell_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_spell_slots (
  id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, slot_level INT NOT NULL, total_slots INT NOT NULL DEFAULT 0, used_slots INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_slot_char_level (character_id, slot_level), INDEX idx_slots_character (character_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_conditions (
  condition_id INT AUTO_INCREMENT PRIMARY KEY, condition_name VARCHAR(255) NOT NULL, description TEXT, mechanical_effects JSON DEFAULT NULL, icon_emoji VARCHAR(64) DEFAULT NULL,
  UNIQUE KEY uniq_condition_name (condition_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_active_conditions (
  id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, condition_id INT NOT NULL, combat_id INT DEFAULT NULL, source VARCHAR(255) DEFAULT NULL,
  duration_rounds INT DEFAULT NULL, save_dc INT DEFAULT NULL, save_type VARCHAR(32) DEFAULT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ac_character (character_id), INDEX idx_ac_condition (condition_id), INDEX idx_ac_combat (combat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_class_resources (
  id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, resource_name VARCHAR(64) NOT NULL, max_uses INT NOT NULL DEFAULT 0, current_uses INT NOT NULL DEFAULT 0, restore_on VARCHAR(16) NOT NULL DEFAULT 'long',
  UNIQUE KEY uniq_char_resource (character_id, resource_name), INDEX idx_cr_character (character_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_quests (
  quest_id INT AUTO_INCREMENT PRIMARY KEY, quest_name VARCHAR(255) NOT NULL, description TEXT, quest_type VARCHAR(32) DEFAULT 'misc', required_level INT NOT NULL DEFAULT 1,
  requirement_count INT NOT NULL DEFAULT 1, reward_exp INT NOT NULL DEFAULT 0, reward_gold INT NOT NULL DEFAULT 0, reward_item_id INT DEFAULT NULL, prerequisite_quest_id INT DEFAULT NULL,
  repeatable TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_required_level (required_level), INDEX idx_quest_type (quest_type), INDEX idx_prerequisite (prerequisite_quest_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_character_quests (
  character_quest_id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, quest_id INT NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', progress INT NOT NULL DEFAULT 0,
  started_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_character (character_id), INDEX idx_quest (quest_id), INDEX idx_character_status (character_id, status), INDEX idx_character_quest_status (character_id, quest_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_dungeons (
  dungeon_id INT AUTO_INCREMENT PRIMARY KEY, dungeon_name VARCHAR(255) NOT NULL, description TEXT, min_level INT NOT NULL DEFAULT 1, total_rooms INT NOT NULL DEFAULT 0,
  rewards JSON, times_completed INT NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_active_level (is_active, min_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_dungeon_rooms (
  room_id INT AUTO_INCREMENT PRIMARY KEY, dungeon_id INT NOT NULL, room_order INT NOT NULL, room_type VARCHAR(32) NOT NULL DEFAULT 'event', encounters JSON, loot_table JSON,
  INDEX idx_dungeon (dungeon_id), INDEX idx_dungeon_order (dungeon_id, room_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_dungeon_runs (
  run_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, dungeon_id INT NOT NULL, difficulty VARCHAR(32) NOT NULL DEFAULT 'normal', current_room INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress', total_xp INT NOT NULL DEFAULT 0, total_gold INT NOT NULL DEFAULT 0, enemies_defeated INT NOT NULL DEFAULT 0, rooms_cleared INT NOT NULL DEFAULT 0,
  started_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP NULL DEFAULT NULL, INDEX idx_dungeon (dungeon_id), INDEX idx_party_status (party_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_parties (
  party_id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, party_name VARCHAR(255) NOT NULL, leader_user_id VARCHAR(20) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'forming',
  max_members INT NOT NULL DEFAULT 6, shared_gold INT NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_guild_status (guild_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_party_members (
  party_member_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, character_id INT NOT NULL, user_id VARCHAR(20) NOT NULL, role VARCHAR(32) NOT NULL DEFAULT 'member', joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_character (character_id), INDEX idx_party (party_id), INDEX idx_party_role_joined (party_id, role, joined_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_party_invites (
  invite_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, invited_user_id VARCHAR(20) NOT NULL, invited_by_user_id VARCHAR(20) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMP NULL DEFAULT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_party (party_id), INDEX idx_invited_status (invited_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_achievements (
  achievement_id INT AUTO_INCREMENT PRIMARY KEY, achievement_name VARCHAR(255) NOT NULL, description TEXT, category VARCHAR(32) NOT NULL DEFAULT 'special', icon_emoji VARCHAR(50),
  points INT NOT NULL DEFAULT 0, requirements JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

`CREATE TABLE IF NOT EXISTS dnd_character_achievements (
  id INT AUTO_INCREMENT PRIMARY KEY, character_id INT NOT NULL, achievement_id INT NOT NULL, earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_character_achievement (character_id, achievement_id), INDEX idx_character (character_id), INDEX idx_achievement (achievement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const DROP_ORDER = [
  'dnd_character_achievements','dnd_achievements','dnd_party_invites','dnd_party_members','dnd_parties',
  'dnd_dungeon_runs','dnd_dungeon_rooms','dnd_dungeons','dnd_character_quests','dnd_quests',
  'dnd_class_resources','dnd_active_conditions','dnd_conditions','dnd_spell_slots','dnd_character_spells','dnd_spells',
  'dnd_shops','dnd_inventory','dnd_items','dnd_pvp_stats','dnd_pvp_matches','dnd_dice_rolls','dnd_enemies',
  'dnd_combat_log','dnd_battles','dnd_combat_participants','dnd_combat_sessions',
  'dnd_session_messages','dnd_sessions','dnd_campaign_modules','dnd_campaign_players','dnd_campaigns','dnd_characters',
];

export async function up(db) {
  for (const ddl of TABLES) await db.execute(ddl);
}

export async function down(db) {
  for (const t of DROP_ORDER) await db.execute(`DROP TABLE IF EXISTS ${t}`);
}
