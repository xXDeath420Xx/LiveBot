/**
 * DEA Raid System
 * Heat tracking and raid execution logic
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { notifyPlayer } from '../ws/broadcaster.js';

// Heat thresholds and raid probabilities
const HEAT_THRESHOLDS = {
    COLD: { min: 0, max: 24, status: 'cold', checkInterval: null, baseChance: 0 },
    WARM: { min: 25, max: 49, status: 'warm', checkInterval: 4 * 60 * 60 * 1000, baseChance: 0.05 },
    HOT: { min: 50, max: 99, status: 'hot', checkInterval: 2 * 60 * 60 * 1000, baseChance: 0.15 },
    SCORCHING: { min: 100, max: 149, status: 'scorching', checkInterval: 60 * 60 * 1000, baseChance: 0.30 },
    INFERNO: { min: 150, max: Infinity, status: 'inferno', checkInterval: 30 * 60 * 1000, baseChance: 0.50 }
};

// Heat sources
const HEAT_SOURCES = {
    harvest: 3,
    harvest_epic: 8,
    harvest_legendary: 8,
    npc_sale_per_100: 2,
    market_sale: 5,
    breeding: 4
};

// Passive heat rates (per hour)
const PASSIVE_HEAT = {
    cash_10k: { threshold: 10000, rate: 0.5 },
    cash_50k: { threshold: 50000, rate: 1.0 },
    inventory_50: { threshold: 50, rate: 0.3 }
};

// Decay rates (per hour)
const HEAT_DECAY = {
    offline: 2.0,
    online: 1.0,
    security_bonus: 0.5 // Per security level
};

// Raid consequences (base percentages)
const RAID_SEIZURE = {
    cash: { min: 0.20, max: 0.40 },
    inventory: { min: 0.15, max: 0.30 },
    plants: { min: 0.25, max: 0.50 },
    seeds: { min: 0.10, max: 0.20 }
};

// Vault capacity per level
const VAULT_CAPACITY = {
    0:  { cash: 0, slots: 0, cost: 0 },
    1:  { cash: 5000, slots: 10, cost: 2500 },
    2:  { cash: 15000, slots: 25, cost: 7500 },
    3:  { cash: 35000, slots: 50, cost: 20000 },
    4:  { cash: 75000, slots: 100, cost: 50000 },
    5:  { cash: 150000, slots: 200, cost: 125000 },
    6:  { cash: 500000, slots: 500, cost: 300000 },
    7:  { cash: 1500000, slots: 1000, cost: 750000 },
    8:  { cash: 5000000, slots: 2500, cost: 2000000 },
    9:  { cash: 15000000, slots: 5000, cost: 5000000 },
    10: { cash: 50000000, slots: 10000, cost: 15000000 }
};

// Security protection per level
const SECURITY_PROTECTION = {
    0: { raidChanceReduction: 0, lossReduction: 0, decayBonus: 0 },
    1: { raidChanceReduction: 0.10, lossReduction: 0.15, decayBonus: 0.5 },
    2: { raidChanceReduction: 0.20, lossReduction: 0.25, decayBonus: 1.0 },
    3: { raidChanceReduction: 0.30, lossReduction: 0.35, decayBonus: 1.5 },
    4: { raidChanceReduction: 0.40, lossReduction: 0.45, decayBonus: 2.0 },
    5: { raidChanceReduction: 0.50, lossReduction: 0.55, decayBonus: 2.5 }
};

/**
 * Get or initialize player heat record
 */
export async function getPlayerHeat(playerId) {
    const [[heat]] = await pool.execute(
        'SELECT * FROM cfx_player_heat WHERE player_id = ?',
        [playerId]
    );

    if (!heat) {
        await pool.execute(
            'INSERT INTO cfx_player_heat (player_id) VALUES (?)',
            [playerId]
        );
        return {
            current_heat: 0,
            lifetime_heat_earned: 0,
            last_heat_update: new Date(),
            last_raid_check: null,
            last_raided_at: null,
            raid_immunity_until: null
        };
    }

    return heat;
}

/**
 * Get player's security level from facility upgrades
 */
export async function getSecurityLevel(playerId) {
    const [[facility]] = await pool.execute(
        'SELECT current_level FROM cfx_facility_upgrades WHERE player_id = ? AND upgrade_key = ?',
        [playerId, 'security']
    );
    return facility?.current_level || 0;
}

/**
 * Calculate current heat with decay applied
 */
export async function calculateHeat(playerId) {
    const heat = await getPlayerHeat(playerId);
    const securityLevel = await getSecurityLevel(playerId);
    const protection = SECURITY_PROTECTION[securityLevel] || SECURITY_PROTECTION[0];

    // Calculate time since last update
    const now = new Date();
    const lastUpdate = new Date(heat.last_heat_update);
    const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

    if (hoursSinceUpdate < 0.01) {
        // Enforce cap even on stored values
        const stored = parseFloat(heat.current_heat);
        return Math.min(300, stored);
    }

    // Get player's online status (check last_online_at)
    const [[player]] = await pool.execute(
        'SELECT last_online_at, cash FROM cfx_players WHERE id = ?',
        [playerId]
    );

    const lastOnline = new Date(player?.last_online_at || 0);
    const isOnline = (now - lastOnline) < 5 * 60 * 1000; // Within 5 minutes

    // Calculate decay
    const baseDecay = isOnline ? HEAT_DECAY.online : HEAT_DECAY.offline;
    const totalDecay = baseDecay + protection.decayBonus;
    const decayAmount = totalDecay * hoursSinceUpdate;

    // Calculate passive heat gain
    let passiveHeat = 0;
    const cash = parseFloat(player?.cash || 0);

    if (cash >= PASSIVE_HEAT.cash_50k.threshold) {
        passiveHeat += PASSIVE_HEAT.cash_50k.rate * hoursSinceUpdate;
    } else if (cash >= PASSIVE_HEAT.cash_10k.threshold) {
        passiveHeat += PASSIVE_HEAT.cash_10k.rate * hoursSinceUpdate;
    }

    // Check inventory count
    const [[invCount]] = await pool.execute(
        'SELECT SUM(quantity) as total FROM cfx_inventory WHERE player_id = ?',
        [playerId]
    );
    if ((invCount?.total || 0) >= PASSIVE_HEAT.inventory_50.threshold) {
        passiveHeat += PASSIVE_HEAT.inventory_50.rate * hoursSinceUpdate;
    }

    // Apply decay and passive gain, cap at MAX_HEAT
    const MAX_HEAT = 300;
    let newHeat = parseFloat(heat.current_heat) - decayAmount + passiveHeat;
    newHeat = Math.max(0, Math.min(MAX_HEAT, newHeat));

    // Update heat if changed significantly
    if (Math.abs(newHeat - parseFloat(heat.current_heat)) > 0.1) {
        await pool.execute(
            'UPDATE cfx_player_heat SET current_heat = ?, last_heat_update = NOW() WHERE player_id = ?',
            [newHeat, playerId]
        );
    }

    return newHeat;
}

/**
 * Add heat from player activity
 */
export async function addHeat(playerId, amount, source) {
    const heat = await getPlayerHeat(playerId);
    const MAX_HEAT = 300;

    // Apply defense-based heat reduction (security level + alarm)
    const secLevel = await getSecurityLevel(playerId);
    const defenses = await getPlayerDefenses(playerId);
    const alarmLevel = defenses.alarm || 0;
    // Security reduces heat gained by 5% per level, alarm by 8% per level
    const heatReduction = Math.min(0.75, (secLevel * 0.05) + (alarmLevel * 0.08));
    const reducedAmount = Math.max(1, Math.round(amount * (1 - heatReduction)));

    const newHeat = Math.min(MAX_HEAT, parseFloat(heat.current_heat) + reducedAmount);

    await pool.execute(
        `UPDATE cfx_player_heat
         SET current_heat = ?,
             lifetime_heat_earned = lifetime_heat_earned + ?,
             last_heat_update = NOW()
         WHERE player_id = ?`,
        [newHeat, amount, playerId]
    );

    // Update highest heat stat if exceeded
    await pool.execute(
        `UPDATE cfx_player_stats
         SET highest_heat_reached = GREATEST(highest_heat_reached, ?)
         WHERE player_id = ?`,
        [newHeat, playerId]
    );

    logger.debug('[RaidSystem] Heat added', {
        playerId,
        source,
        amount,
        newHeat
    });

    // Check if crossed into new threshold
    const threshold = getHeatThreshold(newHeat);
    const oldThreshold = getHeatThreshold(parseFloat(heat.current_heat));

    if (threshold.status !== oldThreshold.status && threshold.status !== 'cold') {
        // Notify player of increased heat level
        notifyPlayer(playerId, 'heat_warning', {
            type: 'warning',
            heatLevel: threshold.status,
            currentHeat: Math.floor(newHeat),
            message: getHeatWarningMessage(threshold.status),
            tips: ['Deposit cash in vault', 'Upgrade security', 'Reduce activity']
        });
    }

    return newHeat;
}

/**
 * Get heat threshold info for a given heat value
 */
export function getHeatThreshold(heat) {
    for (const [key, threshold] of Object.entries(HEAT_THRESHOLDS)) {
        if (heat >= threshold.min && heat <= threshold.max) {
            return threshold;
        }
    }
    return HEAT_THRESHOLDS.INFERNO;
}

/**
 * Get warning message for heat level
 */
function getHeatWarningMessage(status) {
    const messages = {
        warm: 'Your operation is getting noticed. Consider laying low.',
        hot: 'DEA attention is increasing! Protect your assets.',
        scorching: 'DANGER: High raid risk! Vault your valuables now!',
        inferno: 'CRITICAL: Raid imminent! Maximum security recommended!'
    };
    return messages[status] || 'Your operation is attracting attention.';
}

/**
 * Check if player is eligible to be raided
 */
export async function checkRaidEligibility(playerId) {
    // Get player info
    const [[player]] = await pool.execute(
        'SELECT level, cash, last_online_at FROM cfx_players WHERE id = ?',
        [playerId]
    );

    if (!player) return { eligible: false, reason: 'Player not found' };

    // Must be level 5+
    if (player.level < 5) {
        return { eligible: false, reason: 'Below minimum level (5)' };
    }

    // Must have $500+ cash
    if (parseFloat(player.cash) < 500) {
        return { eligible: false, reason: 'Insufficient cash' };
    }

    // Must have been active in last 24 hours
    const lastOnline = new Date(player.last_online_at);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (lastOnline < dayAgo) {
        return { eligible: false, reason: 'Inactive player' };
    }

    // Check raid immunity
    const heat = await getPlayerHeat(playerId);
    if (heat.raid_immunity_until && new Date(heat.raid_immunity_until) > new Date()) {
        return { eligible: false, reason: 'Raid immunity active' };
    }

    return { eligible: true };
}

/**
 * Get player's purchased defenses
 */
export async function getPlayerDefenses(playerId) {
    const [defenses] = await pool.execute(
        'SELECT defense_key, current_level FROM cfx_player_defenses WHERE player_id = ?',
        [playerId]
    );
    const map = {};
    for (const d of defenses) {
        map[d.defense_key] = d.current_level;
    }
    return map;
}

/**
 * Execute a raid on a player
 * Defenses are applied: tunnel (avoidance), safe (cash protection),
 * lawyer (penalty reduction), decoy (inventory protection), alarm (early warning)
 */
export async function executeRaid(playerId) {
    const eligibility = await checkRaidEligibility(playerId);
    if (!eligibility.eligible) {
        return { success: false, reason: eligibility.reason };
    }

    const currentHeat = await calculateHeat(playerId);
    const securityLevel = await getSecurityLevel(playerId);
    const protection = SECURITY_PROTECTION[securityLevel] || SECURITY_PROTECTION[0];
    const defenses = await getPlayerDefenses(playerId);

    const defenseEffects = [];

    // --- TUNNEL: Chance to fully avoid the raid ---
    const tunnelLevel = defenses.tunnel || 0;
    if (tunnelLevel > 0) {
        const avoidChance = 0.15 * tunnelLevel; // 15% per level, 45% at L3
        if (Math.random() < avoidChance) {
            // Raid avoided!
            const heatAfterRaid = Math.max(0, currentHeat - 15);
            const immunityUntil = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2hr immunity

            await pool.execute(
                `UPDATE cfx_player_heat
                 SET current_heat = ?, last_raided_at = NOW(), raid_immunity_until = ?
                 WHERE player_id = ?`,
                [heatAfterRaid, immunityUntil, playerId]
            );

            // Log as defended raid
            await pool.execute(
                `INSERT INTO cfx_raid_log
                 (player_id, heat_at_raid, security_level, cash_seized, inventory_destroyed,
                  plants_destroyed, seeds_confiscated, seizure_details, heat_after_raid, defended, defense_details)
                 VALUES (?, ?, ?, 0, 0, 0, 0, NULL, ?, 1, ?)`,
                [playerId, currentHeat, securityLevel, heatAfterRaid,
                 JSON.stringify({ defense: 'tunnel', level: tunnelLevel, message: 'Escaped through tunnel!' })]
            );

            // Update stats
            await pool.execute(
                `UPDATE cfx_player_stats
                 SET total_raids_suffered = total_raids_suffered + 1
                 WHERE player_id = ?`,
                [playerId]
            );

            notifyPlayer(playerId, 'raid_defended', {
                type: 'raid_defended',
                title: 'RAID AVOIDED!',
                message: `Your Escape Tunnel (L${tunnelLevel}) let you slip away!`,
                defensesUsed: ['tunnel'],
                newHeat: Math.floor(heatAfterRaid),
                immunityUntil: immunityUntil.toISOString()
            });

            logger.info('[RaidSystem] Raid avoided via tunnel', { playerId, tunnelLevel });

            return {
                success: true,
                defended: true,
                defenseUsed: 'tunnel',
                seizure: { cashSeized: 0, inventoryDestroyed: 0, plantsDestroyed: 0, seedsConfiscated: 0 },
                heatAfterRaid: Math.floor(heatAfterRaid),
                immunityUntil
            };
        }
    }

    // --- ALARM: Send early warning notification ---
    const alarmLevel = defenses.alarm || 0;
    if (alarmLevel > 0) {
        defenseEffects.push(`Alarm System L${alarmLevel} detected the raid`);
    }

    // --- Calculate loss reduction: security + lawyer stack ---
    const lawyerLevel = defenses.lawyer || 0;
    const lawyerReduction = 0.06 * lawyerLevel; // 6% per level, 30% at L5
    const totalLossReduction = Math.min(0.85, protection.lossReduction + lawyerReduction);
    if (lawyerLevel > 0) {
        defenseEffects.push(`Lawyer L${lawyerLevel} reduced penalties by ${Math.round(lawyerReduction * 100)}%`);
    }

    // --- SAFE: Cash protection (reduces cash seizure specifically) ---
    const safeLevel = defenses.safe || 0;
    const cashProtection = 0.05 * safeLevel; // 5% per level, 25% at L5
    if (safeLevel > 0) {
        defenseEffects.push(`Hidden Safe L${safeLevel} protected ${Math.round(cashProtection * 100)}% of cash`);
    }

    // --- DECOY: Inventory protection (reduces inventory seizure) ---
    const decoyLevel = defenses.decoy || 0;
    const inventoryProtection = 0.10 * decoyLevel; // 10% per level, 30% at L3
    if (decoyLevel > 0) {
        defenseEffects.push(`Decoy Stash L${decoyLevel} diverted ${Math.round(inventoryProtection * 100)}% of inventory searches`);
    }

    // Get player assets
    const [[player]] = await pool.execute(
        'SELECT cash FROM cfx_players WHERE id = ?',
        [playerId]
    );
    const cash = parseFloat(player.cash);

    // Get inventory
    const [inventory] = await pool.execute(
        'SELECT * FROM cfx_inventory WHERE player_id = ? AND quantity > 0',
        [playerId]
    );

    // Get growing plants
    const [plants] = await pool.execute(
        `SELECT * FROM cfx_grow_slots
         WHERE player_id = ? AND status IN ('growing', 'ready')`,
        [playerId]
    );

    // Get seeds
    const [seeds] = await pool.execute(
        'SELECT * FROM cfx_seed_inventory WHERE player_id = ? AND quantity > 0',
        [playerId]
    );

    // Calculate seizures
    const seizure = {
        cash: 0,
        inventory: [],
        plants: [],
        seeds: [],
        cashSeized: 0,
        inventoryDestroyed: 0,
        plantsDestroyed: 0,
        seedsConfiscated: 0
    };

    // Cash seizure: base rate * (1 - security reduction - lawyer reduction) * (1 - safe protection)
    const cashSeizureRate = randomRange(RAID_SEIZURE.cash.min, RAID_SEIZURE.cash.max)
        * (1 - totalLossReduction) * (1 - cashProtection);
    seizure.cashSeized = Math.floor(cash * cashSeizureRate);

    if (seizure.cashSeized > 0) {
        await pool.execute(
            'UPDATE cfx_players SET cash = cash - ? WHERE id = ?',
            [seizure.cashSeized, playerId]
        );
    }

    // Inventory destruction: reduced by decoy + general loss reduction
    if (inventory.length > 0) {
        const invDestroyRate = randomRange(RAID_SEIZURE.inventory.min, RAID_SEIZURE.inventory.max)
            * (1 - totalLossReduction) * (1 - inventoryProtection);
        const itemsToDestroy = Math.ceil(inventory.length * invDestroyRate);

        const shuffled = inventory.sort(() => Math.random() - 0.5);
        for (let i = 0; i < itemsToDestroy && i < shuffled.length; i++) {
            const item = shuffled[i];
            await pool.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            seizure.inventory.push({
                strainId: item.strain_id,
                quantity: item.quantity,
                quality: item.quality
            });
            seizure.inventoryDestroyed += item.quantity;
        }
    }

    // Plant destruction: reduced by general loss reduction
    if (plants.length > 0) {
        const plantDestroyRate = randomRange(RAID_SEIZURE.plants.min, RAID_SEIZURE.plants.max)
            * (1 - totalLossReduction);
        const plantsToDestroy = Math.ceil(plants.length * plantDestroyRate);

        const shuffledPlants = plants.sort(() => Math.random() - 0.5);
        for (let i = 0; i < plantsToDestroy && i < shuffledPlants.length; i++) {
            const plant = shuffledPlants[i];
            await pool.execute(
                `UPDATE cfx_grow_slots
                 SET status = 'empty', strain_id = NULL, planted_at = NULL,
                     ready_at = NULL, wither_at = NULL, accumulated_growth_ms = 0
                 WHERE id = ?`,
                [plant.id]
            );
            seizure.plants.push({
                slotNumber: plant.slot_number,
                strainId: plant.strain_id
            });
            seizure.plantsDestroyed++;
        }
    }

    // Seed confiscation: reduced by general loss reduction
    if (seeds.length > 0) {
        const seedConfiscateRate = randomRange(RAID_SEIZURE.seeds.min, RAID_SEIZURE.seeds.max)
            * (1 - totalLossReduction);

        for (const seed of seeds) {
            const toConfiscate = Math.floor(seed.quantity * seedConfiscateRate);
            if (toConfiscate > 0) {
                await pool.execute(
                    'UPDATE cfx_seed_inventory SET quantity = quantity - ? WHERE id = ?',
                    [toConfiscate, seed.id]
                );
                seizure.seeds.push({
                    strainId: seed.strain_id,
                    quantity: toConfiscate
                });
                seizure.seedsConfiscated += toConfiscate;
            }
        }
    }

    // Reset heat after raid (reduced to 25)
    const heatAfterRaid = 25;
    const immunityUntil = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours

    await pool.execute(
        `UPDATE cfx_player_heat
         SET current_heat = ?,
             last_raided_at = NOW(),
             raid_immunity_until = ?
         WHERE player_id = ?`,
        [heatAfterRaid, immunityUntil, playerId]
    );

    // Log raid with defense details
    await pool.execute(
        `INSERT INTO cfx_raid_log
         (player_id, heat_at_raid, security_level, cash_seized, inventory_destroyed,
          plants_destroyed, seeds_confiscated, seizure_details, heat_after_raid, defended, defense_details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
            playerId, currentHeat, securityLevel,
            seizure.cashSeized, seizure.inventoryDestroyed,
            seizure.plantsDestroyed, seizure.seedsConfiscated,
            JSON.stringify(seizure), heatAfterRaid,
            defenseEffects.length > 0 ? JSON.stringify(defenseEffects) : null
        ]
    );

    // Update player stats
    await pool.execute(
        `UPDATE cfx_player_stats
         SET total_raids_suffered = total_raids_suffered + 1,
             total_cash_seized = total_cash_seized + ?,
             total_items_destroyed = total_items_destroyed + ?,
             total_plants_destroyed = total_plants_destroyed + ?,
             total_seeds_confiscated = total_seeds_confiscated + ?
         WHERE player_id = ?`,
        [
            seizure.cashSeized, seizure.inventoryDestroyed,
            seizure.plantsDestroyed, seizure.seedsConfiscated, playerId
        ]
    );

    logger.info('[RaidSystem] Raid executed', {
        playerId,
        heatAtRaid: currentHeat,
        securityLevel,
        defenses,
        defenseEffects,
        cashSeized: seizure.cashSeized,
        inventoryDestroyed: seizure.inventoryDestroyed,
        plantsDestroyed: seizure.plantsDestroyed,
        seedsConfiscated: seizure.seedsConfiscated
    });

    // Notify player with defense info
    notifyPlayer(playerId, 'raid_complete', {
        type: 'raid_result',
        title: 'DEA RAID!',
        cashSeized: seizure.cashSeized,
        itemsDestroyed: seizure.inventory,
        plantsDestroyed: seizure.plants,
        seedsConfiscated: seizure.seeds,
        defenseEffects,
        securityBonus: securityLevel > 0
            ? `Security Level ${securityLevel} reduced losses by ${Math.round(protection.lossReduction * 100)}%`
            : null,
        newHeat: heatAfterRaid,
        immunityUntil: immunityUntil.toISOString()
    });

    return {
        success: true,
        defended: false,
        seizure,
        defenseEffects,
        heatAfterRaid,
        immunityUntil
    };
}

/**
 * Get player's current raid status
 */
export async function getRaidStatus(playerId) {
    const currentHeat = await calculateHeat(playerId);
    const threshold = getHeatThreshold(currentHeat);
    const securityLevel = await getSecurityLevel(playerId);
    const protection = SECURITY_PROTECTION[securityLevel] || SECURITY_PROTECTION[0];
    const eligibility = await checkRaidEligibility(playerId);

    // Calculate actual raid chance
    let actualChance = 0;
    if (threshold.baseChance > 0) {
        actualChance = threshold.baseChance * (1 - protection.raidChanceReduction);
    }

    // Get vault info
    const [[vault]] = await pool.execute(
        'SELECT * FROM cfx_player_vault WHERE player_id = ?',
        [playerId]
    );

    const vaultLevel = vault?.vault_level || 0;
    const vaultCapacity = VAULT_CAPACITY[vaultLevel];

    // Get heat record for immunity info
    const heat = await getPlayerHeat(playerId);

    return {
        heat: {
            current: Math.floor(currentHeat),
            status: threshold.status,
            checkInterval: threshold.checkInterval,
            baseChance: threshold.baseChance,
            actualChance: actualChance
        },
        security: {
            level: securityLevel,
            raidChanceReduction: protection.raidChanceReduction,
            lossReduction: protection.lossReduction,
            decayBonus: protection.decayBonus
        },
        vault: {
            level: vaultLevel,
            cashCapacity: vaultCapacity.cash,
            currentCash: parseFloat(vault?.vault_cash || 0),
            slotCapacity: vaultCapacity.slots
        },
        eligibility: eligibility,
        immunity: heat.raid_immunity_until
            ? { until: heat.raid_immunity_until, active: new Date(heat.raid_immunity_until) > new Date() }
            : null,
        lastRaided: heat.last_raided_at
    };
}

/**
 * Get raid protection info based on security level
 */
export function getRaidProtection(securityLevel) {
    return SECURITY_PROTECTION[securityLevel] || SECURITY_PROTECTION[0];
}

/**
 * Get vault capacity info
 */
export function getVaultCapacity(level) {
    return VAULT_CAPACITY[level] || VAULT_CAPACITY[0];
}

/**
 * Utility: Random number in range
 */
function randomRange(min, max) {
    return Math.random() * (max - min) + min;
}

export { VAULT_CAPACITY, SECURITY_PROTECTION, HEAT_THRESHOLDS };
