/**
 * Bonus Resolver
 * Aggregates all bonuses from skills, boosts, prestige, and bot stats
 */

import pool from '../../../utils/db.js';
import { BOT_BONUSES, PRESTIGE } from '../config/game-constants.js';
import { getWorkerBonuses } from '../routes/workers-enhanced.js';
import { getResearchBonuses } from './research-helper.js';
import { getEquipmentBonuses } from '../routes/equipment.js';
import { getLocationBonuses } from '../routes/locations.js';
import { getCartelBonuses } from '../routes/cartels.js';
import { getReputationBonuses } from '../routes/reputation.js';
import { getEventBonuses } from '../routes/random-events.js';
import { createTTLCache } from '../../../utils/cacheUtils.js';

// Cache for player bonuses - 15 second TTL since bonuses change infrequently
const bonusCache = createTTLCache(15000, 1000, 'bonus-resolver');

/**
 * Invalidate bonus cache for a player
 * Call this when skills, boosts, or other bonus sources change
 * @param {number} playerId - Player ID
 */
export function invalidateBonusCache(playerId) {
    bonusCache.delete(`bonuses:${playerId}`);
}

/**
 * Get all bonuses for a player (with caching)
 * @param {number} playerId - Player ID
 * @param {boolean} skipCache - Skip cache and fetch fresh
 * @returns {object} Combined bonuses
 */
export async function getBonuses(playerId, skipCache = false) {
    const cacheKey = `bonuses:${playerId}`;

    // Check cache first
    if (!skipCache) {
        const cached = bonusCache.get(cacheKey);
        if (cached) return cached;
    }

    const bonuses = await _computeBonuses(playerId);

    // Cache the result
    bonusCache.set(cacheKey, bonuses);

    return bonuses;
}

/**
 * Internal: Compute bonuses (uncached) - OPTIMIZED with parallel queries
 */
async function _computeBonuses(playerId) {
    const bonuses = {
        // Growth modifiers
        growSpeed: 0,      // Reduces grow time (0.1 = 10% faster)
        yieldBonus: 0,     // Increases yield
        qualityBonus: 0,   // Increases quality

        // Economy modifiers
        sellPriceBonus: 0, // Better sell prices
        incomeBonus: 0,    // All income
        feeReduction: 0,   // Market fee reduction

        // XP modifier
        xpBonus: 0,

        // Special abilities
        doubleHarvestChance: 0,
        witherResist: 0,   // Extra time before wither
        noWither: false,   // Auto-water (prevents withering)
        harvestAll: false, // Can harvest all at once
        bulkPlant: false,  // Can plant same strain in all slots
        autoSell: false,   // Auto-sell below threshold

        // Breeding
        breedingUnlocked: false,
        breedingPreview: false,
        mutationChance: 0,
        breedQualityFloor: 0,
        breedingSlots: 1,
        legendaryBreeding: false,

        // Other
        extraSlots: 0,
        extraListings: 0,
        inventorySlots: 100, // Base inventory
        offlineBonus: 0,    // Offline growth efficiency
        priceInsight: false,

        // Worker-specific bonuses
        researchSpeed: 0,     // Research time reduction (from Research Assistant)
        extractionBonus: 0,   // Extraction quality boost (from Extraction Specialist)
        dispensaryBonus: 0,   // Dispensary efficiency (from Dispensary Manager)

        // Equipment bonuses
        heatReduction: 0      // Heat reduction (from security equipment)
    };

    const now = Date.now();

    // Run ALL queries in parallel for maximum performance
    const [
        [playerRows],
        [skills],
        [boosts],
        [shopBoosters],
        [botBonusRows],
        [prestigeUpgrades],
        [facilityUpgrades],
        workerBonuses,
        researchBonuses,
        equipmentBonuses,
        locationData,
        cartelBonuses,
        repBonuses,
        eventBonuses
    ] = await Promise.all([
        // 1. Player prestige level
        pool.execute('SELECT prestige_level FROM cfx_players WHERE id = ?', [playerId]),
        // 2. Skills
        pool.execute(
            `SELECT sn.effect_type, sn.effect_value_per_rank, ps.current_rank
             FROM cfx_player_skills ps
             JOIN cfx_skill_nodes sn ON ps.skill_id = sn.id
             WHERE ps.player_id = ?`,
            [playerId]
        ),
        // 3. Active boosts
        pool.execute(
            `SELECT boost_type, multiplier FROM cfx_active_boosts
             WHERE player_id = ? AND expires_at > ?`,
            [playerId, now]
        ),
        // 4. Shop boosters
        pool.execute(
            `SELECT effect_type, multiplier, bonus, uses_remaining FROM cfx_player_shop_items
             WHERE player_id = ?
             AND item_type = 'booster'
             AND activated = 1
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (uses_remaining IS NULL OR uses_remaining > 0)`,
            [playerId]
        ),
        // 5. Bot bonuses
        pool.execute('SELECT * FROM cfx_player_bot_bonuses WHERE player_id = ?', [playerId]),
        // 6. Prestige upgrades
        pool.execute('SELECT upgrade_id, level FROM cfx_prestige_upgrades WHERE player_id = ?', [playerId]),
        // 7. Facility upgrades
        pool.execute('SELECT upgrade_key, current_level FROM cfx_facility_upgrades WHERE player_id = ?', [playerId]),
        // 8. Worker bonuses
        getWorkerBonuses(playerId).catch(() => ({})),
        // 9. Research bonuses
        getResearchBonuses(playerId).catch(() => ({})),
        // 10. Equipment bonuses
        getEquipmentBonuses(playerId).catch(() => ({})),
        // 11. Location bonuses
        getLocationBonuses(playerId).catch(() => ({ bonuses: {}, heatModifier: 1.0 })),
        // 12. Cartel bonuses
        getCartelBonuses(playerId).catch(() => null),
        // 13. Reputation bonuses
        getReputationBonuses(playerId).catch(() => null),
        // 14. Event bonuses
        getEventBonuses(playerId).catch(() => null)
    ]);

    // Process player prestige level bonuses
    const player = playerRows[0];
    if (player) {
        bonuses.xpBonus += player.prestige_level * PRESTIGE.XP_BONUS_PER_PRESTIGE;
        bonuses.yieldBonus += player.prestige_level * PRESTIGE.YIELD_BONUS_PER_PRESTIGE;
        bonuses.incomeBonus += player.prestige_level * PRESTIGE.CASH_BONUS_PER_PRESTIGE;
    }

    // Process prestige upgrades (purchased with prestige tokens)
    // Effect values per level for each upgrade type
    const upgradeEffects = {
        xp_boost: [0.05, 0.10, 0.15, 0.25, 0.40],
        yield_boost: [0.05, 0.10, 0.15, 0.25, 0.40],
        growth_speed: [0.05, 0.10, 0.15, 0.20, 0.30],
        quality_boost: [0.05, 0.10, 0.15, 0.20, 0.30]
    };
    for (const upgrade of prestigeUpgrades) {
        const effects = upgradeEffects[upgrade.upgrade_id];
        if (effects && upgrade.level > 0) {
            const effectValue = effects[upgrade.level - 1] || 0;
            switch (upgrade.upgrade_id) {
                case 'xp_boost': bonuses.xpBonus += effectValue; break;
                case 'yield_boost': bonuses.yieldBonus += effectValue; break;
                case 'growth_speed': bonuses.growSpeed += effectValue; break;
                case 'quality_boost': bonuses.qualityBonus += effectValue; break;
                // starting_cash and starting_slots are applied at prestige reset, not as bonuses
            }
        }
    }

    // Process facility upgrades
    // Effect definitions: upgrade_key -> { bonusKey, valuePerLevel }
    const facilityEffects = {
        lighting: { bonusKey: 'qualityBonus', valuePerLevel: 0.02 },      // +2% quality per level
        ventilation: { bonusKey: 'growSpeed', valuePerLevel: 0.02 },      // +2% grow speed per level
        irrigation: { bonusKey: 'yieldBonus', valuePerLevel: 0.02 },      // +2% yield per level
        security: { bonusKey: 'witherResist', valuePerLevel: 0.1 },       // +10% wither resist per level
        storage: { bonusKey: 'inventorySlots', valuePerLevel: 25 }        // +25 inventory slots per level
        // grow_slots handled separately in facility.js (updates max_grow_slots directly)
    };
    for (const upgrade of facilityUpgrades) {
        const effect = facilityEffects[upgrade.upgrade_key];
        if (effect && upgrade.current_level > 0) {
            bonuses[effect.bonusKey] += effect.valuePerLevel * upgrade.current_level;
        }
    }

    // Process skills
    for (const skill of skills) {
        const value = skill.effect_value_per_rank * skill.current_rank;

        switch (skill.effect_type) {
            case 'yield_bonus': bonuses.yieldBonus += value; break;
            case 'grow_speed': bonuses.growSpeed += value; break;
            case 'quality_bonus': bonuses.qualityBonus += value; break;
            case 'double_harvest_chance': bonuses.doubleHarvestChance += value; break;
            case 'wither_resist': bonuses.witherResist += value; break;
            case 'no_wither': bonuses.noWither = true; break;
            case 'sell_price_bonus': bonuses.sellPriceBonus += value; break;
            case 'price_insight': bonuses.priceInsight = true; break;
            case 'fee_reduction': bonuses.feeReduction += value; break;
            case 'extra_listings': bonuses.extraListings += value; break;
            case 'xp_bonus': bonuses.xpBonus += value; break;
            case 'income_bonus': bonuses.incomeBonus += value; break;
            case 'breeding_unlock':
            case 'unlock_breeding': bonuses.breedingUnlocked = true; break;
            case 'breeding_preview': bonuses.breedingPreview = true; break;
            case 'mutation_chance': bonuses.mutationChance += value; break;
            case 'breed_quality_floor': bonuses.breedQualityFloor += value; break;
            case 'breeding_slots': bonuses.breedingSlots += value; break;
            case 'legendary_breeding': bonuses.legendaryBreeding = true; break;
            case 'extra_slots': bonuses.extraSlots += value; break;
            case 'harvest_all': bonuses.harvestAll = true; break;
            case 'bulk_plant': bonuses.bulkPlant = true; break;
            case 'inventory_slots': bonuses.inventorySlots += value; break;
            case 'auto_sell': bonuses.autoSell = true; break;
            case 'offline_bonus': bonuses.offlineBonus += value; break;
        }
    }

    // Process active boosts
    for (const boost of boosts) {
        switch (boost.boost_type) {
            case 'growth_speed': bonuses.growSpeed += (boost.multiplier - 1); break;
            case 'xp': bonuses.xpBonus += (boost.multiplier - 1); break;
            case 'yield': bonuses.yieldBonus += (boost.multiplier - 1); break;
            case 'quality': bonuses.qualityBonus += (boost.multiplier - 1); break;
        }
    }

    // Process shop boosters
    for (const booster of shopBoosters) {
        const mult = parseFloat(booster.multiplier) || 1;
        const bonus = booster.bonus || 0;

        switch (booster.effect_type) {
            case 'speed': bonuses.growSpeed += (mult - 1); break;
            case 'yield': bonuses.yieldBonus += (mult - 1); break;
            case 'xp': bonuses.xpBonus += (mult - 1); break;
            case 'quality': bonuses.qualityBonus += (bonus / 100); break;
        }
    }

    // Process bot bonuses
    const botBonus = botBonusRows[0];
    if (botBonus) {
        bonuses.growSpeed += parseFloat(botBonus.growth_speed_bonus) || 0;
        bonuses.yieldBonus += parseFloat(botBonus.yield_bonus) || 0;
        bonuses.xpBonus += parseFloat(botBonus.xp_bonus) || 0;
        bonuses.sellPriceBonus += parseFloat(botBonus.sell_price_bonus) || 0;
    }

    // Process worker bonuses
    if (workerBonuses) {
        bonuses.qualityBonus += workerBonuses.qualityBonus || 0;
        bonuses.sellPriceBonus += workerBonuses.efficiencyBonus || 0;
        bonuses.inventorySlots += workerBonuses.storageBonus || 0;
        bonuses.researchSpeed += workerBonuses.researchSpeed || 0;
        bonuses.extractionBonus += workerBonuses.extractionBonus || 0;
        bonuses.dispensaryBonus += workerBonuses.dispensaryBonus || 0;
        bonuses.growSpeed += workerBonuses.growthSpeed || 0;
        bonuses.sellPriceBonus += workerBonuses.priceBonus || 0;
        bonuses.doubleHarvestChance += workerBonuses.exceptionalChance || 0;
    }

    // Process research bonuses
    if (researchBonuses) {
        bonuses.growSpeed += researchBonuses.grow_speed || 0;
        bonuses.yieldBonus += researchBonuses.yield_bonus || 0;
        bonuses.qualityBonus += researchBonuses.quality_bonus || 0;
        bonuses.sellPriceBonus += researchBonuses.sale_bonus || 0;
        bonuses.mutationChance += researchBonuses.mutation_chance || 0;
    }

    // Process equipment bonuses
    if (equipmentBonuses) {
        bonuses.growSpeed += equipmentBonuses.grow_speed || 0;
        bonuses.yieldBonus += equipmentBonuses.yield_bonus || 0;
        bonuses.qualityBonus += equipmentBonuses.quality_bonus || 0;
        if (equipmentBonuses.heat_reduction) {
            bonuses.heatReduction += equipmentBonuses.heat_reduction;
        }
    }

    // Process location bonuses
    if (locationData && locationData.bonuses) {
        for (const [key, value] of Object.entries(locationData.bonuses)) {
            if (bonuses[key] !== undefined) {
                bonuses[key] += value;
            }
        }
        if (locationData.heatModifier && locationData.heatModifier !== 1.0) {
            bonuses.heatReduction += (1 - locationData.heatModifier);
        }
    }

    // Process cartel bonuses
    if (cartelBonuses) {
        bonuses.growSpeed += cartelBonuses.growSpeed || 0;
        bonuses.yieldBonus += cartelBonuses.yieldBonus || 0;
        bonuses.qualityBonus += cartelBonuses.qualityBonus || 0;
        bonuses.sellPriceBonus += cartelBonuses.sellBonus || 0;
        bonuses.xpBonus += cartelBonuses.xpBonus || 0;
    }

    // Process reputation bonuses
    if (repBonuses) {
        bonuses.sellPriceBonus += repBonuses.priceBonus || 0;
        bonuses.heatReduction += repBonuses.heatReduction || 0;
    }

    // Process event bonuses
    if (eventBonuses) {
        for (const [key, value] of Object.entries(eventBonuses)) {
            if (bonuses[key] !== undefined && typeof value === 'number') {
                bonuses[key] += value;
            }
        }
    }

    return bonuses;
}

/**
 * Calculate bot bonuses from tokes profile stats
 * @param {object} tokesProfile - Tokes profile data
 * @returns {object} Calculated bonuses
 */
export function calculateBotBonuses(tokesProfile) {
    const bonuses = {
        growth_speed_bonus: 0,
        yield_bonus: 0,
        xp_bonus: 0,
        sell_price_bonus: 0
    };

    if (!tokesProfile) return bonuses;

    const level = tokesProfile.level || 1;
    const streak = tokesProfile.daily_streak || 0;
    const totalTokes = tokesProfile.total_tokes || 0;

    // Level bonuses
    bonuses.growth_speed_bonus = Math.min(
        level * BOT_BONUSES.GROW_SPEED_PER_LEVEL,
        BOT_BONUSES.GROW_SPEED_CAP
    );
    bonuses.xp_bonus = Math.min(
        level * BOT_BONUSES.XP_PER_LEVEL,
        BOT_BONUSES.XP_CAP
    );

    // Streak bonuses
    bonuses.yield_bonus = Math.min(
        streak * BOT_BONUSES.YIELD_PER_STREAK_DAY,
        BOT_BONUSES.YIELD_STREAK_CAP
    );
    bonuses.sell_price_bonus = Math.min(
        streak * BOT_BONUSES.PRICE_PER_STREAK_DAY,
        BOT_BONUSES.PRICE_STREAK_CAP
    );

    // Tokes milestone bonuses
    for (const [milestone, reward] of Object.entries(BOT_BONUSES.MILESTONES)) {
        if (totalTokes >= parseInt(milestone)) {
            if (reward.type === 'quality_bonus') {
                // This would need to be tracked separately
            } else if (reward.type === 'cash_bonus') {
                bonuses.sell_price_bonus += reward.value;
            }
        }
    }

    return bonuses;
}

export default { getBonuses, calculateBotBonuses, invalidateBonusCache };
