-- Create missing table for leveling rewards
CREATE TABLE IF NOT EXISTS level_role_rewards (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(255) NOT NULL,
    level INT NOT NULL,
    role_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_guild_level (guild_id, level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add missing columns to tickets table
ALTER TABLE tickets
ADD COLUMN IF NOT EXISTS subject VARCHAR(255) DEFAULT 'Support Ticket';

-- Check polls table structure and add missing columns if needed
ALTER TABLE polls
ADD COLUMN IF NOT EXISTS created_by VARCHAR(255) AFTER channel_id,
ADD COLUMN IF NOT EXISTS ended TINYINT(1) DEFAULT 0 AFTER is_active;

-- Add id column to forms if it doesn't exist (some queries use id, some use form_id)
-- ALTER TABLE forms
-- ADD COLUMN IF NOT EXISTS id BIGINT(20) AUTO_INCREMENT FIRST, ADD PRIMARY KEY (id);

-- Check suggestions table
ALTER TABLE suggestions
ADD COLUMN IF NOT EXISTS suggestion_id INT AUTO_INCREMENT PRIMARY KEY FIRST;
