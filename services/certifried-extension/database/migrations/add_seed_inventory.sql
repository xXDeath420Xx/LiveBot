-- Seed Inventory System
-- Seeds are now consumable items that go into inventory when purchased
-- Planting a seed consumes 1 from inventory

CREATE TABLE IF NOT EXISTS cfx_seed_inventory (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL DEFAULT 0,
    
    -- Track where seeds came from
    total_purchased INT UNSIGNED NOT NULL DEFAULT 0,
    total_found INT UNSIGNED NOT NULL DEFAULT 0,
    total_bred INT UNSIGNED NOT NULL DEFAULT 0,
    total_gifted INT UNSIGNED NOT NULL DEFAULT 0,
    total_used INT UNSIGNED NOT NULL DEFAULT 0,
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY uk_player_strain (player_id, strain_id),
    INDEX idx_player (player_id),
    INDEX idx_quantity (player_id, quantity),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Facility upgrades table for business management
CREATE TABLE IF NOT EXISTS cfx_facility_upgrades (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    upgrade_type VARCHAR(50) NOT NULL,
    current_level INT UNSIGNED NOT NULL DEFAULT 1,
    max_level INT UNSIGNED NOT NULL DEFAULT 10,
    
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY uk_player_upgrade (player_id, upgrade_type),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
