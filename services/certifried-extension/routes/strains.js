/**
 * Strains Routes
 * Strain collection and discovery system
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /strains/collection
 * Get player's strain collection with discovery status
 */
router.get('/collection', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all base strains (not player-bred ones)
        const [allStrains] = await pool.execute(
            `SELECT id, name, slug, strain_type, rarity, base_price,
                    base_grow_time_ms as grow_duration_ms,
                    base_yield_min, base_yield_max, genetics,
                    effects, flavors, description
             FROM cfx_strains
             WHERE bred_by_player_id IS NULL OR is_bred = 0
             ORDER BY FIELD(rarity, 'common', 'uncommon', 'rare', 'epic', 'legendary'), name`
        );

        // Get player's discovered strains
        const [discoveries] = await pool.execute(
            `SELECT strain_id, discovered_at FROM cfx_strain_discoveries
             WHERE player_id = ?`,
            [playerId]
        );

        const discoveredSet = new Set(discoveries.map(d => d.strain_id));

        // Get strains created by this player
        const [createdStrains] = await pool.execute(
            `SELECT id, name, rarity, base_price,
                    base_grow_time_ms as grow_duration_ms,
                    base_yield_min, base_yield_max, genetics,
                    effects, flavors, description, created_at
             FROM cfx_strains
             WHERE bred_by_player_id = ?
             ORDER BY created_at DESC`,
            [playerId]
        );

        res.json({
            success: true,
            strains: allStrains.map(s => {
                // Parse genetics from JSON column
                const genetics = typeof s.genetics === 'string'
                    ? JSON.parse(s.genetics)
                    : (s.genetics || {});
                return {
                    id: s.id,
                    name: s.name,
                    rarity: s.rarity,
                    basePrice: s.base_price,
                    growDurationMs: s.grow_duration_ms,
                    baseYieldMin: s.base_yield_min,
                    baseYieldMax: s.base_yield_max,
                    genetics: {
                        thc: genetics.thc || 50,
                        cbd: genetics.cbd || 30,
                        yield: genetics.yield || Math.round(((s.base_yield_min + s.base_yield_max) / 2) * 10),
                        speed: genetics.speed || Math.round(100 - (s.grow_duration_ms / 36000)),
                        quality: genetics.quality || 50,
                        resilience: genetics.resilience || 50
                    },
                    effects: s.effects ? JSON.parse(s.effects) : null,
                    flavors: s.flavors ? JSON.parse(s.flavors) : null,
                    description: s.description,
                    isDiscovered: discoveredSet.has(s.id)
                };
            }),
            createdStrains: createdStrains.map(s => ({
                id: s.id,
                name: s.name,
                rarity: s.rarity,
                basePrice: s.base_price,
                createdAt: s.created_at
            })),
            stats: {
                totalStrains: allStrains.length,
                discovered: discoveredSet.size,
                created: createdStrains.length,
                completionPercent: Math.round((discoveredSet.size / allStrains.length) * 100)
            }
        });

    } catch (error) {
        logger.error('[Strains] Get collection failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /strains/:id
 * Get detailed strain information
 */
router.get('/:id', async (req, res) => {
    try {
        const strainId = parseInt(req.params.id);
        const playerId = req.player.id;

        const [[strain]] = await pool.execute(
            `SELECT s.*,
                    p.display_name as creator_name
             FROM cfx_strains s
             LEFT JOIN cfx_players p ON s.bred_by_player_id = p.id
             WHERE s.id = ?`,
            [strainId]
        );

        if (!strain) {
            return res.status(404).json({ error: 'Strain not found', code: 'NOT_FOUND' });
        }

        // Check if player has discovered this strain
        const [[discovery]] = await pool.execute(
            `SELECT discovered_at FROM cfx_strain_discoveries
             WHERE player_id = ? AND strain_id = ?`,
            [playerId, strainId]
        );

        // Get breeding info if it was created through breeding
        let parents = null;
        if (strain.parent_1_id && strain.parent_2_id) {
            const [parentStrains] = await pool.execute(
                `SELECT id, name FROM cfx_strains WHERE id IN (?, ?)`,
                [strain.parent_1_id, strain.parent_2_id]
            );
            parents = parentStrains;
        }

        // Parse genetics from JSON
        const genetics = typeof strain.genetics === 'string'
            ? JSON.parse(strain.genetics)
            : (strain.genetics || {});

        res.json({
            success: true,
            strain: {
                id: strain.id,
                name: strain.name,
                rarity: strain.rarity,
                basePrice: strain.base_price,
                growDurationMs: strain.base_grow_time_ms,
                baseYieldMin: strain.base_yield_min,
                baseYieldMax: strain.base_yield_max,
                genetics: {
                    thc: genetics.thc || 50,
                    cbd: genetics.cbd || 30,
                    yield: genetics.yield || Math.round(((strain.base_yield_min + strain.base_yield_max) / 2) * 10),
                    speed: genetics.speed || Math.round(100 - (strain.base_grow_time_ms / 36000)),
                    quality: genetics.quality || 50,
                    resilience: genetics.resilience || 50
                },
                effects: strain.effects ? JSON.parse(strain.effects) : null,
                flavors: strain.flavors ? JSON.parse(strain.flavors) : null,
                description: strain.description,
                isDiscovered: !!discovery,
                discoveredAt: discovery?.discovered_at || null,
                creatorName: strain.creator_name,
                parents: parents,
                createdAt: strain.created_at
            }
        });

    } catch (error) {
        logger.error('[Strains] Get strain failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
