/**
 * Facility Routes
 * Facility upgrades and management
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { deductCash } from '../game/engine.js';
import { invalidateBonusCache } from '../game/bonus-resolver.js';

const router = Router();

// Upgrade definitions
const UPGRADES = {
    lighting: {
        name: 'Grow Lights',
        description: 'Better lighting increases quality',
        maxLevel: 10,
        baseCost: 1000,
        costMultiplier: 2.0,
        effect: { type: 'quality_bonus', valuePerLevel: 0.02 }
    },
    ventilation: {
        name: 'Ventilation System',
        description: 'Better airflow speeds up growth',
        maxLevel: 10,
        baseCost: 1500,
        costMultiplier: 2.0,
        effect: { type: 'grow_speed', valuePerLevel: 0.02 }
    },
    irrigation: {
        name: 'Irrigation System',
        description: 'Automated watering increases yield',
        maxLevel: 10,
        baseCost: 2000,
        costMultiplier: 2.0,
        effect: { type: 'yield_bonus', valuePerLevel: 0.02 }
    },
    security: {
        name: 'Security System',
        description: 'Protect your investment',
        maxLevel: 5,
        baseCost: 5000,
        costMultiplier: 2.5,
        effect: { type: 'wither_resist', valuePerLevel: 0.1 }
    },
    storage: {
        name: 'Storage Expansion',
        description: 'More room for inventory',
        maxLevel: 10,
        baseCost: 1000,
        costMultiplier: 1.8,
        effect: { type: 'inventory_slots', valuePerLevel: 25 }
    },
    grow_slots: {
        name: 'Grow Room Expansion',
        description: 'Additional growing space',
        maxLevel: 8,
        baseCost: 5000,
        costMultiplier: 3.0,
        effect: { type: 'extra_slots', valuePerLevel: 1 }
    }
};

/**
 * GET /facility
 * Get facility status and upgrades
 */
router.get('/', async (req, res) => {
    try {
        const [upgrades] = await pool.execute(
            'SELECT * FROM cfx_facility_upgrades WHERE player_id = ?',
            [req.player.id]
        );

        const upgradeMap = new Map(upgrades.map(u => [u.upgrade_key, u.current_level]));

        const facilityUpgrades = Object.entries(UPGRADES).map(([key, def]) => {
            const currentLevel = upgradeMap.get(key) || 0;
            const nextCost = currentLevel < def.maxLevel
                ? Math.floor(def.baseCost * Math.pow(def.costMultiplier, currentLevel))
                : null;

            return {
                key,
                name: def.name,
                description: def.description,
                currentLevel,
                maxLevel: def.maxLevel,
                nextCost,
                isMaxed: currentLevel >= def.maxLevel,
                effectType: def.effect.type,
                effect: {
                    type: def.effect.type,
                    currentValue: def.effect.valuePerLevel * currentLevel,
                    nextValue: currentLevel < def.maxLevel
                        ? def.effect.valuePerLevel * (currentLevel + 1)
                        : null
                }
            };
        });

        res.json({
            success: true,
            facility: {
                name: req.player.facility_name,
                level: req.player.facility_level,
                maxGrowSlots: req.player.max_grow_slots
            },
            upgrades: facilityUpgrades
        });

    } catch (error) {
        logger.error('[Facility] Get failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /facility/upgrade
 * Purchase a facility upgrade
 */
router.post('/upgrade', async (req, res) => {
    try {
        const { upgradeKey } = req.body;

        if (!upgradeKey || !UPGRADES[upgradeKey]) {
            return res.status(400).json({ error: 'Invalid upgrade', code: 'INVALID_UPGRADE' });
        }

        const def = UPGRADES[upgradeKey];

        // Get current level
        const [[current]] = await pool.execute(
            'SELECT current_level FROM cfx_facility_upgrades WHERE player_id = ? AND upgrade_key = ?',
            [req.player.id, upgradeKey]
        );

        const currentLevel = current ? current.current_level : 0;

        if (currentLevel >= def.maxLevel) {
            return res.status(400).json({ error: 'Already at max level', code: 'MAX_LEVEL' });
        }

        // Calculate cost
        const cost = Math.floor(def.baseCost * Math.pow(def.costMultiplier, currentLevel));

        // Deduct cash
        const cashResult = await deductCash(req.player.id, cost);

        if (!cashResult.success) {
            return res.status(400).json({
                error: `Insufficient funds (need $${cost.toLocaleString()})`,
                code: 'INSUFFICIENT_CASH'
            });
        }

        // Apply upgrade
        if (currentLevel === 0) {
            await pool.execute(
                'INSERT INTO cfx_facility_upgrades (player_id, upgrade_key, current_level, max_level) VALUES (?, ?, 1, ?)',
                [req.player.id, upgradeKey, def.maxLevel]
            );
        } else {
            await pool.execute(
                'UPDATE cfx_facility_upgrades SET current_level = current_level + 1 WHERE player_id = ? AND upgrade_key = ?',
                [req.player.id, upgradeKey]
            );
        }

        const newLevel = currentLevel + 1;

        // Handle special effects
        if (def.effect.type === 'extra_slots') {
            await pool.execute(
                'UPDATE cfx_players SET max_grow_slots = max_grow_slots + 1 WHERE id = ?',
                [req.player.id]
            );

            // Create new grow slot
            const [[player]] = await pool.execute(
                'SELECT max_grow_slots FROM cfx_players WHERE id = ?',
                [req.player.id]
            );

            await pool.execute(
                'INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, ?)',
                [req.player.id, player.max_grow_slots]
            );
        }

        // Invalidate bonus cache so new facility bonuses apply immediately
        invalidateBonusCache(req.player.id);

        res.json({
            success: true,
            upgradeKey,
            newLevel,
            maxLevel: def.maxLevel,
            costPaid: cost,
            newCash: cashResult.newCash,
            effectValue: def.effect.valuePerLevel * newLevel
        });

    } catch (error) {
        logger.error('[Facility] Upgrade failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /facility/rename
 * Rename the facility
 */
router.post('/rename', async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || name.length < 1 || name.length > 100) {
            return res.status(400).json({ error: 'Name must be 1-100 characters', code: 'INVALID_NAME' });
        }

        // Basic sanitization
        const sanitized = name.replace(/<[^>]*>/g, '').trim();

        await pool.execute(
            'UPDATE cfx_players SET facility_name = ? WHERE id = ?',
            [sanitized, req.player.id]
        );

        res.json({
            success: true,
            newName: sanitized
        });

    } catch (error) {
        logger.error('[Facility] Rename failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
