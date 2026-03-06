-- Add per-slot seed configuration
-- This allows each grow slot to have its own preferred strain for auto-replanting

-- Add preferred_strain_id to grow slots for per-slot auto-replant
ALTER TABLE cfx_grow_slots
ADD COLUMN IF NOT EXISTS preferred_strain_id INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS use_slot_preference BOOLEAN NOT NULL DEFAULT FALSE;

-- Add auto-buy seed configuration to player settings
ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS auto_buy_seeds_enabled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS auto_buy_seeds_threshold INT NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS auto_buy_seeds_quantity INT NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS auto_buy_seeds_max_price INT NOT NULL DEFAULT 500;

-- Add worker timing configuration per player
ALTER TABLE cfx_player_settings
ADD COLUMN IF NOT EXISTS worker_harvest_interval_ms INT NOT NULL DEFAULT 300000,
ADD COLUMN IF NOT EXISTS worker_plant_interval_ms INT NOT NULL DEFAULT 300000,
ADD COLUMN IF NOT EXISTS worker_sell_interval_ms INT NOT NULL DEFAULT 600000;

-- Foreign key for slot preferred strain
-- Note: Only add if column was just created (ignore duplicate key error)
-- ALTER TABLE cfx_grow_slots
-- ADD FOREIGN KEY (preferred_strain_id) REFERENCES cfx_strains(id) ON DELETE SET NULL;
