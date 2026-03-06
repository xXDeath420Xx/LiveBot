import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// Get weather configuration and stats
router.get('/manage/:guildId/weather', async (req, res) => {
  try {
    const { guildId } = req.params;

    // Get weather configuration
    const [[weatherConfig]] = await pool.execute(
      'SELECT * FROM weather_config WHERE guild_id = ?',
      [guildId]
    );

    // Get stats
    const [[userCountResult]] = await pool.execute(
      'SELECT COUNT(DISTINCT user_id) as count FROM user_alert_zones WHERE guild_id = ?',
      [guildId]
    );

    const [[activeAlertsResult]] = await pool.execute(
      'SELECT COUNT(*) as count FROM weather_alerts WHERE expires_at > NOW()',
      []
    );

    const [[alertsSentResult]] = await pool.execute(
      `SELECT COUNT(*) as count FROM weather_alerts
       WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      []
    );

    const weatherStats = {
      totalUsers: userCountResult?.count || 0,
      activeAlerts: activeAlertsResult?.count || 0,
      alertsSent: alertsSentResult?.count || 0
    };

    res.json({
      weatherConfig: weatherConfig || null,
      weatherStats
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching weather data', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch weather data' });
  }
});

// Update weather configuration
router.post('/manage/:guildId/weather/config', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { enabled, checkInterval } = req.body;

    // Convert checkbox value to boolean
    const isEnabled = enabled === 'on' || enabled === true || enabled === '1' ? 1 : 0;
    const interval = parseInt(checkInterval) || 60;

    // Clamp interval to valid range
    const validInterval = Math.max(30, Math.min(300, interval));

    // Upsert weather configuration
    await pool.execute(
      `INSERT INTO weather_config (guild_id, enabled, check_interval, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         check_interval = VALUES(check_interval),
         updated_at = NOW()`,
      [guildId, isEnabled, validInterval]
    );

    res.redirect(`/manage/${guildId}?page=weather&success=updated`);
  } catch (error) {
    logger.error('[Dashboard] Error updating weather config', { error: error.message });
    res.redirect(`/manage/${guildId}?page=weather&error=failed`);
  }
});

export default router;
