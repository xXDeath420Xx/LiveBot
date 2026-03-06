/**
 * Contracts Routes
 * Order/Contract system for delivering specific strains
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { checkAchievements } from './achievements.js';
import { awardCash, awardXp } from '../game/engine.js';
import { awardReputation } from './reputation.js';
import { updateTournamentScore } from './tournaments.js';

const router = Router();

const MAX_ACTIVE_CONTRACTS = 3;

/**
 * GET /contracts
 * Get available contracts and player's active contracts
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;
        const playerLevel = req.player.level || 1;

        // Get available contracts (not yet accepted by this player)
        const [available] = await pool.execute(
            `SELECT c.*, s.name as strain_name, s.rarity as strain_rarity_name
             FROM cfx_contracts c
             LEFT JOIN cfx_strains s ON c.strain_id = s.id
             WHERE c.is_active = TRUE
               AND c.id NOT IN (
                   SELECT contract_id FROM cfx_player_contracts
                   WHERE player_id = ? AND status = 'active'
               )
             ORDER BY c.difficulty ASC, c.reward_cash DESC
             LIMIT 10`,
            [playerId]
        );

        // Get player's active contracts
        const [active] = await pool.execute(
            `SELECT pc.*, c.client_name, c.client_type, c.contract_type,
                    c.strain_id, c.quality_min, c.quantity, c.reward_cash, c.reward_xp,
                    s.name as strain_name, s.rarity as strain_rarity
             FROM cfx_player_contracts pc
             JOIN cfx_contracts c ON pc.contract_id = c.id
             LEFT JOIN cfx_strains s ON c.strain_id = s.id
             WHERE pc.player_id = ? AND pc.status = 'active'
             ORDER BY pc.deadline_at ASC`,
            [playerId]
        );

        // Get completed contracts count
        const [[stats]] = await pool.execute(
            `SELECT COUNT(*) as completed, SUM(c.reward_cash) as total_earned
             FROM cfx_player_contracts pc
             JOIN cfx_contracts c ON pc.contract_id = c.id
             WHERE pc.player_id = ? AND pc.status = 'completed'`,
            [playerId]
        );

        res.json({
            success: true,
            available: available.map(c => ({
                id: c.id,
                type: c.contract_type,
                clientName: c.client_name,
                clientType: c.client_type,
                strainId: c.strain_id,
                strainName: c.strain_name || 'Any Strain',
                strainRarity: c.strain_rarity || c.strain_rarity_name,
                qualityMin: c.quality_min,
                quantityRequired: c.quantity,
                rewardCash: parseFloat(c.reward_cash),
                rewardXp: c.reward_xp,
                deadlineHours: c.deadline_hours,
                difficulty: c.difficulty
            })),
            active: active.map(c => ({
                id: c.id,
                contractId: c.contract_id,
                type: c.contract_type,
                clientName: c.client_name,
                clientType: c.client_type,
                strainId: c.strain_id,
                strainName: c.strain_name || 'Any Strain',
                strainRarity: c.strain_rarity,
                qualityMin: c.quality_min,
                quantityRequired: c.quantity,
                quantityDelivered: c.delivered_quantity,
                rewardCash: parseFloat(c.reward_cash),
                rewardXp: c.reward_xp,
                status: c.status,
                acceptedAt: c.accepted_at,
                deadlineAt: c.deadline_at,
                progress: Math.round(((c.delivered_quantity || 0) / (c.quantity || 1)) * 100)
            })),
            stats: {
                completed: stats.completed || 0,
                totalEarned: parseFloat(stats.total_earned) || 0
            },
            maxActive: MAX_ACTIVE_CONTRACTS
        });

    } catch (error) {
        logger.error('[Contracts] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get contracts', code: 'ERROR' });
    }
});

/**
 * POST /contracts/:id/accept
 * Accept a contract
 */
router.post('/:id/accept', async (req, res) => {
    try {
        const playerId = req.player.id;
        const contractId = parseInt(req.params.id, 10);

        if (isNaN(contractId)) {
            return res.status(400).json({ error: 'Invalid contract ID', code: 'INVALID_ID' });
        }

        // Check active contract count
        const [[countResult]] = await pool.execute(
            `SELECT COUNT(*) as count FROM cfx_player_contracts
             WHERE player_id = ? AND status = 'active'`,
            [playerId]
        );

        if (countResult.count >= MAX_ACTIVE_CONTRACTS) {
            return res.status(400).json({
                error: `Maximum ${MAX_ACTIVE_CONTRACTS} active contracts allowed`,
                code: 'MAX_CONTRACTS'
            });
        }

        // Get contract details
        const [[contract]] = await pool.execute(
            `SELECT * FROM cfx_contracts WHERE id = ? AND is_active = TRUE`,
            [contractId]
        );

        if (!contract) {
            return res.status(404).json({ error: 'Contract not found', code: 'NOT_FOUND' });
        }

        // Check not already accepted
        const [[existing]] = await pool.execute(
            `SELECT id FROM cfx_player_contracts
             WHERE player_id = ? AND contract_id = ? AND status = 'active'`,
            [playerId, contractId]
        );

        if (existing) {
            return res.status(400).json({ error: 'Contract already accepted', code: 'ALREADY_ACCEPTED' });
        }

        // Calculate deadline
        const deadlineAt = new Date(Date.now() + contract.deadline_hours * 60 * 60 * 1000);

        // Create player contract (contract details are referenced via contract_id)
        const [result] = await pool.execute(
            `INSERT INTO cfx_player_contracts
             (player_id, contract_id, delivered_quantity, status, accepted_at, deadline_at)
             VALUES (?, ?, 0, 'active', NOW(), ?)`,
            [playerId, contractId, deadlineAt]
        );

        logger.info('[Contracts] Accepted', {
            playerId,
            contractId,
            playerContractId: result.insertId
        });

        res.json({
            success: true,
            playerContractId: result.insertId,
            message: `Contract accepted! Deliver ${contract.quantity} units by the deadline.`,
            deadlineAt
        });

    } catch (error) {
        logger.error('[Contracts] Accept failed', { error: error.message });
        res.status(500).json({ error: 'Failed to accept contract', code: 'ERROR' });
    }
});

/**
 * POST /contracts/:id/deliver
 * Deliver items to a contract
 */
router.post('/:id/deliver', async (req, res) => {
    try {
        const playerId = req.player.id;
        const playerContractId = parseInt(req.params.id, 10);
        const { inventoryId, quantity } = req.body;

        if (isNaN(playerContractId)) {
            return res.status(400).json({ error: 'Invalid contract ID', code: 'INVALID_ID' });
        }

        if (!inventoryId || !quantity || quantity < 1) {
            return res.status(400).json({ error: 'Inventory ID and quantity required', code: 'MISSING_FIELDS' });
        }

        // Get the player's contract with contract details
        const [[contract]] = await pool.execute(
            `SELECT pc.*, c.strain_id, c.quality_min, c.quantity, c.reward_cash, c.reward_xp
             FROM cfx_player_contracts pc
             JOIN cfx_contracts c ON pc.contract_id = c.id
             WHERE pc.id = ? AND pc.player_id = ? AND pc.status = 'active'`,
            [playerContractId, playerId]
        );

        if (!contract) {
            return res.status(404).json({ error: 'Active contract not found', code: 'NOT_FOUND' });
        }

        // Check deadline
        if (new Date(contract.deadline_at) < new Date()) {
            // Mark as failed
            await pool.execute(
                `UPDATE cfx_player_contracts SET status = 'failed' WHERE id = ?`,
                [playerContractId]
            );
            return res.status(400).json({ error: 'Contract deadline passed', code: 'DEADLINE_PASSED' });
        }

        // Get inventory item
        const [[invItem]] = await pool.execute(
            `SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ?`,
            [inventoryId, playerId]
        );

        if (!invItem) {
            return res.status(404).json({ error: 'Inventory item not found', code: 'ITEM_NOT_FOUND' });
        }

        // Verify strain matches (if contract requires specific strain)
        if (contract.strain_id && invItem.strain_id !== contract.strain_id) {
            return res.status(400).json({ error: 'Wrong strain for this contract', code: 'WRONG_STRAIN' });
        }

        // Verify quality meets minimum
        if (contract.quality_min && invItem.quality < contract.quality_min) {
            return res.status(400).json({
                error: `Quality must be at least ${contract.quality_min}`,
                code: 'QUALITY_TOO_LOW'
            });
        }

        // Calculate how much is still needed
        const remaining = contract.quantity - (contract.delivered_quantity || 0);
        if (remaining <= 0) {
            return res.status(400).json({ error: 'Contract already fulfilled', code: 'ALREADY_FULFILLED' });
        }

        // Verify quantity available
        const deliverQty = Math.min(quantity || invItem.quantity, invItem.quantity);
        if (deliverQty < 1) {
            return res.status(400).json({ error: 'Insufficient quantity', code: 'INSUFFICIENT_QTY' });
        }

        const actualDeliver = Math.min(deliverQty, remaining);
        if (actualDeliver < 1) {
            return res.status(400).json({ error: 'Nothing to deliver', code: 'NO_DELIVERY' });
        }

        // Start transaction
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Deduct from inventory
            if (invItem.quantity <= actualDeliver) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [actualDeliver, inventoryId]
                );
            }

            // Update contract progress
            const newDelivered = contract.delivered_quantity + actualDeliver;
            const isComplete = newDelivered >= contract.quantity;

            if (isComplete) {
                // Complete the contract
                await conn.execute(
                    `UPDATE cfx_player_contracts
                     SET delivered_quantity = ?, status = 'completed', completed_at = NOW()
                     WHERE id = ?`,
                    [newDelivered, playerContractId]
                );

                // Commit transaction before awarding (awardCash/awardXp use their own mutex)
                await conn.commit();

                // Award rewards with proper bonus application
                await awardCash(playerId, parseFloat(contract.reward_cash || 0));
                await awardXp(playerId, parseInt(contract.reward_xp, 10) || 0);
            } else {
                await conn.execute(
                    'UPDATE cfx_player_contracts SET delivered_quantity = ? WHERE id = ?',
                    [newDelivered, playerContractId]
                );
                await conn.commit();
            }

            // Check achievements after contract completion
            if (isComplete) {
                checkAchievements(playerId).catch(() => {});
                awardReputation(playerId, 'traders_union', 15).catch(() => {});
                updateTournamentScore(playerId, 'sales', parseFloat(contract.reward_cash || 0)).catch(() => {});
            }

            logger.info('[Contracts] Delivered', {
                playerId,
                playerContractId,
                delivered: actualDeliver,
                isComplete
            });

            res.json({
                success: true,
                delivered: actualDeliver,
                newTotal: newDelivered,
                remaining: Math.max(0, contract.quantity - newDelivered),
                isComplete,
                rewards: isComplete ? {
                    cash: parseFloat(contract.reward_cash),
                    xp: contract.reward_xp
                } : null
            });

        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

    } catch (error) {
        logger.error('[Contracts] Deliver failed', { error: error.message });
        res.status(500).json({ error: 'Failed to deliver', code: 'ERROR' });
    }
});

/**
 * POST /contracts/:id/quick-fulfill
 * Auto-fulfill contract using best matching inventory items
 */
router.post('/:id/quick-fulfill', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const playerContractId = parseInt(req.params.id, 10);

        if (isNaN(playerContractId)) {
            return res.status(400).json({ error: 'Invalid contract ID', code: 'INVALID_ID' });
        }

        // Get the player's contract with contract details
        const [[contract]] = await conn.execute(
            `SELECT pc.*, c.strain_id, c.quality_min, c.quantity, c.reward_cash, c.reward_xp
             FROM cfx_player_contracts pc
             JOIN cfx_contracts c ON pc.contract_id = c.id
             WHERE pc.id = ? AND pc.player_id = ? AND pc.status = 'active'`,
            [playerContractId, playerId]
        );

        if (!contract) {
            return res.status(404).json({ error: 'Active contract not found', code: 'NOT_FOUND' });
        }

        // Check deadline
        if (new Date(contract.deadline_at) < new Date()) {
            await conn.execute(
                `UPDATE cfx_player_contracts SET status = 'failed' WHERE id = ?`,
                [playerContractId]
            );
            return res.status(400).json({ error: 'Contract deadline passed', code: 'DEADLINE_PASSED' });
        }

        // Calculate how much is still needed
        const remaining = contract.quantity - (contract.delivered_quantity || 0);
        if (remaining <= 0) {
            return res.json({
                success: true,
                delivered: 0,
                message: 'Contract already complete'
            });
        }

        // Find matching inventory items (sorted by quality ascending - use lowest quality first)
        let query = `
            SELECT * FROM cfx_inventory
            WHERE player_id = ? AND quality >= ? AND quantity > 0
        `;
        const params = [playerId, contract.quality_min || 0];

        // If contract requires specific strain
        if (contract.strain_id) {
            query += ' AND strain_id = ?';
            params.push(contract.strain_id);
        }

        query += ' ORDER BY quality ASC, quantity DESC';

        const [invItems] = await conn.execute(query, params);

        if (invItems.length === 0) {
            return res.json({
                success: true,
                delivered: 0,
                message: 'No matching inventory items found'
            });
        }

        await conn.beginTransaction();

        let totalDelivered = 0;
        const itemsUsed = [];

        for (const item of invItems) {
            if (totalDelivered >= remaining) break;

            const toDeliver = Math.min(item.quantity, remaining - totalDelivered);

            // Deduct from inventory
            if (item.quantity <= toDeliver) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [toDeliver, item.id]
                );
            }

            totalDelivered += toDeliver;
            itemsUsed.push({
                inventoryId: item.id,
                quantity: toDeliver,
                quality: item.quality
            });
        }

        if (totalDelivered === 0) {
            await conn.rollback();
            return res.json({
                success: true,
                delivered: 0,
                message: 'No items to deliver'
            });
        }

        // Update contract progress
        const newDelivered = contract.delivered_quantity + totalDelivered;
        const isComplete = newDelivered >= contract.quantity;

        if (isComplete) {
            await conn.execute(
                `UPDATE cfx_player_contracts
                 SET delivered_quantity = ?, status = 'completed', completed_at = NOW()
                 WHERE id = ?`,
                [newDelivered, playerContractId]
            );

            // Commit transaction before awarding (awardCash/awardXp use their own mutex)
            await conn.commit();

            // Award rewards with proper bonus application
            await awardCash(playerId, parseFloat(contract.reward_cash));
            await awardXp(playerId, contract.reward_xp);
        } else {
            await conn.execute(
                'UPDATE cfx_player_contracts SET delivered_quantity = ? WHERE id = ?',
                [newDelivered, playerContractId]
            );
            await conn.commit();
        }

        // Check achievements after contract completion
        if (isComplete) {
            checkAchievements(playerId).catch(() => {});
        }

        logger.info('[Contracts] Quick-fulfilled', {
            playerId,
            playerContractId,
            delivered: totalDelivered,
            isComplete,
            itemsUsed: itemsUsed.length
        });

        res.json({
            success: true,
            delivered: totalDelivered,
            itemsUsed,
            newTotal: newDelivered,
            remaining: Math.max(0, contract.quantity - newDelivered),
            isComplete,
            rewards: isComplete ? {
                cash: parseFloat(contract.reward_cash),
                xp: contract.reward_xp
            } : null,
            message: isComplete
                ? `Contract completed! +$${parseFloat(contract.reward_cash).toLocaleString()} +${contract.reward_xp} XP`
                : `Delivered ${totalDelivered} items (${newDelivered}/${contract.quantity})`
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Contracts] Quick-fulfill failed', { error: error.message });
        res.status(500).json({ error: 'Failed to quick-fulfill', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /contracts/:id/cancel
 * Cancel an active contract (with penalty)
 */
router.post('/:id/cancel', async (req, res) => {
    try {
        const playerId = req.player.id;
        const playerContractId = parseInt(req.params.id, 10);

        if (isNaN(playerContractId)) {
            return res.status(400).json({ error: 'Invalid contract ID', code: 'INVALID_ID' });
        }

        const [result] = await pool.execute(
            `UPDATE cfx_player_contracts
             SET status = 'cancelled'
             WHERE id = ? AND player_id = ? AND status = 'active'`,
            [playerContractId, playerId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Active contract not found', code: 'NOT_FOUND' });
        }

        logger.info('[Contracts] Cancelled', { playerId, playerContractId });

        res.json({
            success: true,
            message: 'Contract cancelled. Reputation may be affected.'
        });

    } catch (error) {
        logger.error('[Contracts] Cancel failed', { error: error.message });
        res.status(500).json({ error: 'Failed to cancel contract', code: 'ERROR' });
    }
});

export default router;
