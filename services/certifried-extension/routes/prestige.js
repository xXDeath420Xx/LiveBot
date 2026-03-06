/**
 * Prestige Routes
 * Prestige reset and progression
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { PRESTIGE } from '../config/game-constants.js';

const router = Router();

/**
 * GET /prestige/info
 * Get prestige information and eligibility
 */
router.get('/info', async (req, res) => {
    try {
        const player = req.player;

        const canPrestige = player.level >= PRESTIGE.MIN_LEVEL && player.cash >= PRESTIGE.MIN_CASH;

        // Calculate potential tokens
        const tokensFromLevel = Math.floor(player.level / 10);
        const tokensFromCash = Math.floor(Math.log10(Math.max(1, player.cash)));
        const potentialTokens = tokensFromLevel + tokensFromCash;

        // Calculate current bonuses
        const currentBonuses = {
            xp: player.prestige_level * PRESTIGE.XP_BONUS_PER_PRESTIGE * 100,
            yield: player.prestige_level * PRESTIGE.YIELD_BONUS_PER_PRESTIGE * 100,
            cash: player.prestige_level * PRESTIGE.CASH_BONUS_PER_PRESTIGE * 100
        };

        // Get prestige history
        const [history] = await pool.execute(
            `SELECT * FROM cfx_prestige_history WHERE player_id = ? ORDER BY performed_at DESC LIMIT 10`,
            [player.id]
        );

        res.json({
            success: true,
            prestige: {
                currentLevel: player.prestige_level,
                tokens: player.prestige_tokens,
                canPrestige,
                requirements: {
                    minLevel: PRESTIGE.MIN_LEVEL,
                    minCash: PRESTIGE.MIN_CASH,
                    currentLevel: player.level,
                    currentCash: player.cash
                },
                potentialTokens: canPrestige ? potentialTokens : 0,
                currentBonuses,
                nextBonuses: {
                    xp: (player.prestige_level + 1) * PRESTIGE.XP_BONUS_PER_PRESTIGE * 100,
                    yield: (player.prestige_level + 1) * PRESTIGE.YIELD_BONUS_PER_PRESTIGE * 100,
                    cash: (player.prestige_level + 1) * PRESTIGE.CASH_BONUS_PER_PRESTIGE * 100
                },
                whatResets: PRESTIGE.RESETS,
                whatKeeps: PRESTIGE.KEEPS
            },
            history: history.map(h => ({
                prestigeLevel: h.prestige_level,
                cashAtPrestige: h.cash_at_prestige,
                levelAtPrestige: h.level_at_prestige,
                tokensEarned: h.tokens_earned,
                performedAt: h.performed_at
            }))
        });

    } catch (error) {
        logger.error('[Prestige] Get info failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /prestige/reset
 * Perform prestige reset
 */
router.post('/reset', async (req, res) => {
    try {
        const player = req.player;

        // Check eligibility
        if (player.level < PRESTIGE.MIN_LEVEL) {
            return res.status(400).json({
                error: `Requires level ${PRESTIGE.MIN_LEVEL} (you are level ${player.level})`,
                code: 'LEVEL_REQUIRED'
            });
        }

        if (player.cash < PRESTIGE.MIN_CASH) {
            return res.status(400).json({
                error: `Requires $${PRESTIGE.MIN_CASH.toLocaleString()} (you have $${player.cash.toLocaleString()})`,
                code: 'CASH_REQUIRED'
            });
        }

        // Calculate tokens earned
        const tokensFromLevel = Math.floor(player.level / 10);
        const tokensFromCash = Math.floor(Math.log10(Math.max(1, player.cash)));
        const tokensEarned = tokensFromLevel + tokensFromCash;

        const newPrestigeLevel = player.prestige_level + 1;
        const newTokens = player.prestige_tokens + tokensEarned;

        // Get prestige upgrades to apply starting bonuses
        const [prestigeUpgrades] = await pool.execute(
            'SELECT upgrade_id, level FROM cfx_prestige_upgrades WHERE player_id = ?',
            [player.id]
        );

        // Calculate starting bonuses from prestige upgrades
        const startingCashEffects = [500, 1000, 2500, 5000, 10000];
        const startingSlotsEffects = [1, 2, 3];
        let extraStartingCash = 0;
        let extraStartingSlots = 0;

        for (const upgrade of prestigeUpgrades) {
            if (upgrade.upgrade_id === 'starting_cash' && upgrade.level > 0) {
                extraStartingCash = startingCashEffects[upgrade.level - 1] || 0;
            }
            if (upgrade.upgrade_id === 'starting_slots' && upgrade.level > 0) {
                extraStartingSlots = startingSlotsEffects[upgrade.level - 1] || 0;
            }
        }

        const startingCash = 1000 + extraStartingCash;
        const startingSlots = 2 + extraStartingSlots;

        // Wrap all prestige operations in a transaction to prevent partial resets
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Record prestige history
            await conn.execute(
                `INSERT INTO cfx_prestige_history (player_id, prestige_level, cash_at_prestige, level_at_prestige, tokens_earned)
                 VALUES (?, ?, ?, ?, ?)`,
                [player.id, newPrestigeLevel, player.cash, player.level, tokensEarned]
            );

            // Reset player (keeps prestige, tokens, skills, achievements)
            await conn.execute(
                `UPDATE cfx_players SET
                    cash = ?,
                    lifetime_earnings = 0,
                    lifetime_sales = 0,
                    facility_name = 'My Grow Op',
                    facility_level = 1,
                    max_grow_slots = ?,
                    xp = 0,
                    level = 1,
                    prestige_level = ?,
                    prestige_tokens = ?,
                    season_xp = 0
                 WHERE id = ?`,
                [startingCash, startingSlots, newPrestigeLevel, newTokens, player.id]
            );

            // Clear inventory
            await conn.execute('DELETE FROM cfx_inventory WHERE player_id = ?', [player.id]);

            // Reset grow slots
            await conn.execute('DELETE FROM cfx_grow_slots WHERE player_id = ?', [player.id]);
            // Create starting slots using parameterized queries (not string interpolation)
            for (let i = 1; i <= startingSlots; i++) {
                await conn.execute(
                    'INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, ?)',
                    [player.id, i]
                );
            }

            // Clear facility upgrades
            await conn.execute('DELETE FROM cfx_facility_upgrades WHERE player_id = ?', [player.id]);

            // Cancel active listings
            await conn.execute(
                `UPDATE cfx_market_listings SET status = 'cancelled' WHERE player_id = ? AND status = 'active'`,
                [player.id]
            );

            // Cancel active trades
            await conn.execute(
                `UPDATE cfx_trades SET status = 'cancelled' WHERE (offerer_id = ? OR receiver_id = ?) AND status = 'pending'`,
                [player.id, player.id]
            );

            // Clear active boosts (except permanent ones from bits)
            await conn.execute(
                `DELETE FROM cfx_active_boosts WHERE player_id = ? AND source_transaction_id IS NULL`,
                [player.id]
            );

            // Reset active quests
            await conn.execute(
                `UPDATE cfx_player_quests SET status = 'expired' WHERE player_id = ? AND status = 'active'`,
                [player.id]
            );

            // Check for exclusive strain unlocks
            const exclusiveStrainSlug = PRESTIGE.EXCLUSIVE_STRAINS?.[newPrestigeLevel];
            let unlockedStrain = null;

            if (exclusiveStrainSlug) {
                const [[strain]] = await conn.execute(
                    'SELECT id, name FROM cfx_strains WHERE slug = ?',
                    [exclusiveStrainSlug]
                );

                if (strain) {
                    await conn.execute(
                        'INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                        [player.id, strain.id]
                    );
                    unlockedStrain = { id: strain.id, name: strain.name };
                }
            }

            await conn.commit();
        } catch (txError) {
            await conn.rollback();
            throw txError;
        } finally {
            conn.release();
        }

        logger.info('[Prestige] Player prestiged', {
            playerId: player.id,
            newLevel: newPrestigeLevel,
            tokensEarned,
            previousLevel: player.level,
            previousCash: player.cash
        });

        res.json({
            success: true,
            newPrestigeLevel,
            tokensEarned,
            totalTokens: newTokens,
            permanentBonuses: {
                xp: newPrestigeLevel * PRESTIGE.XP_BONUS_PER_PRESTIGE * 100,
                yield: newPrestigeLevel * PRESTIGE.YIELD_BONUS_PER_PRESTIGE * 100,
                cash: newPrestigeLevel * PRESTIGE.CASH_BONUS_PER_PRESTIGE * 100
            },
            unlockedStrain
        });

    } catch (error) {
        logger.error('[Prestige] Reset failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Prestige failed', code: 'ERROR' });
    }
});

/**
 * GET /prestige/upgrades
 * Get available prestige upgrades
 */
router.get('/upgrades', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get player's purchased upgrades
        const [purchased] = await pool.execute(
            `SELECT upgrade_id, level FROM cfx_prestige_upgrades WHERE player_id = ?`,
            [playerId]
        );

        const purchasedMap = new Map(purchased.map(p => [p.upgrade_id, p.level]));

        // Define available upgrades
        const upgrades = [
            {
                id: 'starting_cash',
                name: 'Silver Spoon',
                description: 'Start with more cash after prestige',
                maxLevel: 5,
                costPerLevel: [1, 2, 4, 8, 16],
                effectPerLevel: [500, 1000, 2500, 5000, 10000],
                effectType: 'flat',
                effectLabel: 'Starting Cash'
            },
            {
                id: 'xp_boost',
                name: 'Quick Learner',
                description: 'Permanent XP boost',
                maxLevel: 5,
                costPerLevel: [2, 4, 6, 10, 15],
                effectPerLevel: [5, 10, 15, 25, 40],
                effectType: 'percent',
                effectLabel: 'XP Bonus'
            },
            {
                id: 'yield_boost',
                name: 'Green Thumb',
                description: 'Permanent yield boost',
                maxLevel: 5,
                costPerLevel: [2, 4, 6, 10, 15],
                effectPerLevel: [5, 10, 15, 25, 40],
                effectType: 'percent',
                effectLabel: 'Yield Bonus'
            },
            {
                id: 'growth_speed',
                name: 'Time Warp',
                description: 'Plants grow faster',
                maxLevel: 5,
                costPerLevel: [3, 6, 10, 15, 25],
                effectPerLevel: [5, 10, 15, 20, 30],
                effectType: 'percent',
                effectLabel: 'Growth Speed'
            },
            {
                id: 'starting_slots',
                name: 'Expanded Operation',
                description: 'Start with extra grow slots',
                maxLevel: 3,
                costPerLevel: [5, 15, 30],
                effectPerLevel: [1, 2, 3],
                effectType: 'flat',
                effectLabel: 'Extra Starting Slots'
            },
            {
                id: 'quality_boost',
                name: 'Master Grower',
                description: 'Higher base quality on harvests',
                maxLevel: 5,
                costPerLevel: [3, 6, 10, 15, 25],
                effectPerLevel: [5, 10, 15, 20, 30],
                effectType: 'percent',
                effectLabel: 'Quality Bonus'
            }
        ];

        res.json({
            success: true,
            tokens: req.player.prestige_tokens,
            upgrades: upgrades.map(u => {
                const currentLevel = purchasedMap.get(u.id) || 0;
                const isMaxed = currentLevel >= u.maxLevel;
                const nextCost = isMaxed ? null : u.costPerLevel[currentLevel];
                const currentEffect = currentLevel > 0 ? u.effectPerLevel[currentLevel - 1] : 0;
                const nextEffect = isMaxed ? null : u.effectPerLevel[currentLevel];

                return {
                    ...u,
                    currentLevel,
                    isMaxed,
                    nextCost,
                    currentEffect,
                    nextEffect,
                    canAfford: !isMaxed && req.player.prestige_tokens >= nextCost
                };
            })
        });

    } catch (error) {
        logger.error('[Prestige] Get upgrades failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /prestige/buy
 * Purchase a prestige upgrade
 */
router.post('/buy', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { upgrade_id } = req.body;

        if (!upgrade_id) {
            return res.status(400).json({ error: 'Upgrade ID required', code: 'INVALID_INPUT' });
        }

        // Define upgrade costs (same as above)
        const upgradeCosts = {
            starting_cash: [1, 2, 4, 8, 16],
            xp_boost: [2, 4, 6, 10, 15],
            yield_boost: [2, 4, 6, 10, 15],
            growth_speed: [3, 6, 10, 15, 25],
            starting_slots: [5, 15, 30],
            quality_boost: [3, 6, 10, 15, 25]
        };

        const costs = upgradeCosts[upgrade_id];
        if (!costs) {
            return res.status(400).json({ error: 'Invalid upgrade', code: 'INVALID_UPGRADE' });
        }

        await conn.beginTransaction();

        // Lock player row
        const [[player]] = await conn.execute(
            'SELECT prestige_tokens FROM cfx_players WHERE id = ? FOR UPDATE',
            [playerId]
        );

        // Get current upgrade level
        const [[existing]] = await conn.execute(
            'SELECT level FROM cfx_prestige_upgrades WHERE player_id = ? AND upgrade_id = ?',
            [playerId, upgrade_id]
        );

        const currentLevel = existing?.level || 0;
        const maxLevel = costs.length;

        if (currentLevel >= maxLevel) {
            await conn.rollback();
            return res.status(400).json({ error: 'Already at max level', code: 'MAX_LEVEL' });
        }

        const cost = costs[currentLevel];

        if (player.prestige_tokens < cost) {
            await conn.rollback();
            return res.status(400).json({ error: 'Insufficient prestige tokens', code: 'INSUFFICIENT_TOKENS' });
        }

        // Deduct tokens
        await conn.execute(
            'UPDATE cfx_players SET prestige_tokens = prestige_tokens - ? WHERE id = ?',
            [cost, playerId]
        );

        // Add or update upgrade
        if (existing) {
            await conn.execute(
                'UPDATE cfx_prestige_upgrades SET level = level + 1 WHERE player_id = ? AND upgrade_id = ?',
                [playerId, upgrade_id]
            );
        } else {
            await conn.execute(
                'INSERT INTO cfx_prestige_upgrades (player_id, upgrade_id, level) VALUES (?, ?, 1)',
                [playerId, upgrade_id]
            );
        }

        await conn.commit();

        res.json({
            success: true,
            upgradeId: upgrade_id,
            newLevel: currentLevel + 1,
            tokensSpent: cost,
            remainingTokens: player.prestige_tokens - cost
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Prestige] Buy upgrade failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

export default router;
