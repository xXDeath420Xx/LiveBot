/**
 * Mutations Routes
 * Strain mutation discovery and collection
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /mutations
 * Get player's discovered mutations and collection
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all mutations with discovery status
        const [mutations] = await pool.execute(
            `SELECT m.*, pm.times_discovered, pm.first_discovered_at
             FROM cfx_mutations m
             LEFT JOIN cfx_player_mutations pm ON m.id = pm.mutation_id AND pm.player_id = ?
             ORDER BY m.rarity DESC, m.name ASC`,
            [playerId]
        );

        // Get active mutations on current plants
        const [activeMutations] = await pool.execute(
            `SELECT pm.*, m.name, m.effect_type, m.effect_value, m.rarity, m.is_positive,
                    gs.slot_number, s.name as strain_name
             FROM cfx_plant_mutations pm
             JOIN cfx_mutations m ON pm.mutation_id = m.id
             JOIN cfx_grow_slots gs ON pm.grow_slot_id = gs.id
             LEFT JOIN cfx_strains s ON gs.strain_id = s.id
             WHERE gs.player_id = ? AND gs.status = 'growing'`,
            [playerId]
        );

        // Calculate collection stats
        const totalMutations = mutations.length;
        const discovered = mutations.filter(m => m.times_discovered > 0).length;

        res.json({
            success: true,
            collection: mutations.map(m => ({
                id: m.id,
                key: m.mutation_key,
                name: m.name,
                description: m.description,
                effectType: m.effect_type,
                effectValue: parseFloat(m.effect_value),
                rarity: m.rarity,
                baseChance: parseFloat(m.base_chance),
                isPositive: !!m.is_positive,
                isDiscovered: m.times_discovered > 0,
                timesDiscovered: m.times_discovered || 0,
                firstDiscoveredAt: m.first_discovered_at
            })),
            activeMutations: activeMutations.map(m => ({
                id: m.id,
                mutationId: m.mutation_id,
                name: m.name,
                effectType: m.effect_type,
                effectValue: parseFloat(m.effect_value),
                rarity: m.rarity,
                isPositive: !!m.is_positive,
                slotNumber: m.slot_number,
                strainName: m.strain_name,
                discoveredAt: m.discovered_at
            })),
            stats: {
                total: totalMutations,
                discovered,
                completion: Math.round((discovered / totalMutations) * 100)
            }
        });

    } catch (error) {
        logger.error('[Mutations] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get mutations', code: 'ERROR' });
    }
});

/**
 * Helper: Roll for mutation on a plant
 * Called by grow system when checking plants
 */
export async function rollMutation(playerId, growSlotId, strainRarity = 'common') {
    try {
        // Get mutations that haven't been applied to this plant
        const [mutations] = await pool.execute(
            `SELECT m.* FROM cfx_mutations m
             WHERE m.id NOT IN (
                 SELECT mutation_id FROM cfx_plant_mutations WHERE grow_slot_id = ?
             )`,
            [growSlotId]
        );

        if (mutations.length === 0) return null;

        // Apply rarity modifier
        const rarityMod = {
            common: 1.0,
            uncommon: 1.2,
            rare: 1.5,
            epic: 2.0,
            legendary: 3.0
        }[strainRarity] || 1.0;

        // Roll for each mutation
        for (const mutation of mutations) {
            const chance = mutation.base_chance * rarityMod;
            if (Math.random() < chance) {
                // Mutation triggered!
                await pool.execute(
                    `INSERT INTO cfx_plant_mutations (grow_slot_id, mutation_id) VALUES (?, ?)`,
                    [growSlotId, mutation.id]
                );

                // Update player's mutation collection
                await pool.execute(
                    `INSERT INTO cfx_player_mutations (player_id, mutation_id, times_discovered)
                     VALUES (?, ?, 1)
                     ON DUPLICATE KEY UPDATE times_discovered = times_discovered + 1`,
                    [playerId, mutation.id]
                );

                logger.info('[Mutations] Mutation discovered', {
                    playerId,
                    growSlotId,
                    mutationId: mutation.id,
                    mutationName: mutation.name
                });

                return {
                    id: mutation.id,
                    name: mutation.name,
                    effectType: mutation.effect_type,
                    effectValue: parseFloat(mutation.effect_value),
                    rarity: mutation.rarity,
                    isPositive: mutation.is_positive
                };
            }
        }

        return null;
    } catch (error) {
        logger.error('[Mutations] Roll failed', { error: error.message });
        return null;
    }
}

/**
 * Helper: Get mutations for a grow slot
 */
export async function getSlotMutations(growSlotId) {
    try {
        const [mutations] = await pool.execute(
            `SELECT m.* FROM cfx_mutations m
             JOIN cfx_plant_mutations pm ON m.id = pm.mutation_id
             WHERE pm.grow_slot_id = ?`,
            [growSlotId]
        );

        return mutations.map(m => ({
            id: m.id,
            name: m.name,
            effectType: m.effect_type,
            effectValue: parseFloat(m.effect_value),
            isPositive: m.is_positive
        }));
    } catch (error) {
        logger.error('[Mutations] Get slot mutations failed', { error: error.message });
        return [];
    }
}

/**
 * Helper: Calculate mutation bonuses for a plant
 */
export function calculateMutationBonuses(mutations) {
    const bonuses = {
        yieldBonus: 0,
        qualityBonus: 0,
        growSpeedBonus: 0,
        thcBonus: 0,
        cbdBonus: 0,
        valueBonus: 0
    };

    for (const mutation of mutations) {
        switch (mutation.effectType) {
            case 'yield_bonus':
                bonuses.yieldBonus += mutation.effectValue;
                break;
            case 'quality_bonus':
                bonuses.qualityBonus += mutation.effectValue;
                break;
            case 'grow_speed':
                bonuses.growSpeedBonus += mutation.effectValue;
                break;
            case 'thc_boost':
                bonuses.thcBonus += mutation.effectValue;
                break;
            case 'cbd_boost':
                bonuses.cbdBonus += mutation.effectValue;
                break;
            case 'value_bonus':
                bonuses.valueBonus += mutation.effectValue;
                break;
        }
    }

    return bonuses;
}

export default router;
