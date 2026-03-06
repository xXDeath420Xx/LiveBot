import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/logging - Get logging configuration
router.get('/:guildId/logging', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM logging_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Return default config if doesn't exist
      return res.json({
        guild_id: req.guildId,
        log_channel_id: null,
        enabled_events: []
      });
    }

    // Parse enabled_events JSON
    const config = {
      ...rows[0],
      enabled_events: rows[0].enabled_events ? JSON.parse(rows[0].enabled_events) : []
    };

    res.json(config);
  } catch (error) {
    logger.error('[Logging] Get logging config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch logging configuration' });
  }
});

// PATCH /api/guilds/:guildId/logging - Update logging configuration
router.patch('/:guildId/logging', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { log_channel_id, enabled_events } = req.body;

    // Validate enabled_events if provided
    if (enabled_events !== undefined && !Array.isArray(enabled_events)) {
      return res.status(400).json({ error: 'enabled_events must be an array' });
    }

    // Valid event types
    const validEvents = [
      'message_delete',
      'message_edit',
      'message_bulk_delete',
      'member_join',
      'member_leave',
      'member_update',
      'member_ban',
      'member_unban',
      'role_create',
      'role_delete',
      'role_update',
      'channel_create',
      'channel_delete',
      'channel_update',
      'voice_join',
      'voice_leave',
      'voice_move',
      'server_update',
      'emoji_create',
      'emoji_delete',
      'emoji_update'
    ];

    // Validate event types
    if (enabled_events) {
      for (const event of enabled_events) {
        if (!validEvents.includes(event)) {
          return res.status(400).json({ error: `Invalid event type: ${event}` });
        }
      }
    }

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT * FROM logging_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (existing.length === 0) {
      // Insert new config
      await pool.execute(
        `INSERT INTO logging_config (guild_id, log_channel_id, enabled_events)
         VALUES (?, ?, ?)`,
        [
          req.guildId,
          log_channel_id || null,
          enabled_events ? JSON.stringify(enabled_events) : JSON.stringify([])
        ]
      );
    } else {
      // Update existing config
      const updates = [];
      const values = [];

      if (log_channel_id !== undefined) {
        updates.push('log_channel_id = ?');
        values.push(log_channel_id);
      }
      if (enabled_events !== undefined) {
        updates.push('enabled_events = ?');
        values.push(JSON.stringify(enabled_events));
      }

      if (updates.length > 0) {
        values.push(req.guildId);
        await pool.execute(
          `UPDATE logging_config SET ${updates.join(', ')} WHERE guild_id = ?`,
          values
        );
      }
    }

    // Fetch and return updated config
    const [updated] = await pool.execute(
      'SELECT * FROM logging_config WHERE guild_id = ?',
      [req.guildId]
    );

    res.json({
      success: true,
      message: 'Logging configuration updated',
      config: {
        ...updated[0],
        enabled_events: updated[0].enabled_events ? JSON.parse(updated[0].enabled_events) : []
      }
    });
  } catch (error) {
    logger.error('[Logging] Update logging config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update logging configuration' });
  }
});

export default router;
