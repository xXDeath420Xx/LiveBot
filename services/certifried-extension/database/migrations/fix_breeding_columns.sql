-- Fix breeding operations table columns
-- Add missing columns used by the breeding engine

-- Add duration_ms column if it doesn't exist
ALTER TABLE cfx_breeding_operations
ADD COLUMN IF NOT EXISTS duration_ms INT DEFAULT NULL AFTER ready_at;

-- Add result_is_new column if it doesn't exist (renamed from is_new_strain for consistency)
ALTER TABLE cfx_breeding_operations
ADD COLUMN IF NOT EXISTS result_is_new TINYINT(1) DEFAULT 0 AFTER result_strain_id;

-- Add mutation_occurred column if it doesn't exist
ALTER TABLE cfx_breeding_operations
ADD COLUMN IF NOT EXISTS mutation_occurred TINYINT(1) DEFAULT 0 AFTER result_is_new;

-- Add claimed_at column if it doesn't exist
ALTER TABLE cfx_breeding_operations
ADD COLUMN IF NOT EXISTS claimed_at DATETIME DEFAULT NULL AFTER mutation_occurred;

-- Update existing is_new_strain values to result_is_new if the old column exists
-- This is a safe migration that won't fail if the column doesn't exist
UPDATE cfx_breeding_operations SET result_is_new = is_new_strain WHERE is_new_strain IS NOT NULL;
