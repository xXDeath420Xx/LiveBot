import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/reaction-roles - Get all reaction role panels and mappings
router.get('/:guildId/reaction-roles', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    // Get all reaction role panels
    const [panels] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE guild_id = ? ORDER BY created_at DESC',
      [req.guildId]
    );

    // Get all reaction role mappings for each panel
    const panelsWithRoles = await Promise.all(
      panels.map(async (panel) => {
        const [roles] = await pool.execute(
          'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY created_at ASC',
          [panel.id]
        );
        return {
          ...panel,
          roles
        };
      })
    );

    res.json({
      panels: panelsWithRoles,
      count: panelsWithRoles.length
    });
  } catch (error) {
    logger.error('[ReactionRoles] Get reaction roles error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch reaction roles' });
  }
});

// POST /api/guilds/:guildId/reaction-roles - Create new reaction role panel
router.post('/:guildId/reaction-roles', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const {
      channel_id,
      message_id,
      panel_name,
      description,
      embed_color,
      thumbnail_url,
      image_url,
      panel_mode,
      interaction_type,
      max_selections,
      placeholder_text,
      roles
    } = req.body;

    // Validate required fields
    if (!channel_id) {
      return res.status(400).json({ error: 'Channel ID is required' });
    }

    if (!panel_name) {
      return res.status(400).json({ error: 'Panel name is required' });
    }

    // Validate roles array
    if (!roles || !Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'Roles must be a non-empty array' });
    }

    // Validate individual role entries
    for (const role of roles) {
      if (!role.role_id || !role.emoji_id) {
        return res.status(400).json({ error: 'Each role must have a role_id and emoji_id' });
      }
    }

    // Validate panel_mode
    const validModes = ['normal', 'unique'];
    const mode = panel_mode || 'normal';
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: 'Invalid panel_mode. Must be "normal" or "unique"' });
    }

    // Validate interaction_type
    const validTypes = ['button', 'select_menu', 'reaction'];
    const type = interaction_type || 'button';
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid interaction_type. Must be "button", "select_menu", or "reaction"' });
    }

    // Check if panel already exists for this message
    if (message_id) {
      const [existing] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE guild_id = ? AND message_id = ?',
        [req.guildId, message_id]
      );

      if (existing.length > 0) {
        return res.status(400).json({ error: 'Reaction role panel already exists for this message' });
      }
    }

    // Insert new panel
    const [result] = await pool.execute(
      `INSERT INTO reaction_role_panels (
        guild_id, channel_id, message_id, panel_name, description, embed_color, thumbnail_url, image_url, panel_mode, interaction_type, max_selections, placeholder_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.guildId,
        channel_id,
        message_id || 'PENDING',
        panel_name,
        description || null,
        embed_color || '#a78bfa',
        thumbnail_url || null,
        image_url || null,
        mode,
        type,
        max_selections || 1,
        placeholder_text || 'Choose your roles'
      ]
    );

    const panelId = result.insertId;

    // Insert role mappings
    const roleValues = roles.map(role => [
      panelId,
      role.role_id,
      role.emoji_id,
      role.description || null
    ]);

    await pool.query(
      `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, description) VALUES ?`,
      [roleValues]
    );

    // Fetch and return created panel with roles
    const [created] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE id = ?',
      [panelId]
    );

    const [createdRoles] = await pool.execute(
      'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
      [panelId]
    );

    res.status(201).json({
      success: true,
      message: 'Reaction role panel created',
      panel: {
        ...created[0],
        roles: createdRoles
      }
    });
  } catch (error) {
    logger.error('[ReactionRoles] Create reaction role panel error', { error: error.message });
    res.status(500).json({ error: 'Failed to create reaction role panel' });
  }
});

// PATCH /api/guilds/:guildId/reaction-roles/:panelId - Update reaction role panel
router.patch('/:guildId/reaction-roles/:panelId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { panelId } = req.params;

    // Verify panel exists and belongs to guild
    const [existing] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
      [panelId, req.guildId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Reaction role panel not found' });
    }

    const {
      panel_name,
      description,
      embed_color,
      thumbnail_url,
      image_url,
      panel_mode,
      interaction_type,
      max_selections,
      placeholder_text,
      message_id,
      roles
    } = req.body;

    // Build dynamic update query for panel
    const updates = [];
    const values = [];

    if (panel_name !== undefined) {
      updates.push('panel_name = ?');
      values.push(panel_name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (embed_color !== undefined) {
      updates.push('embed_color = ?');
      values.push(embed_color);
    }
    if (thumbnail_url !== undefined) {
      updates.push('thumbnail_url = ?');
      values.push(thumbnail_url);
    }
    if (image_url !== undefined) {
      updates.push('image_url = ?');
      values.push(image_url);
    }
    if (panel_mode !== undefined) {
      const validModes = ['normal', 'unique'];
      if (!validModes.includes(panel_mode)) {
        return res.status(400).json({ error: 'Invalid panel_mode. Must be "normal" or "unique"' });
      }
      updates.push('panel_mode = ?');
      values.push(panel_mode);
    }
    if (interaction_type !== undefined) {
      const validTypes = ['button', 'select_menu', 'reaction'];
      if (!validTypes.includes(interaction_type)) {
        return res.status(400).json({ error: 'Invalid interaction_type. Must be "button", "select_menu", or "reaction"' });
      }
      updates.push('interaction_type = ?');
      values.push(interaction_type);
    }
    if (max_selections !== undefined) {
      updates.push('max_selections = ?');
      values.push(max_selections);
    }
    if (placeholder_text !== undefined) {
      updates.push('placeholder_text = ?');
      values.push(placeholder_text);
    }
    if (message_id !== undefined) {
      updates.push('message_id = ?');
      values.push(message_id);
    }

    if (updates.length > 0) {
      values.push(panelId, req.guildId);
      await pool.execute(
        `UPDATE reaction_role_panels SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
        values
      );
    }

    // Update roles if provided
    if (roles && Array.isArray(roles)) {
      // Delete existing roles for this panel
      await pool.execute(
        'DELETE FROM reaction_role_mappings WHERE panel_id = ?',
        [panelId]
      );

      // Insert new roles
      if (roles.length > 0) {
        const roleValues = roles.map(role => [
          panelId,
          role.role_id,
          role.emoji_id,
          role.description || null
        ]);

        await pool.query(
          `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, description) VALUES ?`,
          [roleValues]
        );
      }
    }

    // Fetch and return updated panel with roles
    const [updated] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE id = ?',
      [panelId]
    );

    const [updatedRoles] = await pool.execute(
      'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
      [panelId]
    );

    res.json({
      success: true,
      message: 'Reaction role panel updated',
      panel: {
        ...updated[0],
        roles: updatedRoles
      }
    });
  } catch (error) {
    logger.error('[ReactionRoles] Update reaction role panel error', { error: error.message });
    res.status(500).json({ error: 'Failed to update reaction role panel' });
  }
});

// POST /api/guilds/:guildId/reaction-roles/:panelId/post - Post panel to Discord
router.post('/:guildId/reaction-roles/:panelId/post', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { panelId } = req.params;

    // Verify panel exists and belongs to guild
    const [panels] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
      [panelId, req.guildId]
    );

    if (panels.length === 0) {
      return res.status(404).json({ error: 'Reaction role panel not found' });
    }

    const panel = panels[0];

    // Get role mappings
    const [roles] = await pool.execute(
      'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
      [panelId]
    );

    if (roles.length === 0) {
      return res.status(400).json({ error: 'Cannot post panel without roles' });
    }

    // Get bot client for this guild
    if (!global.botManager) {
      return res.status(503).json({ error: 'Bot manager not available' });
    }

    const botClient = global.botManager.getClientForGuild(req.guildId);
    if (!botClient) {
      return res.status(503).json({ error: 'Bot client not available for this guild' });
    }

    // Get reaction role manager
    const reactionRoleManager = botClient.reactionRoleManager;
    if (!reactionRoleManager) {
      return res.status(503).json({ error: 'Reaction role manager not initialized' });
    }

    // Format roles for the manager
    const formattedRoles = roles.map(role => ({
      roleId: role.role_id,
      emoji: role.emoji_id,
      label: role.description || 'Role',
      description: role.description
    }));

    // Create the panel in Discord with custom embed data
    const embedData = {
      title: panel.panel_name,
      description: panel.description || 'Select your roles below!',
      color: panel.embed_color || '#a78bfa',
      thumbnail: panel.thumbnail_url || null,
      image: panel.image_url || null
    };

    const result = await reactionRoleManager.createReactionPanel(
      req.guildId,
      panel.channel_id,
      panel.panel_name,
      panel.panel_mode || 'normal',
      panel.interaction_type || 'button',
      formattedRoles,
      embedData
    );

    if (!result || !result.messageId) {
      return res.status(500).json({ error: 'Failed to post panel to Discord' });
    }

    // Update database with actual message ID
    await pool.execute(
      'UPDATE reaction_role_panels SET message_id = ? WHERE id = ?',
      [result.messageId, panelId]
    );

    // Fetch updated panel
    const [updated] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE id = ?',
      [panelId]
    );

    res.json({
      success: true,
      message: 'Reaction role panel posted to Discord',
      panel: {
        ...updated[0],
        roles
      },
      messageId: result.messageId
    });
  } catch (error) {
    logger.error('[ReactionRoles] Post reaction role panel error', { error: error.message });
    res.status(500).json({
      error: 'Failed to post reaction role panel',
      details: error.message
    });
  }
});

// DELETE /api/guilds/:guildId/reaction-roles/:panelId - Delete reaction role panel
router.delete('/:guildId/reaction-roles/:panelId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { panelId } = req.params;

    // Verify panel exists and belongs to guild
    const [existing] = await pool.execute(
      'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
      [panelId, req.guildId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Reaction role panel not found' });
    }

    // Delete associated roles first (if not handled by CASCADE)
    await pool.execute(
      'DELETE FROM reaction_role_mappings WHERE panel_id = ?',
      [panelId]
    );

    // Delete panel
    await pool.execute(
      'DELETE FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
      [panelId, req.guildId]
    );

    res.json({
      success: true,
      message: 'Reaction role panel deleted'
    });
  } catch (error) {
    logger.error('[ReactionRoles] Delete reaction role panel error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete reaction role panel' });
  }
});

export default router;
