-- Add shop items table for NPC shop purchases
-- This tracks purchased upgrades, boosters, workers, etc.

CREATE TABLE IF NOT EXISTS cfx_player_shop_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT UNSIGNED NOT NULL,
    item_id VARCHAR(50) NOT NULL,
    item_type ENUM('seed', 'booster', 'upgrade', 'worker') NOT NULL,
    effect_type VARCHAR(50) DEFAULT NULL,

    -- Booster specific
    multiplier DECIMAL(5, 2) DEFAULT NULL,
    bonus INT DEFAULT NULL,
    uses_remaining INT DEFAULT NULL,
    expires_at DATETIME DEFAULT NULL,

    -- Worker specific
    worker_interval INT DEFAULT NULL,
    worker_last_run_at DATETIME DEFAULT NULL,
    worker_config JSON DEFAULT NULL,

    purchased_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_player (player_id),
    INDEX idx_player_type (player_id, item_type),
    INDEX idx_player_effect (player_id, effect_type),
    FOREIGN KEY (player_id) REFERENCES cfx_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note: cfx_players.id is INT UNSIGNED, so player_id must also be INT UNSIGNED
-- for the foreign key constraint to work properly
