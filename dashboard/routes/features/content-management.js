import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import configCache from '../../../utils/configCache.js';

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
    const { channel_id } = req.body;
    const message_content = typeof req.body.message_content === 'string' ? req.body.message_content.trim() : '';

    if (!channel_id || !message_content) {
      return res.status(400).json({ error: 'Pick a channel and write the message.' });
    }
    // The bot reposts this as a plain message, so it has Discord's 2,000-character limit.
    if (message_content.length > 2000) {
      return res.status(400).json({ error: 'The message can be at most 2,000 characters.' });
    }
    // The channel must be a text or announcement channel in this server.
    if (!/^\d{15,25}$/.test(String(channel_id))) {
      return res.status(400).json({ error: 'Invalid channel.' });
    }
    const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
    if (guild) {
      const channel = guild.channels.cache.get(String(channel_id));
      if (!channel || ![0, 5].includes(channel.type)) {
        return res.status(400).json({ error: 'Pick a text or announcement channel in this server.' });
      }
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

    // The page speaks enabled/subreddits; the table (and core/auto-meme-manager.js) use is_enabled/subreddit.
    res.json({
      config: config ? {
        ...config,
        enabled: !!config.is_enabled,
        subreddits: config.subreddit || 'memes'
      } : {
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

    // Subreddit names only (letters, digits, underscore), at most 10, stored comma-separated.
    const list = [...new Set(String(subreddits || '').split(',')
      .map(s => s.trim().replace(/^r\//i, ''))
      .filter(s => /^[A-Za-z0-9_]{2,21}$/.test(s)))].slice(0, 10);
    const interval = Math.min(168, Math.max(1, parseInt(post_interval_hours, 10) || 24));
    const channelId = /^\d{5,25}$/.test(String(channel_id || '')) ? String(channel_id) : null;
    const isEnabled = enabled === true || enabled === 'true' || enabled === 'on' || enabled === 1 || enabled === '1';
    if (isEnabled && (!channelId || !list.length)) {
      return res.status(400).json({ error: 'Pick a channel and at least one valid subreddit' });
    }
    if (channelId) {
      const amGuild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
      const amChannel = amGuild?.channels.cache.get(channelId);
      if (amGuild && (!amChannel || ![0, 5].includes(amChannel.type))) {
        return res.status(400).json({ error: 'Pick a text or announcement channel in this server.' });
      }
    }

    await pool.execute(
      `INSERT INTO auto_meme_config
       (guild_id, is_enabled, channel_id, post_interval_hours, subreddit)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       is_enabled = VALUES(is_enabled),
       channel_id = VALUES(channel_id),
       post_interval_hours = VALUES(post_interval_hours),
       subreddit = VALUES(subreddit)`,
      [guildId, isEnabled ? 1 : 0, channelId, interval, (list.length ? list : ['memes']).join(',')]
    );
    // core/auto-meme-manager.js reads this through configCache.
    configCache.invalidate('auto_meme_config', guildId);

    res.json({ success: true });
  } catch (error) {
    logger.error('[ContentManagement] Error updating auto-meme settings', { error: error.message });
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Post one meme now, from the channel and subreddits in the form (saved or not). Uses the same
// fetch and embed as the scheduled posts (core/auto-meme-manager.js postManualMeme).
router.post('/manage/:guildId/automeme/test', async (req, res) => {
  try {
    const { guildId } = req.params;
    const channelId = /^\d{5,25}$/.test(String(req.body?.channel_id || '')) ? String(req.body.channel_id) : null;
    const list = [...new Set(String(req.body?.subreddits || '').split(',')
      .map(s => s.trim().replace(/^r\//i, ''))
      .filter(s => /^[A-Za-z0-9_]{2,21}$/.test(s)))].slice(0, 10);
    if (!channelId) return res.status(400).json({ error: 'Choose a channel first.' });
    if (!list.length) return res.status(400).json({ error: 'Add at least one subreddit.' });
    const client = global.botManager?.getClientForGuild?.(guildId);
    const channel = client?.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    if (!channel || ![0, 5].includes(channel.type)) {
      return res.status(400).json({ error: 'Pick a text or announcement channel in this server.' });
    }
    const { default: AutoMemeManager } = await import('../../../core/auto-meme-manager.js');
    const subreddit = list[Math.floor(Math.random() * list.length)];
    await new AutoMemeManager(client).postManualMeme(guildId, channelId, subreddit);
    res.json({ success: true, subreddit });
  } catch (error) {
    logger.warn('[ContentManagement] Auto-meme test post failed', { error: error.message });
    const msg = error.message === 'No meme found'
      ? 'No new image post was found in that subreddit just now. Try again or add another subreddit.'
      : 'The bot could not post there. Check it can view the channel, send messages and embed links.';
    res.status(400).json({ error: msg });
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

    // Names for the page (the bot that serves this guild); ids only when it cannot see them.
    const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || null;
    const named = capsules.map((c) => {
      const member = guild?.members.cache.get(String(c.creator_id));
      const user = member?.user || guild?.client?.users.cache.get(String(c.creator_id));
      return {
        ...c,
        creator_name: member?.displayName || user?.username || null,
        channel_name: guild?.channels.cache.get(String(c.channel_id))?.name || null,
      };
    });

    res.json({ capsules: named });
  } catch (error) {
    logger.error('[ContentManagement] Error fetching time capsules', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch time capsules' });
  }
});

// Delete a capsule that has not been posted yet (behind /manage/:guildId checkAuth + checkGuildAdmin).
router.delete('/manage/:guildId/timecapsules/:id', async (req, res) => {
  try {
    const { guildId } = req.params;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid capsule' });
    const [result] = await pool.execute(
      'DELETE FROM time_capsules WHERE id = ? AND guild_id = ? AND revealed = 0',
      [id, guildId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'That capsule was not found or has already been posted.' });
    logger.info('[ContentManagement] Time capsule deleted from the dashboard', { guildId, id, by: req.user?.id });
    res.json({ success: true });
  } catch (error) {
    logger.error('[ContentManagement] Error deleting time capsule', { error: error.message });
    res.status(500).json({ error: 'Failed to delete the capsule' });
  }
});

export default router;
