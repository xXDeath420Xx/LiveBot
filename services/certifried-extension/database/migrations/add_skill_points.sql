-- Add skill_points column to cfx_players
-- Players earn skill points when leveling up

ALTER TABLE cfx_players
ADD COLUMN skill_points INT NOT NULL DEFAULT 0 AFTER xp;

-- Give existing players skill points based on their level (1 per level after level 1)
UPDATE cfx_players SET skill_points = GREATEST(0, level - 1);
