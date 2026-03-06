-- Phase 2: Contracts, Extraction & New Loops
-- Run this migration to add contracts, extraction lab, black market, and mutations

-- =============================================
-- 2.1 Contracts/Orders System
-- =============================================

-- Available contracts (templates)
CREATE TABLE IF NOT EXISTS cfx_contracts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    contract_type ENUM('standard', 'premium', 'urgent', 'bulk') NOT NULL DEFAULT 'standard',
    client_name VARCHAR(100) NOT NULL,
    client_type ENUM('dispensary', 'dealer', 'medical', 'collector') NOT NULL,
    strain_id INT UNSIGNED NULL,
    quality_min INT UNSIGNED NOT NULL DEFAULT 0,
    quantity_required INT UNSIGNED NOT NULL,
    reward_cash DECIMAL(15, 2) NOT NULL,
    reward_xp INT UNSIGNED NOT NULL DEFAULT 0,
    reward_reputation INT NOT NULL DEFAULT 0,
    deadline_hours INT UNSIGNED NOT NULL DEFAULT 24,
    level_required INT UNSIGNED NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_active_level (is_active, level_required),
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Player's accepted contracts
CREATE TABLE IF NOT EXISTS cfx_player_contracts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id INT UNSIGNED NOT NULL,
    contract_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NULL,
    quality_min INT UNSIGNED NOT NULL DEFAULT 0,
    quantity_required INT UNSIGNED NOT NULL,
    quantity_delivered INT UNSIGNED NOT NULL DEFAULT 0,
    reward_cash DECIMAL(15, 2) NOT NULL,
    reward_xp INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('active', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'active',
    accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deadline_at DATETIME NOT NULL,
    completed_at DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_player_status (player_id, status),
    KEY idx_deadline (deadline_at),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (contract_id) REFERENCES cfx_contracts(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- 2.2 Extraction Lab
-- =============================================

-- Extraction recipes (what can be made)
CREATE TABLE IF NOT EXISTS cfx_extraction_recipes (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    recipe_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT NULL,
    product_type ENUM('oil', 'wax', 'shatter', 'edible', 'tincture') NOT NULL,
    input_quantity INT UNSIGNED NOT NULL DEFAULT 10,
    output_quantity INT UNSIGNED NOT NULL DEFAULT 1,
    process_time_minutes INT UNSIGNED NOT NULL DEFAULT 60,
    value_multiplier DECIMAL(5, 2) NOT NULL DEFAULT 1.50,
    quality_bonus INT NOT NULL DEFAULT 0,
    level_required INT UNSIGNED NOT NULL DEFAULT 1,
    is_unlocked_by_default BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (id),
    KEY idx_product_type (product_type),
    KEY idx_level (level_required)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Player's extraction slots
CREATE TABLE IF NOT EXISTS cfx_extraction_slots (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id INT UNSIGNED NOT NULL,
    slot_number INT UNSIGNED NOT NULL DEFAULT 1,
    recipe_id INT UNSIGNED NULL,
    strain_id INT UNSIGNED NULL,
    input_quality INT UNSIGNED NULL,
    input_quantity INT UNSIGNED NULL,
    status ENUM('empty', 'processing', 'ready') NOT NULL DEFAULT 'empty',
    started_at DATETIME NULL,
    completes_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_player_slot (player_id, slot_number),
    KEY idx_status (status),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (recipe_id) REFERENCES cfx_extraction_recipes(id) ON DELETE SET NULL,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Player's extracted products inventory
CREATE TABLE IF NOT EXISTS cfx_player_products (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id INT UNSIGNED NOT NULL,
    recipe_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NULL,
    product_name VARCHAR(100) NOT NULL,
    product_type ENUM('oil', 'wax', 'shatter', 'edible', 'tincture') NOT NULL,
    quality INT UNSIGNED NOT NULL DEFAULT 50,
    quantity INT UNSIGNED NOT NULL DEFAULT 1,
    base_value DECIMAL(15, 2) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_player (player_id),
    KEY idx_product_type (product_type),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (recipe_id) REFERENCES cfx_extraction_recipes(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- 2.3 Black Market Channel
-- =============================================

-- Black market contacts
CREATE TABLE IF NOT EXISTS cfx_black_market_contacts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    contact_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT NULL,
    reputation_required INT NOT NULL DEFAULT 0,
    price_multiplier DECIMAL(5, 2) NOT NULL DEFAULT 1.50,
    heat_multiplier DECIMAL(5, 2) NOT NULL DEFAULT 2.00,
    min_quality INT UNSIGNED NOT NULL DEFAULT 0,
    max_quantity_per_sale INT UNSIGNED NOT NULL DEFAULT 100,
    cooldown_minutes INT UNSIGNED NOT NULL DEFAULT 30,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id),
    KEY idx_reputation (reputation_required)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Black market sale history
CREATE TABLE IF NOT EXISTS cfx_black_market_sales (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id INT UNSIGNED NOT NULL,
    contact_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NULL,
    quality INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    base_price DECIMAL(15, 2) NOT NULL,
    final_price DECIMAL(15, 2) NOT NULL,
    heat_generated INT NOT NULL DEFAULT 0,
    sold_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_player (player_id),
    KEY idx_sold_at (sold_at),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES cfx_black_market_contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Player's last contact usage (for cooldowns)
CREATE TABLE IF NOT EXISTS cfx_player_black_market (
    player_id INT UNSIGNED NOT NULL,
    contact_id INT UNSIGNED NOT NULL,
    last_sale_at DATETIME NULL,
    total_sales INT UNSIGNED NOT NULL DEFAULT 0,
    total_revenue DECIMAL(15, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, contact_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES cfx_black_market_contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- 2.4 Strain Mutations
-- =============================================

-- Available mutations
CREATE TABLE IF NOT EXISTS cfx_mutations (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    mutation_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT NULL,
    effect_type ENUM('yield_bonus', 'quality_bonus', 'grow_speed', 'thc_boost', 'cbd_boost', 'value_bonus') NOT NULL,
    effect_value DECIMAL(10, 4) NOT NULL,
    rarity ENUM('common', 'uncommon', 'rare', 'epic', 'legendary') NOT NULL DEFAULT 'uncommon',
    base_chance DECIMAL(8, 6) NOT NULL DEFAULT 0.01,
    is_positive BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (id),
    KEY idx_rarity (rarity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mutations on active plants
CREATE TABLE IF NOT EXISTS cfx_plant_mutations (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    grow_slot_id INT UNSIGNED NOT NULL,
    mutation_id INT UNSIGNED NOT NULL,
    discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_slot_mutation (grow_slot_id, mutation_id),
    FOREIGN KEY (grow_slot_id) REFERENCES cfx_grow_slots(id) ON DELETE CASCADE,
    FOREIGN KEY (mutation_id) REFERENCES cfx_mutations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Player's discovered mutations (collection)
CREATE TABLE IF NOT EXISTS cfx_player_mutations (
    player_id INT UNSIGNED NOT NULL,
    mutation_id INT UNSIGNED NOT NULL,
    times_discovered INT UNSIGNED NOT NULL DEFAULT 1,
    first_discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id, mutation_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (mutation_id) REFERENCES cfx_mutations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- Seed Data
-- =============================================

-- Insert default contracts
INSERT INTO cfx_contracts (contract_type, client_name, client_type, quality_min, quantity_required, reward_cash, reward_xp, deadline_hours, level_required)
VALUES
    ('standard', 'Green Leaf Dispensary', 'dispensary', 30, 10, 1500, 50, 24, 1),
    ('standard', 'Medical Supplies Co', 'medical', 50, 5, 1200, 40, 24, 3),
    ('premium', 'The Connoisseur Club', 'collector', 80, 3, 2500, 100, 48, 5),
    ('urgent', 'Street Dealer Mike', 'dealer', 0, 20, 2000, 60, 12, 2),
    ('bulk', 'Wholesale Distributors', 'dispensary', 40, 50, 5000, 150, 72, 8)
ON DUPLICATE KEY UPDATE client_name = VALUES(client_name);

-- Insert extraction recipes
INSERT INTO cfx_extraction_recipes (recipe_key, name, description, product_type, input_quantity, output_quantity, process_time_minutes, value_multiplier, level_required, is_unlocked_by_default)
VALUES
    ('basic_oil', 'Cannabis Oil', 'Basic extraction into concentrated oil', 'oil', 10, 1, 30, 1.30, 1, TRUE),
    ('premium_oil', 'Premium Oil', 'High-quality refined cannabis oil', 'oil', 15, 1, 60, 1.60, 5, FALSE),
    ('basic_wax', 'Cannabis Wax', 'Concentrated wax extract', 'wax', 12, 1, 45, 1.50, 3, FALSE),
    ('shatter', 'Glass Shatter', 'Pure crystalline concentrate', 'shatter', 20, 1, 90, 2.00, 8, FALSE),
    ('edibles', 'Edible Gummies', 'Infused edible products', 'edible', 8, 5, 60, 1.40, 4, FALSE),
    ('tincture', 'Medical Tincture', 'Alcohol-based tincture', 'tincture', 10, 2, 45, 1.45, 6, FALSE)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Insert black market contacts
INSERT INTO cfx_black_market_contacts (contact_key, name, description, reputation_required, price_multiplier, heat_multiplier, min_quality, max_quantity_per_sale, cooldown_minutes)
VALUES
    ('shady_sam', 'Shady Sam', 'A street-level dealer. Low payouts but always available.', 0, 1.30, 1.50, 0, 20, 15),
    ('tony_soprano', 'Tony "The Connect"', 'Mid-level supplier with better rates.', 100, 1.60, 2.00, 30, 50, 30),
    ('silk_road', 'The Silk Road', 'Anonymous online marketplace. Premium prices.', 500, 2.00, 2.50, 50, 100, 60),
    ('cartel_boss', 'El Jefe', 'Cartel connection. Massive payouts, massive heat.', 1000, 2.50, 3.00, 70, 200, 120)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Insert mutations
INSERT INTO cfx_mutations (mutation_key, name, description, effect_type, effect_value, rarity, base_chance, is_positive)
VALUES
    ('vigorous_growth', 'Vigorous Growth', 'Plant grows 15% faster', 'grow_speed', 0.15, 'common', 0.05, TRUE),
    ('bountiful_harvest', 'Bountiful Harvest', '+20% yield bonus', 'yield_bonus', 0.20, 'uncommon', 0.03, TRUE),
    ('premium_quality', 'Premium Quality', '+10 quality points', 'quality_bonus', 10, 'uncommon', 0.03, TRUE),
    ('thc_surge', 'THC Surge', '+3% THC content', 'thc_boost', 3, 'rare', 0.01, TRUE),
    ('cbd_rich', 'CBD Rich', '+5% CBD content', 'cbd_boost', 5, 'rare', 0.01, TRUE),
    ('golden_strain', 'Golden Strain', '+30% sale value', 'value_bonus', 0.30, 'epic', 0.005, TRUE),
    ('legendary_genetics', 'Legendary Genetics', '+50% yield and quality', 'yield_bonus', 0.50, 'legendary', 0.001, TRUE),
    ('stunted_growth', 'Stunted Growth', '-10% yield (can be overcome)', 'yield_bonus', -0.10, 'common', 0.02, FALSE)
ON DUPLICATE KEY UPDATE name = VALUES(name);
