-- DEA Raid System Migration
-- Adds heat tracking, raid logs, and vault system

-- Heat tracking for raid system
CREATE TABLE IF NOT EXISTS cfx_player_heat (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL UNIQUE,

    current_heat DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    lifetime_heat_earned DECIMAL(15, 2) NOT NULL DEFAULT 0.00,

    last_heat_update DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_raid_check DATETIME DEFAULT NULL,
    last_raided_at DATETIME DEFAULT NULL,

    -- Cooldown: can't be raided twice within 4 hours
    raid_immunity_until DATETIME DEFAULT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    INDEX idx_heat (current_heat),
    INDEX idx_last_check (last_raid_check)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Raid history log
CREATE TABLE IF NOT EXISTS cfx_raid_log (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,

    heat_at_raid DECIMAL(10, 2) NOT NULL,
    security_level INT NOT NULL DEFAULT 0,

    -- What was seized
    cash_seized DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    inventory_destroyed INT NOT NULL DEFAULT 0,
    plants_destroyed INT NOT NULL DEFAULT 0,
    seeds_confiscated INT NOT NULL DEFAULT 0,

    -- Summary JSON for detailed breakdown
    seizure_details JSON DEFAULT NULL,

    -- Post-raid state
    heat_after_raid DECIMAL(10, 2) NOT NULL,

    raided_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    INDEX idx_player_raids (player_id, raided_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Player vault for protected assets
CREATE TABLE IF NOT EXISTS cfx_player_vault (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL UNIQUE,

    vault_level INT NOT NULL DEFAULT 0,
    vault_cash DECIMAL(15, 2) NOT NULL DEFAULT 0.00,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vault inventory (items stored in vault)
CREATE TABLE IF NOT EXISTS cfx_vault_inventory (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NOT NULL,

    quantity INT NOT NULL DEFAULT 0,
    quality INT NOT NULL,

    stored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uk_player_strain_quality (player_id, strain_id, quality),
    INDEX idx_player (player_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vault seed storage
CREATE TABLE IF NOT EXISTS cfx_vault_seeds (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NOT NULL,

    quantity INT NOT NULL DEFAULT 0,

    stored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uk_player_strain (player_id, strain_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add raid stats to player_stats
ALTER TABLE cfx_player_stats
ADD COLUMN IF NOT EXISTS total_raids_suffered INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_cash_seized DECIMAL(20, 2) NOT NULL DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS total_items_destroyed INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_plants_destroyed INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_seeds_confiscated INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS highest_heat_reached DECIMAL(10, 2) NOT NULL DEFAULT 0.00;
