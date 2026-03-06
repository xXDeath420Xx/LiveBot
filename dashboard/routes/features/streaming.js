import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/streaming/subscriptions - Get all streaming subscriptions
router.get('/:guildId/streaming/subscriptions', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM subscriptions WHERE guild_id = ? ORDER BY created_at DESC',
      [req.guildId]
    );

    res.json({
      subscriptions: rows,
      count: rows.length
    });
  } catch (error) {
    logger.error('[Streaming] Get streaming subscriptions error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch streaming subscriptions' });
  }
});

// POST /api/guilds/:guildId/streaming/subscriptions - Create new streaming subscription
router.post('/:guildId/streaming/subscriptions', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const {
      platform,
      username,
      channel_id,
      role_to_mention,
      custom_message,
      enabled
    } = req.body;

    // Validate required fields
    if (!platform) {
      return res.status(400).json({ error: 'Platform is required' });
    }

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    if (!channel_id) {
      return res.status(400).json({ error: 'Channel ID is required' });
    }

    const validPlatforms = ['twitch', 'youtube', 'kick'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid platform. Must be one of: twitch, youtube, kick' });
    }

    // Check if subscription already exists for this streamer in this specific channel
    // Allow same streamer in different channels, but prevent duplicates in same channel
    const [existing] = await pool.execute(
      `SELECT s.subscription_id
       FROM subscriptions sub
       JOIN streamers s ON sub.streamer_id = s.streamer_id
       WHERE sub.guild_id = ? AND s.platform = ? AND s.username = ? AND sub.announcement_channel_id = ?`,
      [req.guildId, platform.toLowerCase(), username, channel_id]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: 'This streamer is already being announced in that channel. Duplicate subscriptions for the same streamer in the same channel are not allowed.'
      });
    }

    // Insert new subscription
    const [result] = await pool.execute(
      `INSERT INTO subscriptions (
        guild_id, platform, username, channel_id, role_to_mention, custom_message, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.guildId,
        platform.toLowerCase(),
        username,
        channel_id,
        role_to_mention || null,
        custom_message || '{streamer} is now live on {platform}! {url}',
        enabled !== undefined ? enabled : true
      ]
    );

    // Fetch and return created subscription
    const [created] = await pool.execute(
      'SELECT * FROM subscriptions WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Streaming subscription created',
      subscription: created[0]
    });
  } catch (error) {
    logger.error('[Streaming] Create streaming subscription error', { error: error.message });
    res.status(500).json({ error: 'Failed to create streaming subscription' });
  }
});

// PATCH /api/guilds/:guildId/streaming/subscriptions/:subscriptionId - Update streaming subscription
router.patch('/:guildId/streaming/subscriptions/:subscriptionId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    // Verify subscription exists and belongs to guild
    const [existing] = await pool.execute(
      'SELECT * FROM subscriptions WHERE id = ? AND guild_id = ?',
      [subscriptionId, req.guildId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Streaming subscription not found' });
    }

    const {
      channel_id,
      role_to_mention,
      custom_message,
      enabled
    } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];

    if (channel_id !== undefined) {
      // Check for duplicate subscription with same channel
      const currentSubscription = existing[0];
      const [duplicate] = await pool.execute(
        `SELECT subscription_id FROM subscriptions
         WHERE streamer_id = ? AND guild_id = ? AND announcement_channel_id = ? AND subscription_id != ?`,
        [currentSubscription.streamer_id, req.guildId, channel_id, subscriptionId]
      );

      if (duplicate.length > 0) {
        return res.status(400).json({
          error: 'This streamer is already being announced in that channel. Duplicate subscriptions for the same streamer in the same channel are not allowed.'
        });
      }

      updates.push('announcement_channel_id = ?');
      values.push(channel_id);
    }
    if (role_to_mention !== undefined) {
      updates.push('role_to_mention = ?');
      values.push(role_to_mention);
    }
    if (custom_message !== undefined) {
      updates.push('custom_message = ?');
      values.push(custom_message);
    }
    if (enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(enabled);
    }

    if (updates.length > 0) {
      values.push(subscriptionId, req.guildId);
      await pool.execute(
        `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
        values
      );
    }

    // Fetch and return updated subscription
    const [updated] = await pool.execute(
      'SELECT * FROM subscriptions WHERE id = ?',
      [subscriptionId]
    );

    res.json({
      success: true,
      message: 'Streaming subscription updated',
      subscription: updated[0]
    });
  } catch (error) {
    logger.error('[Streaming] Update streaming subscription error', { error: error.message });
    res.status(500).json({ error: 'Failed to update streaming subscription' });
  }
});

// POST /api/guilds/:guildId/streaming/subscriptions/bulk-update - Bulk update streaming subscriptions
router.post('/:guildId/streaming/subscriptions/bulk-update', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { subscriptionIds, announcement_channel_id, role_to_mention, custom_message } = req.body;

    if (!Array.isArray(subscriptionIds) || subscriptionIds.length === 0) {
      return res.status(400).json({ error: 'subscriptionIds must be a non-empty array' });
    }

    // Validate all subscription IDs belong to this guild
    const placeholders = subscriptionIds.map(() => '?').join(',');
    const [owned] = await pool.execute(
      `SELECT id FROM subscriptions WHERE id IN (${placeholders}) AND guild_id = ?`,
      [...subscriptionIds, req.guildId]
    );

    if (owned.length !== subscriptionIds.length) {
      return res.status(403).json({ error: 'Some subscription IDs do not belong to this guild' });
    }

    // Build dynamic update query — only update provided fields
    const updates = [];
    const values = [];

    if (announcement_channel_id !== undefined) {
      updates.push('announcement_channel_id = ?');
      values.push(announcement_channel_id);
    }
    if (role_to_mention !== undefined) {
      updates.push('role_to_mention = ?');
      values.push(role_to_mention);
    }
    if (custom_message !== undefined) {
      updates.push('custom_message = ?');
      values.push(custom_message);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update. Provide at least one of: announcement_channel_id, role_to_mention, custom_message' });
    }

    values.push(...subscriptionIds, req.guildId);
    const [result] = await pool.execute(
      `UPDATE subscriptions SET ${updates.join(', ')} WHERE id IN (${placeholders}) AND guild_id = ?`,
      values
    );

    res.json({
      success: true,
      message: `Updated ${result.affectedRows} subscription(s)`,
      updatedCount: result.affectedRows
    });
  } catch (error) {
    logger.error('[Streaming] Bulk update subscriptions error', { error: error.message });
    res.status(500).json({ error: 'Failed to bulk update subscriptions' });
  }
});

// DELETE /api/guilds/:guildId/streaming/subscriptions/:subscriptionId - Delete streaming subscription
router.delete('/:guildId/streaming/subscriptions/:subscriptionId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    // Verify subscription exists and belongs to guild
    const [existing] = await pool.execute(
      'SELECT * FROM subscriptions WHERE id = ? AND guild_id = ?',
      [subscriptionId, req.guildId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Streaming subscription not found' });
    }

    // Delete subscription
    await pool.execute(
      'DELETE FROM subscriptions WHERE id = ? AND guild_id = ?',
      [subscriptionId, req.guildId]
    );

    res.json({
      success: true,
      message: 'Streaming subscription deleted'
    });
  } catch (error) {
    logger.error('[Streaming] Delete streaming subscription error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete streaming subscription' });
  }
});

export default router;
