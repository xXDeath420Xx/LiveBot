import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/tickets - Get ticket configuration
router.get('/:guildId/tickets', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM ticket_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Return default config if doesn't exist
      return res.json({
        guild_id: req.guildId,
        panel_channel_id: null,
        panel_message_id: null,
        ticket_category_id: null,
        support_role_id: null,
        log_channel_id: null,
        auto_close_hours: null,
        use_threads: false,
        thread_parent_channel_id: null,
        form_id: null
      });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Tickets] Get ticket config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch ticket configuration' });
  }
});

// PATCH /api/guilds/:guildId/tickets - Update ticket configuration
router.patch('/:guildId/tickets', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const {
      panel_channel_id,
      panel_message_id,
      ticket_category_id,
      support_role_id,
      log_channel_id,
      auto_close_hours,
      use_threads,
      thread_parent_channel_id,
      form_id
    } = req.body;

    // Validate inputs
    if (auto_close_hours !== undefined && auto_close_hours !== null && (auto_close_hours < 1 || auto_close_hours > 720)) {
      return res.status(400).json({ error: 'Auto close hours must be between 1 and 720 (30 days)' });
    }

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT * FROM ticket_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (existing.length === 0) {
      // Insert new config
      await pool.execute(
        `INSERT INTO ticket_config (
          guild_id, panel_channel_id, panel_message_id, ticket_category_id,
          support_role_id, log_channel_id, auto_close_hours, use_threads,
          thread_parent_channel_id, form_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.guildId,
          panel_channel_id || null,
          panel_message_id || null,
          ticket_category_id || null,
          support_role_id || null,
          log_channel_id || null,
          auto_close_hours || null,
          use_threads !== undefined ? use_threads : false,
          thread_parent_channel_id || null,
          form_id || null
        ]
      );
    } else {
      // Update existing config
      const updates = [];
      const values = [];

      if (panel_channel_id !== undefined) {
        updates.push('panel_channel_id = ?');
        values.push(panel_channel_id);
      }
      if (panel_message_id !== undefined) {
        updates.push('panel_message_id = ?');
        values.push(panel_message_id);
      }
      if (ticket_category_id !== undefined) {
        updates.push('ticket_category_id = ?');
        values.push(ticket_category_id);
      }
      if (support_role_id !== undefined) {
        updates.push('support_role_id = ?');
        values.push(support_role_id);
      }
      if (log_channel_id !== undefined) {
        updates.push('log_channel_id = ?');
        values.push(log_channel_id);
      }
      if (auto_close_hours !== undefined) {
        updates.push('auto_close_hours = ?');
        values.push(auto_close_hours);
      }
      if (use_threads !== undefined) {
        updates.push('use_threads = ?');
        values.push(use_threads);
      }
      if (thread_parent_channel_id !== undefined) {
        updates.push('thread_parent_channel_id = ?');
        values.push(thread_parent_channel_id);
      }
      if (form_id !== undefined) {
        updates.push('form_id = ?');
        values.push(form_id);
      }

      if (updates.length > 0) {
        values.push(req.guildId);
        await pool.execute(
          `UPDATE ticket_config SET ${updates.join(', ')} WHERE guild_id = ?`,
          values
        );
      }
    }

    // Fetch and return updated config
    const [updated] = await pool.execute(
      'SELECT * FROM ticket_config WHERE guild_id = ?',
      [req.guildId]
    );

    res.json({
      success: true,
      message: 'Ticket configuration updated',
      config: updated[0]
    });
  } catch (error) {
    logger.error('[Tickets] Update ticket config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update ticket configuration' });
  }
});

export default router;
