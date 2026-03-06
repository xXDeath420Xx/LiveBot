-- Phase 5: Events, Mini-games & Polish
-- Run this migration after add_phase4_features.sql

-- ============================================
-- 5.1 DISPENSARY MANAGEMENT
-- ============================================

-- Player dispensaries
CREATE TABLE IF NOT EXISTS cfx_dispensaries (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'My Dispensary',
    tier INT NOT NULL DEFAULT 1,
    reputation INT NOT NULL DEFAULT 0,
    customer_capacity INT NOT NULL DEFAULT 3,
    price_modifier DECIMAL(10,4) NOT NULL DEFAULT 1.0,
    is_open BOOLEAN DEFAULT FALSE,
    total_sales INT NOT NULL DEFAULT 0,
    total_revenue BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    UNIQUE KEY unique_player_dispensary (player_id)
);

-- Dispensary inventory (what's for sale)
CREATE TABLE IF NOT EXISTS cfx_dispensary_inventory (
    id INT PRIMARY KEY AUTO_INCREMENT,
    dispensary_id INT NOT NULL,
    inventory_id INT NOT NULL,
    strain_id INT NOT NULL,
    quality INT NOT NULL,
    quantity INT NOT NULL,
    price_per_unit BIGINT NOT NULL,
    listed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dispensary_id) REFERENCES cfx_dispensaries(id) ON DELETE CASCADE,
    FOREIGN KEY (inventory_id) REFERENCES cfx_inventory(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
);

-- Customer types
CREATE TABLE IF NOT EXISTS cfx_dispensary_customers (
    id INT PRIMARY KEY AUTO_INCREMENT,
    customer_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    preferred_quality_min INT NOT NULL DEFAULT 0,
    preferred_quality_max INT NOT NULL DEFAULT 100,
    budget_min BIGINT NOT NULL,
    budget_max BIGINT NOT NULL,
    patience_seconds INT NOT NULL DEFAULT 60,
    tip_chance DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    tip_multiplier DECIMAL(5,4) NOT NULL DEFAULT 0.15,
    spawn_weight INT NOT NULL DEFAULT 100,
    icon VARCHAR(50) DEFAULT '👤',
    is_active BOOLEAN DEFAULT TRUE
);

-- Active customer orders
CREATE TABLE IF NOT EXISTS cfx_dispensary_orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    dispensary_id INT NOT NULL,
    customer_id INT NOT NULL,
    status ENUM('waiting', 'served', 'left', 'expired') NOT NULL DEFAULT 'waiting',
    requested_quality_min INT NOT NULL,
    budget BIGINT NOT NULL,
    sale_amount BIGINT DEFAULT NULL,
    tip_amount BIGINT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP NULL,
    FOREIGN KEY (dispensary_id) REFERENCES cfx_dispensaries(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES cfx_dispensary_customers(id) ON DELETE CASCADE
);

-- Seed customer types
INSERT INTO cfx_dispensary_customers (customer_key, name, description, preferred_quality_min, preferred_quality_max, budget_min, budget_max, patience_seconds, tip_chance, tip_multiplier, spawn_weight, icon) VALUES
('casual', 'Casual Buyer', 'Not picky, just wants something', 0, 50, 50, 200, 90, 0.05, 0.10, 150, '😊'),
('regular', 'Regular Customer', 'Knows what they like', 30, 70, 100, 400, 75, 0.10, 0.15, 120, '🙂'),
('connoisseur', 'Connoisseur', 'Only the finest quality', 70, 100, 300, 1000, 60, 0.20, 0.20, 80, '🧐'),
('bulk_buyer', 'Bulk Buyer', 'Buys large quantities', 20, 60, 500, 2000, 120, 0.15, 0.25, 50, '📦'),
('tourist', 'Tourist', 'Visiting, curious buyer', 0, 100, 75, 300, 45, 0.25, 0.30, 100, '🎒'),
('medical', 'Medical Patient', 'Needs specific quality', 50, 90, 200, 600, 90, 0.15, 0.15, 70, '🏥'),
('high_roller', 'High Roller', 'Money is no object', 80, 100, 1000, 5000, 45, 0.30, 0.35, 30, '💎'),
('sketchy', 'Sketchy Customer', 'Might cause trouble...', 0, 40, 30, 100, 30, 0.02, 0.05, 40, '😬');

-- ============================================
-- 5.2 SEASONAL STRAINS (already in cfx_strains)
-- ============================================

-- Add seasonal columns to strains if not exists
ALTER TABLE cfx_strains ADD COLUMN IF NOT EXISTS is_seasonal BOOLEAN DEFAULT FALSE;
ALTER TABLE cfx_strains ADD COLUMN IF NOT EXISTS seasonal_event VARCHAR(50) DEFAULT NULL;
ALTER TABLE cfx_strains ADD COLUMN IF NOT EXISTS available_from DATE DEFAULT NULL;
ALTER TABLE cfx_strains ADD COLUMN IF NOT EXISTS available_until DATE DEFAULT NULL;

-- ============================================
-- 5.3 RANDOM EVENTS
-- ============================================

-- Random event definitions
CREATE TABLE IF NOT EXISTS cfx_random_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    event_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    event_type ENUM('positive', 'negative', 'neutral', 'choice') NOT NULL,
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL,
    duration_minutes INT DEFAULT NULL,
    base_chance DECIMAL(10,6) NOT NULL DEFAULT 0.01,
    cooldown_hours INT NOT NULL DEFAULT 24,
    min_level INT NOT NULL DEFAULT 1,
    icon VARCHAR(50) DEFAULT '❓',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player active events
CREATE TABLE IF NOT EXISTS cfx_player_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    event_id INT NOT NULL,
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    resolved BOOLEAN DEFAULT FALSE,
    outcome VARCHAR(50) DEFAULT NULL,
    outcome_value BIGINT DEFAULT NULL,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES cfx_random_events(id) ON DELETE CASCADE
);

-- Seed random events
INSERT INTO cfx_random_events (event_key, name, description, event_type, effect_type, effect_value, duration_minutes, base_chance, cooldown_hours, min_level, icon) VALUES
-- Positive events
('lucky_harvest', 'Lucky Harvest', 'Your next harvest yields 50% more!', 'positive', 'yield_bonus', 0.50, 60, 0.02, 12, 1, '🍀'),
('quality_surge', 'Quality Surge', 'All growing plants gain +20 quality', 'positive', 'quality_bonus', 20, 30, 0.015, 24, 5, '✨'),
('buyer_rush', 'Buyer Rush', 'Market prices increased by 25%', 'positive', 'price_bonus', 0.25, 45, 0.01, 24, 3, '📈'),
('mystery_seeds', 'Mystery Seeds', 'Found rare seeds in your garden!', 'positive', 'free_seeds', 3, NULL, 0.005, 48, 10, '🎁'),
('xp_boost', 'Enlightenment', 'Double XP for the next hour', 'positive', 'xp_multiplier', 2.0, 60, 0.02, 12, 1, '🧠'),

-- Negative events
('pest_attack', 'Pest Infestation', 'Pests are attacking! Quality reduced', 'negative', 'quality_penalty', -15, 30, 0.015, 24, 1, '🐛'),
('power_outage', 'Power Outage', 'Growth slowed by 30%', 'negative', 'grow_speed', -0.30, 60, 0.01, 24, 5, '🔌'),
('market_crash', 'Market Crash', 'Prices dropped 20%', 'negative', 'price_penalty', -0.20, 45, 0.008, 48, 3, '📉'),
('equipment_failure', 'Equipment Malfunction', 'Your equipment is less effective', 'negative', 'equipment_penalty', -0.25, 60, 0.01, 24, 10, '🔧'),

-- Neutral/choice events
('suspicious_offer', 'Suspicious Offer', 'A stranger offers a deal... accept?', 'choice', 'risky_deal', 0, NULL, 0.005, 72, 5, '🕵️'),
('research_opportunity', 'Research Opportunity', 'Chance to accelerate research', 'choice', 'research_choice', 0, NULL, 0.008, 48, 15, '🔬'),
('cartel_favor', 'Cartel Request', 'The cartel needs a favor...', 'choice', 'faction_choice', 0, NULL, 0.005, 96, 20, '🤝');

-- ============================================
-- 5.4 BOSS ENCOUNTERS
-- ============================================

-- Boss definitions
CREATE TABLE IF NOT EXISTS cfx_bosses (
    id INT PRIMARY KEY AUTO_INCREMENT,
    boss_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    difficulty ENUM('easy', 'medium', 'hard', 'legendary') NOT NULL DEFAULT 'medium',
    challenge_type ENUM('harvest', 'quality', 'sales', 'speed') NOT NULL,
    challenge_goal BIGINT NOT NULL,
    time_limit_minutes INT NOT NULL DEFAULT 60,
    reward_cash BIGINT NOT NULL DEFAULT 0,
    reward_xp INT NOT NULL DEFAULT 0,
    reward_item VARCHAR(50) DEFAULT NULL,
    min_level INT NOT NULL DEFAULT 1,
    cooldown_hours INT NOT NULL DEFAULT 24,
    icon VARCHAR(50) DEFAULT '👹',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player boss encounters
CREATE TABLE IF NOT EXISTS cfx_boss_encounters (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    boss_id INT NOT NULL,
    status ENUM('active', 'victory', 'defeat', 'abandoned') NOT NULL DEFAULT 'active',
    player_score BIGINT NOT NULL DEFAULT 0,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ends_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP NULL,
    reward_claimed BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (boss_id) REFERENCES cfx_bosses(id) ON DELETE CASCADE
);

-- Seed bosses
INSERT INTO cfx_bosses (boss_key, name, description, difficulty, challenge_type, challenge_goal, time_limit_minutes, reward_cash, reward_xp, min_level, cooldown_hours, icon) VALUES
('harvest_sprint', 'Harvest Sprint', 'Harvest 20 plants before time runs out!', 'easy', 'harvest', 20, 30, 5000, 200, 1, 12, '🌾'),
('quality_master', 'Quality Challenge', 'Achieve average quality of 80+', 'medium', 'quality', 80, 60, 15000, 500, 10, 24, '💎'),
('sales_blitz', 'Sales Blitz', 'Sell $50,000 worth in an hour', 'medium', 'sales', 50000, 60, 20000, 750, 15, 24, '💰'),
('speed_grow', 'Speed Grow', 'Complete 10 full grow cycles', 'hard', 'speed', 10, 120, 50000, 1500, 20, 48, '⚡'),
('legendary_harvest', 'Legendary Harvest', 'Harvest 100 plants in 2 hours', 'legendary', 'harvest', 100, 120, 200000, 5000, 30, 168, '👑'),
('perfection', 'Pursuit of Perfection', 'Produce 5 items at 95+ quality', 'hard', 'quality', 5, 180, 75000, 2000, 25, 72, '⭐'),
('millionaire', 'Millionaire Challenge', 'Earn $500,000 in sales', 'legendary', 'sales', 500000, 240, 500000, 10000, 40, 168, '🤑');

-- ============================================
-- 5.5 MINI-GAMES
-- ============================================

-- Mini-game definitions
CREATE TABLE IF NOT EXISTS cfx_minigames (
    id INT PRIMARY KEY AUTO_INCREMENT,
    minigame_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    instructions TEXT,
    reward_type ENUM('cash', 'xp', 'items', 'quality_boost') NOT NULL,
    base_reward_value BIGINT NOT NULL,
    max_score INT NOT NULL DEFAULT 100,
    cooldown_minutes INT NOT NULL DEFAULT 60,
    min_level INT NOT NULL DEFAULT 1,
    icon VARCHAR(50) DEFAULT '🎮',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player mini-game records
CREATE TABLE IF NOT EXISTS cfx_player_minigames (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    minigame_id INT NOT NULL,
    high_score INT NOT NULL DEFAULT 0,
    play_count INT NOT NULL DEFAULT 0,
    total_rewards BIGINT NOT NULL DEFAULT 0,
    last_played_at TIMESTAMP NULL,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (minigame_id) REFERENCES cfx_minigames(id) ON DELETE CASCADE,
    UNIQUE KEY unique_player_minigame (player_id, minigame_id)
);

-- Seed mini-games
INSERT INTO cfx_minigames (minigame_key, name, description, instructions, reward_type, base_reward_value, max_score, cooldown_minutes, min_level, icon) VALUES
('trim_master', 'Trim Master', 'Trim buds for maximum quality', 'Click the highlighted areas to trim. More precision = higher score!', 'quality_boost', 10, 100, 30, 1, '✂️'),
('quality_inspector', 'Quality Inspector', 'Spot the highest quality products', 'Select items in order of quality. Speed and accuracy matter!', 'xp', 100, 100, 45, 5, '🔍'),
('price_negotiator', 'Price Negotiator', 'Haggle for the best prices', 'Choose the right responses to negotiate higher prices', 'cash', 1000, 100, 60, 10, '🤝'),
('memory_strains', 'Strain Memory', 'Match strain pairs', 'Classic memory game with strain cards. Fewer moves = higher score!', 'xp', 75, 100, 30, 1, '🧠'),
('quick_plant', 'Quick Plant', 'Plant as fast as possible', 'Tap the empty slots in the correct order to plant quickly', 'cash', 500, 100, 20, 1, '🌱'),
('harvest_rhythm', 'Harvest Rhythm', 'Harvest to the beat', 'Time your harvests to the rhythm for bonus rewards', 'cash', 750, 100, 45, 5, '🎵');

-- Create indexes for performance
CREATE INDEX idx_dispensary_orders_status ON cfx_dispensary_orders(dispensary_id, status);
CREATE INDEX idx_player_events_active ON cfx_player_events(player_id, resolved);
CREATE INDEX idx_boss_encounters_status ON cfx_boss_encounters(player_id, status);
CREATE INDEX idx_player_minigames_cooldown ON cfx_player_minigames(player_id, last_played_at);
