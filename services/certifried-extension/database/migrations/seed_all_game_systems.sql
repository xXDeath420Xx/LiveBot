-- ============================================
-- COMPREHENSIVE GAME SYSTEMS SEED DATA
-- Seeds ALL missing data for a fully functional game
-- Updated to match actual table schemas
-- ============================================

-- ============================================
-- 1. FACTIONS & REPUTATION
-- ============================================

INSERT IGNORE INTO cfx_factions (faction_key, name, description, icon, is_active) VALUES
('growers_guild', 'Growers Guild', 'A collective of master cultivators dedicated to advancing growing techniques', '🌿', 1),
('street_vendors', 'Street Vendors', 'Underground network of dealers and distributors', '🛒', 1),
('medical_alliance', 'Medical Alliance', 'Healthcare professionals promoting medical cannabis', '⚕️', 1),
('research_collective', 'Research Collective', 'Scientists studying cannabis properties and applications', '🔬', 1),
('underground_cartel', 'Underground Cartel', 'Shadowy organization with connections everywhere', '🕶️', 1);

-- Reputation tiers (using actual schema: faction_id, tier_level, name, rep_required, perks)
INSERT IGNORE INTO cfx_reputation_tiers (faction_id, tier_level, name, rep_required, perks)
SELECT id, 1, 'Neutral', 0, '{"quality_bonus": 0}' FROM cfx_factions WHERE faction_key = 'growers_guild'
UNION ALL SELECT id, 2, 'Friendly', 100, '{"quality_bonus": 0.02}' FROM cfx_factions WHERE faction_key = 'growers_guild'
UNION ALL SELECT id, 3, 'Trusted', 500, '{"quality_bonus": 0.05}' FROM cfx_factions WHERE faction_key = 'growers_guild'
UNION ALL SELECT id, 4, 'Honored', 1500, '{"quality_bonus": 0.10}' FROM cfx_factions WHERE faction_key = 'growers_guild'
UNION ALL SELECT id, 5, 'Exalted', 5000, '{"quality_bonus": 0.15}' FROM cfx_factions WHERE faction_key = 'growers_guild'

UNION ALL SELECT id, 1, 'Unknown', 0, '{"sell_bonus": 0}' FROM cfx_factions WHERE faction_key = 'street_vendors'
UNION ALL SELECT id, 2, 'Known', 100, '{"sell_bonus": 0.03}' FROM cfx_factions WHERE faction_key = 'street_vendors'
UNION ALL SELECT id, 3, 'Respected', 500, '{"sell_bonus": 0.07}' FROM cfx_factions WHERE faction_key = 'street_vendors'
UNION ALL SELECT id, 4, 'Connected', 1500, '{"sell_bonus": 0.12}' FROM cfx_factions WHERE faction_key = 'street_vendors'
UNION ALL SELECT id, 5, 'Kingpin', 5000, '{"sell_bonus": 0.20}' FROM cfx_factions WHERE faction_key = 'street_vendors'

UNION ALL SELECT id, 1, 'Stranger', 0, '{"xp_bonus": 0}' FROM cfx_factions WHERE faction_key = 'medical_alliance'
UNION ALL SELECT id, 2, 'Patient', 100, '{"xp_bonus": 0.03}' FROM cfx_factions WHERE faction_key = 'medical_alliance'
UNION ALL SELECT id, 3, 'Provider', 500, '{"xp_bonus": 0.07}' FROM cfx_factions WHERE faction_key = 'medical_alliance'
UNION ALL SELECT id, 4, 'Partner', 1500, '{"xp_bonus": 0.12}' FROM cfx_factions WHERE faction_key = 'medical_alliance'
UNION ALL SELECT id, 5, 'Benefactor', 5000, '{"xp_bonus": 0.20}' FROM cfx_factions WHERE faction_key = 'medical_alliance'

UNION ALL SELECT id, 1, 'Outsider', 0, '{"breed_bonus": 0}' FROM cfx_factions WHERE faction_key = 'research_collective'
UNION ALL SELECT id, 2, 'Intern', 100, '{"breed_bonus": 0.03}' FROM cfx_factions WHERE faction_key = 'research_collective'
UNION ALL SELECT id, 3, 'Researcher', 500, '{"breed_bonus": 0.07}' FROM cfx_factions WHERE faction_key = 'research_collective'
UNION ALL SELECT id, 4, 'Scientist', 1500, '{"breed_bonus": 0.12}' FROM cfx_factions WHERE faction_key = 'research_collective'
UNION ALL SELECT id, 5, 'Director', 5000, '{"breed_bonus": 0.20}' FROM cfx_factions WHERE faction_key = 'research_collective'

UNION ALL SELECT id, 1, 'Nobody', 0, '{"heat_reduction": 0}' FROM cfx_factions WHERE faction_key = 'underground_cartel'
UNION ALL SELECT id, 2, 'Associate', 100, '{"heat_reduction": 0.05}' FROM cfx_factions WHERE faction_key = 'underground_cartel'
UNION ALL SELECT id, 3, 'Soldier', 500, '{"heat_reduction": 0.10}' FROM cfx_factions WHERE faction_key = 'underground_cartel'
UNION ALL SELECT id, 4, 'Captain', 1500, '{"heat_reduction": 0.15}' FROM cfx_factions WHERE faction_key = 'underground_cartel'
UNION ALL SELECT id, 5, 'Boss', 5000, '{"heat_reduction": 0.25}' FROM cfx_factions WHERE faction_key = 'underground_cartel';

-- ============================================
-- 2. RANDOM EVENTS
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_random_event_definitions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    event_type ENUM('positive', 'negative', 'neutral', 'choice') NOT NULL DEFAULT 'neutral',
    trigger_chance DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    min_level INT NOT NULL DEFAULT 1,
    duration_minutes INT DEFAULT NULL,
    choices JSON DEFAULT NULL,
    outcomes JSON NOT NULL,
    cooldown_hours INT NOT NULL DEFAULT 24,
    icon VARCHAR(50) DEFAULT '❓',
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO cfx_random_event_definitions (event_key, name, description, event_type, trigger_chance, min_level, outcomes, icon) VALUES
('bumper_crop', 'Bumper Crop!', 'Your plants are thriving! Next harvest yields 50% more.', 'positive', 0.08, 1, '{"effect": "yield_bonus", "value": 0.5, "duration_harvests": 1}', '🌾'),
('quality_surge', 'Quality Surge', 'Perfect conditions result in higher quality buds.', 'positive', 0.06, 5, '{"effect": "quality_bonus", "value": 10, "duration_harvests": 3}', '✨'),
('lucky_seeds', 'Lucky Seeds', 'You found some rare seeds!', 'positive', 0.04, 3, '{"effect": "grant_seeds", "rarity": "rare", "quantity": 3}', '🍀'),
('market_boom', 'Market Boom', 'Prices are up! Sell now for 25% more.', 'positive', 0.05, 5, '{"effect": "price_bonus", "value": 0.25, "duration_minutes": 30}', '📈'),
('growth_spurt', 'Growth Spurt', 'Plants growing 30% faster for the next hour!', 'positive', 0.07, 1, '{"effect": "grow_speed", "value": 0.3, "duration_minutes": 60}', '🌱'),
('pest_infestation', 'Pest Infestation', 'Pests are attacking! Quality reduced by 15%.', 'negative', 0.06, 1, '{"effect": "quality_penalty", "value": -15, "duration_harvests": 2}', '🐛'),
('power_outage', 'Power Outage', 'Growing slowed by 20% until fixed.', 'negative', 0.05, 3, '{"effect": "grow_penalty", "value": 0.2, "duration_minutes": 45}', '⚡'),
('market_crash', 'Market Crash', 'Prices dropped! Sales worth 20% less.', 'negative', 0.04, 5, '{"effect": "price_penalty", "value": -0.2, "duration_minutes": 30}', '📉'),
('equipment_failure', 'Equipment Failure', 'Some equipment needs repair. Efficiency reduced.', 'negative', 0.05, 8, '{"effect": "efficiency_penalty", "value": 0.15, "duration_minutes": 60}', '🔧'),
('heat_wave', 'Heat Wave', 'Increased attention from authorities! Heat +20.', 'negative', 0.04, 10, '{"effect": "heat_increase", "value": 20}', '🔥'),
('mysterious_stranger', 'Mysterious Stranger', 'A stranger offers you a deal...', 'choice', 0.03, 5, '{"choices": [{"label": "Accept", "effect": "cash_or_heat", "cash": 5000, "heat": 15}, {"label": "Decline", "effect": "none"}]}', '🕵️'),
('business_opportunity', 'Business Opportunity', 'Invest cash for potential returns?', 'choice', 0.04, 10, '{"choices": [{"label": "Invest $10,000", "effect": "gamble", "cost": 10000, "win_chance": 0.6, "win_mult": 2.5}, {"label": "Pass", "effect": "none"}]}', '💼'),
('research_breakthrough', 'Research Breakthrough', 'Speed up current research or gain XP?', 'choice', 0.03, 8, '{"choices": [{"label": "Speed Research", "effect": "research_boost", "value": 0.5}, {"label": "Gain 500 XP", "effect": "grant_xp", "value": 500}]}', '💡');

-- ============================================
-- 3. MINIGAMES (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_minigames (minigame_key, name, description, reward_type, base_reward_value, max_score, cooldown_ms, is_active, min_level) VALUES
('trim_rush', 'Trim Rush', 'Trim as many buds as you can in 60 seconds!', 'cash', 100, 1000, 3600000, 1, 1),
('strain_match', 'Strain Match', 'Match strain pairs to test your knowledge', 'xp', 50, 500, 3600000, 1, 3),
('market_trader', 'Market Trader', 'Buy low, sell high in this trading sim', 'cash', 500, 2000, 7200000, 1, 5),
('grow_defense', 'Grow Defense', 'Protect your plants from pests!', 'cash', 250, 800, 3600000, 1, 8),
('genetics_puzzle', 'Genetics Puzzle', 'Solve breeding puzzles for rewards', 'xp', 200, 1500, 7200000, 1, 10),
('slot_machine', 'Lucky Slots', 'Try your luck at the slots!', 'cash', 0, 100, 60000, 1, 5);

-- ============================================
-- 4. BOSSES (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_bosses (boss_key, name, description, difficulty, challenge_type, challenge_goal, time_limit_ms, reward_cash, reward_xp, is_active, min_level, reward_item, cooldown_hours) VALUES
('the_inspector', 'The Inspector', 'A nosy government inspector is snooping around. Distract them!', 1, 'stealth', 500, 300000, 5000, 500, 1, 5, 'inspector_badge', 24),
('rival_grower', 'Rival Grower', 'A competing grower is trying to steal your customers!', 2, 'sales', 10000, 600000, 15000, 1000, 1, 10, 'rival_seeds', 48),
('pest_king', 'The Pest King', 'A massive infestation threatens your entire operation!', 3, 'combat', 3000, 900000, 25000, 2000, 1, 15, 'pesticide_pack', 72),
('the_don', 'The Don', 'The local crime boss wants a cut. Negotiate or fight!', 4, 'negotiation', 5000, 1200000, 50000, 5000, 1, 20, 'protection_token', 168),
('mega_harvest', 'Mega Harvest', 'Harvest an entire warehouse worth of plants!', 5, 'speed', 100, 1800000, 100000, 10000, 1, 25, 'golden_trimmer', 168);

-- ============================================
-- 5. MUTATIONS (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_mutations (mutation_key, name, description, effect_type, effect_value, rarity, mutation_chance, base_chance, is_positive, is_active) VALUES
('vigor', 'Vigor', 'Plants grow 15% faster', 'grow_speed', 0.15, 'common', 0.12, 0.12, 1, 1),
('dense_buds', 'Dense Buds', 'Yield increased by 20%', 'yield_bonus', 0.20, 'common', 0.10, 0.10, 1, 1),
('frost', 'Frost', 'Quality boosted by 10%', 'quality_bonus', 10, 'uncommon', 0.08, 0.08, 1, 1),
('purple_haze', 'Purple Haze', 'Unique coloring, +25% sell price', 'price_bonus', 0.25, 'uncommon', 0.06, 0.06, 1, 1),
('auto_flower', 'Auto-Flower', 'No light cycle needed, 30% faster', 'grow_speed', 0.30, 'rare', 0.04, 0.04, 1, 1),
('giant', 'Giant', 'Massive yields, +50% quantity', 'yield_bonus', 0.50, 'rare', 0.03, 0.03, 1, 1),
('crystal', 'Crystal', 'Extremely high THC, +20% quality', 'quality_bonus', 20, 'epic', 0.02, 0.02, 1, 1),
('golden', 'Golden', 'Legendary golden buds, 2x sell price', 'price_bonus', 1.00, 'legendary', 0.005, 0.005, 1, 1),
('phoenix', 'Phoenix', 'Plants never wither', 'no_wither', 1, 'legendary', 0.003, 0.003, 1, 1);

-- ============================================
-- 6. BLACK MARKET CONTACTS (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_black_market_contacts (contact_key, name, description, reputation_required, price_multiplier, heat_multiplier, is_active, cooldown_minutes, min_quality, max_quantity_per_sale) VALUES
('shady_sam', 'Shady Sam', 'A small-time dealer. Low prices but low risk.', 0, 0.8, 0.5, 1, 60, 0, 100),
('nervous_nick', 'Nervous Nick', 'Pays decent but easily spooked.', 50, 1.0, 0.8, 1, 90, 10, 80),
('cool_kate', 'Cool Kate', 'Reliable contact with good prices.', 150, 1.2, 1.0, 1, 120, 30, 60),
('big_tony', 'Big Tony', 'Bulk buyer. Great prices for large quantities.', 300, 1.4, 1.5, 1, 180, 40, 200),
('medical_mike', 'Medical Mike', 'Pays premium for high quality medical grade.', 500, 1.6, 1.2, 1, 240, 60, 50),
('vip_victoria', 'VIP Victoria', 'Celebrity clientele. Top dollar for top shelf.', 1000, 2.0, 2.0, 1, 360, 80, 30),
('the_chemist', 'The Chemist', 'Wants only the rarest genetics.', 2000, 2.5, 2.5, 1, 480, 90, 20),
('international_ivan', 'International Ivan', 'Export connections. Huge payouts.', 5000, 3.0, 3.5, 1, 720, 95, 10);

-- ============================================
-- 7. EQUIPMENT (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_equipment (equipment_key, name, description, category, tier, effect_type, effect_value, price, unlock_research_key, icon, is_active) VALUES
-- Lighting
('basic_lights', 'Basic Grow Lights', 'Standard fluorescent lights', 'lighting', 1, 'quality_bonus', 0.05, 1000, NULL, '💡', 1),
('led_lights', 'LED Grow Lights', 'Energy efficient with better spectrum', 'lighting', 2, 'quality_bonus', 0.10, 5000, 'climate_control', '🔆', 1),
('quantum_lights', 'Quantum Board Lights', 'Top of the line lighting', 'lighting', 3, 'quality_bonus', 0.20, 25000, 'elite_cultivation', '✨', 1),

-- Climate
('basic_fan', 'Oscillating Fan', 'Basic air circulation', 'climate', 1, 'grow_speed', 0.05, 500, NULL, '🌀', 1),
('carbon_filter', 'Carbon Filter', 'Odor control and air quality', 'climate', 2, 'heat_reduction', 0.10, 3000, 'basic_security', '🌬️', 1),
('hvac_system', 'HVAC System', 'Complete climate control', 'climate', 3, 'quality_bonus', 0.15, 15000, 'climate_control', '❄️', 1),

-- Irrigation
('watering_can', 'Watering Can', 'Manual watering', 'irrigation', 1, 'none', 0, 0, NULL, '🚿', 1),
('drip_system', 'Drip Irrigation', 'Automated watering', 'irrigation', 2, 'grow_speed', 0.10, 2500, 'water_management', '💧', 1),
('hydroponic', 'Hydroponic System', 'Soilless growing', 'irrigation', 3, 'yield_bonus', 0.25, 20000, 'nutrient_optimization', '🌊', 1),

-- Processing
('trim_scissors', 'Trim Scissors', 'Basic trimming tools', 'processing', 1, 'harvest_speed', 0.05, 200, NULL, '✂️', 1),
('trim_machine', 'Trim Machine', 'Automated trimming', 'processing', 2, 'harvest_speed', 0.30, 10000, 'basic_extraction', '⚙️', 1),
('cure_jars', 'Curing Jars', 'Proper curing equipment', 'processing', 1, 'quality_bonus', 0.08, 1500, NULL, '🫙', 1),

-- Security
('basic_lock', 'Basic Lock', 'Simple security', 'security', 1, 'heat_reduction', 0.05, 500, NULL, '🔒', 1),
('camera_system', 'Camera System', 'Surveillance cameras', 'security', 2, 'heat_reduction', 0.15, 8000, 'basic_security', '📹', 1),
('vault_door', 'Vault Door', 'Heavy security', 'security', 3, 'raid_protection', 0.30, 50000, 'stealth_operations', '🚪', 1),

-- Storage
('storage_bins', 'Storage Bins', 'Basic storage', 'storage', 1, 'storage_bonus', 50, 1000, NULL, '📦', 1),
('climate_storage', 'Climate Controlled Storage', 'Preserves quality', 'storage', 2, 'storage_bonus', 200, 10000, 'space_efficiency', '🗄️', 1),
('warehouse_rack', 'Warehouse Racking', 'Industrial storage', 'storage', 3, 'storage_bonus', 1000, 50000, 'location_scouting', '🏗️', 1);

-- ============================================
-- 8. EXTRACTION RECIPES (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_extraction_recipes (recipe_key, name, description, product_type, product_name, input_quantity, output_quantity, process_time_ms, value_multiplier, quality_bonus, quality_retention, unlock_research_key, tier, is_active) VALUES
('kief', 'Kief', 'Collect trichomes for concentrated potency', 'concentrate', 'Kief', 5, 2, 300000, 2.0, 5, 0.90, NULL, 1, 1),
('hash', 'Hash', 'Traditional pressed concentrate', 'concentrate', 'Hash', 10, 3, 600000, 2.5, 8, 0.85, 'basic_extraction', 2, 1),
('rosin', 'Rosin', 'Heat-pressed solventless extract', 'concentrate', 'Rosin', 8, 2, 900000, 3.0, 10, 0.88, 'basic_extraction', 2, 1),
('bubble_hash', 'Bubble Hash', 'Ice water extracted hash', 'concentrate', 'Bubble Hash', 15, 4, 1200000, 3.5, 12, 0.92, 'advanced_extraction', 3, 1),
('shatter', 'Shatter', 'Glass-like BHO concentrate', 'concentrate', 'Shatter', 20, 5, 1800000, 4.0, 15, 0.95, 'advanced_extraction', 3, 1),
('live_resin', 'Live Resin', 'Fresh frozen extraction', 'concentrate', 'Live Resin', 25, 4, 2400000, 5.0, 20, 0.98, 'master_chemist', 4, 1),
('diamonds', 'THC Diamonds', 'Crystalline THC isolate', 'concentrate', 'THC Diamonds', 50, 5, 3600000, 8.0, 30, 1.00, 'master_chemist', 5, 1),
('edible_oil', 'Cannabis Oil', 'Infused cooking oil', 'edible', 'Cannabis Oil', 10, 5, 600000, 2.0, 0, 0.70, 'basic_extraction', 2, 1),
('tincture', 'Tincture', 'Alcohol-based extract', 'tincture', 'Tincture', 15, 8, 900000, 2.5, 5, 0.80, 'quality_testing', 3, 1),
('topical', 'Topical Cream', 'Infused skincare product', 'topical', 'Topical Cream', 10, 10, 1200000, 2.0, 0, 0.60, 'product_refinement', 3, 1);

-- ============================================
-- 9. LOCATIONS (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_locations (location_key, name, description, climate, climate_bonus, climate_bonus_type, climate_bonus_value, heat_modifier, base_slots, max_slots, price, unlock_level, slot_upgrade_cost, is_active) VALUES
('closet', 'Closet Grow', 'A small closet to start your journey', 'indoor', 'stealth', 'stealth', 0.20, 0.5, 2, 4, 0, 1, 1000, 1),
('spare_room', 'Spare Room', 'A dedicated room for growing', 'indoor', 'quality', 'quality', 0.05, 0.8, 4, 8, 10000, 5, 2500, 1),
('garage', 'Garage', 'More space, less climate control', 'indoor', 'yield', 'yield', 0.10, 1.0, 6, 12, 25000, 8, 5000, 1),
('greenhouse', 'Greenhouse', 'Natural light with climate protection', 'greenhouse', 'grow_speed', 'grow_speed', 0.15, 1.2, 8, 16, 75000, 12, 7500, 1),
('warehouse', 'Warehouse', 'Industrial scale operation', 'indoor', 'yield', 'yield', 0.20, 1.5, 12, 30, 250000, 18, 15000, 1),
('bunker', 'Underground Bunker', 'Hidden and secure facility', 'indoor', 'stealth', 'stealth', 0.40, 0.3, 10, 20, 500000, 22, 20000, 1),
('penthouse', 'Penthouse Garden', 'Luxury rooftop growing', 'outdoor', 'quality', 'quality', 0.25, 1.8, 8, 16, 1000000, 28, 25000, 1),
('island', 'Private Island', 'Ultimate growing paradise', 'tropical', 'all_bonus', 'all_bonus', 0.15, 0.2, 20, 50, 5000000, 35, 50000, 1);

-- Ensure starter location is properly marked (add is_starter column if missing)
ALTER TABLE cfx_locations ADD COLUMN IF NOT EXISTS is_starter TINYINT(1) NOT NULL DEFAULT 0;
UPDATE cfx_locations SET is_starter = 1 WHERE price = 0 OR location_key = 'closet';

-- ============================================
-- 10. TERRITORIES (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_territories (name, region, description, bonus_type, bonus_value, control_points_required, is_active) VALUES
('Downtown District', 'downtown', 'Prime retail location with high foot traffic', 'sell_bonus', 0.15, 1000, 1),
('Industrial Zone', 'industrial', 'Warehouses and processing facilities', 'yield_bonus', 0.20, 1500, 1),
('Suburban Area', 'suburbs', 'Quiet residential area, low heat', 'heat_reduction', 0.25, 800, 1),
('University District', 'university', 'Young clientele, high demand', 'xp_bonus', 0.20, 1200, 1),
('Harbor Docks', 'docks', 'Import/export opportunities', 'trade_bonus', 0.25, 2000, 1),
('Medical District', 'medical', 'Premium prices for medical grade', 'quality_bonus', 0.15, 1800, 1);

-- ============================================
-- 11. WORKER TYPES (partial update - table has data but may need more)
-- ============================================

INSERT IGNORE INTO cfx_worker_types (worker_key, name, description, action_type, base_efficiency, base_quality, base_speed, hire_cost, hourly_wage, is_active, unlock_level, base_effect_type, max_tier, icon, base_interval_ms, base_capacity, base_quality_bonus, base_cost) VALUES
('harvester', 'Harvester', 'Automatically harvests ready plants', 'harvest', 1.0, 0, 1.0, 5000, 50, 1, 5, 'harvest', 5, '👨‍🌾', 300000, 1, 0, 5000),
('planter', 'Planter', 'Automatically plants seeds in empty slots', 'plant', 1.0, 0, 1.0, 5000, 50, 1, 5, 'plant', 5, '🌱', 300000, 1, 0, 5000),
('seller', 'Sales Rep', 'Automatically sells harvested product', 'sell', 1.0, 0, 1.0, 10000, 100, 1, 10, 'sell', 5, '💼', 600000, 10, 0, 10000),
('trimmer', 'Trimmer', 'Improves harvest quality', 'quality', 1.0, 0.05, 1.0, 8000, 75, 1, 8, 'quality', 5, '✂️', 0, 0, 0.05, 8000),
('waterer', 'Waterer', 'Keeps plants watered automatically', 'water', 1.0, 0, 1.0, 3000, 30, 1, 3, 'water', 3, '💧', 600000, 5, 0, 3000),
('security', 'Security Guard', 'Reduces heat generation', 'security', 1.0, 0, 1.0, 15000, 150, 1, 15, 'security', 5, '🛡️', 0, 0, 0, 15000),
('research_assistant', 'Research Assistant', 'Speeds up research', 'research', 1.0, 0, 1.0, 25000, 200, 1, 20, 'research', 3, '🔬', 0, 0, 0, 25000),
('extraction_specialist', 'Extraction Specialist', 'Improves extraction yields', 'extraction', 1.0, 0.10, 1.0, 30000, 250, 1, 18, 'extraction', 5, '⚗️', 0, 0, 0.10, 30000);

-- ============================================
-- 12. WORKER TRAITS (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_worker_traits (trait_key, name, description, trait_category, effect_type, effect_value, effect_value_per_level, rarity, max_level, training_time_base_hours, training_cost_base, compatible_workers, unlock_research, is_active) VALUES
('efficient', 'Efficient', 'Works faster', 'efficiency', 'interval_reduction', 0.05, 0.05, 'common', 5, 1, 1000, NULL, NULL, 1),
('careful', 'Careful', 'Higher quality results', 'quality', 'quality_bonus', 0.02, 0.02, 'common', 5, 2, 2000, NULL, NULL, 1),
('productive', 'Productive', 'Handles more at once', 'capacity', 'capacity_bonus', 1, 1, 'uncommon', 5, 2, 1500, NULL, NULL, 1),
('lucky', 'Lucky', 'Chance for bonus rewards', 'special', 'bonus_chance', 0.03, 0.03, 'rare', 3, 4, 5000, NULL, NULL, 1),
('stealthy', 'Stealthy', 'Generates less heat', 'special', 'heat_reduction', 0.05, 0.05, 'uncommon', 5, 3, 3000, '["seller", "security"]', 'basic_security', 1),
('expert', 'Expert', 'Overall efficiency boost', 'efficiency', 'efficiency_bonus', 0.03, 0.03, 'epic', 5, 5, 10000, NULL, 'elite_cultivation', 1);

-- ============================================
-- 13. SHOP ITEMS (using actual schema)
-- ============================================

INSERT IGNORE INTO cfx_shop_items (item_key, item_id, name, description, category, item_type, price, premium_price, effect_type, effect_value, duration_hours, worker_interval, is_active, requires_level, max_owned) VALUES
-- Boosters
('xp_boost_small', 'xp_boost_small', 'XP Boost (Small)', '+25% XP for 1 hour', 'booster', 'consumable', 500, 0, 'xp_bonus', 0.25, 1, 0, 1, 1, 10),
('xp_boost_large', 'xp_boost_large', 'XP Boost (Large)', '+50% XP for 4 hours', 'booster', 'consumable', 2000, 50, 'xp_bonus', 0.50, 4, 0, 1, 5, 5),
('cash_boost_small', 'cash_boost_small', 'Cash Boost (Small)', '+25% cash for 1 hour', 'booster', 'consumable', 500, 0, 'cash_bonus', 0.25, 1, 0, 1, 1, 10),
('cash_boost_large', 'cash_boost_large', 'Cash Boost (Large)', '+50% cash for 4 hours', 'booster', 'consumable', 2000, 50, 'cash_bonus', 0.50, 4, 0, 1, 5, 5),
('grow_boost', 'grow_boost', 'Growth Accelerator', '+30% grow speed for 2 hours', 'booster', 'consumable', 1000, 25, 'grow_speed', 0.30, 2, 0, 1, 3, 5),
('quality_boost', 'quality_boost', 'Quality Enhancer', '+15% quality for next 5 harvests', 'booster', 'consumable', 1500, 30, 'quality_bonus', 15, 0, 0, 1, 8, 5),
('yield_boost', 'yield_boost', 'Yield Maximizer', '+40% yield for next 3 harvests', 'booster', 'consumable', 2500, 50, 'yield_bonus', 0.40, 0, 0, 1, 10, 3),

-- Instant items
('instant_grow', 'instant_grow', 'Instant Grow', 'Instantly complete one plant growth', 'instant', 'consumable', 5000, 100, 'instant_grow', 1, 0, 0, 1, 10, 3),
('instant_breed', 'instant_breed', 'Instant Breed', 'Instantly complete breeding', 'instant', 'consumable', 10000, 200, 'instant_breed', 1, 0, 0, 1, 15, 2),
('heat_reduction', 'heat_reduction', 'Bribe Package', 'Instantly reduce heat by 50', 'instant', 'consumable', 25000, 500, 'heat_reduction', 50, 0, 0, 1, 20, 5),

-- Permanent upgrades
('extra_slot', 'extra_slot', 'Extra Grow Slot', 'Permanently add 1 grow slot', 'upgrade', 'permanent', 50000, 1000, 'max_slots', 1, 0, 0, 1, 15, 10),
('storage_upgrade', 'storage_upgrade', 'Storage Expansion', 'Increase storage by 100', 'upgrade', 'permanent', 25000, 500, 'storage', 100, 0, 0, 1, 10, 10),
('vault_upgrade', 'vault_upgrade', 'Vault Upgrade', 'Increase vault capacity', 'upgrade', 'permanent', 100000, 2000, 'vault_capacity', 1, 0, 0, 1, 20, 5);

-- ============================================
-- 14. CARTEL UPGRADES
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_cartel_upgrades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    upgrade_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL DEFAULT 'expansion',
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL DEFAULT 0,
    max_level INT NOT NULL DEFAULT 10,
    base_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
    cost_multiplier DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    icon VARCHAR(50) DEFAULT '⬆️',
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO cfx_cartel_upgrades (upgrade_key, name, description, category, effect_type, effect_value, max_level, base_cost, cost_multiplier, icon, is_active) VALUES
('member_capacity', 'Member Capacity', 'Increase max cartel members', 'expansion', 'max_members', 5, 10, 10000, 2.0, '👥', 1),
('territory_slots', 'Territory Control', 'Control more territories', 'expansion', 'max_territories', 1, 5, 50000, 2.5, '🗺️', 1),
('shared_bonus', 'Shared Prosperity', 'All members get cash bonus', 'bonus', 'cash_bonus', 0.02, 10, 25000, 1.8, '💰', 1),
('quality_standard', 'Quality Standards', 'All members get quality bonus', 'bonus', 'quality_bonus', 0.01, 10, 30000, 1.8, '✨', 1),
('xp_sharing', 'Knowledge Sharing', 'All members get XP bonus', 'bonus', 'xp_bonus', 0.02, 10, 20000, 1.8, '📚', 1),
('war_strength', 'War Machine', 'Increased war contribution effectiveness', 'war', 'war_bonus', 0.10, 10, 100000, 2.0, '⚔️', 1),
('defense_bonus', 'Fortifications', 'Better territory defense', 'war', 'defense_bonus', 0.10, 10, 75000, 2.0, '🛡️', 1),
('stealth_network', 'Stealth Network', 'Reduced heat for all members', 'bonus', 'heat_reduction', 0.03, 10, 50000, 2.0, '🥷', 1);

-- ============================================
-- 15. RAIDS & DEFENSES
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_raid_defenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    defense_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    defense_type ENUM('passive', 'active', 'bribe') NOT NULL DEFAULT 'passive',
    effectiveness DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    duration_hours INT DEFAULT NULL,
    price DECIMAL(15,2) NOT NULL DEFAULT 0,
    max_owned INT NOT NULL DEFAULT 1,
    unlock_level INT NOT NULL DEFAULT 1,
    unlock_research VARCHAR(100) DEFAULT NULL,
    icon VARCHAR(50) DEFAULT '🛡️',
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO cfx_raid_defenses (defense_key, name, description, defense_type, effectiveness, duration_hours, price, max_owned, unlock_level, icon) VALUES
('basic_alarm', 'Basic Alarm', 'Early warning system', 'passive', 0.05, NULL, 1000, 1, 1, '🚨'),
('reinforced_doors', 'Reinforced Doors', 'Harder to break in', 'passive', 0.10, NULL, 5000, 1, 5, '🚪'),
('guard_dog', 'Guard Dog', 'Loyal protection', 'passive', 0.15, NULL, 10000, 2, 10, '🐕'),
('camera_system_defense', 'Camera System', 'Surveillance coverage', 'passive', 0.12, NULL, 15000, 1, 12, '📹'),
('safe_room', 'Safe Room', 'Protected storage area', 'passive', 0.20, NULL, 50000, 1, 18, '🔐'),
('decoy_stash', 'Decoy Stash', 'Fake product to mislead raids', 'active', 0.30, 24, 25000, 3, 15, '📦'),
('bribe_fund', 'Bribe Fund', 'Pay off the authorities', 'bribe', 0.50, 48, 100000, 1, 20, '💰'),
('legal_team', 'Legal Team', 'Lawyers on retainer', 'active', 0.40, 72, 250000, 1, 25, '⚖️');

-- ============================================
-- 16. ENSURE PLAYER COLUMNS
-- ============================================

-- Add heat column to players if missing
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS heat INT NOT NULL DEFAULT 0;
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS last_raid_at DATETIME DEFAULT NULL;
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS raid_protection_until DATETIME DEFAULT NULL;

-- Ensure all players have a vault record
INSERT IGNORE INTO cfx_player_vault (player_id, vault_level, vault_cash)
SELECT id, 0, 0 FROM cfx_players WHERE id NOT IN (SELECT player_id FROM cfx_player_vault);

-- ============================================
-- 17. TOURNAMENTS
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_tournaments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tournament_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    tournament_type ENUM('daily', 'weekly', 'monthly', 'seasonal') NOT NULL DEFAULT 'weekly',
    score_type VARCHAR(50) NOT NULL DEFAULT 'harvest_count',
    entry_fee DECIMAL(15,2) NOT NULL DEFAULT 0,
    min_level INT NOT NULL DEFAULT 1,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    prize_pool DECIMAL(15,2) NOT NULL DEFAULT 0,
    prize_distribution JSON DEFAULT NULL,
    max_participants INT DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO cfx_tournaments (tournament_key, name, description, tournament_type, score_type, entry_fee, min_level, start_time, end_time, prize_pool, prize_distribution, max_participants, is_active) VALUES
('weekly_harvest', 'Weekly Harvest Challenge', 'Who can harvest the most this week?', 'weekly', 'harvest_count', 1000, 5, DATE_ADD(NOW(), INTERVAL (7 - WEEKDAY(NOW())) DAY), DATE_ADD(DATE_ADD(NOW(), INTERVAL (7 - WEEKDAY(NOW())) DAY), INTERVAL 7 DAY), 100000, '[0.5, 0.25, 0.15, 0.10]', 100, 1),
('quality_kings', 'Quality Kings', 'Produce the highest quality buds!', 'weekly', 'avg_quality', 2500, 10, DATE_ADD(NOW(), INTERVAL (7 - WEEKDAY(NOW())) DAY), DATE_ADD(DATE_ADD(NOW(), INTERVAL (7 - WEEKDAY(NOW())) DAY), INTERVAL 7 DAY), 250000, '[0.5, 0.25, 0.15, 0.10]', 50, 1),
('breeding_masters', 'Breeding Masters', 'Create the most new strains!', 'monthly', 'strains_created', 10000, 15, DATE_ADD(NOW(), INTERVAL 1 MONTH), DATE_ADD(NOW(), INTERVAL 2 MONTH), 1000000, '[0.4, 0.25, 0.15, 0.10, 0.10]', 25, 1),
('cash_champion', 'Cash Champion', 'Earn the most cash this season!', 'seasonal', 'cash_earned', 25000, 20, NOW(), DATE_ADD(NOW(), INTERVAL 3 MONTH), 5000000, '[0.35, 0.20, 0.15, 0.10, 0.10, 0.10]', 10, 1);

SELECT 'All game systems seeded successfully!' AS status;
