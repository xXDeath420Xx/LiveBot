-- ============================================
-- FIX WORKER SETTINGS - CRITICAL MIGRATION
-- ============================================
-- The workers-tick.js uses workflow settings columns that don't exist
-- in cfx_player_settings. This migration adds all missing columns.

-- ============================================
-- 1. Add workflow_mode column
-- ============================================
-- Controls how workers behave with selling:
-- 'balanced' = Smart selling with reserves and quality thresholds
-- 'sell_all' = Aggressive selling, no reserves
-- 'manual' = Workers don't auto-sell at all

ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS workflow_mode ENUM('balanced', 'sell_all', 'manual') NOT NULL DEFAULT 'balanced';

-- ============================================
-- 2. Add min_inventory_reserve column
-- ============================================
-- Minimum number of inventory stacks to keep (never auto-sell below this)

ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS min_inventory_reserve INT UNSIGNED NOT NULL DEFAULT 0;

-- ============================================
-- 3. Add process_before_sell column
-- ============================================
-- If true, workers wait for processing (extraction) before selling

ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS process_before_sell BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================
-- 4. Add sell_quality_threshold column
-- ============================================
-- Only auto-sell items above this quality (0-100)

ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS sell_quality_threshold INT UNSIGNED NOT NULL DEFAULT 0;

-- ============================================
-- 5. Add reserve_rare_strains column
-- ============================================
-- If true, workers won't auto-sell rare/epic/legendary strains

ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS reserve_rare_strains BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================
-- 6. Add max_auto_sell_percent column
-- ============================================
-- Maximum percentage of inventory that can be auto-sold per tick

ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS max_auto_sell_percent INT UNSIGNED NOT NULL DEFAULT 50;

-- ============================================
-- 7. Add input_strain_id column to extraction_slots if missing
-- ============================================
-- workers-tick.js uses input_strain_id but schema may have strain_id

ALTER TABLE cfx_extraction_slots
ADD COLUMN IF NOT EXISTS input_strain_id INT UNSIGNED DEFAULT NULL;

-- Copy strain_id to input_strain_id if input_strain_id is null
UPDATE cfx_extraction_slots SET input_strain_id = strain_id WHERE input_strain_id IS NULL AND strain_id IS NOT NULL;

-- ============================================
-- 8. Add quality_retention column to extraction_recipes if missing
-- ============================================

ALTER TABLE cfx_extraction_recipes
ADD COLUMN IF NOT EXISTS quality_retention DECIMAL(3, 2) NOT NULL DEFAULT 0.85;

-- ============================================
-- 9. Add product_name column to extraction_recipes if missing
-- ============================================

ALTER TABLE cfx_extraction_recipes
ADD COLUMN IF NOT EXISTS product_name VARCHAR(100) DEFAULT NULL;

-- Update product_name from name if null
UPDATE cfx_extraction_recipes SET product_name = name WHERE product_name IS NULL;

-- ============================================
-- 10. Add tier column to extraction_recipes if missing
-- ============================================

ALTER TABLE cfx_extraction_recipes
ADD COLUMN IF NOT EXISTS tier INT UNSIGNED NOT NULL DEFAULT 1;

-- Set tiers based on level_required
UPDATE cfx_extraction_recipes SET tier = CEIL(level_required / 5) WHERE tier = 1 AND level_required > 5;
