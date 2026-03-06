-- Phase 1: Quality of Life + Foundation Features
-- Run this migration to add strain favorites, market alerts, and player settings

-- 1. Strain Favorites System
CREATE TABLE IF NOT EXISTS cfx_strain_favorites (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_player_strain (player_id, strain_id),
    KEY idx_player_order (player_id, sort_order),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Market Alerts System
CREATE TABLE IF NOT EXISTS cfx_market_alerts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id INT UNSIGNED NOT NULL,
    strain_id INT UNSIGNED NOT NULL,
    alert_type ENUM('price_above', 'price_below', 'price_change_percent') NOT NULL,
    threshold_value DECIMAL(15, 2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_triggered_at DATETIME NULL,
    trigger_count INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_player_active (player_id, is_active),
    KEY idx_strain (strain_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE,
    FOREIGN KEY (strain_id) REFERENCES cfx_strains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Player Settings Table (CFX-specific settings)
CREATE TABLE IF NOT EXISTS cfx_player_settings (
    player_id INT UNSIGNED NOT NULL,
    -- Notification settings
    notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Offline automation settings
    offline_harvest_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    offline_sell_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    offline_plant_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    offline_sell_min_quality INT UNSIGNED NOT NULL DEFAULT 0,
    offline_plant_strain_id INT UNSIGNED NULL,
    -- Auto-replant settings (worker enhancement)
    auto_replant_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    auto_replant_strain_id INT UNSIGNED NULL,
    auto_replant_use_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    -- Timestamps
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
