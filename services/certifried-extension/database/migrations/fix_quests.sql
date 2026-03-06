-- Fix quests table and add target column
-- Note: Errors are expected if columns already exist - the setup script handles this gracefully

-- Add target column to player_quests (stores the goal from quest definition)
ALTER TABLE cfx_player_quests ADD COLUMN target INT NOT NULL DEFAULT 1;

-- Update existing quest targets from quest definitions
UPDATE cfx_player_quests pq
JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
SET pq.target = qd.objective_target
WHERE pq.target = 1 OR pq.target IS NULL;
