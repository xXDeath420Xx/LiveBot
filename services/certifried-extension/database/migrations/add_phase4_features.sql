-- Phase 4: Social & Competition Systems
-- Run this migration after add_phase3_features.sql

-- ============================================
-- 4.1 CARTELS/GUILDS
-- ============================================

-- Cartel definitions
CREATE TABLE IF NOT EXISTS cfx_cartels (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) UNIQUE NOT NULL,
    tag VARCHAR(5) NOT NULL,
    description TEXT,
    leader_id INT NOT NULL,
    level INT NOT NULL DEFAULT 1,
    xp BIGINT NOT NULL DEFAULT 0,
    xp_to_next_level BIGINT NOT NULL DEFAULT 1000,
    cash_bank BIGINT NOT NULL DEFAULT 0,
    max_members INT NOT NULL DEFAULT 10,
    is_recruiting BOOLEAN DEFAULT TRUE,
    min_level_requirement INT DEFAULT 1,
    icon VARCHAR(50) DEFAULT '🏴',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (leader_id) REFERENCES cfx_players(id) ON DELETE CASCADE
);

-- Cartel members
CREATE TABLE IF NOT EXISTS cfx_cartel_members (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cartel_id INT NOT NULL,
    player_id INT NOT NULL,
    role ENUM('leader', 'officer', 'member') NOT NULL DEFAULT 'member',
    contribution_cash BIGINT NOT NULL DEFAULT 0,
    contribution_xp BIGINT NOT NULL DEFAULT 0,
    contribution_wars INT NOT NULL DEFAULT 0,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    UNIQUE KEY unique_cartel_member (player_id)
);

-- Cartel upgrades definitions
CREATE TABLE IF NOT EXISTS cfx_cartel_upgrades (
    id INT PRIMARY KEY AUTO_INCREMENT,
    upgrade_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    effect_type VARCHAR(50) NOT NULL,
    effect_value_per_level DECIMAL(10,4) NOT NULL,
    max_level INT NOT NULL DEFAULT 10,
    base_cost BIGINT NOT NULL DEFAULT 1000,
    cost_multiplier DECIMAL(10,4) NOT NULL DEFAULT 1.5,
    icon VARCHAR(50) DEFAULT '⬆️',
    is_active BOOLEAN DEFAULT TRUE
);

-- Cartel upgrade status
CREATE TABLE IF NOT EXISTS cfx_cartel_upgrade_status (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cartel_id INT NOT NULL,
    upgrade_id INT NOT NULL,
    current_level INT NOT NULL DEFAULT 0,
    last_upgraded_at TIMESTAMP NULL,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (upgrade_id) REFERENCES cfx_cartel_upgrades(id) ON DELETE CASCADE,
    UNIQUE KEY unique_cartel_upgrade (cartel_id, upgrade_id)
);

-- Cartel invites
CREATE TABLE IF NOT EXISTS cfx_cartel_invites (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cartel_id INT NOT NULL,
    player_id INT NOT NULL,
    invited_by INT NOT NULL,
    status ENUM('pending', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    responded_at TIMESTAMP NULL,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES cfx_players(id) ON DELETE CASCADE
);

-- Seed cartel upgrades
INSERT INTO cfx_cartel_upgrades (upgrade_key, name, description, effect_type, effect_value_per_level, max_level, base_cost, cost_multiplier, icon) VALUES
('member_slots', 'Expansion', 'Increase max member slots', 'max_members', 2, 10, 5000, 1.8, '👥'),
('yield_bonus', 'Collective Farming', 'Bonus yield for all members', 'yield_bonus', 0.02, 10, 10000, 1.5, '🌾'),
('quality_bonus', 'Quality Standards', 'Bonus quality for all members', 'quality_bonus', 0.015, 10, 10000, 1.5, '💎'),
('xp_bonus', 'Training Program', 'Bonus XP for all members', 'xp_bonus', 0.03, 10, 8000, 1.5, '📚'),
('cash_bonus', 'Trade Network', 'Bonus cash from sales', 'cash_bonus', 0.02, 10, 12000, 1.5, '💰'),
('heat_reduction', 'Connections', 'Reduced heat generation', 'heat_reduction', 0.02, 10, 15000, 1.6, '🕶️'),
('war_strength', 'Military Training', 'Bonus war contribution', 'war_bonus', 0.05, 10, 20000, 1.7, '⚔️'),
('bank_limit', 'Vault Expansion', 'Increase cash bank limit', 'bank_capacity', 100000, 10, 25000, 2.0, '🏦');

-- ============================================
-- 4.2 TURF WARS / TERRITORIES
-- ============================================

-- Territory definitions
CREATE TABLE IF NOT EXISTS cfx_territories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    territory_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    region VARCHAR(50) NOT NULL DEFAULT 'downtown',
    bonus_type VARCHAR(50) NOT NULL,
    bonus_value DECIMAL(10,4) NOT NULL,
    control_points_required INT NOT NULL DEFAULT 1000,
    icon VARCHAR(50) DEFAULT '🏙️',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Territory control
CREATE TABLE IF NOT EXISTS cfx_territory_control (
    id INT PRIMARY KEY AUTO_INCREMENT,
    territory_id INT NOT NULL,
    cartel_id INT,
    control_points INT NOT NULL DEFAULT 0,
    captured_at TIMESTAMP NULL,
    last_contested_at TIMESTAMP NULL,
    FOREIGN KEY (territory_id) REFERENCES cfx_territories(id) ON DELETE CASCADE,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE SET NULL,
    UNIQUE KEY unique_territory_control (territory_id)
);

-- Turf wars
CREATE TABLE IF NOT EXISTS cfx_turf_wars (
    id INT PRIMARY KEY AUTO_INCREMENT,
    territory_id INT NOT NULL,
    attacker_cartel_id INT NOT NULL,
    defender_cartel_id INT,
    status ENUM('active', 'attacker_won', 'defender_won', 'draw', 'cancelled') NOT NULL DEFAULT 'active',
    attacker_score INT NOT NULL DEFAULT 0,
    defender_score INT NOT NULL DEFAULT 0,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ends_at TIMESTAMP NOT NULL,
    ended_at TIMESTAMP NULL,
    FOREIGN KEY (territory_id) REFERENCES cfx_territories(id) ON DELETE CASCADE,
    FOREIGN KEY (attacker_cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (defender_cartel_id) REFERENCES cfx_cartels(id) ON DELETE SET NULL
);

-- Turf war contributions
CREATE TABLE IF NOT EXISTS cfx_turf_war_contributions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    war_id INT NOT NULL,
    player_id INT NOT NULL,
    cartel_id INT NOT NULL,
    contribution_type ENUM('cash', 'harvest', 'product', 'defend') NOT NULL,
    contribution_value INT NOT NULL DEFAULT 0,
    points_earned INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (war_id) REFERENCES cfx_turf_wars(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE
);

-- Seed territories
INSERT INTO cfx_territories (territory_key, name, description, region, bonus_type, bonus_value, control_points_required, icon) VALUES
('downtown_market', 'Downtown Market', 'Prime selling location in the city center', 'downtown', 'sale_bonus', 0.08, 1000, '🏪'),
('warehouse_district', 'Warehouse District', 'Storage and distribution hub', 'industrial', 'storage_capacity', 100, 1500, '🏭'),
('university_area', 'University Area', 'High demand from students', 'campus', 'customer_bonus', 0.10, 800, '🎓'),
('port_access', 'Harbor Port', 'Import/export connections', 'docks', 'trade_bonus', 0.12, 2000, '⚓'),
('suburbs_north', 'North Suburbs', 'Low heat residential area', 'suburbs', 'heat_reduction', 0.15, 1200, '🏘️'),
('nightclub_row', 'Nightclub District', 'Premium nightlife sales', 'entertainment', 'premium_bonus', 0.10, 1800, '🎵'),
('tech_park', 'Tech Park', 'High-income professionals', 'business', 'quality_demand', 0.08, 1400, '💼'),
('hidden_valley', 'Hidden Valley', 'Remote growing location', 'rural', 'grow_speed', 0.05, 2500, '🌄');

-- ============================================
-- 4.3 WEEKLY TOURNAMENTS
-- ============================================

-- Tournament definitions
CREATE TABLE IF NOT EXISTS cfx_tournaments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    tournament_type ENUM('harvest', 'sales', 'quality', 'xp', 'breeding') NOT NULL,
    entry_fee BIGINT NOT NULL DEFAULT 0,
    prize_pool BIGINT NOT NULL DEFAULT 0,
    min_level INT NOT NULL DEFAULT 1,
    max_participants INT DEFAULT NULL,
    status ENUM('upcoming', 'active', 'calculating', 'completed') NOT NULL DEFAULT 'upcoming',
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tournament participants
CREATE TABLE IF NOT EXISTS cfx_tournament_participants (
    id INT PRIMARY KEY AUTO_INCREMENT,
    tournament_id INT NOT NULL,
    player_id INT NOT NULL,
    score BIGINT NOT NULL DEFAULT 0,
    rank INT DEFAULT NULL,
    prize_amount BIGINT DEFAULT NULL,
    reward_claimed BOOLEAN DEFAULT FALSE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES cfx_tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    UNIQUE KEY unique_tournament_participant (tournament_id, player_id)
);

-- Seed sample tournaments (will be generated by job)
INSERT INTO cfx_tournaments (name, description, tournament_type, entry_fee, prize_pool, min_level, starts_at, ends_at, status) VALUES
('Weekly Harvest Challenge', 'Harvest the most produce this week!', 'harvest', 0, 100000, 1, DATE_ADD(NOW(), INTERVAL 1 DAY), DATE_ADD(NOW(), INTERVAL 8 DAY), 'upcoming'),
('High Roller Sales', 'Generate the most cash from sales', 'sales', 5000, 500000, 10, DATE_ADD(NOW(), INTERVAL 2 DAY), DATE_ADD(NOW(), INTERVAL 9 DAY), 'upcoming'),
('Quality Masters', 'Produce the highest quality goods', 'quality', 1000, 200000, 5, DATE_ADD(NOW(), INTERVAL 3 DAY), DATE_ADD(NOW(), INTERVAL 10 DAY), 'upcoming');

-- ============================================
-- 4.4 REFERRALS
-- ============================================

-- Referral tracking
CREATE TABLE IF NOT EXISTS cfx_referrals (
    id INT PRIMARY KEY AUTO_INCREMENT,
    referrer_id INT NOT NULL,
    referred_id INT NOT NULL,
    referral_code VARCHAR(20) NOT NULL,
    milestone_reached INT NOT NULL DEFAULT 0,
    rewards_claimed INT NOT NULL DEFAULT 0,
    total_referrer_rewards BIGINT NOT NULL DEFAULT 0,
    total_referred_rewards BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (referred_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    UNIQUE KEY unique_referred (referred_id)
);

-- Add referral code to players
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE DEFAULT NULL;
ALTER TABLE cfx_players ADD COLUMN IF NOT EXISTS referred_by INT DEFAULT NULL;

-- ============================================
-- 4.5 REPUTATION SYSTEM
-- ============================================

-- Faction definitions
CREATE TABLE IF NOT EXISTS cfx_factions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    faction_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(50) DEFAULT '🏛️',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reputation tiers
CREATE TABLE IF NOT EXISTS cfx_reputation_tiers (
    id INT PRIMARY KEY AUTO_INCREMENT,
    faction_id INT NOT NULL,
    tier_level INT NOT NULL,
    name VARCHAR(50) NOT NULL,
    rep_required INT NOT NULL,
    perks TEXT,
    icon VARCHAR(50) DEFAULT '⭐',
    FOREIGN KEY (faction_id) REFERENCES cfx_factions(id) ON DELETE CASCADE,
    UNIQUE KEY unique_faction_tier (faction_id, tier_level)
);

-- Player reputation
CREATE TABLE IF NOT EXISTS cfx_player_reputation (
    id INT PRIMARY KEY AUTO_INCREMENT,
    player_id INT NOT NULL,
    faction_id INT NOT NULL,
    reputation INT NOT NULL DEFAULT 0,
    current_tier INT NOT NULL DEFAULT 0,
    total_earned INT NOT NULL DEFAULT 0,
    last_action_at TIMESTAMP NULL,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (faction_id) REFERENCES cfx_factions(id) ON DELETE CASCADE,
    UNIQUE KEY unique_player_faction (player_id, faction_id)
);

-- Seed factions
INSERT INTO cfx_factions (faction_key, name, description, icon) VALUES
('growers_guild', 'Growers Guild', 'A collective of master cultivators focused on quality and yield', '🌿'),
('traders_union', 'Traders Union', 'Network of savvy dealers and market manipulators', '💹'),
('shadow_syndicate', 'Shadow Syndicate', 'Underground network specializing in high-risk, high-reward operations', '🕵️'),
('research_collective', 'Research Collective', 'Scientists and breeders pushing the boundaries of genetics', '🔬'),
('enforcement_division', 'The Enforcers', 'Security specialists who handle... problems', '🛡️');

-- Seed reputation tiers (for each faction)
INSERT INTO cfx_reputation_tiers (faction_id, tier_level, name, rep_required, perks, icon) VALUES
-- Growers Guild tiers
(1, 0, 'Seedling', 0, '{"description": "Starting tier"}', '🌱'),
(1, 1, 'Apprentice', 100, '{"yield_bonus": 0.02}', '🌿'),
(1, 2, 'Cultivator', 500, '{"yield_bonus": 0.05, "grow_speed": 0.03}', '🌲'),
(1, 3, 'Master Grower', 2000, '{"yield_bonus": 0.10, "grow_speed": 0.05, "quality_bonus": 0.03}', '🌳'),
(1, 4, 'Legendary Cultivator', 10000, '{"yield_bonus": 0.15, "grow_speed": 0.08, "quality_bonus": 0.05, "mutation_chance": 0.05}', '🏆'),

-- Traders Union tiers
(2, 0, 'Street Dealer', 0, '{"description": "Starting tier"}', '🛒'),
(2, 1, 'Local Supplier', 100, '{"sale_bonus": 0.02}', '🏪'),
(2, 2, 'Regional Distributor', 500, '{"sale_bonus": 0.05, "market_insight": 0.05}', '🏬'),
(2, 3, 'Wholesale Kingpin', 2000, '{"sale_bonus": 0.10, "market_insight": 0.10, "trade_fee_reduction": 0.10}', '🏢'),
(2, 4, 'Market Mogul', 10000, '{"sale_bonus": 0.15, "market_insight": 0.15, "trade_fee_reduction": 0.20, "exclusive_contracts": true}', '👑'),

-- Shadow Syndicate tiers
(3, 0, 'Nobody', 0, '{"description": "Starting tier"}', '👤'),
(3, 1, 'Associate', 100, '{"black_market_bonus": 0.05}', '🕶️'),
(3, 2, 'Made Member', 500, '{"black_market_bonus": 0.10, "heat_reduction": 0.05}', '🎭'),
(3, 3, 'Underboss', 2000, '{"black_market_bonus": 0.15, "heat_reduction": 0.10, "contact_unlock": true}', '💀'),
(3, 4, 'Kingpin', 10000, '{"black_market_bonus": 0.25, "heat_reduction": 0.15, "immunity_chance": 0.10, "shadow_network": true}', '🦅'),

-- Research Collective tiers
(4, 0, 'Lab Assistant', 0, '{"description": "Starting tier"}', '🧫'),
(4, 1, 'Researcher', 100, '{"breeding_success": 0.03}', '🔬'),
(4, 2, 'Lead Scientist', 500, '{"breeding_success": 0.07, "mutation_discovery": 0.05}', '🧬'),
(4, 3, 'Director', 2000, '{"breeding_success": 0.12, "mutation_discovery": 0.10, "research_speed": 0.10}', '👨‍🔬'),
(4, 4, 'Visionary', 10000, '{"breeding_success": 0.18, "mutation_discovery": 0.15, "research_speed": 0.20, "unique_strains": true}', '🌟'),

-- Enforcers tiers
(5, 0, 'Civilian', 0, '{"description": "Starting tier"}', '👨'),
(5, 1, 'Associate', 100, '{"raid_reduction": 0.05}', '🦺'),
(5, 2, 'Soldier', 500, '{"raid_reduction": 0.10, "vault_bonus": 0.10}', '⚔️'),
(5, 3, 'Lieutenant', 2000, '{"raid_reduction": 0.15, "vault_bonus": 0.20, "recovery_bonus": 0.10}', '🎖️'),
(5, 4, 'Commander', 10000, '{"raid_reduction": 0.25, "vault_bonus": 0.30, "recovery_bonus": 0.20, "enforcement_network": true}', '🏅');

-- Indexes for performance
CREATE INDEX idx_cartel_members_cartel ON cfx_cartel_members(cartel_id);
CREATE INDEX idx_cartel_invites_player ON cfx_cartel_invites(player_id, status);
CREATE INDEX idx_territory_control_cartel ON cfx_territory_control(cartel_id);
CREATE INDEX idx_turf_wars_status ON cfx_turf_wars(status, ends_at);
CREATE INDEX idx_tournament_status ON cfx_tournaments(status, starts_at, ends_at);
CREATE INDEX idx_tournament_participants_score ON cfx_tournament_participants(tournament_id, score DESC);
CREATE INDEX idx_player_reputation_faction ON cfx_player_reputation(faction_id, reputation DESC);
