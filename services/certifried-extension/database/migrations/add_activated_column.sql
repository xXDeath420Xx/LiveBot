-- Add 'activated' column to cfx_player_shop_items for tracking booster activation
-- Boosters can be purchased (in inventory) but not activated until the player uses them

ALTER TABLE cfx_player_shop_items
ADD COLUMN activated TINYINT(1) NOT NULL DEFAULT 0 AFTER uses_remaining;
