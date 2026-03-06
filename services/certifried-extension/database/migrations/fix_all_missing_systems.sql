-- ============================================
-- FIX ALL MISSING SYSTEMS - COMPREHENSIVE MIGRATION
-- Ralph Wiggum Loop Iteration 59
-- ============================================

-- 1. VAULT SYSTEM
CREATE TABLE IF NOT EXISTS cfx_player_vault (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL UNIQUE,
    vault_level INT NOT NULL DEFAULT 0,
    vault_cash DECIMAL(20,2) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_vault_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    strain_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    quality INT NOT NULL DEFAULT 50,
    stored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_vault_item (player_id, strain_id, quality),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_vault_seeds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    strain_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    stored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_vault_seed (player_id, strain_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. FACILITY SYSTEM
CREATE TABLE IF NOT EXISTS cfx_facility_upgrades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    upgrade_key VARCHAR(50) NOT NULL,
    current_level INT NOT NULL DEFAULT 0,
    max_level INT NOT NULL DEFAULT 10,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_upgrade (player_id, upgrade_key),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. PRESTIGE SYSTEM
CREATE TABLE IF NOT EXISTS cfx_prestige_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    prestige_level INT NOT NULL,
    cash_at_prestige DECIMAL(20,2) NOT NULL,
    level_at_prestige INT NOT NULL,
    tokens_earned INT NOT NULL DEFAULT 0,
    performed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_prestige_upgrades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    upgrade_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL,
    max_level INT NOT NULL DEFAULT 5,
    base_cost INT NOT NULL DEFAULT 1,
    cost_multiplier DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    icon VARCHAR(100) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_prestige_upgrades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    upgrade_id INT NOT NULL,
    current_level INT NOT NULL DEFAULT 0,
    UNIQUE KEY uk_player_prestige_upgrade (player_id, upgrade_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (upgrade_id) REFERENCES cfx_prestige_upgrades(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. DAILY DEALS / SHOP ROTATION
CREATE TABLE IF NOT EXISTS cfx_shop_rotation (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rotation_type ENUM('daily', 'weekly', 'flash') NOT NULL DEFAULT 'daily',
    item_type ENUM('seed', 'booster', 'equipment', 'cosmetic') NOT NULL,
    item_key VARCHAR(100) NOT NULL,
    strain_slug VARCHAR(100) DEFAULT NULL,
    original_price DECIMAL(15,2) NOT NULL,
    discount_percent INT NOT NULL DEFAULT 0,
    quantity_available INT DEFAULT NULL,
    quantity_sold INT NOT NULL DEFAULT 0,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_daily_deals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    deal_type VARCHAR(50) NOT NULL,
    item_key VARCHAR(100) NOT NULL,
    strain_slug VARCHAR(100) DEFAULT NULL,
    original_price DECIMAL(15,2) NOT NULL,
    discount_percent INT NOT NULL DEFAULT 20,
    quantity_limit INT DEFAULT NULL,
    valid_date DATE NOT NULL,
    purchased_by JSON DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_valid_date (valid_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. TRAITS SYSTEM
CREATE TABLE IF NOT EXISTS cfx_traits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    trait_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL,
    rarity ENUM('common', 'uncommon', 'rare', 'epic', 'legendary') NOT NULL DEFAULT 'common',
    unlock_method ENUM('random', 'quest', 'achievement', 'purchase', 'event') NOT NULL DEFAULT 'random',
    unlock_requirement JSON DEFAULT NULL,
    icon VARCHAR(100) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_traits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    trait_id INT NOT NULL,
    is_equipped TINYINT(1) NOT NULL DEFAULT 0,
    unlocked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_trait (player_id, trait_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (trait_id) REFERENCES cfx_traits(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. WORKERS SYSTEM (expanded)
CREATE TABLE IF NOT EXISTS cfx_workers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    worker_type ENUM('harvester', 'planter', 'seller', 'breeder', 'processor') NOT NULL,
    base_efficiency DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    base_interval_ms INT NOT NULL DEFAULT 300000,
    hire_cost DECIMAL(15,2) NOT NULL DEFAULT 5000,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. PROPERTIES SYSTEM
CREATE TABLE IF NOT EXISTS cfx_properties (
    id INT AUTO_INCREMENT PRIMARY KEY,
    property_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    property_type ENUM('residential', 'commercial', 'industrial', 'special') NOT NULL DEFAULT 'residential',
    bonus_type VARCHAR(50) DEFAULT NULL,
    bonus_value DECIMAL(10,4) DEFAULT NULL,
    grow_slots INT NOT NULL DEFAULT 0,
    storage_slots INT NOT NULL DEFAULT 0,
    price DECIMAL(15,2) NOT NULL DEFAULT 0,
    unlock_level INT NOT NULL DEFAULT 1,
    unlock_prestige INT NOT NULL DEFAULT 0,
    icon VARCHAR(100) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_properties (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    property_id INT NOT NULL,
    upgrade_level INT NOT NULL DEFAULT 0,
    purchased_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_property (player_id, property_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (property_id) REFERENCES cfx_properties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. FACILITIES TABLES (alternative naming used by some routes)
CREATE TABLE IF NOT EXISTS cfx_facilities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    facility_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    facility_type VARCHAR(50) NOT NULL,
    base_bonus DECIMAL(10,4) NOT NULL DEFAULT 0,
    max_level INT NOT NULL DEFAULT 10,
    base_cost DECIMAL(15,2) NOT NULL DEFAULT 1000,
    cost_multiplier DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    icon VARCHAR(100) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_facilities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    facility_id INT NOT NULL,
    current_level INT NOT NULL DEFAULT 0,
    purchased_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_facility (player_id, facility_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (facility_id) REFERENCES cfx_facilities(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. ADD MISSING COLUMNS TO EXISTING TABLES

-- Add facility columns to players if missing
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS facility_name VARCHAR(100) DEFAULT 'My Grow Op';
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS facility_level INT NOT NULL DEFAULT 1;
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS max_grow_slots INT NOT NULL DEFAULT 4;
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS prestige_level INT NOT NULL DEFAULT 0;
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS prestige_tokens INT NOT NULL DEFAULT 0;

-- Add is_open to dispensaries if missing
ALTER TABLE cfx_dispensaries ADD COLUMN IF NOT EXISTS is_open TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE cfx_dispensaries ADD COLUMN IF NOT EXISTS total_sales INT NOT NULL DEFAULT 0;
ALTER TABLE cfx_dispensaries ADD COLUMN IF NOT EXISTS total_revenue DECIMAL(20,2) NOT NULL DEFAULT 0;

-- Add listed_at and inventory_id to dispensary_inventory if missing
ALTER TABLE cfx_dispensary_inventory ADD COLUMN IF NOT EXISTS listed_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cfx_dispensary_inventory ADD COLUMN IF NOT EXISTS inventory_id INT DEFAULT NULL;

-- Add total_earned and last_action_at to player_reputation if missing
ALTER TABLE cfx_player_reputation ADD COLUMN IF NOT EXISTS total_earned INT NOT NULL DEFAULT 0;
ALTER TABLE cfx_player_reputation ADD COLUMN IF NOT EXISTS last_action_at DATETIME DEFAULT NULL;

-- Add icon to reputation tiers if missing
ALTER TABLE cfx_reputation_tiers ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT NULL;

-- Add icon to factions if missing
ALTER TABLE cfx_factions ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT NULL;

-- Add columns to locations if missing
ALTER TABLE cfx_locations ADD COLUMN IF NOT EXISTS slot_upgrade_cost DECIMAL(15,2) NOT NULL DEFAULT 5000;
ALTER TABLE cfx_locations ADD COLUMN IF NOT EXISTS required_research VARCHAR(100) DEFAULT NULL;
ALTER TABLE cfx_locations ADD COLUMN IF NOT EXISTS is_starter TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE cfx_locations ADD COLUMN IF NOT EXISTS climate_bonus_type VARCHAR(50) DEFAULT NULL;
ALTER TABLE cfx_locations ADD COLUMN IF NOT EXISTS climate_bonus_value DECIMAL(10,4) DEFAULT NULL;

-- Add min_level and reward_item and cooldown_hours to bosses if missing
ALTER TABLE cfx_bosses ADD COLUMN IF NOT EXISTS min_level INT NOT NULL DEFAULT 1;
ALTER TABLE cfx_bosses ADD COLUMN IF NOT EXISTS reward_item VARCHAR(100) DEFAULT NULL;
ALTER TABLE cfx_bosses ADD COLUMN IF NOT EXISTS cooldown_hours INT NOT NULL DEFAULT 24;
ALTER TABLE cfx_bosses ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT NULL;

-- Add reward_claimed to boss_encounters if missing
ALTER TABLE cfx_boss_encounters ADD COLUMN IF NOT EXISTS reward_claimed TINYINT(1) NOT NULL DEFAULT 0;

-- Add is_active to cartel_upgrades if missing
ALTER TABLE cfx_cartel_upgrades ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE cfx_cartel_upgrades ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT NULL;

-- Add contribution_wars and last_upgraded_at columns
ALTER TABLE cfx_cartel_members ADD COLUMN IF NOT EXISTS contribution_wars INT NOT NULL DEFAULT 0;
ALTER TABLE cfx_cartel_upgrade_status ADD COLUMN IF NOT EXISTS last_upgraded_at DATETIME DEFAULT NULL;

-- Add xp_to_next_level and is_recruiting and min_level_requirement to cartels
ALTER TABLE cfx_cartels ADD COLUMN IF NOT EXISTS xp_to_next_level BIGINT NOT NULL DEFAULT 1000;
ALTER TABLE cfx_cartels ADD COLUMN IF NOT EXISTS is_recruiting TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE cfx_cartels ADD COLUMN IF NOT EXISTS min_level_requirement INT NOT NULL DEFAULT 1;
ALTER TABLE cfx_cartels ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT NULL;

-- Add cartel invites table
CREATE TABLE IF NOT EXISTS cfx_cartel_invites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cartel_id INT NOT NULL,
    player_id INT NOT NULL,
    invited_by INT NOT NULL,
    status ENUM('pending', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    responded_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Territory system tables
CREATE TABLE IF NOT EXISTS cfx_territories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    territory_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    bonus_type VARCHAR(50) NOT NULL,
    bonus_value DECIMAL(10,4) NOT NULL,
    control_points_required INT NOT NULL DEFAULT 100,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_territory_control (
    id INT AUTO_INCREMENT PRIMARY KEY,
    territory_id INT NOT NULL,
    cartel_id INT NOT NULL,
    control_points INT NOT NULL DEFAULT 0,
    captured_at DATETIME DEFAULT NULL,
    UNIQUE KEY uk_territory (territory_id),
    FOREIGN KEY (territory_id) REFERENCES cfx_territories(id) ON DELETE CASCADE,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Dispensary customers table
CREATE TABLE IF NOT EXISTS cfx_dispensary_customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(100) DEFAULT NULL,
    preferred_quality_min INT NOT NULL DEFAULT 30,
    preferred_quality_max INT NOT NULL DEFAULT 80,
    budget_min DECIMAL(10,2) NOT NULL DEFAULT 10,
    budget_max DECIMAL(10,2) NOT NULL DEFAULT 100,
    patience_seconds INT NOT NULL DEFAULT 120,
    tip_chance DECIMAL(5,4) NOT NULL DEFAULT 0.1,
    tip_multiplier DECIMAL(5,2) NOT NULL DEFAULT 0.15,
    spawn_weight INT NOT NULL DEFAULT 100,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Dispensary orders table
CREATE TABLE IF NOT EXISTS cfx_dispensary_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dispensary_id INT NOT NULL,
    customer_id INT NOT NULL,
    requested_quality_min INT NOT NULL DEFAULT 30,
    budget DECIMAL(10,2) NOT NULL,
    status ENUM('waiting', 'served', 'left') NOT NULL DEFAULT 'waiting',
    sale_amount DECIMAL(10,2) DEFAULT NULL,
    tip_amount DECIMAL(10,2) DEFAULT NULL,
    expires_at DATETIME NOT NULL,
    completed_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dispensary_id) REFERENCES cfx_dispensaries(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES cfx_dispensary_customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. SEED DATA FOR NEW SYSTEMS

-- Prestige upgrades
INSERT IGNORE INTO cfx_prestige_upgrades (upgrade_key, name, description, effect_type, effect_value, max_level, base_cost) VALUES
('xp_boost', 'XP Mastery', 'Increases XP earned from all sources', 'xp_bonus', 0.05, 10, 2),
('cash_boost', 'Business Acumen', 'Increases cash from sales', 'cash_bonus', 0.05, 10, 2),
('yield_boost', 'Green Thumb', 'Increases harvest yields', 'yield_bonus', 0.05, 10, 3),
('quality_boost', 'Quality Control', 'Increases base quality', 'quality_bonus', 0.02, 10, 3),
('grow_speed', 'Quick Grow', 'Reduces grow time', 'grow_speed', 0.03, 10, 4),
('starting_cash', 'Trust Fund', 'Increases starting cash after prestige', 'starting_cash', 1000, 10, 1),
('starting_seeds', 'Seed Vault', 'Start with bonus seeds after prestige', 'starting_seeds', 5, 5, 3);

-- Traits
INSERT IGNORE INTO cfx_traits (trait_key, name, description, effect_type, effect_value, rarity, unlock_method) VALUES
('green_thumb', 'Green Thumb', 'Natural talent for growing', 'quality_bonus', 0.05, 'common', 'random'),
('efficient', 'Efficiency Expert', 'Reduced grow time', 'grow_speed', 0.05, 'common', 'random'),
('lucky', 'Lucky', 'Increased chance of rare events', 'luck_bonus', 0.10, 'uncommon', 'random'),
('business_savvy', 'Business Savvy', 'Better sale prices', 'sell_bonus', 0.08, 'uncommon', 'random'),
('geneticist', 'Master Geneticist', 'Improved breeding outcomes', 'breed_quality', 0.10, 'rare', 'random'),
('legend', 'Living Legend', 'Bonus to all stats', 'all_bonus', 0.03, 'legendary', 'achievement');

-- Workers
INSERT IGNORE INTO cfx_workers (worker_key, name, description, worker_type, base_efficiency, base_interval_ms, hire_cost) VALUES
('trimmer', 'Trimmer', 'Automatically harvests ready plants', 'harvester', 1.0, 300000, 5000),
('planter', 'Propagation Tech', 'Automatically plants seeds in empty slots', 'planter', 1.0, 300000, 5000),
('seller', 'Sales Rep', 'Automatically sells harvested product', 'seller', 1.0, 600000, 10000);

-- Dispensary customers
INSERT IGNORE INTO cfx_dispensary_customers (name, icon, preferred_quality_min, preferred_quality_max, budget_min, budget_max, patience_seconds, tip_chance, tip_multiplier, spawn_weight) VALUES
('Casual Carl', NULL, 20, 50, 10, 30, 180, 0.05, 0.10, 200),
('Medical Mary', NULL, 60, 90, 30, 80, 120, 0.15, 0.20, 150),
('Connoisseur Chris', NULL, 80, 100, 50, 150, 90, 0.25, 0.30, 50),
('Budget Bob', NULL, 10, 40, 5, 20, 240, 0.02, 0.05, 200),
('Premium Pete', NULL, 70, 100, 80, 200, 60, 0.30, 0.25, 30);

-- Properties
INSERT IGNORE INTO cfx_properties (property_key, name, description, property_type, bonus_type, bonus_value, grow_slots, storage_slots, price, unlock_level) VALUES
('starter_apartment', 'Starter Apartment', 'A small apartment to begin your journey', 'residential', NULL, NULL, 2, 50, 0, 1),
('garage', 'Garage Grow', 'A garage converted for growing', 'residential', 'grow_speed', 0.05, 4, 100, 10000, 5),
('warehouse', 'Warehouse', 'An industrial warehouse', 'industrial', 'yield_bonus', 0.10, 8, 500, 100000, 15),
('penthouse', 'Penthouse Suite', 'Luxury penthouse with premium facilities', 'special', 'quality_bonus', 0.15, 6, 200, 500000, 25);

-- Facilities
INSERT IGNORE INTO cfx_facilities (facility_key, name, description, facility_type, base_bonus, max_level, base_cost, cost_multiplier) VALUES
('lighting', 'Grow Lights', 'Better lighting increases quality', 'equipment', 0.02, 10, 1000, 2.0),
('ventilation', 'Ventilation', 'Better airflow speeds up growth', 'equipment', 0.02, 10, 1500, 2.0),
('irrigation', 'Irrigation', 'Automated watering increases yield', 'equipment', 0.02, 10, 2000, 2.0),
('security', 'Security System', 'Protect your investment', 'security', 0.10, 5, 5000, 2.5),
('storage', 'Storage', 'More room for inventory', 'storage', 25, 10, 1000, 1.8);
