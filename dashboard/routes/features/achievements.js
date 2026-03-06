import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// Get achievement leaderboard for guild
router.get('/manage/:guildId/achievements', async (req, res) => {
  try {
    const { guildId } = req.params;

    // Get achievement config
    const [[config]] = await pool.execute(
      'SELECT * FROM achievement_config WHERE guild_id = ?',
      [guildId]
    );

    // Get all achievements
    const [achievements] = await pool.execute(
      'SELECT * FROM achievements ORDER BY category, achievement_key'
    );

    // Get top users by achievement count
    const [topUsers] = await pool.execute(
      `SELECT
         user_id,
         COUNT(DISTINCT achievement_id) as total_achievements,
         SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed_achievements
       FROM user_achievements
       WHERE guild_id = ?
       GROUP BY user_id
       ORDER BY completed_achievements DESC
       LIMIT 20`,
      [guildId]
    );

    // Get recent achievements
    const [recentAchievements] = await pool.execute(
      `SELECT ua.*, a.name, a.description, a.icon_emoji as icon
       FROM user_achievements ua
       JOIN achievements a ON ua.achievement_id = a.id
       WHERE ua.guild_id = ? AND ua.completed = 1
       ORDER BY ua.completed_at DESC
       LIMIT 50`,
      [guildId]
    );

    // Get achievement statistics
    const [[stats]] = await pool.execute(
      `SELECT
         COUNT(DISTINCT user_id) as total_users,
         COUNT(*) as total_progress,
         SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as total_completed
       FROM user_achievements
       WHERE guild_id = ?`,
      [guildId]
    );

    res.json({
      config: config || null,
      achievements,
      topUsers,
      recentAchievements,
      stats: stats || { total_users: 0, total_progress: 0, total_completed: 0 }
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching achievements', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch achievements' });
  }
});

// Get user's achievement progress
router.get('/manage/:guildId/achievements/user/:userId', async (req, res) => {
  try {
    const { guildId, userId } = req.params;

    const [userAchievements] = await pool.execute(
      `SELECT ua.*, a.name, a.description, a.icon_emoji as icon, a.category
       FROM user_achievements ua
       JOIN achievements a ON ua.achievement_id = a.id
       WHERE ua.guild_id = ? AND ua.user_id = ?
       ORDER BY ua.completed DESC, a.category, a.achievement_key`,
      [guildId, userId]
    );

    res.json({ achievements: userAchievements });
  } catch (error) {
    logger.error('[Dashboard] Error fetching user achievements', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch user achievements' });
  }
});

// Save achievement configuration
router.post('/manage/:guildId/achievements/config', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { enabled, announcement_channel_id } = req.body;

    await pool.execute(
      `INSERT INTO achievement_config (guild_id, enabled, announcement_channel_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         announcement_channel_id = VALUES(announcement_channel_id),
         updated_at = NOW()`,
      [guildId, enabled ? 1 : 0, announcement_channel_id]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error saving achievement config', { error: error.message });
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

export default router;
