import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// Get moderation infractions for a guild
router.get('/:guildId/moderation/infractions', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [infractions] = await pool.execute(`
      SELECT
        i.*,
        u.username as userName,
        m.username as moderatorName
      FROM infractions i
      LEFT JOIN users u ON i.user_id = u.discord_id
      LEFT JOIN users m ON i.moderator_id = m.discord_id
      WHERE i.guild_id = ?
      ORDER BY i.created_at DESC
      LIMIT 100
    `, [req.guildId]);

    res.json({ infractions });
  } catch (error) {
    logger.error('[Moderation] Get infractions error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch infractions' });
  }
});

// Get moderation statistics
router.get('/:guildId/moderation/stats', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [stats] = await pool.execute(`
      SELECT
        COUNT(*) as totalInfractions,
        SUM(CASE WHEN type = 'warn' THEN 1 ELSE 0 END) as warns,
        SUM(CASE WHEN type = 'timeout' THEN 1 ELSE 0 END) as timeouts,
        SUM(CASE WHEN type = 'kick' THEN 1 ELSE 0 END) as kicks,
        SUM(CASE WHEN type = 'ban' THEN 1 ELSE 0 END) as bans
      FROM infractions
      WHERE guild_id = ?
    `, [req.guildId]);

    res.json({ stats: stats[0] });
  } catch (error) {
    logger.error('[Moderation] Get moderation stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch moderation stats' });
  }
});

export default router;
