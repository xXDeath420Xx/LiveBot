/**
 * Strain Favorites Routes
 * Manage player's favorite strains for quick access
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

const MAX_FAVORITES = 10;

/**
 * GET /favorites
 * Get player's favorite strains
 */
router.get('/', async (req, res) => {
    try {
        const [favorites] = await pool.execute(
            `SELECT f.id, f.strain_id, f.sort_order, f.created_at,
                    s.name, s.slug, s.rarity, s.base_price,
                    s.genetics, s.base_yield_min, s.base_yield_max, s.base_grow_time_ms
             FROM cfx_strain_favorites f
             JOIN cfx_strains s ON f.strain_id = s.id
             WHERE f.player_id = ?
             ORDER BY f.sort_order ASC, f.created_at ASC`,
            [req.player.id]
        );

        res.json({
            success: true,
            favorites: favorites.map(f => {
                const genetics = typeof f.genetics === 'string' ? JSON.parse(f.genetics) : (f.genetics || {});
                return {
                    id: f.id,
                    strainId: f.strain_id,
                    sortOrder: f.sort_order,
                    strain: {
                        id: f.strain_id,
                        name: f.name,
                        slug: f.slug,
                        rarity: f.rarity,
                        basePrice: parseFloat(f.base_price),
                        thc: genetics.thc || 50,
                        cbd: genetics.cbd || 30,
                        yieldMin: f.base_yield_min,
                        yieldMax: f.base_yield_max,
                        growTimeMs: f.base_grow_time_ms
                    },
                    addedAt: f.created_at
                };
            }),
            maxFavorites: MAX_FAVORITES
        });

    } catch (error) {
        logger.error('[Favorites] Get failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get favorites', code: 'ERROR' });
    }
});

/**
 * POST /favorites
 * Add strain to favorites
 */
router.post('/', async (req, res) => {
    try {
        const { strainId } = req.body;

        if (!strainId) {
            return res.status(400).json({ error: 'Strain ID required', code: 'NO_STRAIN_ID' });
        }

        // Check if strain exists
        const [[strain]] = await pool.execute(
            'SELECT id, name FROM cfx_strains WHERE id = ?',
            [strainId]
        );

        if (!strain) {
            return res.status(404).json({ error: 'Strain not found', code: 'STRAIN_NOT_FOUND' });
        }

        // Check current favorite count
        const [[countResult]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_strain_favorites WHERE player_id = ?',
            [req.player.id]
        );

        if (countResult.count >= MAX_FAVORITES) {
            return res.status(400).json({
                error: `Maximum ${MAX_FAVORITES} favorites allowed`,
                code: 'MAX_FAVORITES'
            });
        }

        // Get next sort order
        const [[maxOrder]] = await pool.execute(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM cfx_strain_favorites WHERE player_id = ?',
            [req.player.id]
        );

        // Insert favorite (ignore if already exists)
        try {
            await pool.execute(
                'INSERT INTO cfx_strain_favorites (player_id, strain_id, sort_order) VALUES (?, ?, ?)',
                [req.player.id, strainId, maxOrder.next_order]
            );

            logger.info('[Favorites] Added', {
                playerId: req.player.id,
                strainId,
                strainName: strain.name
            });

            res.json({
                success: true,
                message: `${strain.name} added to favorites`
            });

        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ error: 'Strain already in favorites', code: 'ALREADY_FAVORITE' });
            }
            throw e;
        }

    } catch (error) {
        logger.error('[Favorites] Add failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to add favorite', code: 'ERROR' });
    }
});

/**
 * DELETE /favorites/:strainId
 * Remove strain from favorites
 */
router.delete('/:strainId', async (req, res) => {
    try {
        const strainId = parseInt(req.params.strainId, 10);

        if (!strainId || isNaN(strainId)) {
            return res.status(400).json({ error: 'Invalid strain ID', code: 'INVALID_ID' });
        }

        const [result] = await pool.execute(
            'DELETE FROM cfx_strain_favorites WHERE player_id = ? AND strain_id = ?',
            [req.player.id, strainId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Favorite not found', code: 'NOT_FOUND' });
        }

        logger.info('[Favorites] Removed', {
            playerId: req.player.id,
            strainId
        });

        res.json({
            success: true,
            message: 'Removed from favorites'
        });

    } catch (error) {
        logger.error('[Favorites] Remove failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to remove favorite', code: 'ERROR' });
    }
});

/**
 * PUT /favorites/reorder
 * Reorder favorites
 */
router.put('/reorder', async (req, res) => {
    try {
        const { order } = req.body;

        if (!Array.isArray(order)) {
            return res.status(400).json({ error: 'Order array required', code: 'INVALID_ORDER' });
        }

        // Update sort order for each favorite
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            for (let i = 0; i < order.length; i++) {
                await conn.execute(
                    'UPDATE cfx_strain_favorites SET sort_order = ? WHERE player_id = ? AND strain_id = ?',
                    [i, req.player.id, order[i]]
                );
            }

            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            message: 'Favorites reordered'
        });

    } catch (error) {
        logger.error('[Favorites] Reorder failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to reorder favorites', code: 'ERROR' });
    }
});

export default router;
