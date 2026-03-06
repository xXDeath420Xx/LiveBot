/**
 * Workers Tick Job - Idle Tycoon Engine
 * Runs every 10 seconds. Instantly processes ALL automation for all active players.
 * No interval gating - every tick runs the full idle cycle.
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { harvestAll, plantSeed } from '../game/growth-system.js';
import { awardCash, awardXp } from '../game/engine.js';
import { logWorkerAction } from '../routes/workers.js';
import { awardEventPoints } from '../routes/events.js';
import { trackStat } from '../routes/stats.js';
import { addHeat, VAULT_CAPACITY } from '../game/raid-system.js';
import { updateQuestProgress } from '../game/quest-system.js';
import { hasFeatureUnlock, hasResearch } from '../game/research-helper.js';
import { getWorkerBonuses } from '../routes/workers-enhanced.js';
import { awardReputation } from '../routes/reputation.js';
import { claimBreeding, startBreeding } from '../game/breeding-engine.js';

// Dynamic imports for optional systems (may not exist yet)
let updateTournamentScore = null;
try {
    const mod = await import('../routes/tournaments.js');
    updateTournamentScore = mod.updateTournamentScore;
} catch (e) {}

/**
 * Main idle tycoon tick - runs the full idle cycle for every active player
 */
export async function workersTick() {
    const startTime = Date.now();
    let playersProcessed = 0;
    let totalActions = 0;

    try {
        // Get all players who have started the game (have at least one grow slot)
        const [players] = await pool.execute(`
            SELECT DISTINCT p.id FROM cfx_players p
            WHERE EXISTS (SELECT 1 FROM cfx_grow_slots gs WHERE gs.player_id = p.id)
        `);

        for (const player of players) {
            try {
                const result = await runIdleCycle(player.id);
                if (result.totalActions > 0) {
                    playersProcessed++;
                    totalActions += result.totalActions;
                }
            } catch (err) {
                logger.error('[IdleTycoon] Player cycle failed', {
                    playerId: player.id,
                    error: err.message
                });
            }
        }

        const duration = Date.now() - startTime;
        if (totalActions > 0) {
            logger.info('[IdleTycoon] Tick complete', {
                players: playersProcessed,
                actions: totalActions,
                duration
            });
        }
    } catch (error) {
        logger.error('[IdleTycoon] Tick failed', { error: error.message });
    }
}

/**
 * Run the complete idle cycle for a single player.
 * Order matters: Harvest -> Plant -> Extract -> BM Sell -> Dispensary -> NPC Sell -> Buy Seeds -> Research -> Train
 */
async function runIdleCycle(playerId) {
    let totalActions = 0;

    // Get worker bonuses (efficiency, quality) for this player
    let efficiency = 1.0;
    let qualityBonus = 0;
    try {
        const bonuses = await getWorkerBonuses(playerId);
        efficiency = 1.0 + (bonuses.efficiencyBonus || 0);
        qualityBonus = bonuses.qualityBonus || 0;
    } catch (e) {}


    // 1. Harvest all ready plants
    try {
        const r = await executeAutoHarvest(playerId, efficiency, qualityBonus);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Harvest error', { playerId, err: e.message }); }

    // 1b. Auto-vault harvested items (protect from raids)
    try {
        await executeAutoVault(playerId);
    } catch (e) { logger.warn('[IdleTycoon] Vault error', { playerId, err: e.message }); }

    // 2. Plant seeds in all empty slots
    try {
        const r = await executeAutoPlant(playerId, efficiency);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Plant error', { playerId, err: e.message }); }

    // 3. Claim completed extractions
    try {
        const r = await executeExtractionWork(playerId, efficiency);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Extraction error', { playerId, err: e.message }); }

    // 4. Start new extractions with inventory
    try {
        const r = await executeAutoProcess(playerId, efficiency);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Process error', { playerId, err: e.message }); }

    // 5. Sell high quality on black market (if unlocked)
    try {
        const r = await executeAutoBlackMarketSell(playerId);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] BM sell error', { playerId, err: e.message }); }

    // 6. Serve dispensary customers
    try {
        const r = await executeDispensaryWork(playerId, efficiency);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Dispensary error', { playerId, err: e.message }); }

    // 7. Sell remaining inventory via NPC market
    try {
        const r = await executeAutoSell(playerId, efficiency);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] NPC sell error', { playerId, err: e.message }); }

    // 8. Auto-buy seeds if running low
    try {
        const r = await executeAutoBuy(playerId, efficiency);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Auto-buy error', { playerId, err: e.message }); }

    // 9. Auto-start next research if idle
    try {
        const r = await executeAutoResearch(playerId);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Research error', { playerId, err: e.message }); }

    // 10. Auto-train idle workers on random traits
    try {
        const r = await executeAutoTrain(playerId);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Train error', { playerId, err: e.message }); }

    // 11. Auto-claim and start breeding
    try {
        const r = await executeAutoBreed(playerId);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Breed error', { playerId, err: e.message }); }

    // 12. Auto-activate purchased boosters
    try {
        const r = await executeAutoBooster(playerId);
        totalActions += r.actionsPerformed;
    } catch (e) { logger.warn('[IdleTycoon] Booster error', { playerId, err: e.message }); }

    // Update all active workers' stats for this player
    if (totalActions > 0) {
        try {
            await pool.execute(`
                UPDATE cfx_player_workers
                SET last_action_at = NOW(),
                    total_actions = total_actions + 1,
                    experience = experience + 1
                WHERE player_id = ? AND is_enabled = TRUE AND is_training = FALSE
            `, [playerId]);
        } catch (e) {}
    }

    return { totalActions };
}

// ============================================================
// IDLE AUTOMATION FUNCTIONS
// ============================================================

/**
 * Auto-harvest: Harvest ALL ready plants instantly
 */
async function executeAutoHarvest(playerId, efficiency = 1.0, qualityBonus = 0) {
    // Check player setting
    const [[hSettings]] = await pool.execute(
        'SELECT auto_harvest_enabled FROM cfx_player_settings WHERE player_id = ?', [playerId]
    );
    if (hSettings && !hSettings.auto_harvest_enabled) {
        return { type: 'auto_harvest', actionsPerformed: 0 };
    }

    const results = await harvestAll(playerId);

    if (results.length > 0) {
        let totalXp = 0;
        for (const harvest of results) {
            const baseXp = 10 + Math.floor(harvest.quality / 10);
            const xp = Math.floor(baseXp * efficiency);
            totalXp += xp;

            if (qualityBonus > 0) {
                await pool.execute(
                    `UPDATE cfx_inventory
                     SET quality = LEAST(100, quality + ?)
                     WHERE player_id = ? AND strain_id = ?
                     ORDER BY id DESC LIMIT 1`,
                    [Math.floor(qualityBonus * 100), playerId, harvest.strainId]
                );
            }
        }

        if (totalXp > 0) await awardXp(playerId, totalXp);

        await logWorkerAction(playerId, 'trimmer', 'auto_harvest', results.length, 0, {
            harvests: results.length, xpAwarded: totalXp, efficiency
        });
        await trackStat(playerId, 'total_harvests', results.length);
        await trackStat(playerId, 'total_plants_grown', results.length);
        await trackStat(playerId, 'total_xp_earned', totalXp);
        await awardEventPoints(playerId, 10 * results.length);
        await addHeat(playerId, 2 * results.length, 'worker_harvest');
        await updateQuestProgress(playerId, 'harvest_count', results.length);

        // Fire-and-forget: reputation + tournament
        awardReputation(playerId, 'growers_guild', results.length).catch(() => {});
        if (updateTournamentScore) updateTournamentScore(playerId, 'harvest', results.length).catch(() => {});

        return {
            type: 'auto_harvest',
            actionsPerformed: results.length,
            xpAwarded: totalXp
        };
    }

    return { type: 'auto_harvest', actionsPerformed: 0 };
}

/**
 * Auto-vault: Move inventory items into vault when space is available.
 * Runs after harvest to protect items from raids automatically.
 * Only runs if player has a vault (level >= 1).
 */
async function executeAutoVault(playerId) {
    // Get vault
    const [[vault]] = await pool.execute(
        'SELECT vault_level, vault_cash FROM cfx_player_vault WHERE player_id = ?',
        [playerId]
    );
    if (!vault || vault.vault_level < 1) return;

    const capacity = VAULT_CAPACITY[vault.vault_level];
    if (!capacity || capacity.slots <= 0) return;

    // Count current vault slot usage
    const [[vaultItemCount]] = await pool.execute(
        'SELECT COUNT(*) as cnt FROM cfx_vault_inventory WHERE player_id = ? AND quantity > 0',
        [playerId]
    );
    const [[vaultSeedQty]] = await pool.execute(
        'SELECT COALESCE(SUM(quantity), 0) as total FROM cfx_vault_seeds WHERE player_id = ?',
        [playerId]
    );
    const usedSlots = (vaultItemCount?.cnt || 0) + Math.ceil((vaultSeedQty?.total || 0) / 10);
    let availableSlots = capacity.slots - usedSlots;

    if (availableSlots <= 0) return;

    // Get all regular inventory items (newest first — most likely just harvested)
    // Skip items with source='vault' — those were manually withdrawn by the player
    const [items] = await pool.execute(
        `SELECT id, strain_id, quantity, quality
         FROM cfx_inventory WHERE player_id = ? AND quantity > 0
         AND (source IS NULL OR source != 'vault')
         ORDER BY id DESC`,
        [playerId]
    );

    if (items.length === 0) return;

    let moved = 0;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        for (const item of items) {
            if (availableSlots <= 0) break;

            // Check if this strain+quality already exists in vault (stack into it)
            const [[existing]] = await conn.execute(
                'SELECT id FROM cfx_vault_inventory WHERE player_id = ? AND strain_id = ? AND quality = ? FOR UPDATE',
                [playerId, item.strain_id, item.quality]
            );

            if (existing) {
                // Stack into existing vault slot (no new slot needed)
                await conn.execute(
                    'UPDATE cfx_vault_inventory SET quantity = quantity + ? WHERE id = ?',
                    [item.quantity, existing.id]
                );
            } else {
                // New vault slot needed
                await conn.execute(
                    'INSERT INTO cfx_vault_inventory (player_id, strain_id, quantity, quality) VALUES (?, ?, ?, ?)',
                    [playerId, item.strain_id, item.quantity, item.quality]
                );
                availableSlots--;
            }

            // Remove from regular inventory
            await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            moved++;
        }

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        logger.warn('[IdleTycoon] Auto-vault transaction failed', { playerId, error: e.message });
        return;
    } finally {
        conn.release();
    }

    if (moved > 0) {
        logger.debug('[IdleTycoon] Auto-vault moved items', { playerId, moved });
    }
}

/**
 * Auto-plant: Plant seeds in ALL empty slots (no cap)
 */
async function executeAutoPlant(playerId, efficiency = 1.0) {
    const [emptySlots] = await pool.execute(
        `SELECT slot_number, preferred_strain_id, use_slot_preference
         FROM cfx_grow_slots
         WHERE player_id = ? AND status = 'empty'
         ORDER BY slot_number`,
        [playerId]
    );

    if (emptySlots.length === 0) return { type: 'auto_plant', actionsPerformed: 0 };

    // Check global auto-replant config
    const [configRows] = await pool.execute(
        `SELECT auto_replant_enabled, auto_replant_strain_id, auto_replant_use_favorite,
                auto_buy_seeds_enabled, auto_buy_seeds_threshold
         FROM cfx_player_settings WHERE player_id = ?`,
        [playerId]
    );
    const config = configRows[0] || {};

    // Respect auto-replant toggle
    if (config.auto_replant_enabled === 0) {
        return { type: 'auto_plant', actionsPerformed: 0 };
    }

    let globalPreferredStrainId = null;
    if (config.auto_replant_use_favorite) {
        const [favRows] = await pool.execute(
            `SELECT sf.strain_id FROM cfx_strain_favorites sf
             JOIN cfx_seed_inventory si ON sf.strain_id = si.strain_id
             WHERE sf.player_id = ? AND si.player_id = ? AND si.quantity > 0
             ORDER BY sf.sort_order LIMIT 1`,
            [playerId, playerId]
        );
        if (favRows.length > 0) globalPreferredStrainId = favRows[0].strain_id;
    } else if (config.auto_replant_strain_id) {
        globalPreferredStrainId = config.auto_replant_strain_id;
    }

    // Get all available seeds
    const [allSeeds] = await pool.execute(
        `SELECT si.strain_id, si.quantity, s.name, s.rarity
         FROM cfx_seed_inventory si
         JOIN cfx_strains s ON si.strain_id = s.id
         WHERE si.player_id = ? AND si.quantity > 0`,
        [playerId]
    );

    const seedMap = new Map();
    for (const seed of allSeeds) seedMap.set(seed.strain_id, { ...seed });

    if (seedMap.size === 0) {
        // No seeds - try auto-buy if enabled
        if (config.auto_buy_seeds_enabled) {
            try {
                const { autoBuySeeds } = await import('../routes/automation.js');
                const buyResult = await autoBuySeeds(playerId, globalPreferredStrainId);
                if (buyResult.purchased) return executeAutoPlant(playerId, efficiency);
            } catch (e) {}
        }
        return { type: 'auto_plant', actionsPerformed: 0 };
    }

    const planted = [];

    // Plant ALL empty slots - no cap
    for (const slot of emptySlots) {
        let strainToPlant = null;

        // Priority 1: Per-slot preference
        if (slot.use_slot_preference && slot.preferred_strain_id) {
            const slotSeed = seedMap.get(slot.preferred_strain_id);
            if (slotSeed && slotSeed.quantity > 0) strainToPlant = slot.preferred_strain_id;
        }

        // Priority 2: Global preference
        if (!strainToPlant && globalPreferredStrainId) {
            const globalSeed = seedMap.get(globalPreferredStrainId);
            if (globalSeed && globalSeed.quantity > 0) strainToPlant = globalPreferredStrainId;
        }

        // Priority 3: Any available seed (prefer higher rarity)
        if (!strainToPlant) {
            const rarityOrder = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
            for (const rarity of rarityOrder) {
                for (const [strainId, seed] of seedMap) {
                    if (seed.rarity === rarity && seed.quantity > 0) {
                        strainToPlant = strainId;
                        break;
                    }
                }
                if (strainToPlant) break;
            }
        }

        if (!strainToPlant) break; // No more seeds available

        try {
            await plantSeed(playerId, slot.slot_number, strainToPlant);
            const seed = seedMap.get(strainToPlant);
            if (seed) seed.quantity--;
            planted.push({ slot: slot.slot_number, strain: seed?.name || 'Unknown' });
        } catch (plantError) {
            logger.warn('[IdleTycoon] Plant slot failed', {
                playerId, slot: slot.slot_number, error: plantError.message
            });
        }
    }

    if (planted.length > 0) {
        await logWorkerAction(playerId, 'propagation_tech', 'auto_plant', planted.length, 0, {
            planted: planted.length, efficiency
        });
        await awardEventPoints(playerId, 5 * planted.length);
    }

    return { type: 'auto_plant', actionsPerformed: planted.length };
}

/**
 * Auto-sell: Sell ALL eligible inventory via NPC market (no percentage/capacity caps)
 */
async function executeAutoSell(playerId, efficiency = 1.0) {
    const [settingsRows] = await pool.execute(
        `SELECT auto_sell_enabled, workflow_mode, min_inventory_reserve, sell_quality_threshold, reserve_rare_strains
         FROM cfx_player_settings WHERE player_id = ?`,
        [playerId]
    );
    const settings = settingsRows[0] || {
        auto_sell_enabled: 1,
        workflow_mode: 'balanced',
        min_inventory_reserve: 0,
        sell_quality_threshold: 0,
        reserve_rare_strains: true
    };

    // Respect auto-sell toggle
    if (!settings.auto_sell_enabled) {
        return { type: 'auto_sell', actionsPerformed: 0, skipped: 'disabled' };
    }

    // Respect manual mode
    if (settings.workflow_mode === 'manual') {
        return { type: 'auto_sell', actionsPerformed: 0, skipped: 'manual_mode' };
    }

    let query = `
        SELECT inv.*, s.name as strain_name, s.base_price, s.rarity
        FROM cfx_inventory inv
        JOIN cfx_strains s ON inv.strain_id = s.id
        WHERE inv.player_id = ? AND inv.quantity > 0
    `;
    const params = [playerId];

    if (settings.sell_quality_threshold > 0) {
        query += ` AND inv.quality >= ?`;
        params.push(settings.sell_quality_threshold);
    }

    if (settings.reserve_rare_strains) {
        query += ` AND s.rarity IN ('common', 'uncommon')`;
    }

    query += ` ORDER BY inv.quality ASC`;

    const [inventory] = await pool.execute(query, params);
    if (inventory.length === 0) return { type: 'auto_sell', actionsPerformed: 0 };

    // Respect min_inventory_reserve only
    const stacksToKeep = settings.min_inventory_reserve || 0;
    const sellableCount = Math.max(0, inventory.length - stacksToKeep);
    if (sellableCount === 0) return { type: 'auto_sell', actionsPerformed: 0 };

    const [marketPrices] = await pool.execute(`SELECT strain_id, current_price FROM cfx_market_prices`);
    const priceMap = new Map(marketPrices.map(p => [p.strain_id, parseFloat(p.current_price)]));

    let totalCash = 0;
    let itemsSold = 0;
    let stacksSold = 0;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        for (let i = 0; i < sellableCount; i++) {
            const item = inventory[i];
            const marketPrice = priceMap.get(item.strain_id) || item.base_price;
            const qualityMultiplier = item.quality / 100;
            const pricePerUnit = Math.floor(marketPrice * qualityMultiplier * efficiency);
            const totalPrice = pricePerUnit * item.quantity;

            await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            totalCash += totalPrice;
            itemsSold += item.quantity;
            stacksSold++;
        }

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    if (totalCash > 0) {
        await awardCash(playerId, totalCash);
        await logWorkerAction(playerId, 'sales_rep', 'auto_sell', itemsSold, totalCash, {
            stacksSold, totalCash, efficiency
        });
        await trackStat(playerId, 'total_cash_earned', totalCash);
        await trackStat(playerId, 'total_trades_completed', stacksSold);
        await awardEventPoints(playerId, 5 * stacksSold);
        await addHeat(playerId, 3 * stacksSold, 'worker_sale');
        await updateQuestProgress(playerId, 'sell_count', stacksSold);

        // Fire-and-forget: reputation + tournament
        awardReputation(playerId, 'traders_union', stacksSold).catch(() => {});
        if (updateTournamentScore) updateTournamentScore(playerId, 'sales', totalCash).catch(() => {});
    }

    return { type: 'auto_sell', actionsPerformed: itemsSold, stacksSold, totalCash };
}

/**
 * Extraction work: Auto-claim completed extractions
 */
async function executeExtractionWork(playerId, efficiency = 1.0) {
    const [completedSlots] = await pool.execute(
        `SELECT es.* FROM cfx_extraction_slots es
         WHERE es.player_id = ? AND es.status = 'processing' AND es.completes_at <= NOW()`,
        [playerId]
    );

    let claimed = 0;

    for (const slot of completedSlots) {
        try {
            const [[recipe]] = await pool.execute(
                `SELECT * FROM cfx_extraction_recipes WHERE id = ?`,
                [slot.recipe_id]
            );

            if (recipe) {
                const outputQuantity = Math.ceil(recipe.output_quantity * efficiency);
                const outputQuality = Math.min(100, Math.floor(slot.input_quality * parseFloat(recipe.quality_retention || 0.85)));

                // Calculate base value from strain price * value_multiplier
                let baseValue = 100;
                if (slot.input_strain_id) {
                    const [[strain]] = await pool.execute('SELECT base_price FROM cfx_strains WHERE id = ?', [slot.input_strain_id]);
                    baseValue = parseFloat(strain?.base_price || 100) * parseFloat(recipe.value_multiplier || 1.5);
                }

                await pool.execute(
                    `INSERT INTO cfx_player_products (player_id, recipe_id, strain_id, product_name, product_type, quality, quantity, base_value)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
                    [playerId, recipe.id, slot.input_strain_id || 0, recipe.product_name || recipe.name,
                     recipe.product_type || 'concentrate', outputQuality, outputQuantity, baseValue, outputQuantity]
                );

                await pool.execute(
                    `UPDATE cfx_extraction_slots
                     SET status = 'empty', recipe_id = NULL, input_strain_id = NULL,
                         input_quality = NULL, started_at = NULL, completes_at = NULL
                     WHERE id = ?`,
                    [slot.id]
                );

                claimed++;
            }
        } catch (error) {
            logger.warn('[IdleTycoon] Extraction claim error', { playerId, slotId: slot.id, error: error.message });
        }
    }

    if (claimed > 0) {
        awardReputation(playerId, 'research_collective', claimed * 5).catch(() => {});
    }

    return { type: 'extraction_work', actionsPerformed: claimed };
}

/**
 * Auto-process: Fill ALL empty extraction slots with inventory (no cap)
 */
async function executeAutoProcess(playerId, efficiency = 1.0) {
    const [emptySlots] = await pool.execute(
        `SELECT id FROM cfx_extraction_slots WHERE player_id = ? AND status = 'empty'`,
        [playerId]
    );

    if (emptySlots.length === 0) return { type: 'auto_process', actionsPerformed: 0 };

    const [recipes] = await pool.execute(
        `SELECT * FROM cfx_extraction_recipes WHERE is_active = TRUE ORDER BY tier ASC`
    );
    if (recipes.length === 0) return { type: 'auto_process', actionsPerformed: 0 };

    const [inventory] = await pool.execute(
        `SELECT inv.*, s.name as strain_name
         FROM cfx_inventory inv
         JOIN cfx_strains s ON inv.strain_id = s.id
         WHERE inv.player_id = ? AND inv.quantity > 0
         ORDER BY inv.quality DESC`,
        [playerId]
    );
    if (inventory.length === 0) return { type: 'auto_process', actionsPerformed: 0 };

    let processed = 0;

    // Fill ALL empty slots (no cap)
    for (let i = 0; i < emptySlots.length && i < inventory.length; i++) {
        const slot = emptySlots[i];
        const item = inventory[i];
        const recipe = recipes[0]; // Use basic recipe

        const processTimeMs = Math.floor((recipe.process_time_ms || 300000) / efficiency);
        const completesAt = new Date(Date.now() + processTimeMs);

        try {
            await pool.execute(
                `UPDATE cfx_extraction_slots
                 SET status = 'processing', recipe_id = ?, input_strain_id = ?,
                     input_quantity = 1, input_quality = ?, started_at = NOW(), completes_at = ?
                 WHERE id = ?`,
                [recipe.id, item.strain_id, item.quality, completesAt, slot.id]
            );

            if (item.quantity <= 1) {
                await pool.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            } else {
                await pool.execute('UPDATE cfx_inventory SET quantity = quantity - 1 WHERE id = ?', [item.id]);
                item.quantity--;
            }

            processed++;
        } catch (error) {
            logger.warn('[IdleTycoon] Process slot error', { playerId, slotId: slot.id, error: error.message });
        }
    }

    return { type: 'auto_process', actionsPerformed: processed };
}

/**
 * Dispensary work: Auto-serve ALL waiting customers (no cap)
 */
async function executeDispensaryWork(playerId, efficiency = 1.0) {
    const [[dispensary]] = await pool.execute(
        `SELECT * FROM cfx_dispensaries WHERE player_id = ? AND is_open = TRUE`,
        [playerId]
    );

    if (!dispensary) return { type: 'dispensary_work', actionsPerformed: 0 };

    const [orders] = await pool.execute(
        `SELECT o.*, c.tip_chance, c.tip_multiplier
         FROM cfx_dispensary_orders o
         JOIN cfx_dispensary_customers c ON o.customer_id = c.id
         WHERE o.dispensary_id = ? AND o.status = 'waiting' AND o.expires_at > NOW()
         ORDER BY o.expires_at ASC
         LIMIT 50`,
        [dispensary.id]
    );

    let served = 0;
    let totalEarned = 0;

    for (const order of orders) {
        const [[listing]] = await pool.execute(
            `SELECT * FROM cfx_dispensary_inventory
             WHERE dispensary_id = ? AND quality >= ? AND price_per_unit <= ? AND quantity > 0
             ORDER BY price_per_unit DESC LIMIT 1`,
            [dispensary.id, order.requested_quality_min, order.budget]
        );

        if (!listing) continue;

        const saleAmount = Math.min(listing.price_per_unit, order.budget);
        const tipRoll = Math.random();
        const tipAmount = tipRoll < order.tip_chance
            ? Math.floor(saleAmount * order.tip_multiplier * efficiency)
            : 0;

        if (listing.quantity <= 1) {
            await pool.execute(`DELETE FROM cfx_dispensary_inventory WHERE id = ?`, [listing.id]);
        } else {
            await pool.execute(`UPDATE cfx_dispensary_inventory SET quantity = quantity - 1 WHERE id = ?`, [listing.id]);
        }

        await pool.execute(
            `UPDATE cfx_dispensary_orders
             SET status = 'served', sale_amount = ?, tip_amount = ?, completed_at = NOW()
             WHERE id = ?`,
            [saleAmount, tipAmount, order.id]
        );

        const totalSale = saleAmount + tipAmount;
        totalEarned += totalSale;
        served++;

        await pool.execute(
            `UPDATE cfx_dispensaries
             SET total_sales = total_sales + 1, total_revenue = total_revenue + ?, reputation = reputation + 1
             WHERE id = ?`,
            [totalSale, dispensary.id]
        );
    }

    if (totalEarned > 0) {
        await awardCash(playerId, totalEarned);
        await trackStat(playerId, 'total_cash_earned', totalEarned);
        awardReputation(playerId, 'traders_union', served).catch(() => {});
        if (updateTournamentScore) updateTournamentScore(playerId, 'sales', totalEarned).catch(() => {});
    }

    return { type: 'dispensary_work', actionsPerformed: served, totalCash: totalEarned };
}

/**
 * Auto-sell on black market: Sell high-quality items (70+) to unlocked contacts
 */
async function executeAutoBlackMarketSell(playerId) {
    // Check if black market is unlocked
    let hasBlackMarket = false;
    try { hasBlackMarket = await hasFeatureUnlock(playerId, 'black_market'); } catch (e) {}
    if (!hasBlackMarket) return { type: 'auto_bm_sell', actionsPerformed: 0 };

    // Skip if heat is too high (SCORCHING+) — don't generate more heat
    try {
        const [[heatRow]] = await pool.execute(
            'SELECT current_heat FROM cfx_player_heat WHERE player_id = ?', [playerId]
        );
        if (parseFloat(heatRow?.current_heat || 0) >= 100) {
            return { type: 'auto_bm_sell', actionsPerformed: 0, skipped: 'heat_too_high' };
        }
    } catch (e) {}

    // Get player reputation
    let playerReputation = 0;
    try {
        const [[rep]] = await pool.execute(
            `SELECT pr.reputation FROM cfx_player_reputation pr
             JOIN cfx_factions f ON pr.faction_id = f.id
             WHERE pr.player_id = ? AND f.faction_key = 'shadow_syndicate'
             LIMIT 1`,
            [playerId]
        );
        playerReputation = rep?.reputation || 0;
    } catch (e) {}

    // Get available contacts (reputation met)
    const [contacts] = await pool.execute(
        `SELECT bmc.*, pbm.last_sale_at
         FROM cfx_black_market_contacts bmc
         LEFT JOIN cfx_player_black_market pbm ON bmc.id = pbm.contact_id AND pbm.player_id = ?
         WHERE bmc.is_active = TRUE AND bmc.reputation_required <= ?
         ORDER BY bmc.price_multiplier DESC`,
        [playerId, playerReputation]
    );

    // Filter out contacts on cooldown
    const availableContacts = contacts.filter(c => {
        if (!c.last_sale_at) return true;
        const cooldownEnds = new Date(c.last_sale_at).getTime() + c.cooldown_minutes * 60 * 1000;
        return cooldownEnds <= Date.now();
    });

    if (availableContacts.length === 0) return { type: 'auto_bm_sell', actionsPerformed: 0 };

    // Get high-quality inventory (quality >= 70 for black market)
    const [inventory] = await pool.execute(
        `SELECT inv.*, s.name as strain_name, s.base_price
         FROM cfx_inventory inv
         JOIN cfx_strains s ON inv.strain_id = s.id
         WHERE inv.player_id = ? AND inv.quantity > 0 AND inv.quality >= 70
         ORDER BY inv.quality DESC`,
        [playerId]
    );

    if (inventory.length === 0) return { type: 'auto_bm_sell', actionsPerformed: 0 };

    let sold = 0;
    let totalCash = 0;

    for (const item of inventory) {
        if (availableContacts.length === 0) break;

        // Find best contact that accepts this quality
        const contactIdx = availableContacts.findIndex(c => item.quality >= c.min_quality);
        if (contactIdx === -1) continue;
        const contact = availableContacts[contactIdx];

        const sellQty = Math.min(item.quantity, contact.max_quantity_per_sale);
        if (sellQty < 1) continue;

        const basePrice = (parseFloat(item.base_price) || 100) * ((item.quality || 50) / 50);
        const finalPrice = basePrice * sellQty * parseFloat(contact.price_multiplier);
        const heatGenerated = Math.ceil(sellQty * parseFloat(contact.heat_multiplier) * 2);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            if (item.quantity <= sellQty) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            } else {
                await conn.execute('UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?', [sellQty, item.id]);
            }

            await conn.execute(
                `INSERT INTO cfx_black_market_sales
                 (player_id, contact_id, strain_id, quality, quantity, sale_price, heat_generated, sold_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [playerId, contact.id, item.strain_id, item.quality, sellQty, finalPrice, heatGenerated]
            );

            await conn.execute(
                `INSERT INTO cfx_player_black_market (player_id, contact_id, last_sale_at, total_sales, total_revenue)
                 VALUES (?, ?, NOW(), 1, ?)
                 ON DUPLICATE KEY UPDATE last_sale_at = NOW(), total_sales = total_sales + 1, total_revenue = total_revenue + ?`,
                [playerId, contact.id, finalPrice, finalPrice]
            );

            await conn.commit();

            await awardCash(playerId, finalPrice);
            addHeat(playerId, heatGenerated, 'black_market_sale').catch(() => {});
            awardReputation(playerId, 'shadow_syndicate', 5).catch(() => {});

            sold++;
            totalCash += finalPrice;

            // Remove this contact from available (cooldown started)
            availableContacts.splice(contactIdx, 1);
        } catch (e) {
            await conn.rollback();
            logger.warn('[IdleTycoon] BM sell error', { playerId, error: e.message });
        } finally {
            conn.release();
        }
    }

    if (sold > 0) {
        await trackStat(playerId, 'total_cash_earned', totalCash);
    }

    return { type: 'auto_bm_sell', actionsPerformed: sold, totalCash };
}

/**
 * Auto-buy: Buy seeds when running low
 */
async function executeAutoBuy(playerId, efficiency = 1.0) {
    const [settingsRows] = await pool.execute(
        `SELECT auto_buy_seeds_enabled, auto_buy_seeds_threshold, auto_buy_seeds_max_price
         FROM cfx_player_settings WHERE player_id = ?`,
        [playerId]
    );
    const settings = settingsRows[0] || {};

    if (!settings.auto_buy_seeds_enabled) return { type: 'auto_buy', actionsPerformed: 0 };

    const [[seedCount]] = await pool.execute(
        `SELECT COALESCE(SUM(quantity), 0) as total FROM cfx_seed_inventory WHERE player_id = ?`,
        [playerId]
    );

    const threshold = settings.auto_buy_seeds_threshold || 5;
    if (seedCount.total >= threshold) return { type: 'auto_buy', actionsPerformed: 0 };

    const [[player]] = await pool.execute(`SELECT cash FROM cfx_players WHERE id = ?`, [playerId]);
    const maxPrice = settings.auto_buy_seeds_max_price || 500;
    if (player.cash < maxPrice) return { type: 'auto_buy', actionsPerformed: 0 };

    // Try deals first
    const [deals] = await pool.execute(
        `SELECT sr.*, s.name as strain_name, s.base_price
         FROM cfx_shop_rotation sr
         JOIN cfx_strains s ON sr.strain_id = s.id
         WHERE sr.is_active = TRUE AND sr.ends_at > NOW()
         AND (sr.max_purchases IS NULL OR sr.current_purchases < sr.max_purchases)
         ORDER BY sr.discount_percent DESC
         LIMIT 1`
    );

    if (deals.length > 0) {
        const deal = deals[0];
        const discountedPrice = Math.floor(deal.base_price * (100 - deal.discount_percent) / 100);
        if (discountedPrice <= maxPrice && player.cash >= discountedPrice) {
            const seedQty = 1 + (deal.bonus_seeds || 0);
            await pool.execute('UPDATE cfx_players SET cash = cash - ? WHERE id = ?', [discountedPrice, playerId]);
            await pool.execute(
                `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
                [playerId, deal.strain_id, seedQty, seedQty]
            );
            await pool.execute('UPDATE cfx_shop_rotation SET current_purchases = current_purchases + 1 WHERE id = ?', [deal.id]);
            return { type: 'auto_buy', actionsPerformed: 1 };
        }
    }

    // Regular shop items
    const [shopSeeds] = await pool.execute(
        `SELECT si.*, s.name as strain_name, s.base_price
         FROM cfx_shop_items si
         JOIN cfx_strains s ON si.strain_id = s.id
         WHERE si.category = 'seeds' AND si.price <= ?
         ORDER BY s.rarity DESC, si.price ASC
         LIMIT 1`,
        [Math.min(maxPrice, player.cash)]
    );

    if (shopSeeds.length > 0) {
        const seed = shopSeeds[0];
        const packSize = seed.pack_size || 1;
        await pool.execute('UPDATE cfx_players SET cash = cash - ? WHERE id = ?', [seed.price, playerId]);
        await pool.execute(
            `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
            [playerId, seed.strain_id, packSize, packSize]
        );
        return { type: 'auto_buy', actionsPerformed: 1 };
    }

    return { type: 'auto_buy', actionsPerformed: 0 };
}

/**
 * Auto-research: If no research in progress, find and start the cheapest available one
 */
async function executeAutoResearch(playerId) {
    // Check if already researching
    const [[existing]] = await pool.execute(
        `SELECT id FROM cfx_player_research WHERE player_id = ? AND status = 'researching'`,
        [playerId]
    );
    if (existing) return { type: 'auto_research', actionsPerformed: 0 };

    // Get completed research keys for prerequisite checking
    const [completedRows] = await pool.execute(
        `SELECT rn.research_key FROM cfx_player_research pr
         JOIN cfx_research_nodes rn ON pr.research_id = rn.id
         WHERE pr.player_id = ? AND pr.status = 'completed'`,
        [playerId]
    );
    const completedKeys = new Set(completedRows.map(r => r.research_key));

    // Get all unstarted research nodes
    const [nodes] = await pool.execute(
        `SELECT rn.* FROM cfx_research_nodes rn
         WHERE rn.is_active = TRUE
         AND rn.id NOT IN (
             SELECT research_id FROM cfx_player_research
             WHERE player_id = ? AND status IN ('completed', 'researching')
         )
         ORDER BY rn.tier ASC, rn.cost_cash ASC`,
        [playerId]
    );

    if (nodes.length === 0) return { type: 'auto_research', actionsPerformed: 0 };

    // Get player resources
    const [[player]] = await pool.execute(`SELECT cash, xp FROM cfx_players WHERE id = ?`, [playerId]);
    if (!player) return { type: 'auto_research', actionsPerformed: 0 };

    // Find first affordable research with met prerequisites
    for (const node of nodes) {
        let prerequisites = [];
        try { prerequisites = node.prerequisites ? JSON.parse(node.prerequisites) : []; } catch (e) {}

        if (!prerequisites.every(key => completedKeys.has(key))) continue;
        if (player.cash < node.cost_cash || player.xp < node.cost_xp) continue;

        // Start this research
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            await conn.execute(
                `UPDATE cfx_players SET cash = cash - ?, xp = xp - ? WHERE id = ?`,
                [node.cost_cash, node.cost_xp, playerId]
            );

            // Calculate time with worker speed bonus
            let workerBonuses = { researchSpeed: 0 };
            try { workerBonuses = await getWorkerBonuses(playerId); } catch (e) {}
            const speedMultiplier = 1 + (workerBonuses.researchSpeed || 0);
            const baseTimeMs = node.research_time_hours * 60 * 60 * 1000;
            const actualTimeMs = baseTimeMs / speedMultiplier;
            const completesAt = new Date(Date.now() + actualTimeMs);

            await conn.execute(
                `INSERT INTO cfx_player_research (player_id, research_id, status, started_at, completes_at)
                 VALUES (?, ?, 'researching', NOW(), ?)
                 ON DUPLICATE KEY UPDATE status = 'researching', started_at = NOW(), completes_at = ?`,
                [playerId, node.id, completesAt, completesAt]
            );

            await conn.commit();

            logger.info('[IdleTycoon] Auto-started research', { playerId, research: node.name });
            return { type: 'auto_research', actionsPerformed: 1, research: node.name };
        } catch (e) {
            await conn.rollback();
            logger.warn('[IdleTycoon] Auto-research failed', { playerId, error: e.message });
        } finally {
            conn.release();
        }
    }

    return { type: 'auto_research', actionsPerformed: 0 };
}

/**
 * Auto-train: Train idle workers on random compatible traits they haven't maxed
 */
async function executeAutoTrain(playerId) {
    // Check if training research is unlocked
    let hasTraining = false;
    try { hasTraining = await hasResearch(playerId, 'worker_efficiency_1'); } catch (e) {}
    if (!hasTraining) return { type: 'auto_train', actionsPerformed: 0 };

    // Get idle workers (not training, enabled)
    const [idleWorkers] = await pool.execute(
        `SELECT pw.id, pw.worker_type_id, wt.worker_key
         FROM cfx_player_workers pw
         JOIN cfx_worker_types wt ON pw.worker_type_id = wt.id
         WHERE pw.player_id = ? AND pw.is_enabled = TRUE AND pw.is_training = FALSE`,
        [playerId]
    );
    if (idleWorkers.length === 0) return { type: 'auto_train', actionsPerformed: 0 };

    // Get all active traits
    const [allTraits] = await pool.execute(`SELECT * FROM cfx_worker_traits WHERE is_active = TRUE`);

    // Get player cash
    const [[player]] = await pool.execute(`SELECT cash FROM cfx_players WHERE id = ?`, [playerId]);
    if (!player) return { type: 'auto_train', actionsPerformed: 0 };

    let trained = 0;
    let availableCash = parseFloat(player.cash);

    for (const worker of idleWorkers) {
        // Get this worker's current trait levels
        const [workerTraitLevels] = await pool.execute(
            `SELECT trait_id, current_level FROM cfx_worker_trait_levels WHERE worker_id = ?`,
            [worker.id]
        );
        const traitLevelMap = new Map(workerTraitLevels.map(t => [t.trait_id, t.current_level]));

        // Find compatible traits that aren't maxed
        const compatibleTraits = [];
        for (const trait of allTraits) {
            if (trait.compatible_workers) {
                let compatible;
                try { compatible = JSON.parse(trait.compatible_workers); } catch { continue; }
                if (!compatible.includes(worker.worker_key)) continue;
            }

            const currentLevel = traitLevelMap.get(trait.id) || 0;
            if (currentLevel >= trait.max_level) continue;

            // Check research unlock
            if (trait.unlock_research) {
                let unlocked = false;
                try { unlocked = await hasResearch(playerId, trait.unlock_research); } catch (e) {}
                if (!unlocked) continue;
            }

            compatibleTraits.push(trait);
        }

        if (compatibleTraits.length === 0) continue;

        // Pick a random compatible trait
        const trait = compatibleTraits[Math.floor(Math.random() * compatibleTraits.length)];
        const currentLevel = traitLevelMap.get(trait.id) || 0;
        const targetLevel = currentLevel + 1;
        const cost = trait.training_cost_base * targetLevel;

        if (availableCash < cost) continue;

        // Calculate training time
        let trainingHours = trait.training_time_base_hours * targetLevel;
        let hasAdvanced = false;
        try { hasAdvanced = await hasResearch(playerId, 'worker_efficiency_2'); } catch (e) {}
        if (hasAdvanced) trainingHours *= 0.75;

        let workerBonuses = { trainingSpeed: 0 };
        try { workerBonuses = await getWorkerBonuses(playerId); } catch (e) {}
        if (workerBonuses.trainingSpeed > 0) {
            trainingHours *= (1 - workerBonuses.trainingSpeed);
        }

        const completesAt = new Date(Date.now() + trainingHours * 60 * 60 * 1000);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            await conn.execute(`UPDATE cfx_players SET cash = cash - ? WHERE id = ?`, [cost, playerId]);

            // Create trait level record if needed
            if (!traitLevelMap.has(trait.id)) {
                await conn.execute(
                    `INSERT IGNORE INTO cfx_worker_trait_levels (worker_id, trait_id, current_level, training_progress)
                     VALUES (?, ?, 0, 0)`,
                    [worker.id, trait.id]
                );
            }

            await conn.execute(
                `INSERT INTO cfx_worker_training (player_id, worker_id, trait_id, target_level, completes_at, cost_paid)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [playerId, worker.id, trait.id, targetLevel, completesAt, cost]
            );

            await conn.execute(
                `UPDATE cfx_player_workers SET is_training = TRUE, training_completes_at = ? WHERE id = ?`,
                [completesAt, worker.id]
            );

            await conn.commit();

            availableCash -= cost;
            trained++;

            logger.info('[IdleTycoon] Auto-started training', {
                playerId, worker: worker.worker_key, trait: trait.name, level: targetLevel
            });
        } catch (e) {
            await conn.rollback();
            logger.warn('[IdleTycoon] Auto-train failed', { workerId: worker.id, error: e.message });
        } finally {
            conn.release();
        }
    }

    return { type: 'auto_train', actionsPerformed: trained };
}

/**
 * Auto-breed: Claim completed breeding operations + start new ones
 */
async function executeAutoBreed(playerId) {
    // Check player setting
    const [[breedSettings]] = await pool.execute(
        'SELECT auto_breed_enabled FROM cfx_player_settings WHERE player_id = ?', [playerId]
    );
    if (!breedSettings?.auto_breed_enabled) {
        return { type: 'auto_breed', actionsPerformed: 0 };
    }

    let actionsPerformed = 0;

    // Step 1: Claim all completed breeding operations
    const [completedOps] = await pool.execute(
        `SELECT id FROM cfx_breeding_operations
         WHERE player_id = ? AND status = 'breeding' AND ready_at <= ?`,
        [playerId, Date.now()]
    );

    for (const op of completedOps) {
        try {
            const result = await claimBreeding(playerId, op.id);
            actionsPerformed++;

            logger.info('[IdleTycoon] Auto-claimed breed', {
                playerId,
                operationId: op.id,
                resultStrain: result.resultStrain?.name,
                isNew: result.isNewStrain
            });

            // Fire-and-forget: reputation + tournament
            awardReputation(playerId, 'research_collective', 10).catch(() => {});
            if (updateTournamentScore) updateTournamentScore(playerId, 'quality', result.resultStrain?.quality || 50).catch(() => {});
        } catch (err) {
            logger.warn('[IdleTycoon] Auto-claim breed failed', { playerId, opId: op.id, error: err.message });
        }
    }

    // Step 2: Start new breeding if slots available
    const [[{ activeCount }]] = await pool.execute(
        `SELECT COUNT(*) as activeCount FROM cfx_breeding_operations
         WHERE player_id = ? AND status = 'breeding'`,
        [playerId]
    );

    // Get breeding slots from bonuses (default 1)
    const bonuses = await (async () => {
        try {
            const { getBonuses } = await import('../game/bonus-resolver.js');
            return await getBonuses(playerId);
        } catch { return { breedingSlots: 1 }; }
    })();
    const maxSlots = bonuses.breedingSlots || 1;

    if (activeCount >= maxSlots) {
        return { type: 'auto_breed', actionsPerformed };
    }

    // Get seeds with 2+ quantity (need 1 of each parent, prefer having extras)
    const [seeds] = await pool.execute(
        `SELECT si.strain_id, si.quantity, s.name, s.rarity
         FROM cfx_seed_inventory si
         JOIN cfx_strains s ON si.strain_id = s.id
         JOIN cfx_strain_discoveries sd ON sd.strain_id = si.strain_id AND sd.player_id = si.player_id
         WHERE si.player_id = ? AND si.quantity > 0
         ORDER BY s.rarity DESC, si.quantity DESC`,
        [playerId]
    );

    // Need at least 2 different strains to breed
    if (seeds.length < 2) {
        return { type: 'auto_breed', actionsPerformed };
    }

    // Start breeding for available slots
    const slotsToFill = maxSlots - activeCount;
    let started = 0;

    for (let i = 0; i < slotsToFill && seeds.length >= 2; i++) {
        // Pick 2 different strains - prefer highest rarity parents
        const parent1 = seeds[0];
        const parent2 = seeds[1];

        try {
            await startBreeding(playerId, parent1.strain_id, parent2.strain_id);
            started++;
            actionsPerformed++;

            // Update local seed counts
            parent1.quantity--;
            parent2.quantity--;

            // Remove depleted seeds from list
            if (parent1.quantity <= 0) seeds.splice(0, 1);
            if (seeds.length > 0 && seeds[0] === parent2 && parent2.quantity <= 0) seeds.splice(0, 1);
            else if (seeds.length > 1 && seeds[1] === parent2 && parent2.quantity <= 0) seeds.splice(1, 1);

            logger.info('[IdleTycoon] Auto-started breed', {
                playerId, parent1: parent1.name, parent2: parent2.name
            });
        } catch (err) {
            logger.warn('[IdleTycoon] Auto-start breed failed', {
                playerId, parent1: parent1.strain_id, parent2: parent2.strain_id, error: err.message
            });
            break;
        }
    }

    return { type: 'auto_breed', actionsPerformed };
}

/**
 * Auto-booster: Auto-activate purchased but inactive boosters
 * Requires 'auto_boosters' research to be completed
 */
async function executeAutoBooster(playerId) {
    // Gate behind research
    let hasAutoBoost = false;
    try { hasAutoBoost = await hasResearch(playerId, 'auto_boosters'); } catch (e) {}
    if (!hasAutoBoost) return { type: 'auto_booster', actionsPerformed: 0 };

    // Find unactivated boosters
    const [inactiveBoosters] = await pool.execute(
        `SELECT id, item_id, effect_type, multiplier, uses_remaining, item_name
         FROM cfx_player_shop_items
         WHERE player_id = ? AND item_type = 'booster' AND activated = 0`,
        [playerId]
    );

    if (inactiveBoosters.length === 0) return { type: 'auto_booster', actionsPerformed: 0 };

    // Check which effect types already have an active booster (don't stack same type)
    const [activeBoosters] = await pool.execute(
        `SELECT DISTINCT effect_type FROM cfx_player_shop_items
         WHERE player_id = ? AND item_type = 'booster' AND activated = 1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (uses_remaining IS NULL OR uses_remaining > 0)`,
        [playerId]
    );
    const activeTypes = new Set(activeBoosters.map(b => b.effect_type));

    // Booster definitions for duration lookup
    const BOOSTER_DURATIONS = {
        'boost_speed_1': 1800000,
        'boost_speed_2': 1800000,
        'boost_xp_1': 3600000,
    };

    let activated = 0;

    for (const booster of inactiveBoosters) {
        // Skip if same effect type already active
        if (activeTypes.has(booster.effect_type)) continue;

        const duration = BOOSTER_DURATIONS[booster.item_id];

        if (duration) {
            // Time-based booster: set expiration
            const expiresAt = new Date(Date.now() + duration);
            await pool.execute(
                'UPDATE cfx_player_shop_items SET activated = 1, expires_at = ? WHERE id = ?',
                [expiresAt, booster.id]
            );
        } else {
            // Uses-based booster: just activate
            await pool.execute(
                'UPDATE cfx_player_shop_items SET activated = 1 WHERE id = ?',
                [booster.id]
            );
        }

        activeTypes.add(booster.effect_type);
        activated++;

        logger.info('[IdleTycoon] Auto-activated booster', {
            playerId, booster: booster.item_name || booster.item_id, effect: booster.effect_type
        });
    }

    return { type: 'auto_booster', actionsPerformed: activated };
}

export default workersTick;
