-- Fix skill_nodes table to match routes expectations
-- Routes use: required_level, prerequisites, cost_cash, icon
-- Note: Errors are expected if columns already exist - the setup script handles this gracefully

-- Add required_level column (alias for requires_level)
ALTER TABLE cfx_skill_nodes ADD COLUMN required_level INT NOT NULL DEFAULT 1;

-- Add cost_cash column
ALTER TABLE cfx_skill_nodes ADD COLUMN cost_cash INT NOT NULL DEFAULT 500;

-- Add prerequisites JSON column
ALTER TABLE cfx_skill_nodes ADD COLUMN prerequisites JSON DEFAULT NULL;

-- Add icon column
ALTER TABLE cfx_skill_nodes ADD COLUMN icon VARCHAR(50) DEFAULT NULL;

-- Copy requires_level to required_level for existing records
UPDATE cfx_skill_nodes SET required_level = COALESCE(requires_level, 1);

-- Set cost_cash for existing skills based on cost_per_rank (500 per rank point)
UPDATE cfx_skill_nodes SET cost_cash = COALESCE(cost_per_rank, 1) * 500;
