/**
 * Core Game Engine
 * Handles tick processing, offline catch-up, and state calculations
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { MutexManager } from '../../../utils/mutex.js';
import { GAME } from '../config/game-constants.js';
import { processGrowthTick } from './growth-system.js';
import { getBonuses } from './bonus-resolver.js';
import { assignQuests } from './quest-system.js';
import { checkAchievements } from '../routes/achievements.js';
import { getRaidStatus } from './raid-system.js';
import { getTotalSlots } from '../routes/locations.js';

// Per-player mutex to prevent race conditions
const playerMutex = new MutexManager({
    name: 'cfx-player',
    maxSize: 10000,
    timeout: 30000
});

/**
 * Get a player mutex lock - returns a release function
 * @param {string} playerId - Player identifier
 * @returns {Promise<Function>} Release function to call when done
 */
export async function getPlayerMutex(playerId) {
    const mutex = playerMutex.getMutex(playerId);
    return await mutex.acquire();
}

/**
 * Calculate XP needed for a level
 * @param {number} level - Target level
 * @returns {number} XP needed
 */
export function xpForLevel(level) {
    if (level <= 1) return 0;
    return Math.floor(
        GAME.XP_PER_LEVEL_BASE * Math.pow(GAME.XP_PER_LEVEL_MULTIPLIER, level - 1)
    );
}

/**
 * Calculate total XP needed from level 1 to target level
 * @param {number} level - Target level
 * @returns {number} Total XP needed
 */
export function totalXpForLevel(level) {
    let total = 0;
    for (let i = 2; i <= level; i++) {
        total += xpForLevel(i);
    }
    return total;
}

/**
 * Calculate level from total XP
 * @param {number} totalXp - Total XP earned
 * @returns {{level: number, xpInLevel: number, xpForNextLevel: number}}
 */
export function levelFromXp(totalXp) {
    let level = 1;
    let remainingXp = totalXp;

    while (level < GAME.MAX_LEVEL) {
        const needed = xpForLevel(level + 1);
        if (remainingXp < needed) break;
        remainingXp -= needed;
        level++;
    }

    return {
        level,
        xpInLevel: remainingXp,
        xpForNextLevel: level < GAME.MAX_LEVEL ? xpForLevel(level + 1) : 0
    };
}

/**
 * Award XP to a player (handles leveling up)
 * @param {number} playerId - Player ID
 * @param {number} amount - Base XP amount
 * @returns {{newXp: number, newLevel: number, leveledUp: boolean, levelsGained: number}}
 */
export async function awardXp(playerId, amount) {
    const sanitizedAmount = Number(amount);
    if (!Number.isFinite(sanitizedAmount) || sanitizedAmount <= 0) {
        return { xpAwarded: 0, newXp: 0, level: 0, leveledUp: false };
    }

    return playerMutex.runExclusive(`xp:${playerId}`, async () => {
        // Use transaction with FOR UPDATE lock to prevent race conditions
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // FOR UPDATE locks the row until transaction completes
            const [[player]] = await conn.execute(
                'SELECT xp, level, prestige_level, skill_points FROM cfx_players WHERE id = ? FOR UPDATE',
                [playerId]
            );

            if (!player) {
                await conn.rollback();
                throw new Error('Player not found');
            }

            // Get bonuses
            const bonuses = await getBonuses(playerId);

            // Apply XP bonuses (safely handle null prestige_level)
            const xpMultiplier = 1 + (bonuses.xpBonus || 0) + ((player.prestige_level || 0) * 0.02);
            const finalXp = Math.floor(sanitizedAmount * xpMultiplier);

            const currentXp = parseInt(player.xp) || 0;
            const newTotalXp = currentXp + finalXp;
            const levelInfo = levelFromXp(newTotalXp);

            const leveledUp = levelInfo.level > player.level;
            const levelsGained = levelInfo.level - player.level;

            // Award 1 skill point per level gained
            const skillPointsAwarded = levelsGained;
            const newSkillPoints = (player.skill_points || 0) + skillPointsAwarded;

            // Update player
            await conn.execute(
                'UPDATE cfx_players SET xp = ?, level = ?, skill_points = ? WHERE id = ?',
                [newTotalXp, levelInfo.level, newSkillPoints, playerId]
            );

            await conn.commit();

            if (leveledUp) {
                logger.info('[Engine] Player leveled up', {
                    playerId,
                    oldLevel: player.level,
                    newLevel: levelInfo.level,
                    xpAwarded: finalXp,
                    skillPointsAwarded
                });

                // Update quest progress for level up (outside transaction)
                const { updateQuestProgress } = await import('./quest-system.js');
                await updateQuestProgress(playerId, 'level_up', levelsGained);
            }

            // Update quest progress for XP earned (outside transaction)
            const { updateQuestProgress } = await import('./quest-system.js');
            await updateQuestProgress(playerId, 'earn_xp', finalXp);

            return {
                xpAwarded: finalXp,
                newXp: newTotalXp,
                newLevel: levelInfo.level,
                leveledUp,
                levelsGained,
                skillPointsAwarded,
                newSkillPoints,
                xpInLevel: levelInfo.xpInLevel,
                xpForNextLevel: levelInfo.xpForNextLevel
            };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    });
}

/**
 * Award cash to a player
 * @param {number} playerId - Player ID
 * @param {number} amount - Cash amount
 * @returns {{newCash: number, bonusApplied: number}}
 */
export async function awardCash(playerId, amount) {
    // Sanitize amount - must be a finite positive number
    const sanitizedAmount = Number(amount);
    if (!Number.isFinite(sanitizedAmount) || sanitizedAmount <= 0) {
        return { cashAwarded: 0, newCash: 0, bonusApplied: 0 };
    }

    return playerMutex.runExclusive(`cash:${playerId}`, async () => {
        // Use transaction with FOR UPDATE lock to prevent race conditions
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[player]] = await conn.execute(
                'SELECT cash, prestige_level FROM cfx_players WHERE id = ? FOR UPDATE',
                [playerId]
            );

            if (!player) {
                await conn.rollback();
                throw new Error('Player not found');
            }

            // Get bonuses
            const bonuses = await getBonuses(playerId);

            // Apply cash bonuses (safely handle null prestige_level)
            const cashMultiplier = 1 + (bonuses.incomeBonus || 0) + ((player.prestige_level || 0) * 0.01);
            const finalCash = Math.floor(sanitizedAmount * cashMultiplier);

            const currentCash = parseInt(player.cash, 10) || 0;
            const newCash = currentCash + finalCash;

            // Use integers for SQL to avoid DOUBLE type coercion issues with BIGINT columns
            await conn.execute(
                'UPDATE cfx_players SET cash = ?, lifetime_earnings = lifetime_earnings + ? WHERE id = ?',
                [Math.round(newCash), Math.round(finalCash), playerId]
            );

            await conn.commit();
            return {
                cashAwarded: finalCash,
                newCash,
                bonusApplied: cashMultiplier - 1
            };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    });
}

/**
 * Deduct cash from a player
 * @param {number} playerId - Player ID
 * @param {number} amount - Cash amount
 * @returns {{success: boolean, newCash: number}}
 */
export async function deductCash(playerId, amount) {
    return playerMutex.runExclusive(`cash:${playerId}`, async () => {
        // Use transaction with FOR UPDATE lock to prevent race conditions
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // FOR UPDATE locks the row until transaction completes
            const [[player]] = await conn.execute(
                'SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE',
                [playerId]
            );

            if (!player) {
                await conn.rollback();
                throw new Error('Player not found');
            }

            // Ensure cash is a valid number
            const currentCash = parseInt(player.cash, 10) || 0;
            if (currentCash < amount) {
                await conn.rollback();
                return { success: false, newCash: currentCash, needed: amount };
            }

            const newCash = currentCash - Math.floor(amount);

            await conn.execute(
                'UPDATE cfx_players SET cash = ? WHERE id = ?',
                [Math.round(newCash), playerId]
            );

            await conn.commit();
            return { success: true, newCash };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    });
}

/**
 * Process offline catch-up for a player
 * Called when player reconnects after being offline
 * @param {number} playerId - Player ID
 * @returns {object} Catch-up results
 */
export async function processOfflineCatchUp(playerId) {
    return playerMutex.runExclusive(`tick:${playerId}`, async () => {
        const [[player]] = await pool.execute(
            'SELECT * FROM cfx_players WHERE id = ?',
            [playerId]
        );

        if (!player) {
            throw new Error('Player not found');
        }

        const now = Date.now();
        // Handle null/invalid last_tick_at - default to now (no offline time)
        const lastTickDate = player.last_tick_at ? new Date(player.last_tick_at) : new Date();
        const lastTick = isNaN(lastTickDate.getTime()) ? now : lastTickDate.getTime();
        const offlineMs = now - lastTick;

        // Cap offline time (24 hours max)
        const maxOfflineMs = 24 * 60 * 60 * 1000;
        const processMs = Math.min(offlineMs, maxOfflineMs);

        if (processMs < 1000) {
            // Less than 1 second, nothing to process
            return { processed: false, reason: 'too_recent' };
        }

        logger.debug('[Engine] Processing offline catch-up', {
            playerId,
            offlineMs,
            processMs
        });

        // Process growth
        const growthResults = await processGrowthTick(playerId, processMs, now);

        // Update last tick time
        await pool.execute(
            'UPDATE cfx_players SET last_tick_at = NOW(), total_playtime_seconds = total_playtime_seconds + ? WHERE id = ?',
            [Math.floor(processMs / 1000), playerId]
        );

        // Check for expired boosts
        await pool.execute(
            'DELETE FROM cfx_active_boosts WHERE player_id = ? AND expires_at < ?',
            [playerId, now]
        );

        return {
            processed: true,
            offlineSeconds: Math.floor(offlineMs / 1000),
            processedSeconds: Math.floor(processMs / 1000),
            growth: growthResults
        };
    });
}

/**
 * Get full game state for a player
 * Uses parallel queries for maximum performance
 * @param {number} playerId - Player ID
 * @returns {object} Complete game state
 */
export async function getFullGameState(playerId) {
    // Process any pending offline time first
    const catchUp = await processOfflineCatchUp(playerId);

    // Run initialization tasks in parallel
    await Promise.all([
        assignQuests(playerId),
        checkAchievements(playerId)
    ]);

    // Execute all independent queries in parallel for maximum performance
    const now = Date.now();
    const [
        [playerRows],
        [slots],
        [inventory],
        [strainsWithSeeds],
        [discoveries],
        [skills],
        [quests],
        [boosts],
        [breeding],
        [trades],
        [listings]
    ] = await Promise.all([
        // Get player data
        pool.execute(
            'SELECT * FROM cfx_players WHERE id = ?',
            [playerId]
        ),
        // Get grow slots
        pool.execute(
            `SELECT gs.*, s.name as strain_name, s.slug as strain_slug, s.rarity
             FROM cfx_grow_slots gs
             LEFT JOIN cfx_strains s ON gs.strain_id = s.id
             WHERE gs.player_id = ?
             ORDER BY gs.slot_number`,
            [playerId]
        ),
        // Get inventory
        pool.execute(
            `SELECT i.*, s.name as strain_name, s.slug as strain_slug, s.rarity
             FROM cfx_inventory i
             JOIN cfx_strains s ON i.strain_id = s.id
             WHERE i.player_id = ? AND i.quantity > 0
             ORDER BY i.harvested_at DESC`,
            [playerId]
        ),
        // Get strains with seeds (for planting)
        pool.execute(
            `SELECT s.*, si.quantity as seeds_available
             FROM cfx_seed_inventory si
             JOIN cfx_strains s ON si.strain_id = s.id
             WHERE si.player_id = ? AND si.quantity > 0
             ORDER BY s.rarity DESC, s.name`,
            [playerId]
        ),
        // Get discovered strains (for display/info)
        pool.execute(
            `SELECT s.* FROM cfx_strains s
             JOIN cfx_strain_discoveries d ON s.id = d.strain_id
             WHERE d.player_id = ?`,
            [playerId]
        ),
        // Get unlocked skills
        pool.execute(
            `SELECT ps.*, sn.skill_key, sn.name, sn.effect_type, sn.effect_value_per_rank
             FROM cfx_player_skills ps
             JOIN cfx_skill_nodes sn ON ps.skill_id = sn.id
             WHERE ps.player_id = ?`,
            [playerId]
        ),
        // Get active quests
        pool.execute(
            `SELECT pq.*, qd.name, qd.description, qd.quest_type, qd.objective_type,
                    qd.reward_cash, qd.reward_xp, qd.reward_prestige_tokens
             FROM cfx_player_quests pq
             JOIN cfx_quest_definitions qd ON pq.quest_id = qd.id
             WHERE pq.player_id = ? AND pq.status IN ('active', 'completed')`,
            [playerId]
        ),
        // Get active boosts
        pool.execute(
            `SELECT * FROM cfx_active_boosts
             WHERE player_id = ? AND expires_at > ?`,
            [playerId, now]
        ),
        // Get active breeding operations
        pool.execute(
            `SELECT bo.*, s1.name as parent1_name, s2.name as parent2_name
             FROM cfx_breeding_operations bo
             JOIN cfx_strains s1 ON bo.parent_1_strain_id = s1.id
             JOIN cfx_strains s2 ON bo.parent_2_strain_id = s2.id
             WHERE bo.player_id = ? AND bo.status IN ('breeding', 'ready')`,
            [playerId]
        ),
        // Get pending trades
        pool.execute(
            `SELECT * FROM cfx_trades
             WHERE (offerer_id = ? OR receiver_id = ?) AND status = 'pending'`,
            [playerId, playerId]
        ),
        // Get active market listings
        pool.execute(
            `SELECT ml.*, s.name as strain_name
             FROM cfx_market_listings ml
             JOIN cfx_strains s ON ml.strain_id = s.id
             WHERE ml.player_id = ? AND ml.status = 'active'`,
            [playerId]
        )
    ]);

    const player = playerRows[0];

    // Get bonuses, raid status, and location slots in parallel
    const [bonuses, raidStatus, locationSlots] = await Promise.all([
        getBonuses(playerId),
        getRaidStatus(playerId).catch(e => {
            logger.warn('[GameState] Could not get raid status', { error: e.message });
            return null;
        }),
        getTotalSlots(playerId).catch(() => 0)
    ]);

    // Calculate actual max slots (location system overrides legacy player.max_grow_slots)
    const maxGrowSlots = Math.max(locationSlots || 0, player.max_grow_slots || 2);

    // Calculate level info
    const levelInfo = levelFromXp(player.xp);

    // Auto-create missing grow slots if location capacity exceeds actual slot rows
    let finalSlots = slots;
    if (slots.length < maxGrowSlots) {
        const existingSlotNumbers = new Set(slots.map(s => s.slot_number));
        const slotsToCreate = [];

        for (let i = 1; i <= maxGrowSlots; i++) {
            if (!existingSlotNumbers.has(i)) {
                slotsToCreate.push([playerId, i]);
            }
        }

        if (slotsToCreate.length > 0) {
            try {
                const placeholders = slotsToCreate.map(() => '(?, ?)').join(', ');
                const values = slotsToCreate.flat();
                await pool.execute(
                    `INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES ${placeholders}`,
                    values
                );

                // Re-fetch all slots with the new ones
                const [newSlots] = await pool.execute(
                    `SELECT gs.*, s.name as strain_name, s.slug as strain_slug, s.rarity
                     FROM cfx_grow_slots gs
                     LEFT JOIN cfx_strains s ON gs.strain_id = s.id
                     WHERE gs.player_id = ?
                     ORDER BY gs.slot_number`,
                    [playerId]
                );
                finalSlots = newSlots;

                logger.info('[GameState] Auto-created missing grow slots', {
                    playerId,
                    created: slotsToCreate.length,
                    totalSlots: maxGrowSlots
                });
            } catch (slotErr) {
                logger.warn('[GameState] Failed to auto-create slots', { error: slotErr.message });
            }
        }
    }

    return {
        catchUp,
        player: {
            id: player.id,
            displayName: player.display_name,
            avatarUrl: player.avatar_url,
            cash: player.cash,
            lifetimeEarnings: player.lifetime_earnings,
            lifetimeSales: player.lifetime_sales,
            facilityName: player.facility_name,
            facilityLevel: player.facility_level,
            maxGrowSlots: maxGrowSlots,
            level: levelInfo.level,
            xp: player.xp,
            xpInLevel: levelInfo.xpInLevel,
            xpForNextLevel: levelInfo.xpForNextLevel,
            prestigeLevel: player.prestige_level,
            prestigeTokens: player.prestige_tokens,
            skillPoints: player.skill_points || 0,
            tutorialCompleted: player.tutorial_completed === 1
        },
        bonuses,
        slots: finalSlots.map(s => ({
            slotNumber: s.slot_number,
            strainId: s.strain_id,
            strainName: s.strain_name,
            strainSlug: s.strain_slug,
            rarity: s.rarity,
            status: s.status,
            plantedAt: s.planted_at,
            growDurationMs: s.grow_duration_ms,
            readyAt: s.ready_at,
            witherAt: s.wither_at,
            baseQuality: s.base_quality,
            accumulatedGrowthMs: s.accumulated_growth_ms
        })),
        inventory: inventory.map(i => ({
            id: i.id,
            strainId: i.strain_id,
            strainName: i.strain_name,
            strainSlug: i.strain_slug,
            rarity: i.rarity,
            quantity: i.quantity,
            quality: i.quality,
            source: i.source,
            harvestedAt: i.harvested_at
        })),
        // Strains available for planting (have seeds in inventory)
        unlockedStrains: strainsWithSeeds.map(s => ({
            id: s.id,
            name: s.name,
            slug: s.slug,
            strainType: s.strain_type,
            rarity: s.rarity,
            baseGrowTimeMs: s.base_grow_time_ms,
            baseYieldMin: s.base_yield_min,
            baseYieldMax: s.base_yield_max,
            basePrice: s.base_price,
            seedsAvailable: s.seeds_available
        })),
        // All discovered strains (for encyclopedia/info)
        discoveries: discoveries.map(d => ({
            id: d.id,
            name: d.name,
            slug: d.slug,
            strainType: d.strain_type,
            rarity: d.rarity,
            baseGrowTimeMs: d.base_grow_time_ms,
            baseYieldMin: d.base_yield_min,
            baseYieldMax: d.base_yield_max,
            basePrice: d.base_price
        })),
        skills: skills.map(s => ({
            skillKey: s.skill_key,
            name: s.name,
            currentRank: s.current_rank,
            effectType: s.effect_type,
            effectValue: s.effect_value_per_rank * s.current_rank
        })),
        quests,
        boosts: boosts.map(b => ({
            boostType: b.boost_type,
            multiplier: parseFloat(b.multiplier),
            expiresAt: b.expires_at
        })),
        breeding: breeding.map(b => ({
            id: b.id,
            parent1StrainId: b.parent_1_strain_id,
            parent2StrainId: b.parent_2_strain_id,
            parent1Name: b.parent1_name,
            parent2Name: b.parent2_name,
            status: b.status,
            startedAt: b.started_at ? new Date(b.started_at).getTime() : null,
            readyAt: b.ready_at ? new Date(b.ready_at).getTime() : null,
            completeAt: b.ready_at ? new Date(b.ready_at).getTime() : null // alias for frontend
        })),
        trades,
        listings,
        raidStatus,
        serverTime: Date.now()
    };
}

export default {
    xpForLevel,
    totalXpForLevel,
    levelFromXp,
    awardXp,
    awardCash,
    deductCash,
    processOfflineCatchUp,
    getFullGameState,
    getPlayerMutex,
    playerMutex
};
