-- ============================================
-- ADD ALL MISSING TABLES FOR GAME FEATURES
-- ============================================

-- Research System
CREATE TABLE IF NOT EXISTS cfx_research_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    research_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category ENUM('cultivation', 'processing', 'business', 'expansion') NOT NULL,
    tier INT NOT NULL DEFAULT 1,
    cost_cash DECIMAL(15,2) NOT NULL DEFAULT 0,
    cost_xp INT NOT NULL DEFAULT 0,
    research_time_hours DECIMAL(10,2) NOT NULL DEFAULT 1,
    prerequisites JSON DEFAULT NULL,
    unlock_type ENUM('bonus', 'feature', 'equipment', 'recipe', 'location') NOT NULL DEFAULT 'bonus',
    unlock_key VARCHAR(100) DEFAULT NULL,
    unlock_value DECIMAL(10,4) DEFAULT NULL,
    icon VARCHAR(100) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_research (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    research_id INT NOT NULL,
    status ENUM('available', 'researching', 'completed') NOT NULL DEFAULT 'available',
    started_at DATETIME DEFAULT NULL,
    completes_at DATETIME DEFAULT NULL,
    completed_at DATETIME DEFAULT NULL,
    UNIQUE KEY uk_player_research (player_id, research_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (research_id) REFERENCES cfx_research_nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Equipment System
CREATE TABLE IF NOT EXISTS cfx_equipment (
    id INT AUTO_INCREMENT PRIMARY KEY,
    equipment_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category ENUM('lighting', 'irrigation', 'climate', 'security', 'processing', 'storage') NOT NULL,
    tier INT NOT NULL DEFAULT 1,
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL DEFAULT 0,
    price DECIMAL(15,2) NOT NULL DEFAULT 0,
    unlock_research_key VARCHAR(50) DEFAULT NULL,
    icon VARCHAR(100) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_equipment (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    equipment_id INT NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    purchased_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_equipment (player_id, equipment_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (equipment_id) REFERENCES cfx_equipment(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Locations System
CREATE TABLE IF NOT EXISTS cfx_locations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    location_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    climate ENUM('indoor', 'greenhouse', 'outdoor', 'tropical', 'arid', 'mountain') NOT NULL DEFAULT 'indoor',
    climate_bonus JSON DEFAULT NULL,
    heat_modifier DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    base_slots INT NOT NULL DEFAULT 4,
    max_slots INT NOT NULL DEFAULT 12,
    price DECIMAL(15,2) NOT NULL DEFAULT 0,
    unlock_level INT NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_locations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    location_id INT NOT NULL,
    current_slots INT NOT NULL DEFAULT 4,
    is_primary TINYINT(1) NOT NULL DEFAULT 0,
    purchased_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_location (player_id, location_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (location_id) REFERENCES cfx_locations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Contracts System
CREATE TABLE IF NOT EXISTS cfx_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contract_type ENUM('daily', 'weekly', 'special') NOT NULL DEFAULT 'daily',
    client_name VARCHAR(100) NOT NULL,
    client_type ENUM('dispensary', 'dealer', 'medical', 'wholesale') NOT NULL,
    strain_id INT DEFAULT NULL,
    strain_rarity VARCHAR(20) DEFAULT NULL,
    quality_min INT DEFAULT NULL,
    quantity INT NOT NULL,
    reward_cash DECIMAL(15,2) NOT NULL,
    reward_xp INT NOT NULL DEFAULT 0,
    deadline_hours INT NOT NULL DEFAULT 24,
    difficulty INT NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    contract_id INT NOT NULL,
    delivered_quantity INT NOT NULL DEFAULT 0,
    status ENUM('active', 'completed', 'failed', 'expired') NOT NULL DEFAULT 'active',
    accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deadline_at DATETIME NOT NULL,
    completed_at DATETIME DEFAULT NULL,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES cfx_contracts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Extraction Lab System
CREATE TABLE IF NOT EXISTS cfx_extraction_recipes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recipe_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    product_type ENUM('concentrate', 'edible', 'tincture', 'topical') NOT NULL,
    input_quantity INT NOT NULL DEFAULT 10,
    output_quantity INT NOT NULL DEFAULT 1,
    process_time_ms INT NOT NULL DEFAULT 300000,
    value_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.5,
    quality_bonus INT NOT NULL DEFAULT 0,
    unlock_research_key VARCHAR(50) DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_extraction_slots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    slot_number INT NOT NULL,
    recipe_id INT DEFAULT NULL,
    strain_id INT DEFAULT NULL,
    input_quality INT DEFAULT NULL,
    status ENUM('empty', 'processing', 'ready') NOT NULL DEFAULT 'empty',
    started_at DATETIME DEFAULT NULL,
    completes_at DATETIME DEFAULT NULL,
    UNIQUE KEY uk_player_slot (player_id, slot_number),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (recipe_id) REFERENCES cfx_extraction_recipes(id) ON DELETE SET NULL,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    recipe_id INT NOT NULL,
    strain_id INT NOT NULL,
    product_name VARCHAR(100) NOT NULL,
    quality INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    base_value DECIMAL(15,2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (recipe_id) REFERENCES cfx_extraction_recipes(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Black Market System
CREATE TABLE IF NOT EXISTS cfx_black_market_contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contact_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    reputation_required INT NOT NULL DEFAULT 0,
    price_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.5,
    heat_multiplier DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_black_market_sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    contact_id INT NOT NULL,
    strain_id INT NOT NULL,
    quantity INT NOT NULL,
    quality INT NOT NULL,
    sale_price DECIMAL(15,2) NOT NULL,
    heat_generated INT NOT NULL DEFAULT 0,
    sold_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES cfx_black_market_contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cartels/Guilds System
CREATE TABLE IF NOT EXISTS cfx_cartels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    tag VARCHAR(10) NOT NULL,
    description TEXT,
    leader_id INT NOT NULL,
    level INT NOT NULL DEFAULT 1,
    xp BIGINT NOT NULL DEFAULT 0,
    cash_bank DECIMAL(20,2) NOT NULL DEFAULT 0,
    max_members INT NOT NULL DEFAULT 10,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (leader_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_cartel_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cartel_id INT NOT NULL,
    player_id INT NOT NULL,
    role ENUM('leader', 'officer', 'member') NOT NULL DEFAULT 'member',
    contribution_cash DECIMAL(20,2) NOT NULL DEFAULT 0,
    contribution_xp BIGINT NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_player_cartel (player_id),
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_cartel_upgrades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    upgrade_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    effect_type VARCHAR(50) NOT NULL,
    effect_value_per_level DECIMAL(10,4) NOT NULL,
    max_level INT NOT NULL DEFAULT 5,
    base_cost DECIMAL(15,2) NOT NULL,
    cost_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.5
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_cartel_upgrade_status (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cartel_id INT NOT NULL,
    upgrade_id INT NOT NULL,
    current_level INT NOT NULL DEFAULT 0,
    UNIQUE KEY uk_cartel_upgrade (cartel_id, upgrade_id),
    FOREIGN KEY (cartel_id) REFERENCES cfx_cartels(id) ON DELETE CASCADE,
    FOREIGN KEY (upgrade_id) REFERENCES cfx_cartel_upgrades(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reputation System
CREATE TABLE IF NOT EXISTS cfx_factions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    faction_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_reputation_tiers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    faction_id INT NOT NULL,
    tier_level INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    rep_required INT NOT NULL,
    perks JSON DEFAULT NULL,
    UNIQUE KEY uk_faction_tier (faction_id, tier_level),
    FOREIGN KEY (faction_id) REFERENCES cfx_factions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_reputation (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    faction_id INT NOT NULL,
    reputation INT NOT NULL DEFAULT 0,
    current_tier INT NOT NULL DEFAULT 0,
    UNIQUE KEY uk_player_faction (player_id, faction_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (faction_id) REFERENCES cfx_factions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Random Events System
CREATE TABLE IF NOT EXISTS cfx_random_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    event_type ENUM('positive', 'negative', 'neutral') NOT NULL,
    effect JSON NOT NULL,
    base_chance DECIMAL(5,4) NOT NULL DEFAULT 0.01,
    duration_ms INT DEFAULT NULL,
    cooldown_ms INT NOT NULL DEFAULT 3600000,
    min_level INT NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Workers System
CREATE TABLE IF NOT EXISTS cfx_worker_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    base_efficiency DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    base_quality DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    base_speed DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    hire_cost DECIMAL(15,2) NOT NULL DEFAULT 1000,
    hourly_wage DECIMAL(10,2) NOT NULL DEFAULT 10,
    action_type VARCHAR(50) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_worker_traits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    trait_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    effect_type VARCHAR(50) NOT NULL,
    effect_value DECIMAL(10,4) NOT NULL,
    rarity ENUM('common', 'uncommon', 'rare', 'epic', 'legendary') NOT NULL DEFAULT 'common',
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_workers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    worker_type_id INT NOT NULL,
    name VARCHAR(100) DEFAULT NULL,
    tier INT NOT NULL DEFAULT 1,
    xp INT NOT NULL DEFAULT 0,
    efficiency DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    quality_bonus DECIMAL(5,2) NOT NULL DEFAULT 0,
    speed_bonus DECIMAL(5,2) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    last_action_at DATETIME DEFAULT NULL,
    hired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_type_id) REFERENCES cfx_worker_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_worker_trained_traits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    trait_id INT NOT NULL,
    trained_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_worker_trait (worker_id, trait_id),
    FOREIGN KEY (worker_id) REFERENCES cfx_player_workers(id) ON DELETE CASCADE,
    FOREIGN KEY (trait_id) REFERENCES cfx_worker_traits(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Dispensary System
CREATE TABLE IF NOT EXISTS cfx_dispensaries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'My Dispensary',
    location VARCHAR(100) DEFAULT NULL,
    tier INT NOT NULL DEFAULT 1,
    reputation INT NOT NULL DEFAULT 0,
    customer_capacity INT NOT NULL DEFAULT 5,
    price_modifier DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_dispensary_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dispensary_id INT NOT NULL,
    strain_id INT NOT NULL,
    quality INT NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    price_per_unit DECIMAL(15,2) NOT NULL,
    UNIQUE KEY uk_disp_strain_quality (dispensary_id, strain_id, quality),
    FOREIGN KEY (dispensary_id) REFERENCES cfx_dispensaries(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Minigames System
CREATE TABLE IF NOT EXISTS cfx_minigames (
    id INT AUTO_INCREMENT PRIMARY KEY,
    minigame_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    reward_type ENUM('cash', 'xp', 'item', 'boost') NOT NULL,
    base_reward_value DECIMAL(15,2) NOT NULL,
    cooldown_ms INT NOT NULL DEFAULT 3600000,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_player_minigames (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    minigame_id INT NOT NULL,
    high_score INT NOT NULL DEFAULT 0,
    play_count INT NOT NULL DEFAULT 0,
    last_played_at DATETIME DEFAULT NULL,
    UNIQUE KEY uk_player_minigame (player_id, minigame_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (minigame_id) REFERENCES cfx_minigames(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bosses System
CREATE TABLE IF NOT EXISTS cfx_bosses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    boss_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    difficulty INT NOT NULL DEFAULT 1,
    challenge_type VARCHAR(50) NOT NULL,
    challenge_goal INT NOT NULL,
    time_limit_ms INT NOT NULL DEFAULT 3600000,
    reward_cash DECIMAL(15,2) NOT NULL DEFAULT 0,
    reward_xp INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfx_boss_encounters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    boss_id INT NOT NULL,
    status ENUM('active', 'won', 'lost', 'expired') NOT NULL DEFAULT 'active',
    player_score INT NOT NULL DEFAULT 0,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at DATETIME NOT NULL,
    completed_at DATETIME DEFAULT NULL,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (boss_id) REFERENCES cfx_bosses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Player Facility (for facility upgrades)
CREATE TABLE IF NOT EXISTS cfx_player_facility (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL UNIQUE,
    facility_level INT NOT NULL DEFAULT 1,
    grow_slots INT NOT NULL DEFAULT 2,
    storage_capacity INT NOT NULL DEFAULT 100,
    has_irrigation TINYINT(1) NOT NULL DEFAULT 0,
    has_climate_control TINYINT(1) NOT NULL DEFAULT 0,
    has_security TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
