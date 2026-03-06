-- CertiFried Extension Database Schema
-- Cannabis Tycoon + Idle + RPG Game

-- ============================================
-- PLAYERS
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    platform ENUM('twitch', 'kick') NOT NULL,
    platform_user_id VARCHAR(64) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(500) DEFAULT NULL,

    -- Currency
    cash DECIMAL(15, 2) NOT NULL DEFAULT 1000.00,
    premium_currency INT NOT NULL DEFAULT 0,
    lifetime_earnings DECIMAL(20, 2) NOT NULL DEFAULT 0.00,
    lifetime_sales INT NOT NULL DEFAULT 0,

    -- Level & XP
    level INT NOT NULL DEFAULT 1,
    xp BIGINT NOT NULL DEFAULT 0,

    -- Prestige
    prestige_level INT NOT NULL DEFAULT 0,
    prestige_tokens INT NOT NULL DEFAULT 0,

    -- Facility
    facility_name VARCHAR(100) DEFAULT 'My Grow Op',
    facility_level INT NOT NULL DEFAULT 1,
    max_grow_slots INT NOT NULL DEFAULT 2,

    -- Progress tracking
    tutorial_completed TINYINT(1) NOT NULL DEFAULT 0,
    total_harvests INT NOT NULL DEFAULT 0,
    total_breeds INT NOT NULL DEFAULT 0,
    total_playtime_seconds BIGINT NOT NULL DEFAULT 0,

    -- Timestamps
    last_tick_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_daily_claim DATE DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Unique constraint on platform + user_id
    UNIQUE KEY uk_platform_user (platform, platform_user_id),
    INDEX idx_level (level),
    INDEX idx_prestige (prestige_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- STRAINS (Cannabis varieties)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_strains (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    strain_type ENUM('indica', 'sativa', 'hybrid') NOT NULL DEFAULT 'hybrid',
    rarity ENUM('common', 'uncommon', 'rare', 'epic', 'legendary') NOT NULL DEFAULT 'common',

    -- Growth stats (milliseconds)
    base_grow_time_ms INT NOT NULL DEFAULT 300000, -- 5 minutes default
    base_yield_min INT NOT NULL DEFAULT 1,
    base_yield_max INT NOT NULL DEFAULT 3,
    base_quality_min INT NOT NULL DEFAULT 20,
    base_quality_max INT NOT NULL DEFAULT 60,

    -- Market value
    base_price DECIMAL(10, 2) NOT NULL DEFAULT 10.00,

    -- Genetics (for breeding)
    gene_thc INT NOT NULL DEFAULT 50,
    gene_cbd INT NOT NULL DEFAULT 50,
    gene_yield INT NOT NULL DEFAULT 50,
    gene_speed INT NOT NULL DEFAULT 50,
    gene_quality INT NOT NULL DEFAULT 50,
    gene_resilience INT NOT NULL DEFAULT 50,

    -- Flavor profile
    effects JSON DEFAULT NULL,  -- ["relaxed", "happy", "hungry"]
    flavors JSON DEFAULT NULL,  -- ["earthy", "citrus", "pine"]
    description TEXT DEFAULT NULL,

    -- Meta
    is_starter TINYINT(1) NOT NULL DEFAULT 0,
    is_breedable TINYINT(1) NOT NULL DEFAULT 1,
    parent_1_id INT DEFAULT NULL,
    parent_2_id INT DEFAULT NULL,
    created_by_player_id INT DEFAULT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_rarity (rarity),
    INDEX idx_starter (is_starter),
    FOREIGN KEY (parent_1_id) REFERENCES cfx_strains(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_2_id) REFERENCES cfx_strains(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_player_id) REFERENCES cfx_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- STRAIN DISCOVERIES (Player unlocked strains)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_strain_discoveries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    strain_id INT NOT NULL,
    discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    discovery_method ENUM('starter', 'breeding', 'purchase', 'quest', 'prestige', 'gift') NOT NULL DEFAULT 'starter',

    UNIQUE KEY uk_player_strain (player_id, strain_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- GROW SLOTS (Active plants)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_grow_slots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    slot_number INT NOT NULL,

    -- Plant state
    status ENUM('empty', 'growing', 'ready', 'withering', 'withered') NOT NULL DEFAULT 'empty',
    strain_id INT DEFAULT NULL,

    -- Timing
    planted_at DATETIME DEFAULT NULL,
    grow_duration_ms INT DEFAULT NULL,
    ready_at DATETIME DEFAULT NULL,
    wither_at DATETIME DEFAULT NULL,

    -- Growth progress (for offline catch-up)
    accumulated_growth_ms INT NOT NULL DEFAULT 0,

    -- Quality determined at plant time
    base_quality INT DEFAULT NULL,

    -- Unique slot per player
    UNIQUE KEY uk_player_slot (player_id, slot_number),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- INVENTORY (Harvested product)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    strain_id INT NOT NULL,

    quantity INT NOT NULL DEFAULT 0,
    quality INT NOT NULL, -- 0-100

    source ENUM('harvest', 'trade', 'purchase', 'gift') NOT NULL DEFAULT 'harvest',
    harvested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Unique combination per quality tier
    UNIQUE KEY uk_player_strain_quality (player_id, strain_id, quality),
    INDEX idx_player (player_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- SKILL NODES (Skill tree definition)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_skill_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    skill_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category ENUM('cultivation', 'business', 'genetics', 'efficiency') NOT NULL,

    max_rank INT NOT NULL DEFAULT 5,
    cost_per_rank INT NOT NULL DEFAULT 1,

    effect_type VARCHAR(50) NOT NULL, -- 'grow_speed', 'yield_bonus', 'quality_bonus', etc.
    effect_value_per_rank DECIMAL(10, 4) NOT NULL DEFAULT 0.05, -- 5% per rank

    -- Prerequisites
    requires_skill_id INT DEFAULT NULL,
    requires_level INT NOT NULL DEFAULT 1,

    -- Position in tree (for UI)
    tree_x INT NOT NULL DEFAULT 0,
    tree_y INT NOT NULL DEFAULT 0,

    FOREIGN KEY (requires_skill_id) REFERENCES cfx_skill_nodes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- PLAYER SKILLS (Unlocked skills)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_skills (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    skill_id INT NOT NULL,
    current_rank INT NOT NULL DEFAULT 1,
    unlocked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uk_player_skill (player_id, skill_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (skill_id) REFERENCES cfx_skill_nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- QUEST DEFINITIONS
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_quest_definitions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    quest_type ENUM('daily', 'weekly', 'achievement', 'story') NOT NULL,
    objective_type VARCHAR(50) NOT NULL, -- 'harvest', 'sell', 'breed', 'level_up', etc.
    objective_target INT NOT NULL DEFAULT 1,
    objective_params JSON DEFAULT NULL, -- {"strain_rarity": "rare", "min_quality": 50}

    -- Rewards
    reward_cash DECIMAL(10, 2) NOT NULL DEFAULT 0,
    reward_xp INT NOT NULL DEFAULT 0,
    reward_prestige_tokens INT NOT NULL DEFAULT 0,
    reward_strain_id INT DEFAULT NULL,

    -- Requirements
    min_level INT NOT NULL DEFAULT 1,

    is_active TINYINT(1) NOT NULL DEFAULT 1,

    FOREIGN KEY (reward_strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- PLAYER QUESTS (Active/Completed quests)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_quests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    quest_id INT NOT NULL,

    status ENUM('active', 'completed', 'claimed', 'expired') NOT NULL DEFAULT 'active',
    progress INT NOT NULL DEFAULT 0,

    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME DEFAULT NULL,
    claimed_at DATETIME DEFAULT NULL,
    expires_at DATETIME DEFAULT NULL,

    INDEX idx_player_status (player_id, status),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (quest_id) REFERENCES cfx_quest_definitions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- ACTIVE BOOSTS
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_active_boosts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    boost_type VARCHAR(50) NOT NULL, -- 'grow_speed', 'xp', 'cash', etc.
    multiplier DECIMAL(5, 2) NOT NULL DEFAULT 1.50,
    expires_at BIGINT NOT NULL, -- Unix timestamp ms
    source VARCHAR(50) NOT NULL DEFAULT 'purchase', -- 'purchase', 'bits', 'quest'

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_player_expires (player_id, expires_at),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- BREEDING OPERATIONS
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_breeding_operations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,

    parent_1_strain_id INT NOT NULL,
    parent_2_strain_id INT NOT NULL,

    status ENUM('breeding', 'ready', 'claimed', 'cancelled') NOT NULL DEFAULT 'breeding',

    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ready_at DATETIME NOT NULL,

    -- Result (populated when claimed)
    result_strain_id INT DEFAULT NULL,
    is_new_strain TINYINT(1) DEFAULT NULL,

    INDEX idx_player_status (player_id, status),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_1_strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_2_strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE,
    FOREIGN KEY (result_strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- MARKET LISTINGS (Player-to-Player)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_market_listings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    strain_id INT NOT NULL,

    quantity INT NOT NULL,
    quality INT NOT NULL,
    price_per_unit DECIMAL(10, 2) NOT NULL,

    status ENUM('active', 'sold', 'cancelled', 'expired') NOT NULL DEFAULT 'active',

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    sold_at DATETIME DEFAULT NULL,
    buyer_id INT DEFAULT NULL,

    INDEX idx_status_strain (status, strain_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE,
    FOREIGN KEY (buyer_id) REFERENCES cfx_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- MARKET PRICES (NPC/Dynamic pricing)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_market_prices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    strain_id INT NOT NULL,

    current_price DECIMAL(10, 2) NOT NULL,
    price_24h_ago DECIMAL(10, 2) DEFAULT NULL,

    demand_factor DECIMAL(5, 2) NOT NULL DEFAULT 1.00,
    supply_count INT NOT NULL DEFAULT 0,

    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_strain (strain_id),
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TRADES (Player-to-Player)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_trades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    offerer_id INT NOT NULL,
    receiver_id INT NOT NULL,

    offered_items JSON NOT NULL, -- [{strain_id, quality, quantity}]
    requested_items JSON NOT NULL,

    status ENUM('pending', 'accepted', 'declined', 'cancelled', 'expired') NOT NULL DEFAULT 'pending',

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    resolved_at DATETIME DEFAULT NULL,

    INDEX idx_offerer (offerer_id, status),
    INDEX idx_receiver (receiver_id, status),
    FOREIGN KEY (offerer_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- BITS PURCHASES (Twitch Extension)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_bits_purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    transaction_id VARCHAR(100) NOT NULL UNIQUE,
    product_sku VARCHAR(50) NOT NULL,
    bits_cost INT NOT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_player (player_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- BOT BONUSES (From Tokes Twitch Bot)
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_bot_bonuses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL UNIQUE,

    -- Linked bot user
    bot_user_id INT DEFAULT NULL,
    bot_level INT NOT NULL DEFAULT 0,
    bot_tokes_count INT NOT NULL DEFAULT 0,

    -- Calculated bonuses
    growth_speed_bonus DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,
    yield_bonus DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,
    xp_bonus DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,
    sell_price_bonus DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,
    quality_bonus DECIMAL(5, 4) NOT NULL DEFAULT 0.0000,

    last_synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- ACHIEVEMENTS
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_achievements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    achievement_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(100) DEFAULT NULL,

    -- Unlock conditions
    condition_type VARCHAR(50) NOT NULL, -- 'harvests', 'level', 'cash', 'breeds', etc.
    condition_value INT NOT NULL,

    -- Rewards
    reward_cash DECIMAL(10, 2) DEFAULT 0,
    reward_xp INT DEFAULT 0,
    reward_prestige_tokens INT DEFAULT 0,

    is_hidden TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- PLAYER ACHIEVEMENTS
-- ============================================
CREATE TABLE IF NOT EXISTS cfx_player_achievements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    achievement_id INT NOT NULL,
    unlocked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed TINYINT(1) NOT NULL DEFAULT 0,

    UNIQUE KEY uk_player_achievement (player_id, achievement_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (achievement_id) REFERENCES cfx_achievements(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
