import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/leveling - Get leveling configuration
router.get('/:guildId/leveling', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM level_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Return default config if doesn't exist
      return res.json({
        guild_id: req.guildId,
        xp_per_message: 15,
        xp_cooldown_seconds: 60,
        xp_per_voice_minute: 5,
        voice_xp_enabled: true,
        level_up_message: 'Congrats {user}! You reached **Level {level}**!',
        level_up_channel_id: null,
        xp_multiplier_weekends: 1.0,
        xp_multiplier_events: 1.0
      });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Leveling] Get leveling config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch leveling configuration' });
  }
});

// PATCH /api/guilds/:guildId/leveling - Update leveling configuration
router.patch('/:guildId/leveling', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const {
      xp_per_message,
      xp_cooldown_seconds,
      xp_per_voice_minute,
      voice_xp_enabled,
      level_up_message,
      level_up_channel_id,
      xp_multiplier_weekends,
      xp_multiplier_events
    } = req.body;

    // Validate inputs
    if (xp_per_message !== undefined && (xp_per_message < 1 || xp_per_message > 100)) {
      return res.status(400).json({ error: 'XP per message must be between 1 and 100' });
    }

    if (xp_cooldown_seconds !== undefined && (xp_cooldown_seconds < 0 || xp_cooldown_seconds > 600)) {
      return res.status(400).json({ error: 'XP cooldown must be between 0 and 600 seconds' });
    }

    if (xp_per_voice_minute !== undefined && (xp_per_voice_minute < 0 || xp_per_voice_minute > 50)) {
      return res.status(400).json({ error: 'XP per voice minute must be between 0 and 50' });
    }

    if (xp_multiplier_weekends !== undefined && (xp_multiplier_weekends < 0.1 || xp_multiplier_weekends > 10)) {
      return res.status(400).json({ error: 'Weekend multiplier must be between 0.1 and 10' });
    }

    if (xp_multiplier_events !== undefined && (xp_multiplier_events < 0.1 || xp_multiplier_events > 10)) {
      return res.status(400).json({ error: 'Event multiplier must be between 0.1 and 10' });
    }

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT * FROM level_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (existing.length === 0) {
      // Insert new config
      await pool.execute(
        `INSERT INTO level_config (
          guild_id, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute,
          voice_xp_enabled, level_up_message, level_up_channel_id,
          xp_multiplier_weekends, xp_multiplier_events
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.guildId,
          xp_per_message || 15,
          xp_cooldown_seconds || 60,
          xp_per_voice_minute || 5,
          voice_xp_enabled !== undefined ? voice_xp_enabled : true,
          level_up_message || 'Congrats {user}! You reached **Level {level}**!',
          level_up_channel_id || null,
          xp_multiplier_weekends || 1.0,
          xp_multiplier_events || 1.0
        ]
      );
    } else {
      // Update existing config
      const updates = [];
      const values = [];

      if (xp_per_message !== undefined) {
        updates.push('xp_per_message = ?');
        values.push(xp_per_message);
      }
      if (xp_cooldown_seconds !== undefined) {
        updates.push('xp_cooldown_seconds = ?');
        values.push(xp_cooldown_seconds);
      }
      if (xp_per_voice_minute !== undefined) {
        updates.push('xp_per_voice_minute = ?');
        values.push(xp_per_voice_minute);
      }
      if (voice_xp_enabled !== undefined) {
        updates.push('voice_xp_enabled = ?');
        values.push(voice_xp_enabled);
      }
      if (level_up_message !== undefined) {
        updates.push('level_up_message = ?');
        values.push(level_up_message);
      }
      if (level_up_channel_id !== undefined) {
        updates.push('level_up_channel_id = ?');
        values.push(level_up_channel_id);
      }
      if (xp_multiplier_weekends !== undefined) {
        updates.push('xp_multiplier_weekends = ?');
        values.push(xp_multiplier_weekends);
      }
      if (xp_multiplier_events !== undefined) {
        updates.push('xp_multiplier_events = ?');
        values.push(xp_multiplier_events);
      }

      if (updates.length > 0) {
        values.push(req.guildId);
        await pool.execute(
          `UPDATE level_config SET ${updates.join(', ')} WHERE guild_id = ?`,
          values
        );
      }
    }

    // Fetch and return updated config
    const [updated] = await pool.execute(
      'SELECT * FROM level_config WHERE guild_id = ?',
      [req.guildId]
    );

    res.json({
      success: true,
      message: 'Leveling configuration updated',
      config: updated[0]
    });
  } catch (error) {
    logger.error('[Leveling] Update leveling config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update leveling configuration' });
  }
});

export default router;
