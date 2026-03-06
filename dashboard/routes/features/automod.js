import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/automod - Get all automod rules
router.get('/:guildId/automod', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY created_at DESC',
      [req.guildId]
    );

    // Parse config JSON for each rule
    const rules = rows.map(rule => ({
      ...rule,
      config: rule.config ? JSON.parse(rule.config) : {},
      ignored_roles: rule.ignored_roles ? JSON.parse(rule.ignored_roles) : [],
      ignored_channels: rule.ignored_channels ? JSON.parse(rule.ignored_channels) : []
    }));

    res.json({
      rules,
      count: rules.length
    });
  } catch (error) {
    logger.error('[Automod] Get automod rules error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch automod rules' });
  }
});

// POST /api/guilds/:guildId/automod - Create new automod rule
router.post('/:guildId/automod', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const {
      filter_type,
      is_enabled,
      action,
      filter_keywords,
      filter_regex,
      ignored_roles,
      ignored_channels,
      delete_message,
      warn_user,
      action_duration_minutes
    } = req.body;

    // Validate required fields
    if (!filter_type) {
      return res.status(400).json({ error: 'Filter type is required' });
    }

    const validFilterTypes = ['spam', 'links', 'invites', 'caps', 'mentions', 'keywords', 'regex'];
    if (!validFilterTypes.includes(filter_type)) {
      return res.status(400).json({ error: 'Invalid filter type' });
    }

    const validActions = ['delete', 'warn', 'timeout', 'kick', 'ban'];
    if (action && !validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action type' });
    }

    // Build config object
    const config = {
      filter_keywords: filter_keywords || [],
      filter_regex: filter_regex || null,
      delete_message: delete_message !== undefined ? delete_message : true,
      warn_user: warn_user !== undefined ? warn_user : false
    };

    // Insert new rule
    const [result] = await pool.execute(
      `INSERT INTO automod_rules (
        guild_id, filter_type, is_enabled, action, config, action_duration_minutes,
        ignored_roles, ignored_channels
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.guildId,
        filter_type,
        is_enabled !== undefined ? is_enabled : true,
        action || 'delete',
        JSON.stringify(config),
        action_duration_minutes || null,
        ignored_roles ? JSON.stringify(ignored_roles) : null,
        ignored_channels ? JSON.stringify(ignored_channels) : null
      ]
    );

    // Fetch and return created rule
    const [created] = await pool.execute(
      'SELECT * FROM automod_rules WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Automod rule created',
      rule: {
        ...created[0],
        config: JSON.parse(created[0].config),
        ignored_roles: created[0].ignored_roles ? JSON.parse(created[0].ignored_roles) : [],
        ignored_channels: created[0].ignored_channels ? JSON.parse(created[0].ignored_channels) : []
      }
    });
  } catch (error) {
    logger.error('[Automod] Create automod rule error', { error: error.message });
    res.status(500).json({ error: 'Failed to create automod rule' });
  }
});

// PATCH /api/guilds/:guildId/automod/:ruleId - Update automod rule
router.patch('/:guildId/automod/:ruleId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { ruleId } = req.params;

    // Verify rule exists and belongs to guild
    const [existing] = await pool.execute(
      'SELECT * FROM automod_rules WHERE id = ? AND guild_id = ?',
      [ruleId, req.guildId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Automod rule not found' });
    }

    const {
      filter_type,
      is_enabled,
      action,
      filter_keywords,
      filter_regex,
      ignored_roles,
      ignored_channels,
      delete_message,
      warn_user,
      action_duration_minutes
    } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];

    if (filter_type !== undefined) {
      const validFilterTypes = ['spam', 'links', 'invites', 'caps', 'mentions', 'keywords', 'regex'];
      if (!validFilterTypes.includes(filter_type)) {
        return res.status(400).json({ error: 'Invalid filter type' });
      }
      updates.push('filter_type = ?');
      values.push(filter_type);
    }
    if (is_enabled !== undefined) {
      updates.push('is_enabled = ?');
      values.push(is_enabled);
    }
    if (action !== undefined) {
      const validActions = ['delete', 'warn', 'timeout', 'kick', 'ban'];
      if (!validActions.includes(action)) {
        return res.status(400).json({ error: 'Invalid action type' });
      }
      updates.push('action = ?');
      values.push(action);
    }

    // Handle config updates
    if (filter_keywords !== undefined || filter_regex !== undefined || delete_message !== undefined || warn_user !== undefined) {
      const currentConfig = existing[0].config ? JSON.parse(existing[0].config) : {};
      const newConfig = {
        ...currentConfig,
        ...(filter_keywords !== undefined && { filter_keywords }),
        ...(filter_regex !== undefined && { filter_regex }),
        ...(delete_message !== undefined && { delete_message }),
        ...(warn_user !== undefined && { warn_user })
      };
      updates.push('config = ?');
      values.push(JSON.stringify(newConfig));
    }

    if (action_duration_minutes !== undefined) {
      updates.push('action_duration_minutes = ?');
      values.push(action_duration_minutes);
    }
    if (ignored_roles !== undefined) {
      updates.push('ignored_roles = ?');
      values.push(ignored_roles ? JSON.stringify(ignored_roles) : null);
    }
    if (ignored_channels !== undefined) {
      updates.push('ignored_channels = ?');
      values.push(ignored_channels ? JSON.stringify(ignored_channels) : null);
    }

    if (updates.length > 0) {
      values.push(ruleId, req.guildId);
      await pool.execute(
        `UPDATE automod_rules SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
        values
      );
    }

    // Fetch and return updated rule
    const [updated] = await pool.execute(
      'SELECT * FROM automod_rules WHERE id = ?',
      [ruleId]
    );

    res.json({
      success: true,
      message: 'Automod rule updated',
      rule: {
        ...updated[0],
        config: JSON.parse(updated[0].config),
        ignored_roles: updated[0].ignored_roles ? JSON.parse(updated[0].ignored_roles) : [],
        ignored_channels: updated[0].ignored_channels ? JSON.parse(updated[0].ignored_channels) : []
      }
    });
  } catch (error) {
    logger.error('[Automod] Update automod rule error', { error: error.message });
    res.status(500).json({ error: 'Failed to update automod rule' });
  }
});

// DELETE /api/guilds/:guildId/automod/:ruleId - Delete automod rule
router.delete('/:guildId/automod/:ruleId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { ruleId } = req.params;

    // Verify rule exists and belongs to guild
    const [existing] = await pool.execute(
      'SELECT * FROM automod_rules WHERE id = ? AND guild_id = ?',
      [ruleId, req.guildId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Automod rule not found' });
    }

    // Delete rule
    await pool.execute(
      'DELETE FROM automod_rules WHERE id = ? AND guild_id = ?',
      [ruleId, req.guildId]
    );

    res.json({
      success: true,
      message: 'Automod rule deleted'
    });
  } catch (error) {
    logger.error('[Automod] Delete automod rule error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete automod rule' });
  }
});

export default router;
