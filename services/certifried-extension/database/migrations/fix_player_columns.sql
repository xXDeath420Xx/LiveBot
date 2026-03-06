-- ============================================
-- FIX PLAYER COLUMNS - CRITICAL MIGRATION
-- ============================================
-- The raid-tick.js and other code uses columns that don't exist in cfx_players.
-- This migration adds all missing player-related columns and tables.

-- ============================================
-- 1. Add last_online_at column to cfx_players
-- ============================================

ALTER TABLE cfx_players
ADD COLUMN IF NOT EXISTS last_online_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ============================================
-- 2. Create cfx_player_stats table (for stats tracking)
-- ============================================

CREATE TABLE IF NOT EXISTS cfx_player_stats (
    player_id INT UNSIGNED NOT NULL PRIMARY KEY,

    -- Core stats
    total_plants_grown INT UNSIGNED NOT NULL DEFAULT 0,
    total_harvests INT UNSIGNED NOT NULL DEFAULT 0,
    total_breeds INT UNSIGNED NOT NULL DEFAULT 0,
    total_successful_breeds INT UNSIGNED NOT NULL DEFAULT 0,
    total_mutations_discovered INT UNSIGNED NOT NULL DEFAULT 0,

    -- Economy stats
    total_cash_earned DECIMAL(20, 2) NOT NULL DEFAULT 0.00,
    total_cash_spent DECIMAL(20, 2) NOT NULL DEFAULT 0.00,
    total_trades_completed INT UNSIGNED NOT NULL DEFAULT 0,
    total_npc_sales INT UNSIGNED NOT NULL DEFAULT 0,
    total_market_sales INT UNSIGNED NOT NULL DEFAULT 0,

    -- Worker stats
    total_worker_actions INT UNSIGNED NOT NULL DEFAULT 0,

    -- Quality stats
    highest_quality_achieved INT UNSIGNED NOT NULL DEFAULT 0,
    total_legendary_harvests INT UNSIGNED NOT NULL DEFAULT 0,

    -- Raid stats (for add_raid_system.sql)
    total_raids_suffered INT NOT NULL DEFAULT 0,
    total_cash_seized DECIMAL(20, 2) NOT NULL DEFAULT 0.00,
    total_items_destroyed INT NOT NULL DEFAULT 0,
    total_plants_destroyed INT NOT NULL DEFAULT 0,
    total_seeds_confiscated INT NOT NULL DEFAULT 0,
    highest_heat_reached DECIMAL(10, 2) NOT NULL DEFAULT 0.00,

    -- XP stats
    total_xp_earned BIGINT UNSIGNED NOT NULL DEFAULT 0,

    -- Time tracking
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 3. Initialize stats for existing players
-- ============================================

INSERT INTO cfx_player_stats (player_id)
SELECT id FROM cfx_players p
WHERE NOT EXISTS (SELECT 1 FROM cfx_player_stats ps WHERE ps.player_id = p.id);

-- ============================================
-- 4. Update last_online_at from last_tick_at for existing players
-- ============================================

UPDATE cfx_players SET last_online_at = last_tick_at WHERE last_online_at = '1970-01-01 00:00:00';

-- ============================================
-- 5. Add skill_points column to cfx_players if missing
-- ============================================
-- Referenced by skill system

ALTER TABLE cfx_players
ADD COLUMN IF NOT EXISTS skill_points INT UNSIGNED NOT NULL DEFAULT 0;

-- ============================================
-- 6. Add notification columns to cfx_players if missing
-- ============================================

ALTER TABLE cfx_players
ADD COLUMN IF NOT EXISTS unread_notifications INT UNSIGNED NOT NULL DEFAULT 0;

-- ============================================
-- 7. Initialize player settings for existing players
-- ============================================

INSERT INTO cfx_player_settings (player_id)
SELECT id FROM cfx_players p
WHERE NOT EXISTS (SELECT 1 FROM cfx_player_settings ps WHERE ps.player_id = p.id);

-- ============================================
-- 8. Initialize player heat for existing players
-- ============================================

INSERT INTO cfx_player_heat (player_id)
SELECT id FROM cfx_players p
WHERE NOT EXISTS (SELECT 1 FROM cfx_player_heat ph WHERE ph.player_id = p.id);

-- ============================================
-- 9. Initialize player vault for existing players
-- ============================================

INSERT INTO cfx_player_vault (player_id)
SELECT id FROM cfx_players p
WHERE NOT EXISTS (SELECT 1 FROM cfx_player_vault pv WHERE pv.player_id = p.id);
