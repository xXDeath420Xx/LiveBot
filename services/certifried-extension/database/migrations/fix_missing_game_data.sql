-- Fix Missing Game Data - Comprehensive Migration
-- Ensures all required tables have data and fixes broken references

-- ============================================
-- 1. Fix cfx_worker_traits - Training Center
-- ============================================
INSERT IGNORE INTO cfx_worker_traits (trait_key, name, description, trait_category, effect_type, effect_value_per_level, max_level, training_time_base_hours, training_cost_base, compatible_workers, is_active) VALUES
('quick_hands', 'Quick Hands', 'Reduces action interval time', 'efficiency', 'interval_reduction', 0.05, 5, 2, 1000, '["trimmer","propagation_tech","sales_rep"]', TRUE),
('multitasking', 'Multitasking', 'Increases capacity per action', 'efficiency', 'capacity_bonus', 1, 5, 3, 1500, '["trimmer","sales_rep","logistics_coordinator"]', TRUE),
('efficiency_expert', 'Efficiency Expert', 'Improves overall work efficiency', 'efficiency', 'efficiency_bonus', 0.03, 5, 4, 2000, '["trimmer","propagation_tech","sales_rep","quality_inspector"]', TRUE),
('eye_for_quality', 'Eye for Quality', 'Increases quality of output', 'quality', 'quality_bonus', 0.02, 5, 3, 1500, '["quality_inspector","trimmer"]', TRUE),
('perfectionist', 'Perfectionist', 'Chance to produce exceptional items', 'quality', 'exceptional_chance', 0.02, 3, 5, 3000, '["quality_inspector","extraction_specialist"]', TRUE),
('green_thumb', 'Green Thumb', 'Faster plant growth when planting', 'cultivation', 'growth_speed', 0.03, 5, 3, 1500, '["propagation_tech"]', TRUE),
('haggler', 'Haggler', 'Better prices when selling', 'business', 'price_bonus', 0.02, 5, 3, 1500, '["sales_rep","dispensary_manager"]', TRUE),
('customer_service', 'Customer Service', 'Increased tips and bonuses', 'business', 'tip_bonus', 0.05, 3, 2, 1000, '["sales_rep","dispensary_manager"]', TRUE),
('scientific_method', 'Scientific Method', 'Faster processing times', 'processing', 'process_speed', 0.04, 5, 4, 2000, '["extraction_specialist","research_assistant"]', TRUE),
('inventory_master', 'Inventory Master', 'Increased storage capacity', 'logistics', 'storage_bonus', 5, 5, 3, 1500, '["logistics_coordinator"]', TRUE),
('automation_sync', 'Automation Sync', 'Better worker coordination', 'automation', 'sync_bonus', 0.02, 3, 6, 5000, '["logistics_coordinator"]', TRUE),
('master_trainer', 'Master Trainer', 'Faster worker training times', 'training', 'training_speed', 0.05, 3, 8, 10000, '["research_assistant"]', TRUE);

-- ============================================
-- 2. Fix cfx_black_market_contacts - Black Market
-- ============================================
INSERT IGNORE INTO cfx_black_market_contacts (contact_key, name, description, reputation_required, price_multiplier, heat_multiplier, min_quality, max_quantity_per_sale, cooldown_minutes, is_active) VALUES
('shady_sam', 'Shady Sam', 'A small-time dealer. Takes anything but pays poorly.', 0, 0.80, 0.50, 1, 60, 0, TRUE),
('nervous_nick', 'Nervous Nick', 'Paranoid buyer who pays decent for quick deals.', 50, 1.00, 0.80, 1, 90, 10, TRUE),
('smooth_operator', 'Smooth Operator', 'Professional middleman with fair prices.', 100, 1.20, 1.00, 20, 120, 15, TRUE),
('big_tony', 'Big Tony', 'Connected guy who moves serious weight.', 250, 1.40, 1.30, 35, 180, 30, TRUE),
('the_chemist', 'The Chemist', 'Only interested in high quality extracts.', 500, 1.60, 1.50, 50, 240, 45, TRUE),
('silk_road', 'Silk Road', 'Anonymous online marketplace with premium prices.', 750, 1.80, 1.80, 60, 300, 60, TRUE),
('cartel_connect', 'Cartel Connect', 'International distribution network.', 1000, 2.20, 2.20, 75, 500, 90, TRUE),
('el_jefe', 'El Jefe', 'The boss. Pays top dollar for the best only.', 2000, 3.00, 3.00, 85, 1000, 120, TRUE);

UPDATE cfx_black_market_contacts SET is_active = TRUE WHERE is_active = FALSE OR is_active IS NULL;

-- ============================================
-- 3. Fix cfx_minigames - Match frontend game keys
-- ============================================
-- Add missing columns needed by route and frontend
ALTER TABLE cfx_minigames ADD COLUMN icon VARCHAR(10) DEFAULT '🎮';
ALTER TABLE cfx_minigames ADD COLUMN instructions TEXT;
ALTER TABLE cfx_minigames ADD COLUMN cooldown_minutes INT DEFAULT 5;

-- Populate cooldown_minutes from existing cooldown_ms
UPDATE cfx_minigames SET cooldown_minutes = ROUND(cooldown_ms / 60000) WHERE cooldown_minutes IS NULL OR cooldown_minutes = 5;

-- Update the first 4 existing minigames to match frontend GAME_IMPLEMENTATIONS
UPDATE cfx_minigames SET minigame_key = 'reaction_time', name = 'Reaction Time',
  description = 'Test your reflexes! Click when the screen turns green.',
  instructions = 'Wait for RED to turn GREEN, then click as fast as you can! 5 rounds, lower average time = higher score.',
  icon = '⚡', min_level = 1, base_reward_value = 5000, cooldown_minutes = 5
  WHERE id = (SELECT id FROM (SELECT MIN(id) as id FROM cfx_minigames) t);

UPDATE cfx_minigames SET minigame_key = 'memory_match', name = 'Memory Match',
  description = 'Match pairs of cards to test your memory.',
  instructions = 'Flip cards to find matching pairs. Fewer moves and faster time = higher score!',
  icon = '🧠', min_level = 3, base_reward_value = 7500, cooldown_minutes = 10
  WHERE id = (SELECT id FROM (SELECT MIN(id) + 1 as id FROM cfx_minigames) t);

UPDATE cfx_minigames SET minigame_key = 'quick_math', name = 'Quick Math',
  description = 'Solve math problems as fast as you can!',
  instructions = 'Answer addition, subtraction, and multiplication problems. 60 seconds to answer as many as possible!',
  icon = '🔢', min_level = 5, base_reward_value = 10000, cooldown_minutes = 15
  WHERE id = (SELECT id FROM (SELECT MIN(id) + 2 as id FROM cfx_minigames) t);

UPDATE cfx_minigames SET minigame_key = 'sequence_memory', name = 'Simon Says',
  description = 'Remember and repeat the color pattern.',
  instructions = 'Watch the colored buttons light up, then repeat the sequence. Each level adds one more step!',
  icon = '🎵', min_level = 3, base_reward_value = 8000, cooldown_minutes = 10
  WHERE id = (SELECT id FROM (SELECT MIN(id) + 3 as id FROM cfx_minigames) t);

-- Deactivate old minigames that have no frontend implementation
UPDATE cfx_minigames SET is_active = FALSE WHERE minigame_key NOT IN ('reaction_time', 'memory_match', 'quick_math', 'sequence_memory');

-- Ensure our 4 games are active
UPDATE cfx_minigames SET is_active = TRUE WHERE minigame_key IN ('reaction_time', 'memory_match', 'quick_math', 'sequence_memory');

-- Fallback: INSERT if UPDATE didn't match (e.g., table had fewer than 4 rows)
INSERT IGNORE INTO cfx_minigames (minigame_key, name, description, instructions, reward_type, base_reward_value, max_score, cooldown_minutes, min_level, icon, is_active) VALUES
('reaction_time', 'Reaction Time', 'Test your reflexes! Click when the screen turns green.', 'Wait for RED to turn GREEN, then click. 5 rounds, lower average = higher score.', 'cash', 5000, 1000, 5, 1, '⚡', TRUE),
('memory_match', 'Memory Match', 'Match pairs of cards to test your memory.', 'Flip cards to find matching pairs. Fewer moves and faster time = higher score!', 'cash', 7500, 1000, 10, 3, '🧠', TRUE),
('quick_math', 'Quick Math', 'Solve math problems as fast as you can!', 'Answer math problems. 60 seconds to answer as many as possible!', 'cash', 10000, 1000, 15, 5, '🔢', TRUE),
('sequence_memory', 'Simon Says', 'Remember and repeat the color pattern.', 'Watch colored buttons light up, then repeat. Each level adds one more step!', 'cash', 8000, 1000, 10, 3, '🎵', TRUE);

-- ============================================
-- 4. Auto-discover starter strains for all players
-- ============================================
INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id)
SELECT p.id, s.id
FROM cfx_players p
CROSS JOIN cfx_strains s
WHERE s.is_bred = 0
AND s.rarity IN ('common', 'uncommon');

-- ============================================
-- 5. Give starter seeds to players with no seeds
-- ============================================
INSERT IGNORE INTO cfx_seed_inventory (player_id, strain_id, quantity)
SELECT p.id, s.id, 5
FROM cfx_players p
CROSS JOIN cfx_strains s
WHERE s.is_bred = 0
AND s.rarity = 'common'
AND NOT EXISTS (
    SELECT 1 FROM cfx_seed_inventory si WHERE si.player_id = p.id AND si.strain_id = s.id
);

-- ============================================
-- 6. Ensure cfx_worker_trait_levels table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_worker_trait_levels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    trait_id INT NOT NULL,
    current_level INT NOT NULL DEFAULT 1,
    xp INT NOT NULL DEFAULT 0,
    training_progress DECIMAL(5,2) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_worker_trait (worker_id, trait_id)
);

-- ============================================
-- 7. Create cfx_player_defenses for raid defense ownership
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_defenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    defense_key VARCHAR(50) NOT NULL,
    current_level INT NOT NULL DEFAULT 1,
    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    upgraded_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_player_defense (player_id, defense_key)
);

-- ============================================
-- 8. Ensure cfx_player_heat table exists for raid system
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_heat (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL UNIQUE,
    current_heat DECIMAL(10,2) NOT NULL DEFAULT 0,
    lifetime_heat_earned DECIMAL(10,2) NOT NULL DEFAULT 0,
    last_heat_update DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_raid_check DATETIME DEFAULT NULL,
    last_raided_at DATETIME DEFAULT NULL,
    raid_immunity_until DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize heat for existing players who don't have records
INSERT IGNORE INTO cfx_player_heat (player_id)
SELECT id FROM cfx_players;

-- ============================================
-- 9. Ensure cfx_player_vault table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_vault (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL UNIQUE,
    vault_level INT NOT NULL DEFAULT 0,
    vault_cash DECIMAL(20,2) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Initialize vault for existing players
INSERT IGNORE INTO cfx_player_vault (player_id)
SELECT id FROM cfx_players;

-- ============================================
-- 10. Ensure cfx_player_stats table has all required columns
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL UNIQUE,
    total_raids_suffered INT DEFAULT 0,
    total_cash_seized DECIMAL(20,2) DEFAULT 0,
    total_items_destroyed INT DEFAULT 0,
    total_plants_destroyed INT DEFAULT 0,
    total_seeds_confiscated INT DEFAULT 0,
    highest_heat_reached DECIMAL(10,2) DEFAULT 0,
    total_harvests INT DEFAULT 0,
    total_plants_grown INT DEFAULT 0,
    total_cash_earned DECIMAL(20,2) DEFAULT 0,
    total_trades_completed INT DEFAULT 0,
    total_xp_earned BIGINT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize stats for existing players
INSERT IGNORE INTO cfx_player_stats (player_id)
SELECT id FROM cfx_players;

-- ============================================
-- 11. Ensure cfx_player_black_market has unique key
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_black_market (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    contact_id INT NOT NULL,
    last_sale_at DATETIME DEFAULT NULL,
    total_sales INT DEFAULT 0,
    total_revenue DECIMAL(20,2) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_player_contact (player_id, contact_id)
);

-- ============================================
-- 12. Ensure cfx_worker_action_log table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_worker_action_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    worker_id INT DEFAULT NULL,
    action_type VARCHAR(50) NOT NULL,
    items_processed INT DEFAULT 0,
    cash_earned DECIMAL(20,2) DEFAULT 0,
    xp_earned INT DEFAULT 0,
    details JSON DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_player_action (player_id, action_type),
    INDEX idx_created (created_at)
);

-- ============================================
-- 13. Add new locations for progression
-- ============================================
INSERT IGNORE INTO cfx_locations (location_key, name, description, climate, climate_bonus_type, climate_bonus_value, base_slots, max_slots, slot_upgrade_cost, price, unlock_level, heat_modifier, is_starter, is_active) VALUES
('industrial_complex', 'Industrial Complex', 'A repurposed factory floor. Massive space but attracts attention.', 'indoor', 'yield_bonus', 0.15, 12, 24, 15000, 250000, 15, 1.3, 0, TRUE),
('underground_bunker', 'Underground Bunker', 'Hidden underground. Hard to find, impossible to raid.', 'indoor', 'wither_resist', 0.20, 6, 16, 20000, 500000, 20, 0.5, 0, TRUE),
('rooftop_garden', 'Rooftop Garden', 'Urban rooftop with natural sunlight. Great quality boost.', 'greenhouse', 'quality_bonus', 0.12, 8, 18, 12000, 175000, 12, 1.1, 0, TRUE),
('tropical_island', 'Tropical Island', 'Remote island paradise. Perfect climate and zero heat.', 'tropical', 'growth_speed', 0.20, 10, 20, 25000, 1000000, 25, 0.3, 0, TRUE),
('space_station', 'Space Station', 'Zero gravity growing. The ultimate endgame location.', 'indoor', 'all_bonus', 0.10, 16, 32, 50000, 5000000, 30, 0.1, 0, TRUE),
('abandoned_mine', 'Abandoned Mine', 'Deep underground with natural mineral-rich water.', 'mountain', 'yield_bonus', 0.10, 8, 20, 10000, 100000, 10, 0.7, 0, TRUE),
('college_dorm', 'College Dorm Lab', 'Small but efficient. Perfect for beginners stepping up.', 'indoor', 'efficiency_bonus', 0.08, 4, 10, 5000, 25000, 5, 1.2, 0, TRUE),
('penthouse_suite', 'Penthouse Suite', 'Luxury high-rise with state-of-the-art growing equipment.', 'indoor', 'quality_bonus', 0.15, 6, 14, 18000, 350000, 18, 0.8, 0, TRUE);

-- ============================================
-- 14. Ensure cfx_player_settings has automation columns
-- ============================================
ALTER TABLE cfx_player_settings ADD COLUMN last_settings_automation DATETIME DEFAULT NULL;
ALTER TABLE cfx_player_settings ADD COLUMN auto_sell_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE cfx_player_settings ADD COLUMN auto_harvest_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE cfx_player_settings ADD COLUMN auto_replant_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE cfx_player_settings ADD COLUMN auto_replant_strain_id INT DEFAULT NULL;
ALTER TABLE cfx_player_settings ADD COLUMN auto_replant_use_favorite BOOLEAN DEFAULT FALSE;
ALTER TABLE cfx_player_settings ADD COLUMN auto_buy_seeds_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE cfx_player_settings ADD COLUMN auto_buy_seeds_threshold INT DEFAULT 5;
ALTER TABLE cfx_player_settings ADD COLUMN auto_buy_seeds_max_price INT DEFAULT 500;
ALTER TABLE cfx_player_settings ADD COLUMN auto_buy_seeds_quantity INT DEFAULT 3;
ALTER TABLE cfx_player_settings ADD COLUMN workflow_mode VARCHAR(20) DEFAULT 'balanced';
ALTER TABLE cfx_player_settings ADD COLUMN min_inventory_reserve INT DEFAULT 0;
ALTER TABLE cfx_player_settings ADD COLUMN process_before_sell BOOLEAN DEFAULT TRUE;
ALTER TABLE cfx_player_settings ADD COLUMN sell_quality_threshold INT DEFAULT 0;
ALTER TABLE cfx_player_settings ADD COLUMN reserve_rare_strains BOOLEAN DEFAULT TRUE;
ALTER TABLE cfx_player_settings ADD COLUMN max_auto_sell_percent INT DEFAULT 50;

-- ============================================
-- 15. Ensure cfx_raid_log table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_raid_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    heat_at_raid DECIMAL(10,2) DEFAULT 0,
    security_level INT DEFAULT 0,
    cash_seized DECIMAL(20,2) DEFAULT 0,
    inventory_destroyed INT DEFAULT 0,
    plants_destroyed INT DEFAULT 0,
    seeds_confiscated INT DEFAULT 0,
    seizure_details JSON DEFAULT NULL,
    heat_after_raid DECIMAL(10,2) DEFAULT 0,
    raided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_player (player_id),
    INDEX idx_raided (raided_at)
);

-- ============================================
-- 16. Ensure cfx_black_market_sales table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_black_market_sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    contact_id INT NOT NULL,
    strain_id INT DEFAULT NULL,
    quality INT DEFAULT 0,
    quantity INT DEFAULT 0,
    base_price DECIMAL(20,2) DEFAULT 0,
    final_price DECIMAL(20,2) DEFAULT 0,
    heat_generated INT DEFAULT 0,
    sold_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_player (player_id),
    INDEX idx_sold (sold_at)
);

-- ============================================
-- 17. Add updated_at to cfx_player_heat if missing
-- ============================================
ALTER TABLE cfx_player_heat ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- ============================================
-- 18. Ensure cfx_player_products has unique key for ON DUPLICATE KEY UPDATE
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    recipe_id INT DEFAULT NULL,
    strain_id INT DEFAULT NULL,
    product_name VARCHAR(100) DEFAULT NULL,
    quality INT DEFAULT 0,
    quantity INT DEFAULT 0,
    base_value DECIMAL(20,2) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_player_product (player_id, recipe_id, quality)
);

-- ============================================
-- 19. Initialize territory control records for all territories
-- ============================================
INSERT IGNORE INTO cfx_territory_control (territory_id, cartel_id, control_points)
SELECT id, NULL, 0 FROM cfx_territories;

-- ============================================
-- 20. Ensure cfx_player_reputation is initialized for players
-- ============================================
INSERT IGNORE INTO cfx_player_reputation (player_id, faction_id, reputation)
SELECT p.id, f.id, 0
FROM cfx_players p
CROSS JOIN cfx_factions f;

-- ============================================
-- 21. Fix cfx_player_stats counters from actual data
-- ============================================
UPDATE cfx_player_stats ps SET
    total_harvests = COALESCE((SELECT p.lifetime_sales FROM cfx_players p WHERE p.id = ps.player_id), 0)
WHERE ps.total_harvests = 0 OR ps.total_harvests IS NULL;

UPDATE cfx_player_stats ps SET
    total_cash_earned = COALESCE((SELECT p.lifetime_earnings FROM cfx_players p WHERE p.id = ps.player_id), 0)
WHERE ps.total_cash_earned = 0 OR ps.total_cash_earned IS NULL;

-- ============================================
-- 22. Ensure cfx_prestige_history table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_prestige_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    from_level INT DEFAULT 0,
    to_prestige INT DEFAULT 0,
    tokens_earned INT DEFAULT 0,
    cash_reset_from DECIMAL(20,2) DEFAULT 0,
    prestiged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_player (player_id)
);

-- ============================================
-- 23a. Ensure last_worker_run column on cfx_player_shop_items
-- ============================================
ALTER TABLE cfx_player_shop_items ADD COLUMN last_worker_run DATETIME DEFAULT NULL;

-- ============================================
-- 23b. Ensure cfx_player_bot_bonuses table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_bot_bonuses (
    player_id INT NOT NULL PRIMARY KEY,
    bot_level INT DEFAULT 1,
    bot_lifetime_tokes INT DEFAULT 0,
    bot_current_streak INT DEFAULT 0,
    bot_best_streak INT DEFAULT 0,
    growth_speed_bonus DECIMAL(5,4) DEFAULT 0,
    yield_bonus DECIMAL(5,4) DEFAULT 0,
    xp_bonus DECIMAL(5,4) DEFAULT 0,
    sell_price_bonus DECIMAL(5,4) DEFAULT 0,
    synced_at DATETIME DEFAULT NULL,
    INDEX idx_synced (synced_at)
);

-- ============================================
-- 23c. Ensure cfx_offline_progress table exists
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_offline_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    session_start DATETIME DEFAULT NULL,
    session_end DATETIME DEFAULT NULL,
    workers_cash_earned DECIMAL(20,2) DEFAULT 0,
    workers_plants_harvested INT DEFAULT 0,
    workers_seeds_planted INT DEFAULT 0,
    plants_withered INT DEFAULT 0,
    plants_ready INT DEFAULT 0,
    shown_to_player BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_player (player_id)
);

-- Add missing columns to cfx_offline_progress if it already exists with old schema
ALTER TABLE cfx_offline_progress ADD COLUMN session_start DATETIME DEFAULT NULL;
ALTER TABLE cfx_offline_progress ADD COLUMN session_end DATETIME DEFAULT NULL;
ALTER TABLE cfx_offline_progress ADD COLUMN workers_cash_earned DECIMAL(20,2) DEFAULT 0;
ALTER TABLE cfx_offline_progress ADD COLUMN workers_plants_harvested INT DEFAULT 0;
ALTER TABLE cfx_offline_progress ADD COLUMN workers_seeds_planted INT DEFAULT 0;
ALTER TABLE cfx_offline_progress ADD COLUMN plants_withered INT DEFAULT 0;
ALTER TABLE cfx_offline_progress ADD COLUMN plants_ready INT DEFAULT 0;
ALTER TABLE cfx_offline_progress ADD COLUMN shown_to_player BOOLEAN DEFAULT FALSE;

-- ============================================
-- 24. Add last_online_at to cfx_players for offline progress tracking
-- ============================================
ALTER TABLE cfx_players ADD COLUMN last_online_at DATETIME DEFAULT NULL;

-- ============================================
-- 25. Ensure first active season exists
-- ============================================
INSERT IGNORE INTO cfx_seasons (id, name, start_date, end_date, is_active)
VALUES (1, 'Season 1', CURDATE(), DATE_ADD(CURDATE(), INTERVAL 30 DAY), 1);

-- ============================================
-- 26. Ensure starter tournaments exist (tournament_tick job will auto-create more)
-- ============================================
INSERT IGNORE INTO cfx_tournaments (id, tournament_type, name, starts_at, ends_at, prize_pool, status)
VALUES
    (1, 'harvest', 'Weekly Harvest Championship', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), 50000, 'active'),
    (2, 'sales', 'Weekly Sales Showdown', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), 75000, 'active'),
    (3, 'quality', 'Weekly Quality Cup', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), 60000, 'active');
