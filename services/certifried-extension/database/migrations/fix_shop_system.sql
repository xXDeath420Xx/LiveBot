-- ============================================
-- FIX SHOP SYSTEM - CRITICAL MIGRATION
-- ============================================
-- The shop-rotation.js and workers-tick.js use tables/columns that don't exist.
-- This migration adds all missing shop-related components.

-- ============================================
-- 1. Create cfx_shop_rotation table (daily/weekly deals)
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_shop_rotation (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    rotation_type ENUM('daily_deal', 'weekly_special', 'flash_sale', 'limited_time') NOT NULL,
    strain_id INT UNSIGNED NOT NULL,
    discount_percent INT UNSIGNED NOT NULL DEFAULT 0,
    bonus_seeds INT UNSIGNED NOT NULL DEFAULT 0,
    max_purchases INT UNSIGNED DEFAULT NULL,
    current_purchases INT UNSIGNED NOT NULL DEFAULT 0,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_active (is_active, ends_at),
    INDEX idx_type (rotation_type, is_active),
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 2. Create cfx_shop_items table (permanent shop items)
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_shop_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_key VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category ENUM('seeds', 'equipment', 'boosts', 'cosmetics', 'workers') NOT NULL,
    strain_id INT UNSIGNED DEFAULT NULL,
    price DECIMAL(15, 2) NOT NULL,
    pack_size INT UNSIGNED NOT NULL DEFAULT 1,
    level_required INT UNSIGNED NOT NULL DEFAULT 1,
    research_required VARCHAR(50) DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_category (category, is_active),
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 3. Create cfx_player_shop_items table (purchased items)
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_player_shop_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    item_id INT UNSIGNED DEFAULT NULL,
    item_type ENUM('seed_pack', 'equipment', 'boost', 'cosmetic', 'worker') NOT NULL,
    item_key VARCHAR(50) NOT NULL,
    quantity INT UNSIGNED NOT NULL DEFAULT 1,

    -- Worker-specific fields
    effect_type VARCHAR(50) DEFAULT NULL,
    effect_value DECIMAL(10, 4) DEFAULT NULL,
    worker_interval INT UNSIGNED DEFAULT NULL,
    last_worker_run DATETIME DEFAULT NULL,

    -- Boost-specific fields
    expires_at DATETIME DEFAULT NULL,

    purchased_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_player (player_id),
    INDEX idx_type (player_id, item_type),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES cfx_shop_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. Seed shop items with basic seeds for starter strains
-- ============================================

-- Insert seed packs for each starter strain
INSERT INTO cfx_shop_items (item_key, name, description, category, strain_id, price, pack_size, level_required)
SELECT
    CONCAT('seeds_', s.slug),
    CONCAT(s.name, ' Seeds'),
    CONCAT('A pack of ', s.name, ' seeds. ', COALESCE(s.description, '')),
    'seeds',
    s.id,
    s.base_price * 0.5,
    3,
    1
FROM cfx_strains s
WHERE s.is_starter = 1
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Insert seed packs for non-starter strains (higher prices)
INSERT INTO cfx_shop_items (item_key, name, description, category, strain_id, price, pack_size, level_required)
SELECT
    CONCAT('seeds_', s.slug),
    CONCAT(s.name, ' Seeds'),
    CONCAT('A pack of ', s.name, ' seeds. ', COALESCE(s.description, '')),
    'seeds',
    s.id,
    s.base_price * 0.8,
    2,
    CASE s.rarity
        WHEN 'common' THEN 1
        WHEN 'uncommon' THEN 5
        WHEN 'rare' THEN 10
        WHEN 'epic' THEN 20
        WHEN 'legendary' THEN 30
        ELSE 1
    END
FROM cfx_strains s
WHERE s.is_starter = 0
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============================================
-- 5. Seed basic worker items
-- ============================================

INSERT INTO cfx_shop_items (item_key, name, description, category, price, level_required)
VALUES
    ('worker_trimmer_basic', 'Basic Trimmer', 'Automatically harvests ready plants every 5 minutes', 'workers', 10000, 5),
    ('worker_planter_basic', 'Basic Planter', 'Automatically plants seeds in empty slots every 5 minutes', 'workers', 15000, 8),
    ('worker_seller_basic', 'Basic Seller', 'Automatically sells inventory to NPCs every 10 minutes', 'workers', 25000, 12)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============================================
-- 6. Seed basic boost items
-- ============================================

INSERT INTO cfx_shop_items (item_key, name, description, category, price, level_required)
VALUES
    ('boost_speed_1h', 'Speed Boost (1h)', '25% faster growth for 1 hour', 'boosts', 500, 1),
    ('boost_yield_1h', 'Yield Boost (1h)', '25% more yield for 1 hour', 'boosts', 750, 1),
    ('boost_xp_1h', 'XP Boost (1h)', 'Double XP for 1 hour', 'boosts', 1000, 1),
    ('boost_quality_1h', 'Quality Boost (1h)', '+10 quality bonus for 1 hour', 'boosts', 600, 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);
