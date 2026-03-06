/**
 * Grow Routes
 * Plant, harvest, and manage grow slots
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { plantSeed, harvestPlant, harvestAll } from '../game/growth-system.js';
import { awardXp } from '../game/engine.js';
import { getBonuses } from '../game/bonus-resolver.js';
import { validate, schemas } from '../middleware/validate.js';
import { plantCooldown, harvestCooldown } from '../middleware/rate-limit.js';
import { awardEventPoints } from './events.js';
import { trackStat } from './stats.js';
import { checkAchievements } from './achievements.js';
import { addHeat } from '../game/raid-system.js';
import { getTotalSlots } from './locations.js';
import { awardReputation } from './reputation.js';
import { updateTournamentScore } from './tournaments.js';

const router = Router();

/**
 * Get the correct max slots for a player
 * Uses location slots if locations exist, otherwise falls back to player.max_grow_slots
 */
async function getMaxSlots(playerId, playerMaxSlots) {
    try {
        const locationSlots = await getTotalSlots(playerId);
        // Use whichever is greater - location system or legacy system
        return Math.max(locationSlots || 0, playerMaxSlots || 2);
    } catch (e) {
        return playerMaxSlots || 2;
    }
}

/**
 * GET /grow/slots
 * Get all grow slots for the player
 */
router.get('/slots', async (req, res) => {
    try {
        // Get correct max slots from locations OR legacy system
        const maxSlots = await getMaxSlots(req.player.id, req.player.max_grow_slots);

        // Get existing slots
        let [slots] = await pool.execute(
            `SELECT gs.*, s.name as strain_name, s.slug, s.rarity,
                    s.base_grow_time_ms, s.base_yield_min, s.base_yield_max
             FROM cfx_grow_slots gs
             LEFT JOIN cfx_strains s ON gs.strain_id = s.id
             WHERE gs.player_id = ?
             ORDER BY gs.slot_number`,
            [req.player.id]
        );

        // Create missing slots if needed (sync slots with location capacity)
        if (slots.length < maxSlots) {
            const existingSlotNumbers = new Set(slots.map(s => s.slot_number));
            const slotsToCreate = [];

            for (let i = 1; i <= maxSlots; i++) {
                if (!existingSlotNumbers.has(i)) {
                    slotsToCreate.push([req.player.id, i]);
                }
            }

            if (slotsToCreate.length > 0) {
                // Create missing slots
                const placeholders = slotsToCreate.map(() => '(?, ?)').join(', ');
                const values = slotsToCreate.flat();
                await pool.execute(
                    `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES ${placeholders}`,
                    values
                );

                // Re-fetch all slots
                [slots] = await pool.execute(
                    `SELECT gs.*, s.name as strain_name, s.slug, s.rarity,
                            s.base_grow_time_ms, s.base_yield_min, s.base_yield_max
                     FROM cfx_grow_slots gs
                     LEFT JOIN cfx_strains s ON gs.strain_id = s.id
                     WHERE gs.player_id = ?
                     ORDER BY gs.slot_number`,
                    [req.player.id]
                );

                logger.info('[Grow] Created missing slots', {
                    playerId: req.player.id,
                    created: slotsToCreate.length,
                    totalSlots: maxSlots
                });
            }
        }

        const now = Date.now();

        res.json({
            success: true,
            slots: slots.map(s => {
                // Calculate progress based on elapsed time since planting
                let progressPercent = 0;
                if (s.status === 'growing' && s.planted_at && s.grow_duration_ms) {
                    const elapsed = now - Number(s.planted_at);
                    progressPercent = Math.min(100, Math.max(0, (elapsed / s.grow_duration_ms) * 100));
                } else if (s.status === 'ready' || s.status === 'withered') {
                    progressPercent = 100;
                }

                return {
                    slotNumber: s.slot_number,
                    status: s.status,
                    strainId: s.strain_id,
                    strainName: s.strain_name,
                    strainSlug: s.slug,
                    rarity: s.rarity,
                    plantedAt: s.planted_at,
                    growDurationMs: s.grow_duration_ms,
                    readyAt: s.ready_at,
                    witherAt: s.wither_at,
                    baseQuality: s.base_quality,
                    accumulatedGrowthMs: s.accumulated_growth_ms,
                    progressPercent: Math.round(progressPercent * 10) / 10 // One decimal place
                };
            }),
            maxSlots,
            serverTime: now
        });

    } catch (error) {
        logger.error('[Grow] Get slots failed', { playerId: req.player.id, error: error.message });
        res.status(500).json({ error: 'Failed to get slots', code: 'ERROR' });
    }
});

/**
 * POST /grow/plant
 * Plant a seed in a slot
 */
router.post('/plant', plantCooldown, validate(schemas.plant), async (req, res) => {
    try {
        const { slotNumber, strainId } = req.body;

        // Get correct max slots from locations OR legacy system
        const maxSlots = await getMaxSlots(req.player.id, req.player.max_grow_slots);

        // Check slot is within player's limit
        if (slotNumber > maxSlots) {
            return res.status(400).json({
                error: `You only have ${maxSlots} grow slots`,
                code: 'SLOT_LIMIT'
            });
        }

        const result = await plantSeed(req.player.id, slotNumber, strainId);

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        logger.error('[Grow] Plant failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('not empty') ||
            error.message.includes('No seeds available')) {
            return res.status(400).json({ error: error.message, code: 'PLANT_ERROR' });
        }

        res.status(500).json({ error: 'Failed to plant', code: 'ERROR' });
    }
});

/**
 * POST /grow/harvest
 * Harvest a single slot
 */
router.post('/harvest', harvestCooldown, validate(schemas.harvest), async (req, res) => {
    try {
        const { slotNumber } = req.body;

        const result = await harvestPlant(req.player.id, slotNumber);

        // Award XP based on quality and rarity
        const rarityMultiplier = { common: 1, uncommon: 1.5, rare: 2, epic: 3, legendary: 5 };
        const baseXp = 10 + Math.floor(result.quality / 10);
        const xp = Math.floor(baseXp * (rarityMultiplier[result.rarity] || 1));
        const xpResult = await awardXp(req.player.id, xp);

        // Track stats, event points, and achievements
        await trackStat(req.player.id, 'total_harvests', 1);
        await trackStat(req.player.id, 'total_plants_grown', 1);
        await trackStat(req.player.id, 'total_xp_earned', xp);
        await trackStat(req.player.id, 'highest_quality_grown', result.quality);
        await awardEventPoints(req.player.id, 10); // 10 points per harvest
        checkAchievements(req.player.id).catch(() => {}); // Fire and forget

        // Add heat for raid system (epic/legendary bonus)
        const heatBonus = (result.rarity === 'epic' || result.rarity === 'legendary') ? 8 : 0;
        await addHeat(req.player.id, 3 + heatBonus, result.rarity === 'legendary' ? 'harvest_legendary' : (result.rarity === 'epic' ? 'harvest_epic' : 'harvest'));

        // Award reputation and update tournament scores (fire-and-forget)
        awardReputation(req.player.id, 'growers_guild', 1).catch(() => {});
        updateTournamentScore(req.player.id, 'harvest', 1).catch(() => {});
        if (result.mutation) {
            awardReputation(req.player.id, 'research_collective', 25).catch(() => {});
        }

        res.json({
            success: true,
            ...result,
            xpAwarded: xpResult.xpAwarded,
            leveledUp: xpResult.leveledUp,
            newLevel: xpResult.newLevel,
            newXp: xpResult.newXp,
            xpInLevel: xpResult.xpInLevel,
            xpToNextLevel: xpResult.xpForNextLevel
        });

    } catch (error) {
        logger.error('[Grow] Harvest failed', {
            playerId: req.player.id,
            error: error.message
        });

        if (error.message.includes('not found') || error.message.includes('not ready')) {
            return res.status(400).json({ error: error.message, code: 'HARVEST_ERROR' });
        }

        res.status(500).json({ error: 'Failed to harvest', code: 'ERROR' });
    }
});

/**
 * POST /grow/harvest-all
 * Harvest all ready plants (requires skill)
 */
router.post('/harvest-all', harvestCooldown, async (req, res) => {
    try {
        const bonuses = await getBonuses(req.player.id);

        if (!bonuses.harvestAll) {
            return res.status(400).json({
                error: 'Harvest All skill required',
                code: 'SKILL_REQUIRED'
            });
        }

        const results = await harvestAll(req.player.id);

        if (results.length === 0) {
            return res.json({
                success: true,
                message: 'No plants ready to harvest',
                harvested: []
            });
        }

        // Award XP for all harvests
        let totalXp = 0;
        const rarityMultiplier = { common: 1, uncommon: 1.5, rare: 2, epic: 3, legendary: 5 };

        for (const result of results) {
            const baseXp = 10 + Math.floor(result.quality / 10);
            totalXp += Math.floor(baseXp * (rarityMultiplier[result.rarity] || 1));
        }

        const xpResult = await awardXp(req.player.id, totalXp);

        // Track stats, event points, and achievements for bulk harvest
        await trackStat(req.player.id, 'total_harvests', results.length);
        await trackStat(req.player.id, 'total_plants_grown', results.length);
        await trackStat(req.player.id, 'total_xp_earned', totalXp);
        const maxQuality = Math.max(...results.map(r => r.quality));
        await trackStat(req.player.id, 'highest_quality_grown', maxQuality);
        await awardEventPoints(req.player.id, 10 * results.length); // 10 points per harvest
        checkAchievements(req.player.id).catch(() => {}); // Fire and forget

        // Add heat for raid system (3 per harvest + bonus for epic/legendary)
        let totalHeat = 0;
        for (const result of results) {
            const heatBonus = (result.rarity === 'epic' || result.rarity === 'legendary') ? 8 : 0;
            totalHeat += 3 + heatBonus;
        }
        await addHeat(req.player.id, totalHeat, 'harvest');

        // Award reputation and update tournament scores (fire-and-forget)
        awardReputation(req.player.id, 'growers_guild', results.length).catch(() => {});
        updateTournamentScore(req.player.id, 'harvest', results.length).catch(() => {});
        const mutationsFound = results.filter(r => r.mutation).length;
        if (mutationsFound > 0) {
            awardReputation(req.player.id, 'research_collective', 25 * mutationsFound).catch(() => {});
        }

        res.json({
            success: true,
            harvested: results,
            totalYield: results.reduce((sum, r) => sum + r.yield, 0),
            xpAwarded: xpResult.xpAwarded,
            leveledUp: xpResult.leveledUp,
            newLevel: xpResult.newLevel,
            newXp: xpResult.newXp,
            xpInLevel: xpResult.xpInLevel,
            xpToNextLevel: xpResult.xpForNextLevel
        });

    } catch (error) {
        logger.error('[Grow] Harvest all failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to harvest', code: 'ERROR' });
    }
});

/**
 * POST /grow/bulk-plant
 * Plant same strain in all empty slots (requires skill)
 */
router.post('/bulk-plant', plantCooldown, async (req, res) => {
    try {
        const { strainId } = req.body;

        if (!strainId) {
            return res.status(400).json({ error: 'Strain ID required', code: 'NO_STRAIN' });
        }

        const bonuses = await getBonuses(req.player.id);

        if (!bonuses.bulkPlant) {
            return res.status(400).json({
                error: 'Bulk Plant skill required',
                code: 'SKILL_REQUIRED'
            });
        }

        // Get correct max slots
        const maxSlots = await getMaxSlots(req.player.id, req.player.max_grow_slots);

        // Get empty slots
        const [emptySlots] = await pool.execute(
            `SELECT slot_number FROM cfx_grow_slots
             WHERE player_id = ? AND status = 'empty' AND slot_number <= ?
             ORDER BY slot_number`,
            [req.player.id, maxSlots]
        );

        if (emptySlots.length === 0) {
            return res.json({
                success: true,
                message: 'No empty slots',
                planted: []
            });
        }

        // Check how many seeds are available
        const [[seedCount]] = await pool.execute(
            'SELECT quantity FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ?',
            [req.player.id, strainId]
        );

        const seedsAvailable = seedCount?.quantity || 0;
        if (seedsAvailable === 0) {
            return res.status(400).json({
                error: 'No seeds available for this strain',
                code: 'NO_SEEDS'
            });
        }

        // Only plant up to the number of seeds we have
        const slotsToPlant = emptySlots.slice(0, seedsAvailable);

        const results = [];
        for (const slot of slotsToPlant) {
            try {
                const result = await plantSeed(req.player.id, slot.slot_number, strainId);
                results.push(result);
            } catch (error) {
                // If we run out of seeds, stop planting
                if (error.message.includes('No seeds available')) {
                    break;
                }
                logger.warn('[Grow] Bulk plant slot failed', {
                    playerId: req.player.id,
                    slotNumber: slot.slot_number,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            planted: results
        });

    } catch (error) {
        logger.error('[Grow] Bulk plant failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /grow/quick-plant
 * Auto-plant all empty slots with the best available strains
 * Prioritizes by rarity, then by seed count
 */
router.post('/quick-plant', plantCooldown, async (req, res) => {
    try {
        const playerId = req.player.id;
        const maxSlots = await getMaxSlots(playerId, req.player.max_grow_slots);

        // Get empty slots
        const [emptySlots] = await pool.execute(
            `SELECT slot_number FROM cfx_grow_slots
             WHERE player_id = ? AND status = 'empty' AND slot_number <= ?
             ORDER BY slot_number`,
            [playerId, maxSlots]
        );

        if (emptySlots.length === 0) {
            return res.json({
                success: true,
                message: 'No empty slots',
                planted: []
            });
        }

        // Get available strains sorted by rarity (best first)
        const rarityOrder = "FIELD(s.rarity, 'legendary', 'epic', 'rare', 'uncommon', 'common')";
        const [seedStrains] = await pool.execute(
            `SELECT s.id, s.name, s.rarity, si.quantity as seeds
             FROM cfx_seed_inventory si
             JOIN cfx_strains s ON si.strain_id = s.id
             WHERE si.player_id = ? AND si.quantity > 0
             ORDER BY ${rarityOrder}, si.quantity DESC`,
            [playerId]
        );

        if (seedStrains.length === 0) {
            return res.json({
                success: true,
                message: 'No seeds available',
                planted: []
            });
        }

        const results = [];
        let strainIndex = 0;
        let currentStrain = seedStrains[strainIndex];
        let remainingSeeds = currentStrain.seeds;

        for (const slot of emptySlots) {
            // Move to next strain if we're out of seeds
            while (remainingSeeds <= 0 && strainIndex < seedStrains.length - 1) {
                strainIndex++;
                currentStrain = seedStrains[strainIndex];
                remainingSeeds = currentStrain.seeds;
            }

            if (remainingSeeds <= 0) {
                break; // No more seeds
            }

            try {
                const result = await plantSeed(playerId, slot.slot_number, currentStrain.id);
                results.push({
                    slot: slot.slot_number,
                    strainId: currentStrain.id,
                    strainName: currentStrain.name,
                    rarity: currentStrain.rarity,
                    ...result
                });
                remainingSeeds--;
            } catch (error) {
                if (error.message.includes('No seeds available')) {
                    // Move to next strain
                    if (strainIndex < seedStrains.length - 1) {
                        strainIndex++;
                        currentStrain = seedStrains[strainIndex];
                        remainingSeeds = currentStrain.seeds;
                    } else {
                        break;
                    }
                }
                logger.warn('[Grow] Quick plant slot failed', {
                    playerId,
                    slotNumber: slot.slot_number,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            planted: results,
            slotsPlanted: results.length,
            message: `Planted ${results.length} slot${results.length !== 1 ? 's' : ''}`
        });

    } catch (error) {
        logger.error('[Grow] Quick plant failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /grow/strains
 * Get available strains for planting (those with seeds in inventory)
 */
router.get('/strains', async (req, res) => {
    try {
        // Get strains with seeds in inventory
        const [seedStrains] = await pool.execute(
            `SELECT s.*, si.quantity as seeds_available, d.discovered_at
             FROM cfx_seed_inventory si
             JOIN cfx_strains s ON si.strain_id = s.id
             LEFT JOIN cfx_strain_discoveries d ON s.id = d.strain_id AND d.player_id = si.player_id
             WHERE si.player_id = ? AND si.quantity > 0
             ORDER BY s.rarity DESC, s.name`,
            [req.player.id]
        );

        res.json({
            success: true,
            strains: seedStrains.map(s => ({
                id: s.id,
                name: s.name,
                slug: s.slug,
                strainType: s.strain_type,
                rarity: s.rarity,
                baseGrowTimeMs: s.base_grow_time_ms,
                baseYieldMin: s.base_yield_min,
                baseYieldMax: s.base_yield_max,
                baseQualityMin: s.base_quality_min,
                baseQualityMax: s.base_quality_max,
                basePrice: s.base_price,
                effects: typeof s.effects === 'string' ? JSON.parse(s.effects) : s.effects,
                flavors: typeof s.flavors === 'string' ? JSON.parse(s.flavors) : s.flavors,
                description: s.description,
                discoveredAt: s.discovered_at,
                seedsAvailable: s.seeds_available
            }))
        });

    } catch (error) {
        logger.error('[Grow] Get strains failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /grow/water
 * Water a plant to boost growth
 */
router.post('/water', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { slotNumber } = req.body;

        if (!slotNumber) {
            return res.status(400).json({ error: 'Slot number required', code: 'INVALID_INPUT' });
        }

        // Get the slot
        const [[slot]] = await pool.execute(
            `SELECT * FROM cfx_grow_slots WHERE player_id = ? AND slot_number = ?`,
            [playerId, slotNumber]
        );

        if (!slot) {
            return res.status(404).json({ error: 'Slot not found', code: 'NOT_FOUND' });
        }

        if (slot.status !== 'growing') {
            return res.status(400).json({ error: 'No plant to water', code: 'NOT_GROWING' });
        }

        // Check if already watered recently (cooldown: 5 minutes)
        const lastUpdated = slot.last_updated_at ? new Date(slot.last_updated_at) : null;
        const now = new Date();
        const cooldownMs = 5 * 60 * 1000; // 5 minutes

        // Use last_updated_at as proxy for last watered (water updates this field)
        if (lastUpdated && (now - lastUpdated) < cooldownMs) {
            const remainingMs = cooldownMs - (now - lastUpdated);
            return res.status(400).json({
                error: 'Water cooldown active',
                code: 'COOLDOWN',
                remainingMs
            });
        }

        // Apply water bonus - reduce remaining grow time by 10%
        // Use ready_at (not harvest_at which doesn't exist)
        const readyAt = slot.ready_at ? new Date(slot.ready_at) : null;
        if (!readyAt) {
            return res.status(400).json({ error: 'Plant has no ready time set', code: 'NO_READY_TIME' });
        }

        const remainingTime = readyAt - now;
        if (remainingTime <= 0) {
            return res.status(400).json({ error: 'Plant is already ready', code: 'ALREADY_READY' });
        }

        const timeReduction = Math.floor(remainingTime * 0.1); // 10% reduction
        const newReadyAt = new Date(readyAt.getTime() - timeReduction);

        await pool.execute(
            `UPDATE cfx_grow_slots
             SET ready_at = ?, last_updated_at = NOW()
             WHERE player_id = ? AND slot_number = ?`,
            [newReadyAt, playerId, slotNumber]
        );

        res.json({
            success: true,
            timeReduced: timeReduction,
            newReadyAt
        });

    } catch (error) {
        logger.error('[Grow] Water failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /grow/remove
 * Remove a plant from a slot (destroys the plant)
 */
router.post('/remove', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { slotNumber } = req.body;

        if (!slotNumber) {
            return res.status(400).json({ error: 'Slot number required', code: 'INVALID_INPUT' });
        }

        // Get the slot
        const [[slot]] = await pool.execute(
            `SELECT * FROM cfx_grow_slots WHERE player_id = ? AND slot_number = ?`,
            [playerId, slotNumber]
        );

        if (!slot) {
            return res.status(404).json({ error: 'Slot not found', code: 'NOT_FOUND' });
        }

        if (slot.status === 'empty') {
            return res.status(400).json({ error: 'Slot already empty', code: 'ALREADY_EMPTY' });
        }

        // Clear the slot (use correct column names from schema)
        await pool.execute(
            `UPDATE cfx_grow_slots
             SET status = 'empty', strain_id = NULL, planted_at = NULL, ready_at = NULL,
                 wither_at = NULL, grow_duration_ms = NULL, base_quality = NULL,
                 accumulated_growth_ms = 0, last_updated_at = NULL
             WHERE player_id = ? AND slot_number = ?`,
            [playerId, slotNumber]
        );

        logger.info('[Grow] Plant removed', {
            playerId,
            slotNumber,
            strainId: slot.strain_id
        });

        res.json({
            success: true,
            slot: {
                slotNumber,
                status: 'empty',
                strainId: null
            }
        });

    } catch (error) {
        logger.error('[Grow] Remove failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
