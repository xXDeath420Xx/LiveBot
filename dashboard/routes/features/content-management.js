import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// ============================================
// STICKY MESSAGES
// ============================================

// Get sticky messages for guild
router.get('/manage/:guildId/sticky', async (req, res) => {
  try {
    const { guildId } = req.params;

    const [stickyMessages] = await pool.execute(
      `SELECT * FROM sticky_messages
       WHERE guild_id = ?
       ORDER BY created_at DESC`,
      [guildId]
    );

    res.json({ stickyMessages });
  } catch (error) {
    logger.error('[ContentManagement] Error fetching sticky messages', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch sticky messages' });
  }
});

// Create/Update sticky message
router.post('/manage/:guildId/sticky', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { channel_id, message_content } = req.body;

    if (!channel_id || !message_content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await pool.execute(
      `INSERT INTO sticky_messages (guild_id, channel_id, message_content, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       message_content = VALUES(message_content),
       last_message_id = NULL`,
      [guildId, channel_id, message_content, req.user?.id || 'dashboard']
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[ContentManagement] Error creating sticky message', { error: error.message });
    res.status(500).json({ error: 'Failed to create sticky message' });
  }
});

// Delete sticky message
router.delete('/manage/:guildId/sticky/:channelId', async (req, res) => {
  try {
    const { guildId, channelId } = req.params;

    await pool.execute(
      'DELETE FROM sticky_messages WHERE guild_id = ? AND channel_id = ?',
      [guildId, channelId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[ContentManagement] Error deleting sticky message', { error: error.message });
    res.status(500).json({ error: 'Failed to delete sticky message' });
  }
});

// ============================================
// AUTO-MEMES
// ============================================

// Get auto-meme settings
router.get('/manage/:guildId/automeme', async (req, res) => {
  try {
    const { guildId } = req.params;

    const [[config]] = await pool.execute(
      'SELECT * FROM auto_meme_config WHERE guild_id = ?',
      [guildId]
    );

    res.json({
      config: config || {
        enabled: false,
        channel_id: null,
        post_interval_hours: 24,
        subreddits: 'memes,dankmemes'
      }
    });
  } catch (error) {
    logger.error('[ContentManagement] Error fetching auto-meme settings', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch auto-meme settings' });
  }
});

// Update auto-meme settings
router.post('/manage/:guildId/automeme', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { enabled, channel_id, post_interval_hours, subreddits } = req.body;

    await pool.execute(
      `INSERT INTO auto_meme_config
       (guild_id, enabled, channel_id, post_interval_hours, subreddits)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       channel_id = VALUES(channel_id),
       post_interval_hours = VALUES(post_interval_hours),
       subreddits = VALUES(subreddits)`,
      [guildId, enabled, channel_id, post_interval_hours, subreddits]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[ContentManagement] Error updating auto-meme settings', { error: error.message });
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================
// TIME CAPSULES
// ============================================

// Get time capsules for guild
router.get('/manage/:guildId/timecapsules', async (req, res) => {
  try {
    const { guildId } = req.params;

    const [capsules] = await pool.execute(
      `SELECT * FROM time_capsules
       WHERE guild_id = ?
       ORDER BY reveal_date DESC
       LIMIT 100`,
      [guildId]
    );

    res.json({ capsules });
  } catch (error) {
    logger.error('[ContentManagement] Error fetching time capsules', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch time capsules' });
  }
});

export default router;
