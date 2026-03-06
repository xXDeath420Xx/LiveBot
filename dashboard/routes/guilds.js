import express from 'express';
import pool from '../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from './api.js';
import logger from '../../utils/logger.js';

// Import feature routers
import welcomeRouter from './features/welcome.js';
import levelingRouter from './features/leveling.js';
import economyRouter from './features/economy.js';
import automodRouter from './features/automod.js';
import loggingRouter from './features/logging.js';
import ticketsRouter from './features/tickets.js';
import streamingRouter from './features/streaming.js';
import reactionRolesRouter from './features/reaction-roles.js';
import moderationRouter from './features/moderation.js';
import starboardRouter from './features/starboard.js';
import utilitiesRouter from './features/utilities.js';
import selfPromoRouter from './features/self-promo.js';
import communitySupportRouter from './features/community-support.js';
import streamEndedRouter from './features/stream-ended.js';
import autoTrackRouter from './features/auto-track.js';
import globalBanRouter from './features/global-ban.js';

const router = express.Router();

// Use feature routers
router.use('/', welcomeRouter);
router.use('/', levelingRouter);
router.use('/', economyRouter);
router.use('/', automodRouter);
router.use('/', loggingRouter);
router.use('/', ticketsRouter);
router.use('/', streamingRouter);
router.use('/', reactionRolesRouter);
router.use('/', moderationRouter);
router.use('/', starboardRouter);
router.use('/', utilitiesRouter);
router.use('/', selfPromoRouter);
router.use('/', communitySupportRouter);
router.use('/', streamEndedRouter);
router.use('/', autoTrackRouter);
router.use('/', globalBanRouter);

// Get guild configuration
router.get('/:guildId/config', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM guild_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Create default config if doesn't exist
      await pool.execute(
        'INSERT INTO guild_config (guild_id, prefix) VALUES (?, ?)',
        [req.guildId, '!']
      );
      return res.json({ guild_id: req.guildId, prefix: '!' });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Guilds] Get config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch guild config' });
  }
});

// Update guild configuration
router.patch('/:guildId/config', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { prefix } = req.body;

    await pool.execute(
      'UPDATE guild_config SET prefix = ? WHERE guild_id = ?',
      [prefix || '!', req.guildId]
    );

    res.json({ success: true, message: 'Configuration updated' });
  } catch (error) {
    logger.error('[Guilds] Update config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Get guild modules status
router.get('/:guildId/modules', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [welcome] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [req.guildId]);
    const [leveling] = await pool.execute('SELECT * FROM level_config WHERE guild_id = ?', [req.guildId]);
    const [economy] = await pool.execute('SELECT * FROM economy_config WHERE guild_id = ?', [req.guildId]);
    const [automod] = await pool.execute('SELECT COUNT(*) as count FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [req.guildId]);
    const [logging] = await pool.execute('SELECT * FROM logging_config WHERE guild_id = ?', [req.guildId]);

    res.json({
      welcome: welcome.length > 0 && welcome[0].enabled,
      leveling: leveling.length > 0 && leveling[0].enabled,
      economy: economy.length > 0,
      automod: automod[0].count > 0,
      logging: logging.length > 0 && logging[0].enabled
    });
  } catch (error) {
    logger.error('[Guilds] Get modules error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

export default router;
