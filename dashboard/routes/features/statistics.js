import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// Get server statistics
router.get('/manage/:guildId/serverstats', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { period = '7d' } = req.query;

    // Calculate date range based on period
    let days = 7;
    if (period === '30d') days = 30;
    else if (period === '90d') days = 90;

    let dateCondition = `DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`;
    let statDateCondition = `stat_date >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`;

    // Get current stats from latest snapshot or aggregate from message_stats
    const [[currentStats]] = await pool.execute(
      `SELECT
         COUNT(DISTINCT user_id) as total_members,
         SUM(message_count) as total_messages,
         (SELECT COUNT(*) FROM message_stats WHERE guild_id = ? AND ${dateCondition}) as members_joined,
         0 as members_left
       FROM message_stats
       WHERE guild_id = ? AND ${dateCondition}`,
      [guildId, guildId]
    );

    // Get activity stats (voice, commands, reactions)
    const [[activityStats]] = await pool.execute(
      `SELECT
         COALESCE(SUM(voice_minutes), 0) as total_voice_minutes,
         COALESCE(SUM(commands_used), 0) as total_commands,
         COALESCE(SUM(reactions_added), 0) as total_reactions,
         COALESCE(SUM(members_joined), 0) as members_joined,
         COALESCE(SUM(members_left), 0) as members_left
       FROM activity_stats
       WHERE guild_id = ? AND ${statDateCondition}`,
      [guildId]
    );

    // Get historical snapshots for growth chart
    const [snapshots] = await pool.execute(
      `SELECT snapshot_date as date, member_count, boost_count, boost_level
       FROM server_stats_snapshots
       WHERE guild_id = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
       ORDER BY snapshot_date ASC`,
      [guildId]
    );

    // Get top message senders
    const [topMessagers] = await pool.execute(
      `SELECT user_id, SUM(message_count) as total_messages
       FROM message_stats
       WHERE guild_id = ? AND ${statDateCondition}
       GROUP BY user_id
       ORDER BY total_messages DESC
       LIMIT 10`,
      [guildId]
    );

    // Get channel activity
    const [channelActivity] = await pool.execute(
      `SELECT channel_id, SUM(message_count) as total_messages
       FROM message_stats
       WHERE guild_id = ? AND ${statDateCondition}
       GROUP BY channel_id
       ORDER BY total_messages DESC
       LIMIT 10`,
      [guildId]
    );

    // Get peak activity hours (heatmap data)
    const [peakHours] = await pool.execute(
      `SELECT hour_of_day, day_of_week, message_count, active_users
       FROM peak_activity_hours
       WHERE guild_id = ?
       ORDER BY day_of_week, hour_of_day`,
      [guildId]
    );

    // Get top emojis
    const [topEmojis] = await pool.execute(
      `SELECT emoji_id, emoji_name, is_custom, SUM(usage_count) as use_count
       FROM emoji_usage
       WHERE guild_id = ? AND ${statDateCondition}
       GROUP BY emoji_id, emoji_name, is_custom
       ORDER BY use_count DESC
       LIMIT 10`,
      [guildId]
    );

    // Get daily message trend
    const [dailyMessages] = await pool.execute(
      `SELECT stat_date as date, SUM(message_count) as messages
       FROM message_stats
       WHERE guild_id = ? AND ${statDateCondition}
       GROUP BY stat_date
       ORDER BY stat_date ASC`,
      [guildId]
    );

    // Merge activity stats into currentStats
    const mergedStats = {
      ...currentStats,
      voice_minutes: activityStats?.total_voice_minutes || 0,
      commands_used: activityStats?.total_commands || 0,
      reactions_added: activityStats?.total_reactions || 0,
      members_joined: activityStats?.members_joined || currentStats?.members_joined || 0,
      members_left: activityStats?.members_left || 0
    };

    res.json({
      currentStats: mergedStats,
      snapshots,
      topMessagers,
      channelActivity,
      peakHours,
      topEmojis,
      dailyMessages,
      period
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching server stats:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch server stats' });
  }
});

// Get emoji statistics
router.get('/manage/:guildId/emojistats', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { period = '7d' } = req.query;

    let dateCondition = 'DATE(used_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    if (period === '30d') {
      dateCondition = 'DATE(used_at) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    } else if (period === '90d') {
      dateCondition = 'DATE(used_at) >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)';
    }

    // Get top emojis overall
    const [topEmojis] = await pool.execute(
      `SELECT emoji_id as emoji, emoji_name, is_custom, SUM(usage_count) as use_count
       FROM emoji_usage
       WHERE guild_id = ? AND ${dateCondition.replace('used_at', 'stat_date')}
       GROUP BY emoji_id, emoji_name, is_custom
       ORDER BY use_count DESC
       LIMIT 20`,
      [guildId]
    );

    // Get top emoji users
    const [topUsers] = await pool.execute(
      `SELECT user_id, SUM(usage_count) as total_emoji_uses
       FROM emoji_usage
       WHERE guild_id = ? AND ${dateCondition.replace('used_at', 'stat_date')}
       GROUP BY user_id
       ORDER BY total_emoji_uses DESC
       LIMIT 10`,
      [guildId]
    );

    // Get emoji usage over time (daily)
    const [dailyUsage] = await pool.execute(
      `SELECT stat_date as date, SUM(usage_count) as count
       FROM emoji_usage
       WHERE guild_id = ? AND ${dateCondition.replace('used_at', 'stat_date')}
       GROUP BY stat_date
       ORDER BY stat_date ASC`,
      [guildId]
    );

    // Get custom vs unicode split
    const [emojiTypeSplit] = await pool.execute(
      `SELECT
         CASE WHEN is_custom = 1 THEN 'custom' ELSE 'unicode' END as emoji_type,
         SUM(usage_count) as total_uses
       FROM emoji_usage
       WHERE guild_id = ? AND ${dateCondition.replace('used_at', 'stat_date')}
       GROUP BY is_custom`,
      [guildId]
    );

    res.json({
      topEmojis,
      topUsers,
      trends: dailyUsage,
      emojiTypeSplit,
      period
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching emoji stats:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch emoji stats' });
  }
});

export default router;
