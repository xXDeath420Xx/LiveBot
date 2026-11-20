import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// POST /manage/:guildId/update-tempchannels - Update temporary voice channels configuration
router.post('/:guildId/update-tempchannels', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    logger.debug('[Utilities] POST /:guildId/update-tempchannels hit!');
    const { creator_channel_id, category_id, naming_template } = req.body;

    // Validate inputs
    if (!creator_channel_id || !category_id) {
      return res.status(400).json({
        error: 'Creator channel and category are required'
      });
    }

    // One row per creator channel (PK guild_id + creator_channel_id): add or update this one only. It used to
    // set every row of the server to this creator channel (H-810).
    await pool.execute(
      `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), naming_template = VALUES(naming_template)`,
      [req.guildId, creator_channel_id, category_id, naming_template || "{user}'s Channel"]
    );

    // Redirect back to manage page
    res.redirect(`/manage/${req.guildId}?tab=utilities&success=true`);
  } catch (error) {
    logger.error('[Utilities] Update temp channels config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update temporary channels configuration' });
  }
});

// GET /api/guilds/:guildId/tempchannels - Get temporary channels configuration
router.get('/:guildId/tempchannels', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM temp_channel_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      return res.json({
        guild_id: req.guildId,
        creator_channel_id: null,
        category_id: null,
        naming_template: "{user}'s Channel"
      });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Utilities] Get temp channels config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch temporary channels configuration' });
  }
});

export default router;
