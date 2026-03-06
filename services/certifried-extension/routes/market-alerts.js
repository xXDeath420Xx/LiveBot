/**
 * Market Alerts Routes
 * Price monitoring alerts for strains
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

const MAX_ALERTS = 10;
const ALERT_TYPES = ['price_above', 'price_below', 'price_change_percent'];

/**
 * GET /market/alerts
 * Get player's market alerts
 */
router.get('/', async (req, res) => {
    try {
        const [alerts] = await pool.execute(
            `SELECT a.id, a.strain_id, a.alert_type, a.threshold_value,
                    a.is_active, a.last_triggered_at, a.trigger_count, a.created_at,
                    s.name as strain_name, s.slug, s.rarity
             FROM cfx_market_alerts a
             JOIN cfx_strains s ON a.strain_id = s.id
             WHERE a.player_id = ?
             ORDER BY a.created_at DESC`,
            [req.player.id]
        );

        res.json({
            success: true,
            alerts: alerts.map(a => ({
                id: a.id,
                strainId: a.strain_id,
                strainName: a.strain_name,
                strainSlug: a.slug,
                strainRarity: a.rarity,
                alertType: a.alert_type,
                thresholdValue: parseFloat(a.threshold_value),
                isActive: !!a.is_active,
                lastTriggeredAt: a.last_triggered_at,
                triggerCount: a.trigger_count,
                createdAt: a.created_at
            })),
            maxAlerts: MAX_ALERTS
        });

    } catch (error) {
        logger.error('[MarketAlerts] Get failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get alerts', code: 'ERROR' });
    }
});

/**
 * POST /market/alerts
 * Create a new market alert
 */
router.post('/', async (req, res) => {
    try {
        const { strainId, alertType, thresholdValue } = req.body;

        // Validate inputs
        if (!strainId || !alertType || thresholdValue === undefined) {
            return res.status(400).json({
                error: 'Strain ID, alert type, and threshold required',
                code: 'MISSING_FIELDS'
            });
        }

        if (!ALERT_TYPES.includes(alertType)) {
            return res.status(400).json({
                error: 'Invalid alert type',
                code: 'INVALID_ALERT_TYPE'
            });
        }

        if (thresholdValue < 0) {
            return res.status(400).json({
                error: 'Threshold must be positive',
                code: 'INVALID_THRESHOLD'
            });
        }

        // Check strain exists
        const [[strain]] = await pool.execute(
            'SELECT id, name FROM cfx_strains WHERE id = ?',
            [strainId]
        );

        if (!strain) {
            return res.status(404).json({ error: 'Strain not found', code: 'STRAIN_NOT_FOUND' });
        }

        // Check alert count
        const [[countResult]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_market_alerts WHERE player_id = ?',
            [req.player.id]
        );

        if (countResult.count >= MAX_ALERTS) {
            return res.status(400).json({
                error: `Maximum ${MAX_ALERTS} alerts allowed`,
                code: 'MAX_ALERTS'
            });
        }

        // Check for duplicate alert
        const [[existing]] = await pool.execute(
            `SELECT id FROM cfx_market_alerts
             WHERE player_id = ? AND strain_id = ? AND alert_type = ?`,
            [req.player.id, strainId, alertType]
        );

        if (existing) {
            return res.status(400).json({
                error: 'Alert already exists for this strain and type',
                code: 'DUPLICATE_ALERT'
            });
        }

        // Create alert
        const [result] = await pool.execute(
            `INSERT INTO cfx_market_alerts (player_id, strain_id, alert_type, threshold_value)
             VALUES (?, ?, ?, ?)`,
            [req.player.id, strainId, alertType, thresholdValue]
        );

        logger.info('[MarketAlerts] Created', {
            playerId: req.player.id,
            alertId: result.insertId,
            strainId,
            alertType,
            thresholdValue
        });

        res.json({
            success: true,
            alertId: result.insertId,
            message: `Alert created for ${strain.name}`
        });

    } catch (error) {
        logger.error('[MarketAlerts] Create failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to create alert', code: 'ERROR' });
    }
});

/**
 * PUT /market/alerts/:id
 * Update an alert (toggle active, change threshold)
 */
router.put('/:id', async (req, res) => {
    try {
        const alertId = parseInt(req.params.id, 10);
        const { isActive, thresholdValue } = req.body;

        if (isNaN(alertId)) {
            return res.status(400).json({ error: 'Invalid alert ID', code: 'INVALID_ID' });
        }

        // Build update query
        const updates = [];
        const params = [];

        if (isActive !== undefined) {
            updates.push('is_active = ?');
            params.push(isActive ? 1 : 0);
        }

        if (thresholdValue !== undefined) {
            if (thresholdValue < 0) {
                return res.status(400).json({ error: 'Threshold must be positive', code: 'INVALID_THRESHOLD' });
            }
            updates.push('threshold_value = ?');
            params.push(thresholdValue);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update', code: 'NO_CHANGES' });
        }

        params.push(req.player.id, alertId);

        const [result] = await pool.execute(
            `UPDATE cfx_market_alerts SET ${updates.join(', ')} WHERE player_id = ? AND id = ?`,
            params
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Alert not found', code: 'NOT_FOUND' });
        }

        res.json({
            success: true,
            message: 'Alert updated'
        });

    } catch (error) {
        logger.error('[MarketAlerts] Update failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to update alert', code: 'ERROR' });
    }
});

/**
 * DELETE /market/alerts/:id
 * Delete an alert
 */
router.delete('/:id', async (req, res) => {
    try {
        const alertId = parseInt(req.params.id, 10);

        if (isNaN(alertId)) {
            return res.status(400).json({ error: 'Invalid alert ID', code: 'INVALID_ID' });
        }

        const [result] = await pool.execute(
            'DELETE FROM cfx_market_alerts WHERE player_id = ? AND id = ?',
            [req.player.id, alertId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Alert not found', code: 'NOT_FOUND' });
        }

        logger.info('[MarketAlerts] Deleted', {
            playerId: req.player.id,
            alertId
        });

        res.json({
            success: true,
            message: 'Alert deleted'
        });

    } catch (error) {
        logger.error('[MarketAlerts] Delete failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to delete alert', code: 'ERROR' });
    }
});

export default router;
