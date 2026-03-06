-- Worker Enhancement System
-- Adds worker tiers, traits, training, and upgrade paths

-- =====================================================
-- Worker Types Definition
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_worker_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    base_effect_type VARCHAR(50) NOT NULL,
    base_interval_ms INT NOT NULL DEFAULT 300000,
    max_tier INT NOT NULL DEFAULT 5,
    base_capacity INT NOT NULL DEFAULT 1,
    base_efficiency DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    base_quality_bonus DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    unlock_level INT NOT NULL DEFAULT 1,
    unlock_research VARCHAR(50) DEFAULT NULL,
    base_cost INT NOT NULL DEFAULT 10000,
    icon VARCHAR(50) DEFAULT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- Worker Traits System
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_worker_traits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    trait_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    trait_category ENUM('speed', 'efficiency', 'quality', 'capacity', 'special') NOT NULL,
    effect_type VARCHAR(50) NOT NULL,
    effect_value_per_level DECIMAL(8,4) NOT NULL,
    max_level INT NOT NULL DEFAULT 10,
    training_time_base_hours DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    training_cost_base INT NOT NULL DEFAULT 500,
    compatible_workers JSON DEFAULT NULL,
    unlock_research VARCHAR(50) DEFAULT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- Player Workers (Enhanced)
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_player_workers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    worker_type_id INT NOT NULL,
    name VARCHAR(100) DEFAULT NULL,
    tier INT NOT NULL DEFAULT 1,
    experience INT NOT NULL DEFAULT 0,
    total_actions INT NOT NULL DEFAULT 0,

    -- Efficiency stats
    current_interval_ms INT NOT NULL,
    current_capacity INT NOT NULL DEFAULT 1,
    current_efficiency DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    current_quality_bonus DECIMAL(5,2) NOT NULL DEFAULT 0.00,

    -- Status
    is_enabled BOOLEAN DEFAULT TRUE,
    is_training BOOLEAN DEFAULT FALSE,
    training_completes_at DATETIME DEFAULT NULL,
    last_action_at DATETIME DEFAULT NULL,

    -- Configuration
    config JSON DEFAULT NULL,

    hired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_type_id) REFERENCES cfx_worker_types(id),
    INDEX idx_player_workers_player (player_id),
    INDEX idx_player_workers_action (player_id, is_enabled, last_action_at)
);

-- =====================================================
-- Worker Trait Progress
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_worker_trait_levels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    trait_id INT NOT NULL,
    current_level INT NOT NULL DEFAULT 0,
    training_progress DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    upgraded_at DATETIME DEFAULT NULL,

    FOREIGN KEY (worker_id) REFERENCES cfx_player_workers(id) ON DELETE CASCADE,
    FOREIGN KEY (trait_id) REFERENCES cfx_worker_traits(id),
    UNIQUE KEY unique_worker_trait (worker_id, trait_id)
);

-- =====================================================
-- Worker Training Queue
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_worker_training (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    worker_id INT NOT NULL,
    trait_id INT NOT NULL,
    target_level INT NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completes_at DATETIME NOT NULL,
    cost_paid INT NOT NULL DEFAULT 0,
    status ENUM('training', 'completed', 'cancelled') DEFAULT 'training',

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES cfx_player_workers(id) ON DELETE CASCADE,
    FOREIGN KEY (trait_id) REFERENCES cfx_worker_traits(id),
    INDEX idx_training_completion (status, completes_at)
);

-- =====================================================
-- Worker Upgrade Costs
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_worker_tier_costs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_type_id INT NOT NULL,
    from_tier INT NOT NULL,
    to_tier INT NOT NULL,
    cost_cash INT NOT NULL,
    cost_xp INT NOT NULL DEFAULT 0,
    required_research VARCHAR(50) DEFAULT NULL,
    required_actions INT NOT NULL DEFAULT 0,
    interval_reduction_percent INT NOT NULL DEFAULT 10,
    efficiency_bonus DECIMAL(5,2) NOT NULL DEFAULT 0.10,
    capacity_bonus INT NOT NULL DEFAULT 0,
    quality_bonus DECIMAL(5,2) NOT NULL DEFAULT 0.00,

    FOREIGN KEY (worker_type_id) REFERENCES cfx_worker_types(id),
    UNIQUE KEY unique_tier_upgrade (worker_type_id, from_tier, to_tier)
);

-- =====================================================
-- Worker Action Log (Enhanced)
-- =====================================================
CREATE TABLE IF NOT EXISTS cfx_worker_action_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    worker_id INT NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    items_processed INT NOT NULL DEFAULT 0,
    cash_earned DECIMAL(15,2) NOT NULL DEFAULT 0,
    xp_earned INT NOT NULL DEFAULT 0,
    quality_avg DECIMAL(5,2) DEFAULT NULL,
    efficiency_used DECIMAL(5,2) DEFAULT NULL,
    details JSON DEFAULT NULL,
    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES cfx_player_workers(id) ON DELETE CASCADE,
    INDEX idx_worker_log_player (player_id, performed_at),
    INDEX idx_worker_log_worker (worker_id, performed_at)
);

-- =====================================================
-- Seed Data: Worker Types
-- =====================================================
INSERT INTO cfx_worker_types (worker_key, name, description, base_effect_type, base_interval_ms, max_tier, base_capacity, base_efficiency, base_quality_bonus, unlock_level, base_cost, icon) VALUES
('trimmer', 'Trimmer', 'Harvests ready plants and processes them for sale. Higher tiers harvest more plants per cycle.', 'auto_harvest', 300000, 5, 2, 1.00, 0.00, 1, 10000, '✂️'),
('propagation_tech', 'Propagation Tech', 'Plants seeds in empty grow slots automatically. Improved tiers can handle more slots.', 'auto_plant', 300000, 5, 2, 1.00, 0.00, 3, 15000, '🌱'),
('sales_rep', 'Sales Rep', 'Sells harvested product to NPCs. Higher tiers get better prices and move more volume.', 'auto_sell', 600000, 5, 5, 1.00, 0.00, 5, 25000, '💰'),
('quality_inspector', 'Quality Inspector', 'Improves quality of harvests. Each tier adds quality bonus to all harvested plants.', 'quality_boost', 0, 5, 0, 1.00, 0.05, 10, 50000, '🔍'),
('logistics_coordinator', 'Logistics Coordinator', 'Manages inventory and storage. Higher tiers unlock more storage and better organization.', 'storage_boost', 0, 5, 10, 1.00, 0.00, 8, 35000, '📦'),
('research_assistant', 'Research Assistant', 'Speeds up research completion. Each tier reduces research time.', 'research_speed', 0, 5, 0, 0.10, 0.00, 15, 75000, '🔬'),
('extraction_specialist', 'Extraction Specialist', 'Operates extraction equipment. Higher tiers produce better quality extracts.', 'extraction_boost', 0, 5, 1, 1.00, 0.10, 12, 60000, '⚗️'),
('dispensary_manager', 'Dispensary Manager', 'Manages dispensary operations. Improves customer satisfaction and sales.', 'dispensary_boost', 0, 5, 0, 1.10, 0.00, 20, 100000, '🏪')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- =====================================================
-- Seed Data: Worker Traits
-- =====================================================
INSERT INTO cfx_worker_traits (trait_key, name, description, trait_category, effect_type, effect_value_per_level, max_level, training_time_base_hours, training_cost_base, compatible_workers) VALUES
-- Speed traits
('quick_hands', 'Quick Hands', 'Reduces action interval, letting the worker perform tasks more frequently.', 'speed', 'interval_reduction', 0.05, 10, 2.0, 1000, '["trimmer", "propagation_tech", "sales_rep"]'),
('multitasking', 'Multitasking', 'Increases the number of items processed per action.', 'capacity', 'capacity_bonus', 1, 10, 3.0, 1500, '["trimmer", "propagation_tech", "sales_rep"]'),
('efficiency_expert', 'Efficiency Expert', 'Increases overall efficiency, improving yields and reducing waste.', 'efficiency', 'efficiency_bonus', 0.05, 10, 2.5, 1200, NULL),

-- Quality traits
('quality_eye', 'Eye for Quality', 'Improves quality of output. Harvests are higher quality, sales get better prices.', 'quality', 'quality_bonus', 0.02, 10, 4.0, 2000, '["trimmer", "quality_inspector", "extraction_specialist"]'),
('perfectionist', 'Perfectionist', 'Small chance for exceptional quality results.', 'quality', 'exceptional_chance', 0.03, 5, 6.0, 3000, '["trimmer", "quality_inspector"]'),

-- Special traits
('green_thumb', 'Green Thumb', 'Plants have faster growth when tended by this worker.', 'special', 'growth_speed', 0.03, 10, 3.0, 1800, '["propagation_tech"]'),
('haggler', 'Haggler', 'Gets better prices when selling to NPCs.', 'special', 'price_bonus', 0.04, 10, 3.5, 2000, '["sales_rep", "dispensary_manager"]'),
('customer_service', 'Customer Service', 'Increases customer satisfaction and tip rates.', 'special', 'tip_bonus', 0.05, 10, 2.0, 1500, '["sales_rep", "dispensary_manager"]'),
('scientific_method', 'Scientific Method', 'Speeds up research and extraction processes.', 'special', 'process_speed', 0.05, 10, 4.0, 2500, '["research_assistant", "extraction_specialist"]'),
('inventory_master', 'Inventory Master', 'Increases storage capacity and organization.', 'special', 'storage_bonus', 2, 10, 2.0, 1000, '["logistics_coordinator"]'),

-- Advanced traits (require research)
('automation_sync', 'Automation Sync', 'Workers coordinate better, reducing conflicts and improving throughput.', 'efficiency', 'sync_bonus', 0.03, 5, 8.0, 5000, NULL),
('master_trainer', 'Master Trainer', 'Reduces training time for all traits.', 'special', 'training_speed', 0.10, 5, 10.0, 10000, NULL)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- =====================================================
-- Seed Data: Tier Upgrade Costs
-- =====================================================
-- Trimmer upgrades
INSERT INTO cfx_worker_tier_costs (worker_type_id, from_tier, to_tier, cost_cash, cost_xp, required_actions, interval_reduction_percent, efficiency_bonus, capacity_bonus, quality_bonus) VALUES
((SELECT id FROM cfx_worker_types WHERE worker_key = 'trimmer'), 1, 2, 25000, 500, 100, 10, 0.10, 1, 0.02),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'trimmer'), 2, 3, 75000, 1500, 500, 10, 0.10, 1, 0.03),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'trimmer'), 3, 4, 200000, 5000, 2000, 15, 0.15, 2, 0.05),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'trimmer'), 4, 5, 500000, 15000, 10000, 20, 0.20, 2, 0.10);

-- Propagation Tech upgrades
INSERT INTO cfx_worker_tier_costs (worker_type_id, from_tier, to_tier, cost_cash, cost_xp, required_actions, interval_reduction_percent, efficiency_bonus, capacity_bonus, quality_bonus) VALUES
((SELECT id FROM cfx_worker_types WHERE worker_key = 'propagation_tech'), 1, 2, 30000, 600, 100, 10, 0.10, 1, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'propagation_tech'), 2, 3, 90000, 1800, 500, 10, 0.10, 2, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'propagation_tech'), 3, 4, 250000, 6000, 2000, 15, 0.15, 2, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'propagation_tech'), 4, 5, 600000, 18000, 10000, 20, 0.20, 3, 0.00);

-- Sales Rep upgrades
INSERT INTO cfx_worker_tier_costs (worker_type_id, from_tier, to_tier, cost_cash, cost_xp, required_actions, interval_reduction_percent, efficiency_bonus, capacity_bonus, quality_bonus) VALUES
((SELECT id FROM cfx_worker_types WHERE worker_key = 'sales_rep'), 1, 2, 50000, 1000, 50, 10, 0.10, 2, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'sales_rep'), 2, 3, 150000, 3000, 200, 10, 0.10, 3, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'sales_rep'), 3, 4, 400000, 10000, 1000, 15, 0.15, 5, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'sales_rep'), 4, 5, 1000000, 30000, 5000, 20, 0.20, 5, 0.00);

-- Quality Inspector upgrades
INSERT INTO cfx_worker_tier_costs (worker_type_id, from_tier, to_tier, cost_cash, cost_xp, required_actions, interval_reduction_percent, efficiency_bonus, capacity_bonus, quality_bonus) VALUES
((SELECT id FROM cfx_worker_types WHERE worker_key = 'quality_inspector'), 1, 2, 100000, 2000, 0, 0, 0.00, 0, 0.05),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'quality_inspector'), 2, 3, 300000, 6000, 0, 0, 0.00, 0, 0.05),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'quality_inspector'), 3, 4, 750000, 15000, 0, 0, 0.00, 0, 0.07),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'quality_inspector'), 4, 5, 1500000, 40000, 0, 0, 0.00, 0, 0.10);

-- Research Assistant upgrades
INSERT INTO cfx_worker_tier_costs (worker_type_id, from_tier, to_tier, cost_cash, cost_xp, required_actions, interval_reduction_percent, efficiency_bonus, capacity_bonus, quality_bonus) VALUES
((SELECT id FROM cfx_worker_types WHERE worker_key = 'research_assistant'), 1, 2, 150000, 3000, 0, 0, 0.05, 0, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'research_assistant'), 2, 3, 400000, 8000, 0, 0, 0.05, 0, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'research_assistant'), 3, 4, 900000, 20000, 0, 0, 0.07, 0, 0.00),
((SELECT id FROM cfx_worker_types WHERE worker_key = 'research_assistant'), 4, 5, 2000000, 50000, 0, 0, 0.10, 0, 0.00);

-- =====================================================
-- Add worker-related research nodes
-- =====================================================
INSERT INTO cfx_research_nodes (research_key, name, description, category, tier, cost_cash, cost_xp, research_time_hours, prerequisites, unlock_type, unlock_key, unlock_value, icon, is_active) VALUES
('worker_efficiency_1', 'Basic Workforce Training', 'Unlock worker trait training system. Workers can now learn new skills.', 'business', 2, 15000, 300, 4, '[]', 'feature', 'worker_training', 1, '👷', TRUE),
('worker_efficiency_2', 'Advanced Training Programs', 'Reduce worker training time by 25%.', 'business', 3, 50000, 1000, 8, '["worker_efficiency_1"]', 'bonus', 'training_speed', 0.25, '📚', TRUE),
('worker_automation_1', 'Basic Automation', 'Workers perform actions 10% faster.', 'business', 2, 25000, 500, 6, '[]', 'bonus', 'worker_speed', 0.10, '⚙️', TRUE),
('worker_automation_2', 'Advanced Automation', 'Workers perform actions 15% faster.', 'business', 3, 75000, 1500, 10, '["worker_automation_1"]', 'bonus', 'worker_speed', 0.15, '🤖', TRUE),
('worker_automation_3', 'Master Automation', 'Workers perform actions 20% faster and gain double XP.', 'business', 4, 200000, 4000, 16, '["worker_automation_2"]', 'bonus', 'worker_speed', 0.20, '🔧', TRUE),
('worker_capacity_1', 'Team Expansion', 'Hire up to 2 additional workers.', 'business', 2, 30000, 600, 5, '[]', 'feature', 'max_workers', 2, '👥', TRUE),
('worker_capacity_2', 'Department Growth', 'Hire up to 4 additional workers.', 'business', 3, 100000, 2000, 10, '["worker_capacity_1"]', 'feature', 'max_workers', 4, '🏢', TRUE),
('worker_synergy', 'Worker Synergy', 'Workers gain 5% efficiency for each other active worker.', 'business', 4, 150000, 3000, 12, '["worker_capacity_1", "worker_efficiency_2"]', 'bonus', 'worker_synergy', 0.05, '🤝', TRUE),
('master_cultivator', 'Master Cultivator Program', 'Unlock Tier 5 for Trimmer and Propagation Tech workers.', 'business', 5, 500000, 10000, 24, '["worker_automation_3", "worker_synergy"]', 'feature', 'worker_tier_5', 1, '🏆', TRUE)
ON DUPLICATE KEY UPDATE name = VALUES(name);
