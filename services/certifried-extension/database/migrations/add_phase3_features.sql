-- Phase 3: Research & Equipment System
-- Run this migration after add_phase2_features.sql

-- ============================================
-- 3.1 RESEARCH TREE
-- ============================================

-- Research nodes (the tech tree)
CREATE TABLE IF NOT EXISTS cfx_research_nodes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    research_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category ENUM('cultivation', 'processing', 'business', 'expansion') NOT NULL DEFAULT 'cultivation',
    tier INT NOT NULL DEFAULT 1,
    cost_cash BIGINT NOT NULL DEFAULT 0,
    cost_xp INT NOT NULL DEFAULT 0,
    research_time_hours INT NOT NULL DEFAULT 1,
    prerequisites JSON DEFAULT NULL, -- Array of research_key strings
    unlock_type ENUM('bonus', 'feature', 'equipment', 'recipe', 'location') NOT NULL DEFAULT 'bonus',
    unlock_key VARCHAR(100) DEFAULT NULL, -- References what gets unlocked
    unlock_value DECIMAL(10,4) DEFAULT NULL, -- For bonuses
    icon VARCHAR(50) DEFAULT '🔬',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player research progress
CREATE TABLE IF NOT EXISTS cfx_player_research (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    research_id INT NOT NULL,
    status ENUM('locked', 'available', 'researching', 'completed') NOT NULL DEFAULT 'locked',
    started_at TIMESTAMP NULL,
    completes_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (research_id) REFERENCES cfx_research_nodes(id) ON DELETE CASCADE,
    UNIQUE KEY unique_player_research (player_id, research_id)
);

-- Seed research nodes
INSERT INTO cfx_research_nodes (research_key, name, description, category, tier, cost_cash, cost_xp, research_time_hours, prerequisites, unlock_type, unlock_key, unlock_value, icon) VALUES
-- Cultivation Tree (Tier 1)
('basic_botany', 'Basic Botany', 'Fundamental plant biology knowledge', 'cultivation', 1, 1000, 100, 1, NULL, 'bonus', 'grow_speed', 0.05, '🌱'),
('soil_science', 'Soil Science', 'Understanding soil composition', 'cultivation', 1, 1500, 150, 2, NULL, 'bonus', 'yield_bonus', 0.05, '🪴'),
('water_management', 'Water Management', 'Efficient irrigation techniques', 'cultivation', 1, 1200, 120, 1, NULL, 'bonus', 'water_efficiency', 0.10, '💧'),

-- Cultivation Tree (Tier 2)
('advanced_genetics', 'Advanced Genetics', 'Manipulate plant genetics', 'cultivation', 2, 5000, 500, 4, '["basic_botany"]', 'bonus', 'breeding_success', 0.10, '🧬'),
('climate_control', 'Climate Control', 'Environmental optimization', 'cultivation', 2, 4000, 400, 3, '["water_management"]', 'bonus', 'quality_bonus', 0.08, '🌡️'),
('nutrient_optimization', 'Nutrient Optimization', 'Perfect feeding schedules', 'cultivation', 2, 4500, 450, 3, '["soil_science"]', 'bonus', 'yield_bonus', 0.10, '⚗️'),

-- Cultivation Tree (Tier 3)
('mutation_mastery', 'Mutation Mastery', 'Increased mutation chances', 'cultivation', 3, 15000, 1500, 8, '["advanced_genetics"]', 'bonus', 'mutation_chance', 0.15, '☢️'),
('elite_cultivation', 'Elite Cultivation', 'Master grower techniques', 'cultivation', 3, 20000, 2000, 12, '["climate_control", "nutrient_optimization"]', 'bonus', 'quality_bonus', 0.15, '👨‍🌾'),

-- Processing Tree (Tier 1)
('basic_extraction', 'Basic Extraction', 'Simple extraction methods', 'processing', 1, 2000, 200, 2, NULL, 'feature', 'extraction_lab', 1, '🧪'),
('quality_testing', 'Quality Testing', 'Lab testing capabilities', 'processing', 1, 1800, 180, 2, NULL, 'bonus', 'quality_accuracy', 0.20, '🔬'),

-- Processing Tree (Tier 2)
('advanced_extraction', 'Advanced Extraction', 'Complex concentrates', 'processing', 2, 8000, 800, 6, '["basic_extraction"]', 'bonus', 'extraction_yield', 0.15, '⚗️'),
('product_refinement', 'Product Refinement', 'Higher purity products', 'processing', 2, 7000, 700, 5, '["quality_testing"]', 'bonus', 'product_quality', 0.12, '💎'),

-- Processing Tree (Tier 3)
('master_chemist', 'Master Chemist', 'Legendary extraction skills', 'processing', 3, 25000, 2500, 16, '["advanced_extraction", "product_refinement"]', 'bonus', 'extraction_value', 0.25, '🥼'),

-- Business Tree (Tier 1)
('market_analysis', 'Market Analysis', 'Understand market trends', 'business', 1, 1500, 150, 2, NULL, 'bonus', 'market_insight', 0.10, '📊'),
('negotiation_101', 'Negotiation 101', 'Better deal-making', 'business', 1, 2000, 200, 2, NULL, 'bonus', 'sale_bonus', 0.05, '🤝'),
('customer_relations', 'Customer Relations', 'Build loyal customers', 'business', 1, 1800, 180, 2, NULL, 'bonus', 'reputation_gain', 0.10, '😊'),

-- Business Tree (Tier 2)
('black_market_contacts', 'Black Market Contacts', 'Access shadier deals', 'business', 2, 10000, 1000, 8, '["negotiation_101"]', 'feature', 'black_market', 1, '🕶️'),
('contract_expertise', 'Contract Expertise', 'Better contract rewards', 'business', 2, 6000, 600, 4, '["market_analysis"]', 'bonus', 'contract_bonus', 0.15, '📝'),
('brand_building', 'Brand Building', 'Establish your reputation', 'business', 2, 8000, 800, 6, '["customer_relations"]', 'bonus', 'base_price', 0.10, '🏷️'),

-- Business Tree (Tier 3)
('trade_empire', 'Trade Empire', 'Dominate the market', 'business', 3, 30000, 3000, 20, '["black_market_contacts", "contract_expertise", "brand_building"]', 'bonus', 'all_income', 0.20, '👑'),

-- Expansion Tree (Tier 1)
('basic_security', 'Basic Security', 'Reduce heat buildup', 'expansion', 1, 2500, 250, 3, NULL, 'bonus', 'heat_reduction', 0.10, '🔒'),
('space_efficiency', 'Space Efficiency', 'Optimize growing space', 'expansion', 1, 3000, 300, 3, NULL, 'bonus', 'slot_capacity', 0.10, '📐'),

-- Expansion Tree (Tier 2)
('location_scouting', 'Location Scouting', 'Find new grow spots', 'expansion', 2, 15000, 1500, 10, '["space_efficiency"]', 'feature', 'locations', 1, '🗺️'),
('stealth_operations', 'Stealth Operations', 'Operate under the radar', 'expansion', 2, 12000, 1200, 8, '["basic_security"]', 'bonus', 'heat_reduction', 0.20, '🥷'),

-- Expansion Tree (Tier 3)
('underground_network', 'Underground Network', 'Vast hidden operations', 'expansion', 3, 50000, 5000, 24, '["location_scouting", "stealth_operations"]', 'bonus', 'max_slots', 5, '🕳️');

-- ============================================
-- 3.2 EQUIPMENT SYSTEM
-- ============================================

-- Equipment definitions
CREATE TABLE IF NOT EXISTS cfx_equipment (
    id INT PRIMARY KEY AUTO_INCREMENT,
    equipment_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category ENUM('lighting', 'irrigation', 'climate', 'security', 'processing', 'storage') NOT NULL,
    tier INT NOT NULL DEFAULT 1,
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL,
    price BIGINT NOT NULL DEFAULT 0,
    required_research VARCHAR(50) DEFAULT NULL,
    required_level INT DEFAULT 1,
    icon VARCHAR(50) DEFAULT '🔧',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player owned equipment
CREATE TABLE IF NOT EXISTS cfx_player_equipment (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    equipment_id INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (equipment_id) REFERENCES cfx_equipment(id) ON DELETE CASCADE,
    UNIQUE KEY unique_player_equipment (player_id, equipment_id)
);

-- Seed equipment
INSERT INTO cfx_equipment (equipment_key, name, description, category, tier, effect_type, effect_value, price, required_research, required_level, icon) VALUES
-- Lighting (affects grow speed & quality)
('basic_led', 'Basic LED Panel', 'Entry-level grow lights', 'lighting', 1, 'grow_speed', 0.05, 500, NULL, 1, '💡'),
('advanced_led', 'Advanced LED Array', 'Full spectrum coverage', 'lighting', 2, 'grow_speed', 0.10, 2500, 'basic_botany', 5, '🔆'),
('quantum_board', 'Quantum Board', 'High efficiency lighting', 'lighting', 3, 'grow_speed', 0.15, 10000, 'climate_control', 15, '✨'),
('plasma_lights', 'Plasma Grow Lights', 'Top-tier illumination', 'lighting', 4, 'grow_speed', 0.25, 50000, 'elite_cultivation', 30, '⚡'),

-- Irrigation (affects yield & efficiency)
('drip_system', 'Drip Irrigation', 'Basic automated watering', 'irrigation', 1, 'yield_bonus', 0.05, 750, NULL, 1, '💧'),
('hydro_system', 'Hydroponic System', 'Soilless growing', 'irrigation', 2, 'yield_bonus', 0.12, 4000, 'water_management', 8, '🌊'),
('aero_system', 'Aeroponic System', 'Mist-based nutrients', 'irrigation', 3, 'yield_bonus', 0.20, 15000, 'nutrient_optimization', 20, '💨'),
('auto_feed', 'Auto-Feed Controller', 'AI-driven feeding', 'irrigation', 4, 'yield_bonus', 0.30, 60000, 'elite_cultivation', 35, '🤖'),

-- Climate (affects quality)
('basic_fan', 'Oscillating Fan', 'Basic air circulation', 'climate', 1, 'quality_bonus', 0.03, 300, NULL, 1, '🌀'),
('carbon_filter', 'Carbon Filter', 'Air purification', 'climate', 2, 'quality_bonus', 0.08, 1500, 'climate_control', 6, '🫁'),
('hvac_system', 'HVAC System', 'Full climate control', 'climate', 3, 'quality_bonus', 0.15, 8000, 'climate_control', 18, '❄️'),
('sealed_room', 'Sealed Room Setup', 'Perfect environment', 'climate', 4, 'quality_bonus', 0.25, 40000, 'elite_cultivation', 32, '🏠'),

-- Security (affects heat)
('basic_lock', 'Reinforced Lock', 'Basic security upgrade', 'security', 1, 'heat_reduction', 0.05, 400, NULL, 1, '🔒'),
('camera_system', 'Security Cameras', 'Surveillance system', 'security', 2, 'heat_reduction', 0.10, 2000, 'basic_security', 7, '📹'),
('alarm_system', 'Alarm System', 'Intrusion detection', 'security', 3, 'heat_reduction', 0.18, 7500, 'stealth_operations', 16, '🚨'),
('safe_room', 'Panic Room', 'Ultimate security', 'security', 4, 'heat_reduction', 0.30, 35000, 'stealth_operations', 28, '🛡️'),

-- Processing (affects extraction)
('basic_press', 'Basic Press', 'Manual extraction', 'processing', 1, 'extraction_yield', 0.08, 1000, 'basic_extraction', 3, '🗜️'),
('rosin_press', 'Rosin Press', 'Heat and pressure', 'processing', 2, 'extraction_yield', 0.15, 5000, 'advanced_extraction', 12, '🔥'),
('bho_extractor', 'BHO Extractor', 'Butane extraction', 'processing', 3, 'extraction_yield', 0.25, 20000, 'advanced_extraction', 22, '⚗️'),
('co2_extractor', 'CO2 Extractor', 'Supercritical CO2', 'processing', 4, 'extraction_yield', 0.40, 100000, 'master_chemist', 40, '🧪'),

-- Storage (affects capacity & preservation)
('basic_jars', 'Glass Jars', 'Basic storage', 'storage', 1, 'storage_capacity', 50, 200, NULL, 1, '🫙'),
('humidity_packs', 'Humidity Control', 'Preserve freshness', 'storage', 2, 'quality_decay', -0.50, 800, NULL, 4, '💧'),
('vacuum_sealer', 'Vacuum Sealer', 'Long-term storage', 'storage', 3, 'storage_capacity', 200, 3000, 'space_efficiency', 14, '📦'),
('vault_storage', 'Climate Vault', 'Premium preservation', 'storage', 4, 'storage_capacity', 500, 25000, 'underground_network', 25, '🏦');

-- ============================================
-- 3.3 LAND EXPANSION / LOCATIONS
-- ============================================

-- Location definitions
CREATE TABLE IF NOT EXISTS cfx_locations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    location_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    climate ENUM('indoor', 'greenhouse', 'outdoor_temperate', 'outdoor_tropical', 'outdoor_arid') NOT NULL DEFAULT 'indoor',
    climate_bonus_type VARCHAR(50) DEFAULT NULL,
    climate_bonus_value DECIMAL(10,4) DEFAULT 0,
    base_slots INT NOT NULL DEFAULT 4,
    max_slots INT NOT NULL DEFAULT 12,
    slot_upgrade_cost BIGINT NOT NULL DEFAULT 1000,
    purchase_price BIGINT NOT NULL DEFAULT 0,
    required_research VARCHAR(50) DEFAULT NULL,
    required_level INT DEFAULT 1,
    heat_modifier DECIMAL(10,4) DEFAULT 1.0,
    icon VARCHAR(50) DEFAULT '🏠',
    is_starter BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player owned locations
CREATE TABLE IF NOT EXISTS cfx_player_locations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    location_id INT NOT NULL,
    current_slots INT NOT NULL DEFAULT 4,
    is_primary BOOLEAN DEFAULT FALSE,
    purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES cfx_locations(id) ON DELETE CASCADE,
    UNIQUE KEY unique_player_location (player_id, location_id)
);

-- Seed locations
INSERT INTO cfx_locations (location_key, name, description, climate, climate_bonus_type, climate_bonus_value, base_slots, max_slots, slot_upgrade_cost, purchase_price, required_research, required_level, heat_modifier, icon, is_starter) VALUES
('starter_closet', 'Starter Closet', 'A small closet to begin your journey', 'indoor', NULL, 0, 4, 8, 500, 0, NULL, 1, 1.0, '🚪', TRUE),
('basement_grow', 'Basement Grow Room', 'Hidden underground operation', 'indoor', 'heat_reduction', 0.15, 6, 16, 1500, 10000, 'basic_security', 5, 0.85, '🏚️', FALSE),
('warehouse', 'Industrial Warehouse', 'Large-scale indoor operation', 'indoor', 'yield_bonus', 0.10, 12, 32, 3000, 50000, 'location_scouting', 15, 1.2, '🏭', FALSE),
('greenhouse', 'Professional Greenhouse', 'Natural light with control', 'greenhouse', 'quality_bonus', 0.12, 8, 24, 2000, 30000, 'location_scouting', 10, 1.0, '🏡', FALSE),
('mountain_cabin', 'Remote Mountain Cabin', 'Isolated growing location', 'outdoor_temperate', 'heat_reduction', 0.25, 6, 12, 2500, 25000, 'stealth_operations', 12, 0.70, '🏔️', FALSE),
('tropical_farm', 'Tropical Farm', 'Year-round outdoor growing', 'outdoor_tropical', 'grow_speed', 0.20, 10, 20, 4000, 75000, 'location_scouting', 20, 1.1, '🌴', FALSE),
('desert_bunker', 'Desert Bunker', 'Hidden underground facility', 'outdoor_arid', 'quality_bonus', 0.08, 8, 20, 3500, 60000, 'underground_network', 25, 0.60, '🏜️', FALSE),
('penthouse', 'Luxury Penthouse', 'High-end urban grow', 'indoor', 'sale_bonus', 0.15, 4, 10, 5000, 100000, 'trade_empire', 30, 1.3, '🌆', FALSE),
('island_compound', 'Private Island', 'Ultimate secluded operation', 'outdoor_tropical', 'all_bonus', 0.10, 16, 48, 10000, 500000, 'underground_network', 40, 0.50, '🏝️', FALSE);

-- Add location_id to grow_slots for multi-location support
ALTER TABLE cfx_grow_slots ADD COLUMN IF NOT EXISTS location_id INT DEFAULT NULL;

-- Create indexes for performance
CREATE INDEX idx_player_research_status ON cfx_player_research(player_id, status);
CREATE INDEX idx_player_equipment_active ON cfx_player_equipment(player_id, is_active);
CREATE INDEX idx_player_locations_primary ON cfx_player_locations(player_id, is_primary);
CREATE INDEX idx_research_prereqs ON cfx_research_nodes(tier, category);
CREATE INDEX idx_equipment_category ON cfx_equipment(category, tier);
