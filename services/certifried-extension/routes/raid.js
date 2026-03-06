/**
 * Raid Routes
 * DEA raid status and history
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getRaidStatus, SECURITY_PROTECTION, VAULT_CAPACITY } from '../game/raid-system.js';
import { deductCash } from '../game/engine.js';
import { awardReputation } from './reputation.js';

const router = Router();

// Defense definitions
const RAID_DEFENSES = {
    alarm: {
        id: 'alarm',
        name: 'Alarm System',
        icon: '🚨',
        baseCost: 5000,
        costMultiplier: 1.5,
        maxLevel: 3,
        effect: 'Warns you 30s before raid',
        effectPerLevel: { warningTime: 30 }
    },
    safe: {
        id: 'safe',
        name: 'Hidden Safe',
        icon: '🔒',
        baseCost: 15000,
        costMultiplier: 1.6,
        maxLevel: 5,
        effect: 'Protect 25% of cash',
        effectPerLevel: { cashProtection: 0.05 }
    },
    tunnel: {
        id: 'tunnel',
        name: 'Escape Tunnel',
        icon: '🕳️',
        baseCost: 25000,
        costMultiplier: 1.8,
        maxLevel: 3,
        effect: '20% chance to avoid raid',
        effectPerLevel: { avoidChance: 0.07 }
    },
    lawyer: {
        id: 'lawyer',
        name: 'Lawyer Retainer',
        icon: '⚖️',
        baseCost: 50000,
        costMultiplier: 2.0,
        maxLevel: 5,
        effect: 'Reduce penalties by 30%',
        effectPerLevel: { penaltyReduction: 0.06 }
    },
    bribe: {
        id: 'bribe',
        name: 'Police Contact',
        icon: '🤝',
        baseCost: 100000,
        costMultiplier: 1.0,
        maxLevel: 1,
        effect: 'Can bribe to end raids',
        effectPerLevel: { canBribe: true }
    },
    decoy: {
        id: 'decoy',
        name: 'Decoy Stash',
        icon: '📦',
        baseCost: 20000,
        costMultiplier: 1.5,
        maxLevel: 3,
        effect: 'Save inventory from seizure',
        effectPerLevel: { inventoryProtection: 0.10 }
    }
};

/**
 * GET /raid/status
 * Get current heat level, risk status, and protection info
 */
router.get('/status', async (req, res) => {
    try {
        const status = await getRaidStatus(req.player.id);

        // Get player's owned defenses from player-specific table
        const [ownedDefenses] = await pool.execute(
            'SELECT * FROM cfx_player_defenses WHERE player_id = ?',
            [req.player.id]
        );
        const defenseMap = new Map(ownedDefenses.map(d => [d.defense_key, d.current_level]));

        // Build defenses list with ownership info
        const defenses = Object.values(RAID_DEFENSES).map(def => {
            const currentLevel = defenseMap.get(def.id) || 0;
            const owned = currentLevel > 0;
            const nextCost = currentLevel < def.maxLevel
                ? Math.floor(def.baseCost * Math.pow(def.costMultiplier, currentLevel))
                : null;

            return {
                id: def.id,
                name: def.name,
                icon: def.icon,
                cost: nextCost || def.baseCost,
                effect: def.effect,
                owned,
                level: currentLevel,
                maxLevel: def.maxLevel
            };
        });

        // Get stats
        const [[stats]] = await pool.execute(
            `SELECT total_raids_suffered, total_cash_seized, total_items_destroyed
             FROM cfx_player_stats WHERE player_id = ?`,
            [req.player.id]
        );

        // Count successfully defended raids
        const [[defendedCount]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_raid_log WHERE player_id = ? AND defended = 1',
            [req.player.id]
        );

        // Add tips based on current status
        const tips = [];
        if (status.heat.status !== 'cold') {
            if (status.vault.level === 0) {
                tips.push('Purchase a vault to protect your assets!');
            } else if (status.vault.currentCash < status.vault.cashCapacity * 0.5) {
                tips.push('Consider depositing more cash in your vault.');
            }

            if (status.security.level < 3) {
                tips.push('Upgrade your security to reduce raid risk.');
            }

            if (status.heat.status === 'scorching' || status.heat.status === 'inferno') {
                tips.push('DANGER: Consider reducing your operation size temporarily.');
            }
        }

        // Flatten heat data for frontend compatibility
        res.json({
            success: true,
            status: status,
            // Flat fields for frontend
            heatLevel: status.heat.current,
            raidChance: Math.round(status.heat.actualChance * 100),
            heatStatus: status.heat.status,
            totalRaids: stats?.total_raids_suffered || 0,
            successfulDefenses: defendedCount?.count || 0,
            totalCashLost: parseFloat(stats?.total_cash_seized || 0),
            totalItemsSeized: stats?.total_items_destroyed || 0,
            // Defenses for frontend
            defenses,
            // Nested structure for detailed info
            ...status,
            tips
        });

    } catch (error) {
        logger.error('[Raid] Get status failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get raid status', code: 'ERROR' });
    }
});

/**
 * GET /raid/history
 * Get raid history for the player
 */
router.get('/history', async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        const [raids] = await pool.execute(
            `SELECT * FROM cfx_raid_log
             WHERE player_id = ?
             ORDER BY raided_at DESC
             LIMIT ?`,
            [req.player.id, parseInt(limit)]
        );

        res.json({
            success: true,
            raids: raids.map(r => ({
                id: r.id,
                heatAtRaid: parseFloat(r.heat_at_raid),
                securityLevel: r.security_level,
                cashSeized: parseFloat(r.cash_seized),
                cashLost: parseFloat(r.cash_seized), // Alias for frontend
                inventoryDestroyed: r.inventory_destroyed,
                itemsSeized: r.inventory_destroyed, // Alias for frontend
                plantsDestroyed: r.plants_destroyed,
                seedsConfiscated: r.seeds_confiscated,
                details: r.seizure_details ? JSON.parse(r.seizure_details) : null,
                raidedAt: r.raided_at,
                timestamp: r.raided_at, // Alias for frontend
                defended: r.defended === 1,
                defenseDetails: r.defense_details ? JSON.parse(r.defense_details) : null
            }))
        });

    } catch (error) {
        logger.error('[Raid] Get history failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get raid history', code: 'ERROR' });
    }
});

/**
 * GET /raid/stats
 * Get lifetime raid statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const [[stats]] = await pool.execute(
            `SELECT total_raids_suffered, total_cash_seized, total_items_destroyed,
                    total_plants_destroyed, total_seeds_confiscated, highest_heat_reached
             FROM cfx_player_stats WHERE player_id = ?`,
            [req.player.id]
        );

        if (!stats) {
            return res.json({
                success: true,
                stats: {
                    totalRaids: 0,
                    totalCashSeized: 0,
                    totalItemsDestroyed: 0,
                    totalPlantsDestroyed: 0,
                    totalSeedsConfiscated: 0,
                    highestHeat: 0
                }
            });
        }

        res.json({
            success: true,
            stats: {
                totalRaids: stats.total_raids_suffered,
                totalCashSeized: parseFloat(stats.total_cash_seized),
                totalItemsDestroyed: stats.total_items_destroyed,
                totalPlantsDestroyed: stats.total_plants_destroyed,
                totalSeedsConfiscated: stats.total_seeds_confiscated,
                highestHeat: parseFloat(stats.highest_heat_reached)
            }
        });

    } catch (error) {
        logger.error('[Raid] Get stats failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get raid stats', code: 'ERROR' });
    }
});

/**
 * GET /raid/protection-info
 * Get information about security upgrades and vault
 */
router.get('/protection-info', async (req, res) => {
    try {
        res.json({
            success: true,
            securityLevels: Object.entries(SECURITY_PROTECTION).map(([level, data]) => ({
                level: parseInt(level),
                raidChanceReduction: `${Math.round(data.raidChanceReduction * 100)}%`,
                lossReduction: `${Math.round(data.lossReduction * 100)}%`,
                decayBonus: `+${data.decayBonus}/hr`
            })),
            vaultLevels: Object.entries(VAULT_CAPACITY).map(([level, data]) => ({
                level: parseInt(level),
                cashCapacity: data.cash,
                slotCapacity: data.slots,
                upgradeCost: data.cost
            }))
        });

    } catch (error) {
        logger.error('[Raid] Get protection info failed', {
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get protection info', code: 'ERROR' });
    }
});

/**
 * POST /raid/buy-defense
 * Purchase or upgrade a raid defense
 */
router.post('/buy-defense', async (req, res) => {
    try {
        const { defenseId } = req.body;

        if (!defenseId || !RAID_DEFENSES[defenseId]) {
            return res.status(400).json({ error: 'Invalid defense', code: 'INVALID_DEFENSE' });
        }

        const def = RAID_DEFENSES[defenseId];

        // Check current level from player-specific defenses table
        const [[current]] = await pool.execute(
            'SELECT current_level FROM cfx_player_defenses WHERE player_id = ? AND defense_key = ?',
            [req.player.id, defenseId]
        );

        const currentLevel = current?.current_level || 0;

        if (currentLevel >= def.maxLevel) {
            return res.status(400).json({ error: 'Already at max level', code: 'MAX_LEVEL' });
        }

        // Calculate cost
        const cost = Math.floor(def.baseCost * Math.pow(def.costMultiplier, currentLevel));

        // Deduct cash
        const cashResult = await deductCash(req.player.id, cost);
        if (!cashResult.success) {
            return res.status(400).json({
                error: `Need $${cost.toLocaleString()}`,
                code: 'INSUFFICIENT_CASH'
            });
        }

        // Apply purchase/upgrade in player-specific defenses table
        if (currentLevel === 0) {
            await pool.execute(
                'INSERT INTO cfx_player_defenses (player_id, defense_key, current_level) VALUES (?, ?, 1)',
                [req.player.id, defenseId]
            );
        } else {
            await pool.execute(
                'UPDATE cfx_player_defenses SET current_level = current_level + 1 WHERE player_id = ? AND defense_key = ?',
                [req.player.id, defenseId]
            );
        }

        const newLevel = currentLevel + 1;

        // Award reputation for investing in defenses (fire-and-forget)
        awardReputation(req.player.id, 'enforcement_division', 20).catch(() => {});

        logger.info('[Raid] Defense purchased', {
            playerId: req.player.id,
            defenseId,
            newLevel,
            cost
        });

        res.json({
            success: true,
            message: `${def.name} ${currentLevel === 0 ? 'purchased' : 'upgraded to level ' + newLevel}!`,
            defenseId,
            newLevel,
            maxLevel: def.maxLevel,
            costPaid: cost,
            newCash: cashResult.newCash
        });

    } catch (error) {
        logger.error('[Raid] Buy defense failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Purchase failed', code: 'ERROR' });
    }
});

/**
 * POST /raid/use-defense
 * Activate a defense during a raid
 */
router.post('/use-defense', async (req, res) => {
    try {
        const { defenseId } = req.body;

        // Check if player owns this defense
        const [[defense]] = await pool.execute(
            'SELECT current_level FROM cfx_player_defenses WHERE player_id = ? AND defense_key = ?',
            [req.player.id, defenseId]
        );

        if (!defense || defense.current_level < 1) {
            return res.status(400).json({ error: 'Defense not owned', code: 'NOT_OWNED' });
        }

        // For now, just acknowledge the defense use
        // In a real implementation, this would interact with an active raid system
        logger.info('[Raid] Defense used', {
            playerId: req.player.id,
            defenseId,
            level: defense.current_level
        });

        res.json({
            success: true,
            message: `${RAID_DEFENSES[defenseId]?.name || defenseId} activated!`,
            effect: RAID_DEFENSES[defenseId]?.effect
        });

    } catch (error) {
        logger.error('[Raid] Use defense failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Defense activation failed', code: 'ERROR' });
    }
});

/**
 * POST /raid/bribe
 * Bribe to end an active raid
 */
router.post('/bribe', async (req, res) => {
    try {
        // Check if player has the bribe defense
        const [[bribeDefense]] = await pool.execute(
            'SELECT current_level FROM cfx_player_defenses WHERE player_id = ? AND defense_key = ?',
            [req.player.id, 'bribe']
        );

        if (!bribeDefense || bribeDefense.current_level < 1) {
            return res.status(400).json({
                error: 'You need Police Contact to bribe',
                code: 'NO_BRIBE_ABILITY'
            });
        }

        // Calculate bribe cost (based on player level and cash)
        const [[player]] = await pool.execute(
            'SELECT level, cash FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        const bribeCost = Math.floor(5000 * (player?.level || 1) * 0.5);

        // Deduct bribe cost
        const cashResult = await deductCash(req.player.id, bribeCost);
        if (!cashResult.success) {
            return res.status(400).json({
                error: `Need $${bribeCost.toLocaleString()} for bribe`,
                code: 'INSUFFICIENT_CASH'
            });
        }

        // Grant 6 hours of raid immunity and reduce heat by 50
        const immunityUntil = new Date(Date.now() + 6 * 60 * 60 * 1000);
        await pool.execute(
            `UPDATE cfx_player_heat
             SET current_heat = GREATEST(0, current_heat - 50),
                 raid_immunity_until = ?,
                 last_heat_update = NOW()
             WHERE player_id = ?`,
            [immunityUntil, req.player.id]
        );

        logger.info('[Raid] Bribe paid - immunity granted', {
            playerId: req.player.id,
            bribeCost,
            immunityUntil
        });

        res.json({
            success: true,
            message: 'Raid called off! The cops looked the other way...',
            bribeCost,
            newCash: cashResult.newCash,
            heatReduced: 50,
            immunityUntil: immunityUntil.toISOString()
        });

    } catch (error) {
        logger.error('[Raid] Bribe failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Bribe failed', code: 'ERROR' });
    }
});

export default router;
