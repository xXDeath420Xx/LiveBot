import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

/**
 * Resolve Discord usernames + avatars for a set of user IDs in a guild, and
 * report which of them are confirmed-present members.
 *
 * Returns { info, present }:
 *  - info: Map<userId, { username, avatar }> for resolved members.
 *  - present: Set<userId> of users we can KEEP — confirmed current members,
 *    plus (deliberately) anyone whose membership we could NOT reliably check
 *    (bot not loaded, or a fetch error). `keep-on-uncertainty` guarantees we
 *    never wipe the board over a transient failure; we only drop users we can
 *    positively confirm have left.
 */
async function resolveMembers(guildId, userIds) {
  const info = new Map();
  const present = new Set();
  const unique = [...new Set(userIds)];

  const botClient = global.botManager?.getClientForGuild?.(guildId);
  const guild = botClient?.guilds?.cache?.get(guildId);
  if (!guild) {
    // Can't determine membership at all — keep everyone (don't filter).
    for (const id of unique) present.add(id);
    return { info, present };
  }

  const misses = [];
  const record = (id, m) => {
    present.add(id);
    info.set(id, {
      username: m.displayName || m.user?.username || null,
      avatar: m.user?.displayAvatarURL?.({ size: 64 }) || null,
    });
  };

  for (const id of unique) {
    const m = guild.members.cache.get(id);
    if (m) record(id, m); else misses.push(id);
  }

  if (misses.length) {
    try {
      const fetched = await guild.members.fetch({ user: misses, time: 10000 });
      for (const [id, m] of fetched) record(id, m);
      // Any miss NOT returned by a SUCCESSFUL fetch is a confirmed non-member:
      // intentionally left out of `present` so it gets filtered from the lists.
    } catch {
      // Fetch failed — membership unknown for these. Keep them to be safe.
      for (const id of misses) present.add(id);
    }
  }

  return { info, present };
}

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
       LIMIT 50`,
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

    // Resolve usernames + avatars and confirm membership, so the lists show
    // real current members (not raw IDs, and not users who've left the guild).
    const { info, present } = await resolveMembers(
      guildId,
      [...topUsers.map(u => u.user_id), ...recentAchievements.map(r => r.user_id)]
    );
    const decorate = (row) => ({ ...row, ...(info.get(row.user_id) || { username: null, avatar: null }) });
    const inGuild = (row) => present.has(row.user_id);

    res.json({
      config: config || null,
      achievements,
      // Drop users no longer in the guild, then trim the leaderboard to top 25.
      topUsers: topUsers.filter(inGuild).map(decorate).slice(0, 25),
      recentAchievements: recentAchievements.filter(inGuild).map(decorate),
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
