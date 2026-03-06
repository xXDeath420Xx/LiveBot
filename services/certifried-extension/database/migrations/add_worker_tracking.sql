-- Add worker tracking column
-- Tracks when each worker last ran

ALTER TABLE cfx_player_shop_items
ADD COLUMN IF NOT EXISTS last_worker_run DATETIME DEFAULT NULL;

-- Index for efficient worker tick queries
CREATE INDEX IF NOT EXISTS idx_shop_items_worker_run
ON cfx_player_shop_items (item_type, last_worker_run);
