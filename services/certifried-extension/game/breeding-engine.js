/**
 * Breeding Engine
 * Handles genetics crossover, mutations, and strain discovery
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { BREEDING } from '../config/game-constants.js';
import { gaussian, clamp, rollChance, randomInt, randomFloat } from './rng.js';
import { getBonuses } from './bonus-resolver.js';
import { updateQuestProgress } from './quest-system.js';
import { hasFeatureUnlock } from './research-helper.js';

/**
 * Crossover two parent genetics
 * @param {object} parent1Genetics - First parent genetics
 * @param {object} parent2Genetics - Second parent genetics
 * @returns {object} Child genetics
 */
export function crossoverGenetics(parent1Genetics, parent2Genetics) {
    const child = {};

    for (const gene of BREEDING.GENE_KEYS) {
        // Random weight between 40-60% from parent 1
        const weight1 = randomFloat(BREEDING.PARENT_WEIGHT_MIN, BREEDING.PARENT_WEIGHT_MAX);
        const weight2 = 1 - weight1;

        // Weighted average
        let value = (parent1Genetics[gene] * weight1) + (parent2Genetics[gene] * weight2);

        // Add gaussian noise
        const noise = gaussian(0, BREEDING.CROSSOVER_NOISE_SIGMA);
        value += noise;

        // Clamp to valid range
        child[gene] = Math.floor(clamp(value, 0, 100));
    }

    return child;
}

/**
 * Apply mutation to genetics
 * @param {object} genetics - Current genetics
 * @param {number} mutationChance - Chance of mutation (0-1)
 * @returns {{genetics: object, mutated: boolean, mutatedGene: string|null}}
 */
export function applyMutation(genetics, mutationChance) {
    if (!rollChance(mutationChance * 100)) {
        return { genetics, mutated: false, mutatedGene: null };
    }

    // Pick random gene to mutate
    const geneIndex = randomInt(0, BREEDING.GENE_KEYS.length - 1);
    const gene = BREEDING.GENE_KEYS[geneIndex];

    // Random shift
    const direction = Math.random() < 0.5 ? -1 : 1;
    const shift = randomInt(BREEDING.MUTATION_SHIFT_MIN, BREEDING.MUTATION_SHIFT_MAX) * direction;

    const mutatedGenetics = { ...genetics };
    mutatedGenetics[gene] = Math.floor(clamp(genetics[gene] + shift, 0, 100));

    return {
        genetics: mutatedGenetics,
        mutated: true,
        mutatedGene: gene
    };
}

/**
 * Find matching strain for given genetics
 * @param {object} genetics - Genetics to match
 * @returns {object|null} Matching strain or null
 */
export async function findMatchingStrain(genetics) {
    const [strains] = await pool.execute('SELECT * FROM cfx_strains');

    for (const strain of strains) {
        // Parse genetics from JSON column
        const strainGenetics = typeof strain.genetics === 'string'
            ? JSON.parse(strain.genetics)
            : (strain.genetics || {});

        let matches = true;
        for (const gene of BREEDING.GENE_KEYS) {
            const diff = Math.abs(genetics[gene] - (strainGenetics[gene] || 50));
            if (diff > BREEDING.MATCH_THRESHOLD) {
                matches = false;
                break;
            }
        }

        if (matches) {
            return strain;
        }
    }

    return null;
}

/**
 * Generate strain properties from genetics
 * @param {object} genetics - Strain genetics
 * @param {string} parent1Type - Parent 1 strain type
 * @param {string} parent2Type - Parent 2 strain type
 * @returns {object} Strain properties
 */
export function generateStrainProperties(genetics, parent1Type, parent2Type) {
    // Determine strain type
    let strainType;
    if (parent1Type === parent2Type) {
        strainType = parent1Type;
    } else {
        strainType = 'hybrid';
    }

    // Determine rarity based on average gene values
    const avgGene = BREEDING.GENE_KEYS.reduce((sum, g) => sum + genetics[g], 0) / BREEDING.GENE_KEYS.length;
    let rarity;
    if (avgGene >= 85) rarity = 'legendary';
    else if (avgGene >= 70) rarity = 'epic';
    else if (avgGene >= 55) rarity = 'rare';
    else if (avgGene >= 40) rarity = 'uncommon';
    else rarity = 'common';

    // Calculate base stats from genetics
    const baseGrowTime = Math.floor(300000 + (100 - genetics.speed) * 33000); // 5min to 60min
    const baseYieldMin = Math.floor(2 + genetics.yield * 0.13);
    const baseYieldMax = Math.floor(baseYieldMin + 3 + genetics.yield * 0.05);
    const baseQualityMin = Math.floor(20 + genetics.quality * 0.5);
    const baseQualityMax = Math.floor(baseQualityMin + 20 + genetics.quality * 0.3);
    const basePrice = Math.floor(50 + (avgGene * 5));

    return {
        strainType,
        rarity,
        baseGrowTime,
        baseYieldMin,
        baseYieldMax,
        baseQualityMin,
        baseQualityMax,
        basePrice
    };
}

/**
 * Generate a unique strain name
 * @param {string} parent1Name - First parent name
 * @param {string} parent2Name - Second parent name
 * @returns {string} Generated name
 */
function generateStrainName(parent1Name, parent2Name) {
    // Take parts of each parent name
    const prefixes = ['Purple', 'Blue', 'Green', 'Golden', 'Silver', 'Crystal', 'Cosmic', 'Electric', 'Mystic', 'Atomic'];
    const suffixes = ['Dream', 'Haze', 'Kush', 'OG', 'Cookies', 'Cake', 'Fire', 'Star', 'Moon', 'Thunder'];

    // Mix parent names or generate new
    if (Math.random() < 0.3) {
        // Use parts of parent names
        const p1Parts = parent1Name.split(' ');
        const p2Parts = parent2Name.split(' ');
        return `${p1Parts[0]} ${p2Parts[p2Parts.length - 1]}`;
    } else {
        // Generate new name
        const prefix = prefixes[randomInt(0, prefixes.length - 1)];
        const suffix = suffixes[randomInt(0, suffixes.length - 1)];
        return `${prefix} ${suffix}`;
    }
}

/**
 * Start a breeding operation
 * @param {number} playerId - Player ID
 * @param {number} parent1StrainId - First parent strain ID
 * @param {number} parent2StrainId - Second parent strain ID
 * @returns {object} Breeding operation
 */
export async function startBreeding(playerId, parent1StrainId, parent2StrainId) {
    logger.info('[BreedingEngine] Starting breed', { playerId, parent1StrainId, parent2StrainId });

    // Get bonuses
    const bonuses = await getBonuses(playerId);
    logger.info('[BreedingEngine] Bonuses', { playerId, breedingUnlocked: bonuses.breedingUnlocked, breedingSlots: bonuses.breedingSlots });

    // Check if breeding is unlocked via skills OR research
    // NOTE: We auto-unlock breeding for all players now to reduce frustration
    const hasResearchBreeding = await hasFeatureUnlock(playerId, 'breeding');
    logger.info('[BreedingEngine] Research check', { playerId, hasResearchBreeding, breedingUnlocked: bonuses.breedingUnlocked });

    // Breeding is now available to everyone - removed the artificial skill gate
    // if (!bonuses.breedingUnlocked && !hasResearchBreeding) {
    //     throw new Error('Breeding not unlocked');
    // }

    // Check active breeding count
    const [[{ activeCount }]] = await pool.execute(
        `SELECT COUNT(*) as activeCount FROM cfx_breeding_operations
         WHERE player_id = ? AND status = 'breeding'`,
        [playerId]
    );

    logger.info('[BreedingEngine] Slot check', { playerId, activeCount, breedingSlots: bonuses.breedingSlots });

    if (activeCount >= bonuses.breedingSlots) {
        logger.warn('[BreedingEngine] Max slots reached', { playerId, activeCount, breedingSlots: bonuses.breedingSlots });
        throw new Error(`Maximum ${bonuses.breedingSlots} breeding slots`);
    }

    // Get parent strains
    const [[parent1]] = await pool.execute('SELECT * FROM cfx_strains WHERE id = ?', [parent1StrainId]);
    const [[parent2]] = await pool.execute('SELECT * FROM cfx_strains WHERE id = ?', [parent2StrainId]);

    logger.info('[BreedingEngine] Parent strains', { playerId, parent1: parent1?.name, parent2: parent2?.name });

    if (!parent1 || !parent2) {
        logger.warn('[BreedingEngine] Parent strain not found', { playerId, parent1StrainId, parent2StrainId, hasParent1: !!parent1, hasParent2: !!parent2 });
        throw new Error('Parent strain not found');
    }

    // Check discovery
    const [[disc1]] = await pool.execute(
        'SELECT * FROM cfx_strain_discoveries WHERE player_id = ? AND strain_id = ?',
        [playerId, parent1StrainId]
    );
    const [[disc2]] = await pool.execute(
        'SELECT * FROM cfx_strain_discoveries WHERE player_id = ? AND strain_id = ?',
        [playerId, parent2StrainId]
    );

    logger.info('[BreedingEngine] Discovery check', { playerId, hasDisc1: !!disc1, hasDisc2: !!disc2 });

    if (!disc1 || !disc2) {
        logger.warn('[BreedingEngine] Strain not discovered', { playerId, hasDisc1: !!disc1, hasDisc2: !!disc2 });
        throw new Error('Must discover strains before breeding');
    }

    // Check legendary breeding (no longer gated - anyone can breed legendaries)
    const rarityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    const parent1RarityIndex = rarityOrder.indexOf(parent1.rarity);
    const parent2RarityIndex = rarityOrder.indexOf(parent2.rarity);
    const maxRarity = Math.max(parent1RarityIndex, parent2RarityIndex);

    // Legendary breeding is now available to everyone
    // if (maxRarity >= 4 && !bonuses.legendaryBreeding) {
    //     throw new Error('Legendary breeding skill required');
    // }

    // Calculate breed time
    const baseTime = BREEDING.BASE_BREED_TIME_MS;
    const rarityBonus = maxRarity * 300000; // +5min per rarity tier
    const speedReduction = bonuses.growSpeed || 0;
    const breedTime = Math.min(
        BREEDING.MAX_BREED_TIME_MS,
        Math.floor((baseTime + rarityBonus) * (1 - speedReduction))
    );

    const now = Date.now();
    const readyAt = now + breedTime;

    // Use transaction with FOR UPDATE locks to prevent race conditions on seed deduction
    const connection = await pool.getConnection();
    let operationId;
    try {
        await connection.beginTransaction();

        // Check seed availability WITH FOR UPDATE lock to prevent race conditions
        const [[seeds1]] = await connection.execute(
            'SELECT quantity FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ? FOR UPDATE',
            [playerId, parent1StrainId]
        );
        const [[seeds2]] = await connection.execute(
            'SELECT quantity FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ? FOR UPDATE',
            [playerId, parent2StrainId]
        );

        logger.info('[BreedingEngine] Seed check', {
            playerId,
            parent1StrainId, parent2StrainId,
            seeds1Qty: seeds1?.quantity, seeds2Qty: seeds2?.quantity
        });

        // Need at least 1 seed of each parent strain
        if (!seeds1 || seeds1.quantity < 1) {
            logger.warn('[BreedingEngine] Missing seeds for parent1', { playerId, parent1StrainId, seeds1 });
            throw new Error(`Need at least 1 seed of ${parent1.name}`);
        }
        if (!seeds2 || seeds2.quantity < 1) {
            logger.warn('[BreedingEngine] Missing seeds for parent2', { playerId, parent2StrainId, seeds2 });
            throw new Error(`Need at least 1 seed of ${parent2.name}`);
        }

        // Deduct seeds from inventory (1 of each parent)
        await connection.execute(
            'UPDATE cfx_seed_inventory SET quantity = quantity - 1 WHERE player_id = ? AND strain_id = ?',
            [playerId, parent1StrainId]
        );
        await connection.execute(
            'UPDATE cfx_seed_inventory SET quantity = quantity - 1 WHERE player_id = ? AND strain_id = ?',
            [playerId, parent2StrainId]
        );

        // Clean up empty seed stacks
        await connection.execute(
            'DELETE FROM cfx_seed_inventory WHERE player_id = ? AND quantity <= 0',
            [playerId]
        );

        // Create breeding operation
        const [result] = await connection.execute(
            `INSERT INTO cfx_breeding_operations
             (player_id, parent_1_strain_id, parent_2_strain_id, started_at, ready_at, duration_ms, status)
             VALUES (?, ?, ?, ?, ?, ?, 'breeding')`,
            [playerId, parent1StrainId, parent2StrainId, now, readyAt, breedTime]
        );

        operationId = result.insertId;
        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }

    return {
        id: operationId,
        operationId: operationId,
        parent1: { id: parent1.id, name: parent1.name, rarity: parent1.rarity },
        parent2: { id: parent2.id, name: parent2.name, rarity: parent2.rarity },
        parent1Name: parent1.name,
        parent2Name: parent2.name,
        startedAt: now,
        durationMs: breedTime,
        readyAt,
        completeAt: readyAt,
        status: 'breeding'
    };
}

/**
 * Claim a completed breeding operation
 * @param {number} playerId - Player ID
 * @param {number} operationId - Breeding operation ID
 * @returns {object} Breeding result
 */
export async function claimBreeding(playerId, operationId) {
    // Use transaction with FOR UPDATE lock to prevent double-claim exploit
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Get operation with parent genetics and lock it
        const [[operation]] = await connection.execute(
            `SELECT bo.*, s1.genetics as p1_genetics, s1.name as p1_name, s1.strain_type as p1_type,
                    s2.genetics as p2_genetics, s2.name as p2_name, s2.strain_type as p2_type
             FROM cfx_breeding_operations bo
             JOIN cfx_strains s1 ON bo.parent_1_strain_id = s1.id
             JOIN cfx_strains s2 ON bo.parent_2_strain_id = s2.id
             WHERE bo.id = ? AND bo.player_id = ?
             FOR UPDATE`,
            [operationId, playerId]
        );

        if (!operation) {
            await connection.rollback();
            throw new Error('Breeding operation not found');
        }

        if (operation.status === 'claimed') {
            await connection.rollback();
            throw new Error('Already claimed');
        }

        const now = Date.now();
        if (operation.status === 'breeding' && now < operation.ready_at) {
            await connection.rollback();
            throw new Error('Breeding not complete');
        }

        // Parse parent genetics from JSON
        const p1Genetics = typeof operation.p1_genetics === 'string'
            ? JSON.parse(operation.p1_genetics)
            : (operation.p1_genetics || { thc: 50, cbd: 50, yield: 50, speed: 50, quality: 50, resilience: 50 });
        const p2Genetics = typeof operation.p2_genetics === 'string'
            ? JSON.parse(operation.p2_genetics)
            : (operation.p2_genetics || { thc: 50, cbd: 50, yield: 50, speed: 50, quality: 50, resilience: 50 });

        // Crossover genetics
        let childGenetics = crossoverGenetics(p1Genetics, p2Genetics);

        // Get bonuses for mutation
        const bonuses = await getBonuses(playerId);
        const mutationChance = BREEDING.MUTATION_CHANCE_BASE + (bonuses.mutationChance || 0);

        // Apply mutation
        const mutationResult = applyMutation(childGenetics, mutationChance);
        childGenetics = mutationResult.genetics;

        // Apply quality floor from skills
        if (bonuses.breedQualityFloor > 0) {
            childGenetics.quality = Math.max(childGenetics.quality, bonuses.breedQualityFloor);
        }

        // Find or create strain
        let resultStrain = await findMatchingStrain(childGenetics);
        let isNewStrain = false;

        if (!resultStrain) {
            // Create new strain
            const props = generateStrainProperties(childGenetics, operation.p1_type, operation.p2_type);
            const strainName = generateStrainName(operation.p1_name, operation.p2_name);
            const slug = strainName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        // Check slug uniqueness (inside transaction)
        let finalSlug = slug;
        let counter = 1;
        while (true) {
            const [[existing]] = await connection.execute('SELECT id FROM cfx_strains WHERE slug = ?', [finalSlug]);
            if (!existing) break;
            finalSlug = `${slug}-${counter++}`;
        }

        const [insertResult] = await connection.execute(
            `INSERT INTO cfx_strains
             (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max,
              base_quality_min, base_quality_max, base_price, genetics, is_bred, bred_by_player_id,
              parent_1_id, parent_2_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            [strainName, finalSlug, props.strainType, props.rarity, props.baseGrowTime,
             props.baseYieldMin, props.baseYieldMax, props.baseQualityMin, props.baseQualityMax,
             props.basePrice, JSON.stringify(childGenetics), playerId,
             operation.parent_1_strain_id, operation.parent_2_strain_id]
        );

        [[resultStrain]] = await connection.execute('SELECT * FROM cfx_strains WHERE id = ?', [insertResult.insertId]);
        isNewStrain = true;

        // Initialize market price (inside transaction)
        await connection.execute(
            `INSERT INTO cfx_market_prices (strain_id, current_price, previous_price, npc_base_price, high_24h, low_24h)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [resultStrain.id, props.basePrice, props.basePrice, props.basePrice, props.basePrice, props.basePrice]
        );

            logger.info('[BreedingEngine] New strain created', {
                playerId,
                strainId: resultStrain.id,
                strainName,
                rarity: props.rarity
            });
        }

        // Add discovery (inside transaction)
        const [discoveryResult] = await connection.execute(
            `INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)`,
            [playerId, resultStrain.id]
        );

        // Track if new discovery for quest progress update after commit
        const isNewDiscovery = discoveryResult.affectedRows > 0;

        // Update breeding operation (inside transaction)
        await connection.execute(
            `UPDATE cfx_breeding_operations
             SET status = 'claimed', result_strain_id = ?, result_is_new = ?
             WHERE id = ?`,
            [resultStrain.id, isNewStrain ? 1 : 0, operationId]
        );

        // Update breeding stats (inside transaction)
        await connection.execute(
            'UPDATE cfx_players SET total_breeds = total_breeds + 1 WHERE id = ?',
            [playerId]
        );

        await connection.commit();

        // Update quest progress (outside transaction - non-critical)
        await updateQuestProgress(playerId, 'breed_count', 1);
        if (isNewDiscovery) {
            await updateQuestProgress(playerId, 'discover_strains', 1);
        }

        return {
            operationId,
            resultStrain: {
                id: resultStrain.id,
                name: resultStrain.name,
                slug: resultStrain.slug,
                strainType: resultStrain.strain_type,
                rarity: resultStrain.rarity,
                genetics: childGenetics
            },
            isNewStrain,
            mutationOccurred: mutationResult.mutated,
            mutatedGene: mutationResult.mutatedGene
        };
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

/**
 * Preview breeding outcome (requires skill)
 * @param {number} playerId - Player ID
 * @param {number} parent1StrainId - First parent strain ID
 * @param {number} parent2StrainId - Second parent strain ID
 * @returns {object} Preview data
 */
export async function previewBreeding(playerId, parent1StrainId, parent2StrainId) {
    const bonuses = await getBonuses(playerId);

    if (!bonuses.breedingPreview) {
        throw new Error('Breeding preview skill required');
    }

    const [[parent1]] = await pool.execute('SELECT * FROM cfx_strains WHERE id = ?', [parent1StrainId]);
    const [[parent2]] = await pool.execute('SELECT * FROM cfx_strains WHERE id = ?', [parent2StrainId]);

    if (!parent1 || !parent2) {
        throw new Error('Parent strain not found');
    }

    // Parse genetics from JSON column
    const p1Genetics = typeof parent1.genetics === 'string'
        ? JSON.parse(parent1.genetics)
        : (parent1.genetics || { thc: 50, cbd: 50, yield: 50, speed: 50, quality: 50, resilience: 50 });
    const p2Genetics = typeof parent2.genetics === 'string'
        ? JSON.parse(parent2.genetics)
        : (parent2.genetics || { thc: 50, cbd: 50, yield: 50, speed: 50, quality: 50, resilience: 50 });

    // Calculate expected ranges
    const expectedGenetics = {};
    for (const gene of BREEDING.GENE_KEYS) {
        const avg = (p1Genetics[gene] + p2Genetics[gene]) / 2;
        const variance = Math.abs(p1Genetics[gene] - p2Genetics[gene]) / 2 + BREEDING.CROSSOVER_NOISE_SIGMA;
        expectedGenetics[gene] = {
            min: Math.max(0, Math.floor(avg - variance)),
            max: Math.min(100, Math.ceil(avg + variance)),
            expected: Math.floor(avg)
        };
    }

    // Estimate possible rarities
    const avgExpected = BREEDING.GENE_KEYS.reduce((sum, g) => sum + expectedGenetics[g].expected, 0) / BREEDING.GENE_KEYS.length;
    const avgMin = BREEDING.GENE_KEYS.reduce((sum, g) => sum + expectedGenetics[g].min, 0) / BREEDING.GENE_KEYS.length;
    const avgMax = BREEDING.GENE_KEYS.reduce((sum, g) => sum + expectedGenetics[g].max, 0) / BREEDING.GENE_KEYS.length;

    return {
        parent1: { id: parent1.id, name: parent1.name, genetics: p1Genetics },
        parent2: { id: parent2.id, name: parent2.name, genetics: p2Genetics },
        expectedGenetics,
        possibleRarities: {
            likely: avgExpected >= 70 ? 'epic' : avgExpected >= 55 ? 'rare' : avgExpected >= 40 ? 'uncommon' : 'common',
            bestCase: avgMax >= 85 ? 'legendary' : avgMax >= 70 ? 'epic' : avgMax >= 55 ? 'rare' : 'uncommon',
            worstCase: avgMin >= 55 ? 'rare' : avgMin >= 40 ? 'uncommon' : 'common'
        },
        mutationChance: (BREEDING.MUTATION_CHANCE_BASE + (bonuses.mutationChance || 0)) * 100
    };
}

export default {
    crossoverGenetics,
    applyMutation,
    findMatchingStrain,
    generateStrainProperties,
    startBreeding,
    claimBreeding,
    previewBreeding
};
