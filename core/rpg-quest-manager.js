import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * RPG Quest Manager - Handles quest system
 */
class RPGQuestManager {
    constructor(client, characterManager) {
        this.client = client;
        this.characterManager = characterManager;
    }

    /**
     * Get all available quests
     */
    async getAvailableQuests(characterLevel = 1) {
        try {
            const [quests] = await pool.execute(
                'SELECT * FROM dnd_quests WHERE required_level <= ? ORDER BY required_level, quest_name',
                [characterLevel]
            );

            return quests;
        } catch (error) {
            logger.error(`[RPGQuestManager] Error getting available quests: ${error.message}`);
            return [];
        }
    }

    /**
     * Get quest by ID
     */
    async getQuest(questId) {
        try {
            const [quests] = await pool.execute(
                'SELECT * FROM dnd_quests WHERE quest_id = ?',
                [questId]
            );

            return quests[0] || null;
        } catch (error) {
            logger.error(`[RPGQuestManager] Error getting quest: ${error.message}`);
            return null;
        }
    }

    /**
     * Start a quest
     */
    async startQuest(characterId, questId) {
        try {
            // Check if character already has this quest
            const [existing] = await pool.execute(
                'SELECT * FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "active"',
                [characterId, questId]
            );

            if (existing.length > 0) {
                throw new Error('You already have this quest active');
            }

            // Get quest info
            const quest = await this.getQuest(questId);

            if (!quest) {
                throw new Error('Quest not found');
            }

            // Get character info
            const [chars] = await pool.execute(
                'SELECT level FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );
            const character = chars[0];

            if (!character) {
                throw new Error('Character not found');
            }

            // Check level requirement
            if (character.level < quest.required_level) {
                throw new Error(`You need to be at least level ${quest.required_level} for this quest`);
            }

            // Start the quest
            await pool.execute(
                'INSERT INTO dnd_character_quests (character_id, quest_id, status, progress, started_at) VALUES (?, ?, "active", 0, NOW())',
                [characterId, questId]
            );

            logger.info(`[RPGQuestManager] Character ${characterId} started quest ${questId}`);
            return quest;

        } catch (error) {
            logger.error(`[RPGQuestManager] Error starting quest: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get active quests for a character
     */
    async getActiveQuests(characterId) {
        try {
            const [quests] = await pool.execute(
                `SELECT q.*, cq.progress, cq.started_at, cq.character_quest_id
                 FROM dnd_character_quests cq
                 JOIN dnd_quests q ON cq.quest_id = q.quest_id
                 WHERE cq.character_id = ? AND cq.status = 'active'
                 ORDER BY cq.started_at DESC`,
                [characterId]
            );

            return quests;
        } catch (error) {
            logger.error(`[RPGQuestManager] Error getting active quests: ${error.message}`);
            return [];
        }
    }

    /**
     * Get completed quests for a character
     */
    async getCompletedQuests(characterId) {
        try {
            const [quests] = await pool.execute(
                `SELECT q.*, cq.completed_at
                 FROM dnd_character_quests cq
                 JOIN dnd_quests q ON cq.quest_id = q.quest_id
                 WHERE cq.character_id = ? AND cq.status = 'completed'
                 ORDER BY cq.completed_at DESC`,
                [characterId]
            );

            return quests;
        } catch (error) {
            logger.error(`[RPGQuestManager] Error getting completed quests: ${error.message}`);
            return [];
        }
    }

    /**
     * Update quest progress
     */
    async updateQuestProgress(characterId, questId, progress) {
        try {
            // Ensure progress is between 0 and 100
            const validProgress = Math.max(0, Math.min(100, progress));

            await pool.execute(
                'UPDATE dnd_character_quests SET progress = ? WHERE character_id = ? AND quest_id = ? AND status = "active"',
                [validProgress, characterId, questId]
            );

            logger.info(`[RPGQuestManager] Updated quest ${questId} progress to ${validProgress}% for character ${characterId}`);
            return true;

        } catch (error) {
            logger.error(`[RPGQuestManager] Error updating quest progress: ${error.message}`);
            return false;
        }
    }

    /**
     * Complete a quest
     */
    async completeQuest(characterId, questId) {
        try {
            // Check if quest is active
            const [activeQuests] = await pool.execute(
                'SELECT * FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "active"',
                [characterId, questId]
            );

            if (activeQuests.length === 0) {
                throw new Error('Quest not found or not active');
            }

            const activeQuest = activeQuests[0];

            // Check if progress is complete (allow some flexibility)
            if (activeQuest.progress < 90) {
                throw new Error('Quest is not yet complete. Keep working on it!');
            }

            // Get quest info
            const quest = await this.getQuest(questId);

            if (!quest) {
                throw new Error('Quest not found');
            }

            // Update quest status
            await pool.execute(
                'UPDATE dnd_character_quests SET status = "completed", progress = 100, completed_at = NOW() WHERE character_id = ? AND quest_id = ?',
                [characterId, questId]
            );

            // Award rewards
            const rewards = {
                exp: quest.reward_exp || 0,
                gold: quest.reward_gold || 0,
                item: null,
                leveledUp: false
            };

            // Add gold
            if (rewards.gold > 0) {
                await this.characterManager.addGold(characterId, rewards.gold);
            }

            // Add experience
            if (rewards.exp > 0) {
                const expResult = await this.characterManager.addExperience(characterId, rewards.exp);
                if (expResult && expResult.leveledUp) {
                    rewards.leveledUp = true;
                    rewards.newLevel = expResult.newLevel;
                }
            }

            // Award item if any
            if (quest.reward_item_id) {
                await this.characterManager.addItem(characterId, quest.reward_item_id, 1);

                const [items] = await pool.execute(
                    'SELECT item_name FROM dnd_items WHERE item_id = ?',
                    [quest.reward_item_id]
                );

                if (items.length > 0) {
                    rewards.item = items[0].item_name;
                }
            }

            logger.info(`[RPGQuestManager] Character ${characterId} completed quest ${questId}`);

            return {
                quest,
                rewards
            };

        } catch (error) {
            logger.error(`[RPGQuestManager] Error completing quest: ${error.message}`);
            throw error;
        }
    }

    /**
     * Abandon a quest
     */
    async abandonQuest(characterId, questId) {
        try {
            const [result] = await pool.execute(
                'DELETE FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "active"',
                [characterId, questId]
            );

            if (result.affectedRows === 0) {
                throw new Error('Quest not found or not active');
            }

            logger.info(`[RPGQuestManager] Character ${characterId} abandoned quest ${questId}`);
            return true;

        } catch (error) {
            logger.error(`[RPGQuestManager] Error abandoning quest: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get quest chain (prerequisite quests)
     */
    async getQuestChain(questId) {
        try {
            const chain = [];
            let currentQuestId = questId;

            while (currentQuestId) {
                const [quests] = await pool.execute(
                    'SELECT * FROM dnd_quests WHERE quest_id = ?',
                    [currentQuestId]
                );

                if (quests.length === 0) break;

                const quest = quests[0];
                chain.unshift(quest);

                // Check if there's a prerequisite
                currentQuestId = quest.prerequisite_quest_id || null;
            }

            return chain;

        } catch (error) {
            logger.error(`[RPGQuestManager] Error getting quest chain: ${error.message}`);
            return [];
        }
    }

    /**
     * Check if character can start quest (including prerequisites)
     */
    async canStartQuest(characterId, questId) {
        try {
            const quest = await this.getQuest(questId);

            if (!quest) {
                return { canStart: false, reason: 'Quest not found' };
            }

            // Get character level
            const [chars] = await pool.execute(
                'SELECT level FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            if (chars.length === 0) {
                return { canStart: false, reason: 'Character not found' };
            }

            const character = chars[0];

            // Check level requirement
            if (character.level < quest.required_level) {
                return {
                    canStart: false,
                    reason: `You need to be at least level ${quest.required_level}`
                };
            }

            // Check prerequisite quest
            if (quest.prerequisite_quest_id) {
                const [completed] = await pool.execute(
                    'SELECT * FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "completed"',
                    [characterId, quest.prerequisite_quest_id]
                );

                if (completed.length === 0) {
                    const [prereqQuest] = await pool.execute(
                        'SELECT quest_name FROM dnd_quests WHERE quest_id = ?',
                        [quest.prerequisite_quest_id]
                    );

                    return {
                        canStart: false,
                        reason: `You must first complete: ${prereqQuest[0]?.quest_name || 'prerequisite quest'}`
                    };
                }
            }

            // Check if already active
            const [active] = await pool.execute(
                'SELECT * FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "active"',
                [characterId, questId]
            );

            if (active.length > 0) {
                return { canStart: false, reason: 'Quest already active' };
            }

            // Check if already completed (unless repeatable)
            if (!quest.repeatable) {
                const [completed] = await pool.execute(
                    'SELECT * FROM dnd_character_quests WHERE character_id = ? AND quest_id = ? AND status = "completed"',
                    [characterId, questId]
                );

                if (completed.length > 0) {
                    return { canStart: false, reason: 'Quest already completed' };
                }
            }

            return { canStart: true };

        } catch (error) {
            logger.error(`[RPGQuestManager] Error checking quest eligibility: ${error.message}`);
            return { canStart: false, reason: 'Error checking eligibility' };
        }
    }

    /**
     * Get quest statistics for a character
     */
    async getQuestStats(characterId) {
        try {
            const [stats] = await pool.execute(
                `SELECT
                    COUNT(CASE WHEN status = 'active' THEN 1 END) as active_count,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
                    SUM(CASE WHEN status = 'completed' THEN q.reward_exp ELSE 0 END) as total_exp_earned,
                    SUM(CASE WHEN status = 'completed' THEN q.reward_gold ELSE 0 END) as total_gold_earned
                 FROM dnd_character_quests cq
                 JOIN dnd_quests q ON cq.quest_id = q.quest_id
                 WHERE cq.character_id = ?`,
                [characterId]
            );

            return stats[0] || {
                active_count: 0,
                completed_count: 0,
                total_exp_earned: 0,
                total_gold_earned: 0
            };

        } catch (error) {
            logger.error(`[RPGQuestManager] Error getting quest stats: ${error.message}`);
            return {
                active_count: 0,
                completed_count: 0,
                total_exp_earned: 0,
                total_gold_earned: 0
            };
        }
    }

    /**
     * Auto-progress quest based on activity (e.g., battles, items collected)
     */
    async autoProgressQuest(characterId, questType, amount = 1) {
        try {
            // Get active quests that match the type
            const [quests] = await pool.execute(
                `SELECT cq.*, q.quest_type, q.requirement_count
                 FROM dnd_character_quests cq
                 JOIN dnd_quests q ON cq.quest_id = q.quest_id
                 WHERE cq.character_id = ? AND cq.status = 'active' AND q.quest_type = ?`,
                [characterId, questType]
            );

            for (const quest of quests) {
                const progressIncrement = (amount / quest.requirement_count) * 100;
                const newProgress = Math.min(100, quest.progress + progressIncrement);

                await this.updateQuestProgress(characterId, quest.quest_id, newProgress);
            }

            return true;

        } catch (error) {
            logger.error(`[RPGQuestManager] Error auto-progressing quest: ${error.message}`);
            return false;
        }
    }
}

export default RPGQuestManager;
