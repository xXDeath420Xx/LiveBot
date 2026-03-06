import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/welcome - Get welcome configuration
router.get('/:guildId/welcome', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM welcome_settings WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Return default config if doesn't exist
      return res.json({
        guild_id: req.guildId,
        channel_id: null,
        message: 'Welcome {user} to {server}!',
        auto_role_id: null
      });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Welcome] Get welcome config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch welcome configuration' });
  }
});

// PATCH /api/guilds/:guildId/welcome - Update welcome configuration
router.patch('/:guildId/welcome', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { channel_id, message, auto_role_id } = req.body;

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT * FROM welcome_settings WHERE guild_id = ?',
      [req.guildId]
    );

    if (existing.length === 0) {
      // Insert new config
      await pool.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message, auto_role_id)
         VALUES (?, ?, ?, ?)`,
        [
          req.guildId,
          channel_id || null,
          message || 'Welcome {user} to {server}!',
          auto_role_id || null
        ]
      );
    } else {
      // Update existing config
      const updates = [];
      const values = [];

      if (channel_id !== undefined) {
        updates.push('channel_id = ?');
        values.push(channel_id);
      }
      if (message !== undefined) {
        updates.push('message = ?');
        values.push(message);
      }
      if (auto_role_id !== undefined) {
        updates.push('auto_role_id = ?');
        values.push(auto_role_id);
      }

      if (updates.length > 0) {
        values.push(req.guildId);
        await pool.execute(
          `UPDATE welcome_settings SET ${updates.join(', ')} WHERE guild_id = ?`,
          values
        );
      }
    }

    // Fetch and return updated config
    const [updated] = await pool.execute(
      'SELECT * FROM welcome_settings WHERE guild_id = ?',
      [req.guildId]
    );

    res.json({
      success: true,
      message: 'Welcome configuration updated',
      config: updated[0]
    });
  } catch (error) {
    logger.error('[Welcome] Update welcome config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update welcome configuration' });
  }
});

export default router;
