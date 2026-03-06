import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// Get confession settings
router.get('/manage/:guildId/confessions', async (req, res) => {
  try {
    const { guildId } = req.params;

    // Get confession config
    const [[config]] = await pool.execute(
      'SELECT * FROM confession_config WHERE guild_id = ?',
      [guildId]
    );

    // Get pending confessions if approval is enabled
    let pendingConfessions = [];
    if (config && config.require_approval) {
      const [confessions] = await pool.execute(
        `SELECT * FROM confessions
         WHERE guild_id = ? AND approved = 0 AND message_id IS NULL
         ORDER BY submitted_at DESC`,
        [guildId]
      );
      pendingConfessions = confessions;
    }

    // Get recent approved confessions
    const [recentConfessions] = await pool.execute(
      `SELECT * FROM confessions
       WHERE guild_id = ? AND approved = 1
       ORDER BY submitted_at DESC
       LIMIT 20`,
      [guildId]
    );

    res.json({
      config: config || {
        enabled: false,
        require_approval: true,
        min_length: 10,
        max_length: 1000
      },
      pendingConfessions,
      recentConfessions
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching confession settings', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch confession settings' });
  }
});

// Update confession settings
router.post('/manage/:guildId/confessions/config', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { enabled, require_approval, channel_id, min_length, max_length } = req.body;

    await pool.execute(
      `INSERT INTO confession_config
       (guild_id, enabled, require_approval, channel_id, min_length, max_length)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       require_approval = VALUES(require_approval),
       channel_id = VALUES(channel_id),
       min_length = VALUES(min_length),
       max_length = VALUES(max_length)`,
      [guildId, enabled, require_approval, channel_id, min_length, max_length]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error updating confession settings', { error: error.message });
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Approve confession
router.post('/manage/:guildId/confessions/:confessionId/approve', async (req, res) => {
  try {
    const { guildId, confessionId } = req.params;

    await pool.execute(
      'UPDATE confessions SET approved = 1 WHERE id = ? AND guild_id = ?',
      [confessionId, guildId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error approving confession', { error: error.message });
    res.status(500).json({ error: 'Failed to approve confession' });
  }
});

// Reject confession
router.post('/manage/:guildId/confessions/:confessionId/reject', async (req, res) => {
  try {
    const { guildId, confessionId } = req.params;

    await pool.execute(
      'UPDATE confessions SET approved = -1 WHERE id = ? AND guild_id = ?',
      [confessionId, guildId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error rejecting confession', { error: error.message });
    res.status(500).json({ error: 'Failed to reject confession' });
  }
});

export default router;
