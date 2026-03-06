import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// Get starboard configuration
router.get('/:guildId/starboard', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM starboard_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Return default config
      return res.json({
        guild_id: req.guildId,
        channel_id: null,
        star_threshold: 3
      });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Starboard] Get starboard config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch starboard configuration' });
  }
});

// Update starboard configuration
router.put('/:guildId/starboard', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { channel_id, star_threshold } = req.body;

    // Validation
    if (star_threshold && (star_threshold < 1 || star_threshold > 50)) {
      return res.status(400).json({ error: 'Threshold must be between 1 and 50' });
    }

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT guild_id FROM starboard_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (existing.length === 0) {
      // Insert new config
      await pool.execute(
        `INSERT INTO starboard_config (guild_id, channel_id, star_threshold)
         VALUES (?, ?, ?)`,
        [
          req.guildId,
          channel_id || null,
          star_threshold || 3
        ]
      );
    } else {
      // Update existing config
      const updates = [];
      const values = [];

      if (channel_id !== undefined) {
        updates.push('channel_id = ?');
        values.push(channel_id || null);
      }
      if (star_threshold !== undefined) {
        updates.push('star_threshold = ?');
        values.push(star_threshold);
      }

      if (updates.length > 0) {
        values.push(req.guildId);
        await pool.execute(
          `UPDATE starboard_config SET ${updates.join(', ')} WHERE guild_id = ?`,
          values
        );
      }
    }

    // Fetch and return updated config
    const [updated] = await pool.execute(
      'SELECT * FROM starboard_config WHERE guild_id = ?',
      [req.guildId]
    );

    res.json({
      success: true,
      message: 'Starboard configuration updated',
      config: updated[0] || { guild_id: req.guildId, channel_id: null, star_threshold: 3 }
    });
  } catch (error) {
    logger.error('[Starboard] Update starboard config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update starboard configuration' });
  }
});

export default router;
