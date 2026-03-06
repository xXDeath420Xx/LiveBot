/**
 * Growth System
 * Handles plant growth, harvesting, and yield calculations
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { GAME } from '../config/game-constants.js';
import { gaussian, clamp, applyVariance, randomInt } from './rng.js';
import { getBonuses } from './bonus-resolver.js';
import { updateQuestProgress } from './quest-system.js';
import { rollMutation } from '../routes/mutations.js';

/**
 * Calculate grow time with all modifiers
 * @param {object} strain - Strain data
 * @param {object} bonuses - Player bonuses
 * @returns {number} Final grow time in ms
 */
export function calculateGrowTime(strain, bonuses) {
    let growTime = strain.base_grow_time_ms;

    // Apply variance (+/- 10%)
    growTime = applyVariance(growTime, GAME.GROW_TIME_VARIANCE_PERCENT);

    // Apply speed bonuses (reduce time)
    const speedMultiplier = 1 - (bonuses.growSpeed || 0);
    growTime = growTime * Math.max(0.1, speedMultiplier); // Min 10% of base time

    return Math.floor(growTime);
}

/**
 * Calculate quality at planting with variance
 * @param {object} strain - Strain data
 * @param {object} bonuses - Player bonuses
 * @returns {number} Base quality (will be modified at harvest)
 */
export function calculatePlantQuality(strain, bonuses) {
    const baseQuality = randomInt(strain.base_quality_min, strain.base_quality_max);

    // Add gaussian variance
    const variance = gaussian(0, GAME.QUALITY_VARIANCE_PLANT);
    let quality = baseQuality + variance;

    // Apply quality bonuses
    quality += (bonuses.qualityBonus || 0) * 100;

    return Math.floor(clamp(quality, GAME.QUALITY_MIN, GAME.QUALITY_MAX));
}

/**
 * Calculate final quality at harvest
 * @param {number} baseQuality - Quality set at planting
 * @param {object} bonuses - Player bonuses
 * @param {boolean} withered - Whether plant is withering
 * @returns {number} Final harvest quality
 */
export function calculateHarvestQuality(baseQuality, bonuses, withered = false) {
    // Add harvest variance
    const variance = gaussian(0, GAME.QUALITY_VARIANCE_HARVEST);
    let quality = baseQuality + variance;

    // Apply wither penalty
    if (withered) {
        quality *= GAME.WITHER_PENALTY_QUALITY;
    }

    return Math.floor(clamp(quality, GAME.QUALITY_MIN, GAME.QUALITY_MAX));
}

/**
 * Calculate yield at harvest
 * @param {object} strain - Strain data
 * @param {object} bonuses - Player bonuses
 * @param {boolean} withered - Whether plant is withering
 * @returns {number} Yield amount
 */
export function calculateYield(strain, bonuses, withered = false) {
    // Random base yield
    let baseYield = randomInt(strain.base_yield_min, strain.base_yield_max);

    // Apply variance
    baseYield = applyVariance(baseYield, GAME.YIELD_VARIANCE_PERCENT);

    // Apply yield bonuses
    const yieldMultiplier = 1 + (bonuses.yieldBonus || 0);
    let finalYield = baseYield * yieldMultiplier;

    // Apply wither penalty
    if (withered) {
        finalYield *= GAME.WITHER_PENALTY_YIELD;
    }

    // Check for double harvest
    if (bonuses.doubleHarvestChance && Math.random() < bonuses.doubleHarvestChance) {
        finalYield *= 2;
        logger.debug('[GrowthSystem] Double harvest triggered!');
    }

    return Math.max(1, Math.floor(finalYield));
}

/**
 * Process growth tick for a player
 * Called during offline catch-up or periodic updates
 * @param {number} playerId - Player ID
 * @param {number} elapsedMs - Time elapsed since last tick
 * @param {number} now - Current timestamp
 * @returns {object} Growth results
 */
export async function processGrowthTick(playerId, elapsedMs, now) {
    const results = {
        slotsUpdated: 0,
        plantsReady: [],
        plantsWithered: []
    };

    // Get player's grow slots
    const [slots] = await pool.execute(
        `SELECT gs.*, s.name as strain_name, s.base_yield_min, s.base_yield_max
         FROM cfx_grow_slots gs
         LEFT JOIN cfx_strains s ON gs.strain_id = s.id
         WHERE gs.player_id = ? AND gs.status IN ('growing', 'ready')`,
        [playerId]
    );

    // Get bonuses
    const bonuses = await getBonuses(playerId);

    // Check for auto-water skill (prevents withering)
    const hasAutoWater = bonuses.noWither || false;

    for (const slot of slots) {
        if (slot.status === 'growing') {
            // Calculate new accumulated growth
            let newAccumulated = (slot.accumulated_growth_ms || 0) + elapsedMs;

            // Check if ready
            if (newAccumulated >= slot.grow_duration_ms) {
                // Plant is ready!
                const witherTime = hasAutoWater
                    ? null
                    : now + (slot.grow_duration_ms * GAME.WITHER_TIME_MULTIPLIER);

                await pool.execute(
                    `UPDATE cfx_grow_slots
                     SET status = 'ready', accumulated_growth_ms = ?, ready_at = ?, wither_at = ?, last_updated_at = ?
                     WHERE id = ?`,
                    [slot.grow_duration_ms, now, witherTime, now, slot.id]
                );

                results.plantsReady.push({
                    slotNumber: slot.slot_number,
                    strainName: slot.strain_name,
                    strainId: slot.strain_id
                });
                results.slotsUpdated++;
            } else {
                // Still growing, update accumulated time
                await pool.execute(
                    `UPDATE cfx_grow_slots SET accumulated_growth_ms = ?, last_updated_at = ? WHERE id = ?`,
                    [newAccumulated, now, slot.id]
                );
                results.slotsUpdated++;
            }
        } else if (slot.status === 'ready' && slot.wither_at && !hasAutoWater) {
            // Check for withering
            if (now >= slot.wither_at) {
                await pool.execute(
                    `UPDATE cfx_grow_slots SET status = 'withered', last_updated_at = ? WHERE id = ?`,
                    [now, slot.id]
                );

                results.plantsWithered.push({
                    slotNumber: slot.slot_number,
                    strainName: slot.strain_name,
                    strainId: slot.strain_id
                });
                results.slotsUpdated++;
            }
        }
    }

    return results;
}

/**
 * Plant a seed in a slot
 * @param {number} playerId - Player ID
 * @param {number} slotNumber - Slot number
 * @param {number} strainId - Strain ID to plant
 * @returns {object} Plant result
 */
export async function plantSeed(playerId, slotNumber, strainId) {
    // Get slot
    const [[slot]] = await pool.execute(
        'SELECT * FROM cfx_grow_slots WHERE player_id = ? AND slot_number = ?',
        [playerId, slotNumber]
    );

    if (!slot) {
        throw new Error('Slot not found');
    }

    if (slot.status !== 'empty') {
        throw new Error('Slot is not empty');
    }

    // Check if player has seeds of this strain in inventory
    const [[seedInventory]] = await pool.execute(
        'SELECT * FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ? AND quantity > 0',
        [playerId, strainId]
    );

    if (!seedInventory) {
        throw new Error('No seeds available for this strain');
    }

    // Get strain data
    const [[strain]] = await pool.execute(
        'SELECT * FROM cfx_strains WHERE id = ?',
        [strainId]
    );

    if (!strain) {
        throw new Error('Strain not found');
    }

    // Get bonuses
    const bonuses = await getBonuses(playerId);

    // Calculate grow time and quality
    const growTime = calculateGrowTime(strain, bonuses);
    const quality = calculatePlantQuality(strain, bonuses);
    const now = Date.now();
    const readyAt = now + growTime;

    // Use transaction to ensure atomicity of planting + seed consumption + booster decrement
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Plant the seed
        await connection.execute(
            `UPDATE cfx_grow_slots
             SET strain_id = ?, status = 'growing', planted_at = ?, grow_duration_ms = ?,
                 ready_at = ?, base_quality = ?, accumulated_growth_ms = 0, last_updated_at = ?,
                 wither_at = NULL
             WHERE id = ?`,
            [strainId, now, growTime, readyAt, quality, now, slot.id]
        );

        // Consume 1 seed from inventory
        await connection.execute(
            `UPDATE cfx_seed_inventory
             SET quantity = quantity - 1, total_used = total_used + 1, updated_at = NOW()
             WHERE player_id = ? AND strain_id = ?`,
            [playerId, strainId]
        );

        // Decrement uses for quality boosters that were applied (described as "for next 5 plants")
        await connection.execute(
            `UPDATE cfx_player_shop_items
             SET uses_remaining = uses_remaining - 1
             WHERE player_id = ?
             AND item_type = 'booster'
             AND effect_type = 'quality'
             AND activated = 1
             AND uses_remaining IS NOT NULL
             AND uses_remaining > 0`,
            [playerId]
        );

        // Delete any quality boosters that have run out of uses
        await connection.execute(
            `DELETE FROM cfx_player_shop_items
             WHERE player_id = ?
             AND item_type = 'booster'
             AND effect_type = 'quality'
             AND uses_remaining IS NOT NULL
             AND uses_remaining <= 0`,
            [playerId]
        );

        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }

    logger.info('[GrowthSystem] Seed planted and consumed', {
        playerId,
        slotNumber,
        strainId,
        strainName: strain.name,
        seedsRemaining: seedInventory.quantity - 1
    });

    // Update quest progress for planting (outside transaction - non-critical)
    await updateQuestProgress(playerId, 'plant_count', 1);

    return {
        slotNumber,
        strainId,
        strainName: strain.name,
        growDurationMs: growTime,
        readyAt,
        baseQuality: quality
    };
}

/**
 * Harvest a plant from a slot
 * @param {number} playerId - Player ID
 * @param {number} slotNumber - Slot number
 * @returns {object} Harvest result
 */
export async function harvestPlant(playerId, slotNumber) {
    // Get slot with strain data
    const [[slot]] = await pool.execute(
        `SELECT gs.*, s.name as strain_name, s.slug, s.base_yield_min, s.base_yield_max, s.base_price, s.rarity
         FROM cfx_grow_slots gs
         JOIN cfx_strains s ON gs.strain_id = s.id
         WHERE gs.player_id = ? AND gs.slot_number = ?`,
        [playerId, slotNumber]
    );

    if (!slot) {
        throw new Error('Slot not found');
    }

    // Defense-in-depth: Server-side time validation in addition to status check
    // This protects against status manipulation and ensures growth tick timing is respected
    const now = Date.now();

    if (slot.status === 'growing') {
        // Check if actually ready (growth tick may not have run yet)
        if (slot.ready_at && now >= slot.ready_at) {
            // Plant is actually ready, update status inline
            await pool.execute(
                `UPDATE cfx_grow_slots SET status = 'ready' WHERE id = ? AND status = 'growing'`,
                [slot.id]
            );
            slot.status = 'ready';
        } else {
            throw new Error('Plant is not ready to harvest');
        }
    } else if (slot.status !== 'ready' && slot.status !== 'withered') {
        throw new Error('Plant is not ready to harvest');
    }

    const isWithered = slot.status === 'withered';

    // Get bonuses
    const bonuses = await getBonuses(playerId);

    // Calculate harvest results
    const quality = calculateHarvestQuality(slot.base_quality, bonuses, isWithered);
    const yieldAmount = calculateYield({
        base_yield_min: slot.base_yield_min,
        base_yield_max: slot.base_yield_max
    }, bonuses, isWithered);

    // Use transaction for all harvest operations to ensure atomicity
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check for existing stack with row lock
        const [[existingStack]] = await connection.execute(
            `SELECT id, quantity FROM cfx_inventory
             WHERE player_id = ? AND strain_id = ? AND quality = ? AND source = 'grown'
             FOR UPDATE`,
            [playerId, slot.strain_id, quality]
        );

        if (existingStack) {
            await connection.execute(
                'UPDATE cfx_inventory SET quantity = quantity + ?, harvested_at = NOW() WHERE id = ?',
                [yieldAmount, existingStack.id]
            );
        } else {
            await connection.execute(
                `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality, source)
                 VALUES (?, ?, ?, ?, 'grown')`,
                [playerId, slot.strain_id, yieldAmount, quality]
            );
        }

        // Clear the slot
        await connection.execute(
            `UPDATE cfx_grow_slots
             SET strain_id = NULL, status = 'empty', planted_at = NULL, grow_duration_ms = NULL,
                 ready_at = NULL, base_quality = NULL, accumulated_growth_ms = 0, last_updated_at = NULL,
                 wither_at = NULL
             WHERE id = ?`,
            [slot.id]
        );

        // Update lifetime stats (lifetime_sales tracks total harvests completed)
        await connection.execute(
            'UPDATE cfx_players SET lifetime_sales = lifetime_sales + 1 WHERE id = ?',
            [playerId]
        );

        // Decrement uses for yield boosters that were applied
        await connection.execute(
            `UPDATE cfx_player_shop_items
             SET uses_remaining = uses_remaining - 1
             WHERE player_id = ?
             AND item_type = 'booster'
             AND effect_type = 'yield'
             AND activated = 1
             AND uses_remaining IS NOT NULL
             AND uses_remaining > 0`,
            [playerId]
        );

        // Delete any boosters that have run out of uses
        await connection.execute(
            `DELETE FROM cfx_player_shop_items
             WHERE player_id = ?
             AND item_type = 'booster'
             AND uses_remaining IS NOT NULL
             AND uses_remaining <= 0`,
            [playerId]
        );

        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }

    // Roll for mutation discovery on harvest
    let mutation = null;
    try {
        mutation = await rollMutation(playerId, slot.id, slot.rarity);
    } catch (e) {
        // Mutation failure should never block harvest
    }

    // Update quest progress for harvest
    await updateQuestProgress(playerId, 'harvest_count', 1, {
        rarity: slot.rarity,
        quality
    });

    // Also update quality-based quests
    await updateQuestProgress(playerId, 'harvest_quality', quality, { quality });

    // Update rarity-based quests (rare = 3, epic = 4, legendary = 5)
    const rarityValue = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 }[slot.rarity] || 1;
    await updateQuestProgress(playerId, 'harvest_rarity', rarityValue, { rarity: slot.rarity });

    return {
        slotNumber,
        strainId: slot.strain_id,
        strainName: slot.strain_name,
        strainSlug: slot.slug,
        rarity: slot.rarity,
        quality,
        yield: yieldAmount,
        wasWithered: isWithered,
        basePrice: slot.base_price,
        mutation
    };
}

/**
 * Harvest all ready plants
 * @param {number} playerId - Player ID
 * @returns {object[]} Array of harvest results
 */
export async function harvestAll(playerId) {
    // Get all ready slots — include growing slots past their ready_at time
    // (growth-tick may not have transitioned them yet)
    // ready_at is stored as bigint epoch milliseconds
    const nowMs = Date.now();
    const [slots] = await pool.execute(
        `SELECT slot_number FROM cfx_grow_slots
         WHERE player_id = ? AND (
             status IN ('ready', 'withered')
             OR (status = 'growing' AND ready_at IS NOT NULL AND ready_at <= ?)
         )`,
        [playerId, nowMs]
    );

    const results = [];
    for (const slot of slots) {
        try {
            const result = await harvestPlant(playerId, slot.slot_number);
            results.push(result);
        } catch (error) {
            logger.warn('[GrowthSystem] Failed to harvest slot', {
                playerId,
                slotNumber: slot.slot_number,
                error: error.message
            });
        }
    }

    return results;
}

export default {
    calculateGrowTime,
    calculatePlantQuality,
    calculateHarvestQuality,
    calculateYield,
    processGrowthTick,
    plantSeed,
    harvestPlant,
    harvestAll
};
