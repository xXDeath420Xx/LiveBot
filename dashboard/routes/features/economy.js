import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/economy - Get economy configuration
router.get('/:guildId/economy', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM economy_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (rows.length === 0) {
      // Return default config if doesn't exist
      return res.json({
        guild_id: req.guildId,
        currency_name: 'coins',
        starting_balance: 100
      });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('[Economy] Get economy config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch economy configuration' });
  }
});

// PATCH /api/guilds/:guildId/economy - Update economy configuration
router.patch('/:guildId/economy', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { currency_name, starting_balance } = req.body;

    // Validate inputs
    if (currency_name !== undefined && (currency_name.length < 1 || currency_name.length > 32)) {
      return res.status(400).json({ error: 'Currency name must be between 1 and 32 characters' });
    }

    if (starting_balance !== undefined && (starting_balance < 0 || starting_balance > 1000000)) {
      return res.status(400).json({ error: 'Starting balance must be between 0 and 1,000,000' });
    }

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT * FROM economy_config WHERE guild_id = ?',
      [req.guildId]
    );

    if (existing.length === 0) {
      // Insert new config
      await pool.execute(
        `INSERT INTO economy_config (guild_id, currency_name, starting_balance)
         VALUES (?, ?, ?)`,
        [
          req.guildId,
          currency_name || 'coins',
          starting_balance !== undefined ? starting_balance : 100
        ]
      );
    } else {
      // Update existing config
      const updates = [];
      const values = [];

      if (currency_name !== undefined) {
        updates.push('currency_name = ?');
        values.push(currency_name);
      }
      if (starting_balance !== undefined) {
        updates.push('starting_balance = ?');
        values.push(starting_balance);
      }

      if (updates.length > 0) {
        values.push(req.guildId);
        await pool.execute(
          `UPDATE economy_config SET ${updates.join(', ')} WHERE guild_id = ?`,
          values
        );
      }
    }

    // Fetch and return updated config
    const [updated] = await pool.execute(
      'SELECT * FROM economy_config WHERE guild_id = ?',
      [req.guildId]
    );

    res.json({
      success: true,
      message: 'Economy configuration updated',
      config: updated[0]
    });
  } catch (error) {
    logger.error('[Economy] Update economy config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update economy configuration' });
  }
});

export default router;
