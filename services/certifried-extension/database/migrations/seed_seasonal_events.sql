-- Seasonal Events table
CREATE TABLE IF NOT EXISTS cfx_seasonal_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_slug VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    event_type ENUM('harvest', 'breeding', 'sales', 'general') NOT NULL DEFAULT 'general',
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    bonus_type VARCHAR(50) DEFAULT NULL,
    bonus_value DECIMAL(10,4) DEFAULT 0,
    special_strain_ids JSON DEFAULT NULL,
    rewards_json JSON DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sample seasonal events
INSERT IGNORE INTO cfx_seasonal_events (event_slug, name, description, event_type, starts_at, ends_at, bonus_type, bonus_value, rewards_json, is_active) VALUES
('winter_harvest_2026', 'Winter Harvest Festival', 'Celebrate the winter season with bonus harvests and exclusive strains!', 'harvest', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 'harvest_bonus', 0.25, '{"milestones": [{"points": 100, "reward": "500 cash"}, {"points": 500, "reward": "2500 cash"}, {"points": 1000, "reward": "rare_seed_pack"}, {"points": 2500, "reward": "10000 cash"}, {"points": 5000, "reward": "epic_seed_pack"}]}', 1),
('breeding_bonanza', 'Breeding Bonanza', 'Double breeding speed and increased mutation chances!', 'breeding', NOW(), DATE_ADD(NOW(), INTERVAL 14 DAY), 'breed_speed', 0.50, '{"milestones": [{"points": 50, "reward": "1000 cash"}, {"points": 150, "reward": "rare_seed_pack"}, {"points": 300, "reward": "5000 cash"}]}', 1),
('green_rush', 'Green Rush Sales Event', 'Increased demand means higher prices! Sell for 20% more during the event.', 'sales', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), 'sell_bonus', 0.20, '{"milestones": [{"points": 200, "reward": "2000 cash"}, {"points": 1000, "reward": "8000 cash"}, {"points": 2000, "reward": "epic_seed_pack"}]}', 1);

-- Player events junction table (if not exists)
CREATE TABLE IF NOT EXISTS cfx_player_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    event_id INT NOT NULL,
    points_earned INT NOT NULL DEFAULT 0,
    rewards_claimed JSON DEFAULT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_player_event (player_id, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SELECT 'Seasonal events seeded!' AS status;
