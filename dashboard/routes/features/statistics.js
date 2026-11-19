import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { userBits } from '../../../core/user-display.js';

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

    // Members who posted, and messages sent, in the period (message_stats: one row per channel,
    // member and day). total_members is kept for older callers; it is the members who posted.
    const [[currentStats]] = await pool.execute(
      `SELECT
         COUNT(DISTINCT user_id) as total_members,
         COALESCE(SUM(message_count), 0) as total_messages
       FROM message_stats
       WHERE guild_id = ? AND ${statDateCondition}`,
      [guildId]
    );

    // The same figures for the period just before (same length), for "vs previous" on the page.
    const prevCondition = `stat_date >= DATE_SUB(CURDATE(), INTERVAL ${days * 2 + 1} DAY) AND stat_date < DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`;
    const [[prevMessages]] = await pool.execute(
      `SELECT COUNT(DISTINCT user_id) as active_members, COALESCE(SUM(message_count), 0) as total_messages
       FROM message_stats WHERE guild_id = ? AND ${prevCondition}`,
      [guildId]
    );
    const [[prevActivity]] = await pool.execute(
      `SELECT COALESCE(SUM(voice_minutes), 0) as voice_minutes, COALESCE(SUM(commands_used), 0) as commands_used,
              COALESCE(SUM(members_joined), 0) as members_joined, COALESCE(SUM(members_left), 0) as members_left
       FROM activity_stats WHERE guild_id = ? AND ${prevCondition}`,
      [guildId]
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
    const [topMessagersRaw] = await pool.execute(
      `SELECT user_id, SUM(message_count) as total_messages
       FROM message_stats
       WHERE guild_id = ? AND ${statDateCondition}
       GROUP BY user_id
       ORDER BY total_messages DESC
       LIMIT 10`,
      [guildId]
    );

    // Get channel activity
    const [channelActivityRaw] = await pool.execute(
      `SELECT channel_id, SUM(message_count) as total_messages
       FROM message_stats
       WHERE guild_id = ? AND ${statDateCondition}
       GROUP BY channel_id
       ORDER BY total_messages DESC
       LIMIT 10`,
      [guildId]
    );

    // Resolve user and channel names from Discord cache
    const botClient = global.botManager?.getClientForGuild(guildId) || req.app?.locals?.client;
    const guild = botClient?.guilds?.cache?.get(guildId);

    const topMessagers = await Promise.all(topMessagersRaw.map(async (row) => {
      let username = null;
      if (guild) {
        try {
          const member = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(() => null);
          username = member?.displayName || member?.user?.username || null;
        } catch { /* ignore */ }
      }
      return { ...row, username };
    }));

    const channelActivity = channelActivityRaw.map(row => {
      let channel_name = null;
      if (guild) {
        const channel = guild.channels.cache.get(row.channel_id);
        channel_name = channel?.name || null;
      }
      return { ...row, channel_name };
    });

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
      // (Joins used to fall back to the number of message_stats rows, which is not a join count.)
      members_joined: activityStats?.members_joined || 0,
      members_left: activityStats?.members_left || 0,
      active_members: currentStats?.total_members || 0,
      server_members: guild?.memberCount ?? null
    };
    const prevStats = {
      total_messages: Number(prevMessages?.total_messages) || 0,
      active_members: Number(prevMessages?.active_members) || 0,
      voice_minutes: Number(prevActivity?.voice_minutes) || 0,
      commands_used: Number(prevActivity?.commands_used) || 0,
      members_joined: Number(prevActivity?.members_joined) || 0,
      members_left: Number(prevActivity?.members_left) || 0
    };

    res.json({
      currentStats: mergedStats,
      prevStats,
      days,
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
    const [topUsersRaw] = await pool.execute(
      `SELECT user_id, SUM(usage_count) as total_emoji_uses
       FROM emoji_usage
       WHERE guild_id = ? AND ${dateCondition.replace('used_at', 'stat_date')}
       GROUP BY user_id
       ORDER BY total_emoji_uses DESC
       LIMIT 10`,
      [guildId]
    );

    // Resolve usernames
    const eBotClient = global.botManager?.getClientForGuild(guildId) || req.app?.locals?.client;
    const eGuild = eBotClient?.guilds?.cache?.get(guildId);
    const topUsers = await Promise.all(topUsersRaw.map(async (row) => {
      let username = null;
      if (eGuild) {
        try {
          const member = eGuild.members.cache.get(row.user_id) || await eGuild.members.fetch(row.user_id).catch(() => null);
          username = member?.displayName || member?.user?.username || null;
        } catch { /* ignore */ }
      }
      return { ...row, username };
    }));

    // Get emoji usage over time (daily)
    const [dailyUsage] = await pool.execute(
      `SELECT stat_date as date, SUM(usage_count) as count
       FROM emoji_usage
       WHERE guild_id = ? AND ${dateCondition.replace('used_at', 'stat_date')}
       GROUP BY stat_date
       ORDER BY stat_date ASC`,
      [guildId]
    );

    // Totals for the whole period (the lists above are capped), the period before, and the
    // server's own emoji nobody used in the period.
    const statCond = dateCondition.replace('used_at', 'stat_date');
    const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;
    const [[totals]] = await pool.execute(
      `SELECT COALESCE(SUM(usage_count), 0) as total_uses, COUNT(DISTINCT emoji_id) as unique_emojis,
              COUNT(DISTINCT user_id) as active_users
       FROM emoji_usage WHERE guild_id = ? AND ${statCond}`,
      [guildId]
    );
    const [[prevTotals]] = await pool.execute(
      `SELECT COALESCE(SUM(usage_count), 0) as total_uses, COUNT(DISTINCT emoji_id) as unique_emojis,
              COUNT(DISTINCT user_id) as active_users
       FROM emoji_usage
       WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ${days * 2 + 1} DAY)
         AND stat_date < DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`,
      [guildId]
    );
    let unusedEmojis = null;
    if (eGuild) {
      const [usedCustom] = await pool.execute(
        `SELECT DISTINCT emoji_id FROM emoji_usage WHERE guild_id = ? AND is_custom = 1 AND ${statCond}`,
        [guildId]
      );
      const used = new Set(usedCustom.map(r => String(r.emoji_id)));
      unusedEmojis = [...eGuild.emojis.cache.values()]
        .filter(e => !used.has(e.id))
        .map(e => ({ id: e.id, name: e.name, animated: !!e.animated }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

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
      totals: {
        total_uses: Number(totals?.total_uses) || 0,
        unique_emojis: Number(totals?.unique_emojis) || 0,
        active_users: Number(totals?.active_users) || 0
      },
      prevTotals: {
        total_uses: Number(prevTotals?.total_uses) || 0,
        unique_emojis: Number(prevTotals?.unique_emojis) || 0,
        active_users: Number(prevTotals?.active_users) || 0
      },
      unusedEmojis,
      days,
      period
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching emoji stats:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch emoji stats' });
  }
});

// Audit log — paginated, filterable
router.get('/manage/:guildId/audit-logs', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { type, user } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const days = Math.min(3650, Math.max(0, parseInt(req.query.days, 10) || 0));
    const offset = (page - 1) * limit;

    let where = 'WHERE guild_id = ?';
    const params = [guildId];
    if (days) { where += ' AND timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)'; params.push(days); }

    if (type) { where += ' AND event_type = ?'; params.push(type); }
    if (user) { where += ' AND (user_id = ? OR target_id = ? OR moderator_id = ?)'; params.push(user, user, user); }

    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);

    const [logs] = await pool.execute(
      `SELECT * FROM audit_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Resolve usernames
    const botClient = global.botManager?.getClientForGuild(guildId) || req.app?.locals?.client;
    const guild = botClient?.guilds?.cache?.get(guildId);
    const userCache = new Map();

    async function resolveName(userId) {
      if (!userId) return null;
      if (userCache.has(userId)) return userCache.get(userId);
      let name = null;
      if (guild) {
        try {
          const m = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
          name = m?.displayName || m?.user?.username || null;
        } catch {}
      }
      if (!name) {
        try { const u = await botClient.users.fetch(userId).catch(() => null); name = u?.username || null; } catch {}
      }
      userCache.set(userId, name);
      return name;
    }

    const enriched = await Promise.all(logs.map(async log => {
      const userName = await resolveName(log.user_id);
      const targetName = await resolveName(log.target_id);
      const moderatorName = await resolveName(log.moderator_id);
      // Avatar + display name + @username for the page (core/user-display.js); the names above are the fallback.
      const bits = (id, name) => (id ? userBits(guild, id, { storedName: name }) : null);
      return {
        ...log, userName, targetName, moderatorName,
        user: bits(log.user_id, userName),
        target: targetName ? bits(log.target_id, targetName) : null,
        moderator: bits(log.moderator_id, moderatorName),
      };
    }));

    // Get available event types for filter dropdown
    const [types] = await pool.execute('SELECT DISTINCT event_type FROM audit_logs WHERE guild_id = ? ORDER BY event_type', [guildId]);

    res.json({
      logs: enriched,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      eventTypes: types.map(t => t.event_type)
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching audit logs:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

export default router;
