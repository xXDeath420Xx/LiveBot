-- ============================================
-- FIX MARKET ENGINE - CRITICAL MIGRATION
-- ============================================
-- The market-engine.js uses columns and tables that don't exist in the base schema.
-- This migration adds all missing components.

-- ============================================
-- 1. Fix cfx_market_prices table - Add missing columns
-- ============================================

-- Add previous_price column (code uses this instead of price_24h_ago)
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS previous_price DECIMAL(10, 2) DEFAULT NULL AFTER current_price;

-- Add price_change_pct column
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS price_change_pct DECIMAL(8, 3) NOT NULL DEFAULT 0.000 AFTER previous_price;

-- Add 24h high/low tracking
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS high_24h DECIMAL(10, 2) DEFAULT NULL AFTER price_change_pct;
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS low_24h DECIMAL(10, 2) DEFAULT NULL AFTER high_24h;

-- Add volume_24h (total units traded in 24h)
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS volume_24h INT UNSIGNED NOT NULL DEFAULT 0 AFTER low_24h;

-- Add supply_volume (code uses this instead of supply_count)
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS supply_volume INT UNSIGNED NOT NULL DEFAULT 0 AFTER volume_24h;

-- Add demand_score (code uses this instead of demand_factor)
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS demand_score DECIMAL(8, 3) NOT NULL DEFAULT 100.000 AFTER supply_volume;

-- Add trend column for stock-like price movements
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS trend ENUM('rising', 'falling', 'stable') NOT NULL DEFAULT 'stable' AFTER demand_score;

-- Add volatility column for stock-like price movements
ALTER TABLE cfx_market_prices ADD COLUMN IF NOT EXISTS volatility DECIMAL(5, 3) NOT NULL DEFAULT 0.050 AFTER trend;

-- Initialize previous_price from current_price where null
UPDATE cfx_market_prices SET previous_price = current_price WHERE previous_price IS NULL;

-- Initialize high_24h and low_24h from current_price where null
UPDATE cfx_market_prices SET high_24h = current_price WHERE high_24h IS NULL;
UPDATE cfx_market_prices SET low_24h = current_price WHERE low_24h IS NULL;

-- ============================================
-- 2. Fix cfx_strains table - Add demand_weight column
-- ============================================

-- Add demand_weight column for market price calculation weighting
ALTER TABLE cfx_strains ADD COLUMN IF NOT EXISTS demand_weight DECIMAL(5, 2) NOT NULL DEFAULT 1.00 AFTER base_price;

-- Set demand_weight based on rarity (rarer strains have higher demand weight)
UPDATE cfx_strains SET demand_weight =
    CASE rarity
        WHEN 'common' THEN 0.80
        WHEN 'uncommon' THEN 1.00
        WHEN 'rare' THEN 1.30
        WHEN 'epic' THEN 1.60
        WHEN 'legendary' THEN 2.00
        ELSE 1.00
    END
WHERE demand_weight = 1.00;

-- ============================================
-- 3. Fix cfx_market_listings table - Add inventory_id column
-- ============================================

-- The market engine references the source inventory item
ALTER TABLE cfx_market_listings ADD COLUMN IF NOT EXISTS inventory_id INT UNSIGNED DEFAULT NULL AFTER player_id;

-- ============================================
-- 4. Create cfx_npc_sales table (NPC quick-sell tracking)
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_npc_sales (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    quality INT UNSIGNED NOT NULL,
    price_per_unit DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(15, 2) NOT NULL,
    sold_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_player (player_id),
    INDEX idx_sold_at (sold_at),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. Create cfx_market_price_history table (for charts)
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_market_price_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    strain_id INT UNSIGNED NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    volume INT UNSIGNED NOT NULL DEFAULT 0,
    supply INT UNSIGNED NOT NULL DEFAULT 0,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_strain_time (strain_id, recorded_at),
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 6. Initialize market prices for all strains that don't have entries
-- ============================================

INSERT INTO cfx_market_prices (strain_id, current_price, previous_price, demand_score, high_24h, low_24h)
SELECT
    s.id,
    s.base_price,
    s.base_price,
    100.000,
    s.base_price,
    s.base_price
FROM cfx_strains s
LEFT JOIN cfx_market_prices mp ON s.id = mp.strain_id
WHERE mp.id IS NULL;

-- ============================================
-- 7. Create indexes for performance
-- ============================================

-- Index on market price history for chart queries (7 day lookback)
CREATE INDEX IF NOT EXISTS idx_market_history_7d ON cfx_market_price_history (strain_id, recorded_at);

-- Index on NPC sales for daily aggregation
CREATE INDEX IF NOT EXISTS idx_npc_sales_daily ON cfx_npc_sales (player_id, sold_at);
