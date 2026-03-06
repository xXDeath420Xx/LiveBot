-- Add missing columns for breeding system

-- Add is_bred column to track player-bred strains
ALTER TABLE cfx_strains
ADD COLUMN IF NOT EXISTS is_bred TINYINT(1) NOT NULL DEFAULT 0 AFTER is_breedable;

-- Add bred_by_player_id column (the code uses this while schema only has created_by_player_id)
ALTER TABLE cfx_strains
ADD COLUMN IF NOT EXISTS bred_by_player_id INT DEFAULT NULL AFTER created_by_player_id;

-- Add genetics JSON column for storing computed genetics from breeding
ALTER TABLE cfx_strains
ADD COLUMN IF NOT EXISTS genetics JSON DEFAULT NULL AFTER flavors;

-- Update existing bred strains (where created_by_player_id is set)
UPDATE cfx_strains
SET is_bred = 1, bred_by_player_id = created_by_player_id
WHERE created_by_player_id IS NOT NULL AND is_bred = 0;

-- Add last_updated_at column to cfx_grow_slots if missing (for water cooldown tracking)
ALTER TABLE cfx_grow_slots
ADD COLUMN IF NOT EXISTS last_updated_at DATETIME DEFAULT NULL AFTER accumulated_growth_ms;
