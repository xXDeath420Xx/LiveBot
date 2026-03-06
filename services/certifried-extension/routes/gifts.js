/**
 * Gifts Routes
 * Player-to-player gifting system
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { createNotification } from './notifications.js';
import { awardCash } from '../game/engine.js';

const router = Router();

/**
 * GET /gifts/pending
 * Get pending gifts for the player (both sent and received)
 */
router.get('/pending', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get received gifts (pending)
        const [received] = await pool.execute(
            `SELECT g.*,
                    p.display_name as sender_name,
                    s.name as strain_name
             FROM cfx_gifts g
             JOIN cfx_players p ON g.sender_id = p.id
             LEFT JOIN cfx_strains s ON g.strain_id = s.id
             WHERE g.receiver_id = ? AND g.status = 'pending'
             ORDER BY g.created_at DESC`,
            [playerId]
        );

        // Get sent gifts (pending)
        const [sent] = await pool.execute(
            `SELECT g.*,
                    p.display_name as receiver_name,
                    s.name as strain_name
             FROM cfx_gifts g
             JOIN cfx_players p ON g.receiver_id = p.id
             LEFT JOIN cfx_strains s ON g.strain_id = s.id
             WHERE g.sender_id = ? AND g.status = 'pending'
             ORDER BY g.created_at DESC`,
            [playerId]
        );

        res.json({
            success: true,
            received: received.map(g => ({
                id: g.id,
                senderId: g.sender_id,
                senderName: g.sender_name,
                giftType: g.gift_type,
                strainId: g.strain_id,
                strainName: g.strain_name,
                quantity: g.quantity,
                quality: g.quality,
                cashAmount: parseFloat(g.cash_amount) || 0,
                message: g.message,
                createdAt: g.created_at
            })),
            sent: sent.map(g => ({
                id: g.id,
                receiverId: g.receiver_id,
                receiverName: g.receiver_name,
                giftType: g.gift_type,
                strainId: g.strain_id,
                strainName: g.strain_name,
                quantity: g.quantity,
                quality: g.quality,
                cashAmount: parseFloat(g.cash_amount) || 0,
                message: g.message,
                createdAt: g.created_at
            }))
        });

    } catch (error) {
        logger.error('[Gifts] Get pending failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /gifts/send
 * Send a gift to another player
 */
router.post('/send', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const senderId = req.player.id;
        const { receiverId, giftType, strainId, quantity, quality, cashAmount, message } = req.body;

        if (!receiverId) {
            return res.status(400).json({ error: 'Receiver required', code: 'INVALID_INPUT' });
        }

        if (receiverId === senderId) {
            return res.status(400).json({ error: 'Cannot gift yourself', code: 'INVALID_INPUT' });
        }

        // Verify receiver exists
        const [[receiver]] = await conn.execute(
            'SELECT id, display_name FROM cfx_players WHERE id = ?',
            [receiverId]
        );

        if (!receiver) {
            return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
        }

        await conn.beginTransaction();

        // Handle different gift types
        if (giftType === 'cash') {
            if (!cashAmount || cashAmount <= 0) {
                await conn.rollback();
                return res.status(400).json({ error: 'Invalid cash amount', code: 'INVALID_INPUT' });
            }

            // Check sender has enough cash
            const [[sender]] = await conn.execute(
                'SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE',
                [senderId]
            );

            if (sender.cash < cashAmount) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient funds', code: 'INSUFFICIENT_FUNDS' });
            }

            // Deduct cash from sender
            await conn.execute(
                'UPDATE cfx_players SET cash = cash - ? WHERE id = ?',
                [cashAmount, senderId]
            );

            // Create gift record
            const [result] = await conn.execute(
                `INSERT INTO cfx_gifts (sender_id, receiver_id, gift_type, cash_amount, message, status)
                 VALUES (?, ?, 'cash', ?, ?, 'pending')`,
                [senderId, receiverId, cashAmount, message || null]
            );

            await conn.commit();

            // Notify receiver
            await createNotification(
                receiverId,
                'gift_received',
                'Gift Received!',
                `${req.player.display_name} sent you $${cashAmount.toLocaleString()}!`,
                { giftId: result.insertId, type: 'cash', amount: cashAmount }
            );

            res.json({
                success: true,
                giftId: result.insertId,
                newCash: sender.cash - cashAmount
            });

        } else if (giftType === 'item') {
            if (!strainId || !quantity || quantity <= 0) {
                await conn.rollback();
                return res.status(400).json({ error: 'Invalid item details', code: 'INVALID_INPUT' });
            }

            // Check sender has the item
            const qualityVal = quality || 100;
            const [[item]] = await conn.execute(
                `SELECT id, quantity FROM cfx_inventory
                 WHERE player_id = ? AND strain_id = ? AND (quality = ? OR (? IS NULL AND quality IS NULL)) FOR UPDATE`,
                [senderId, strainId, qualityVal, qualityVal]
            );

            if (!item || item.quantity < quantity) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient items', code: 'INSUFFICIENT_ITEMS' });
            }

            // Deduct from sender inventory
            if (item.quantity === quantity) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [item.id]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [quantity, item.id]
                );
            }

            // Get strain name for notification
            const [[strain]] = await conn.execute('SELECT name FROM cfx_strains WHERE id = ?', [strainId]);

            // Create gift record
            const [result] = await conn.execute(
                `INSERT INTO cfx_gifts (sender_id, receiver_id, gift_type, strain_id, quantity, quality, message, status)
                 VALUES (?, ?, 'item', ?, ?, ?, ?, 'pending')`,
                [senderId, receiverId, strainId, quantity, quality || 100, message || null]
            );

            await conn.commit();

            // Notify receiver
            await createNotification(
                receiverId,
                'gift_received',
                'Gift Received!',
                `${req.player.display_name} sent you ${quantity}x ${strain?.name || 'item'}!`,
                { giftId: result.insertId, type: 'item', strainId, quantity }
            );

            res.json({
                success: true,
                giftId: result.insertId
            });

        } else if (giftType === 'seeds') {
            if (!strainId || !quantity || quantity <= 0) {
                await conn.rollback();
                return res.status(400).json({ error: 'Invalid seed details', code: 'INVALID_INPUT' });
            }

            // Check sender has seeds
            const [[seeds]] = await conn.execute(
                `SELECT id, quantity FROM cfx_seed_inventory
                 WHERE player_id = ? AND strain_id = ? FOR UPDATE`,
                [senderId, strainId]
            );

            if (!seeds || seeds.quantity < quantity) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient seeds', code: 'INSUFFICIENT_SEEDS' });
            }

            // Deduct seeds
            if (seeds.quantity === quantity) {
                await conn.execute('DELETE FROM cfx_seed_inventory WHERE id = ?', [seeds.id]);
            } else {
                await conn.execute(
                    'UPDATE cfx_seed_inventory SET quantity = quantity - ? WHERE id = ?',
                    [quantity, seeds.id]
                );
            }

            // Get strain name
            const [[strain]] = await conn.execute('SELECT name FROM cfx_strains WHERE id = ?', [strainId]);

            // Create gift record
            const [result] = await conn.execute(
                `INSERT INTO cfx_gifts (sender_id, receiver_id, gift_type, strain_id, quantity, message, status)
                 VALUES (?, ?, 'seeds', ?, ?, ?, 'pending')`,
                [senderId, receiverId, strainId, quantity, message || null]
            );

            await conn.commit();

            // Notify receiver
            await createNotification(
                receiverId,
                'gift_received',
                'Seeds Received!',
                `${req.player.display_name} sent you ${quantity}x ${strain?.name || 'seeds'}!`,
                { giftId: result.insertId, type: 'seeds', strainId, quantity }
            );

            res.json({
                success: true,
                giftId: result.insertId
            });

        } else {
            await conn.rollback();
            return res.status(400).json({ error: 'Invalid gift type', code: 'INVALID_TYPE' });
        }

    } catch (error) {
        await conn.rollback();
        logger.error('[Gifts] Send failed', { error: error.message });
        res.status(500).json({ error: 'Failed to send gift', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /gifts/claim
 * Claim a pending gift
 */
router.post('/claim', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { giftId } = req.body;

        if (!giftId) {
            return res.status(400).json({ error: 'Gift ID required', code: 'INVALID_INPUT' });
        }

        await conn.beginTransaction();

        // Get and lock the gift
        const [[gift]] = await conn.execute(
            `SELECT * FROM cfx_gifts WHERE id = ? AND receiver_id = ? AND status = 'pending' FOR UPDATE`,
            [giftId, playerId]
        );

        if (!gift) {
            await conn.rollback();
            return res.status(404).json({ error: 'Gift not found or already claimed', code: 'NOT_FOUND' });
        }

        let newCash = null;
        let cashGiftAmount = 0;

        if (gift.gift_type === 'cash') {
            // Store cash gift amount and award after transaction
            cashGiftAmount = parseFloat(gift.cash_amount);

        } else if (gift.gift_type === 'item') {
            // Add to inventory
            const [[existing]] = await conn.execute(
                `SELECT id, quantity FROM cfx_inventory
                 WHERE player_id = ? AND strain_id = ? AND quality = ?`,
                [playerId, gift.strain_id, gift.quality]
            );

            if (existing) {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                    [gift.quantity, existing.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality)
                     VALUES (?, ?, ?, ?)`,
                    [playerId, gift.strain_id, gift.quantity, gift.quality]
                );
            }

        } else if (gift.gift_type === 'seeds') {
            // Add to seed inventory
            const [[existing]] = await conn.execute(
                `SELECT id, quantity FROM cfx_seed_inventory
                 WHERE player_id = ? AND strain_id = ?`,
                [playerId, gift.strain_id]
            );

            if (existing) {
                await conn.execute(
                    'UPDATE cfx_seed_inventory SET quantity = quantity + ? WHERE id = ?',
                    [gift.quantity, existing.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity)
                     VALUES (?, ?, ?)`,
                    [playerId, gift.strain_id, gift.quantity]
                );
            }
        }

        // Mark gift as claimed
        await conn.execute(
            `UPDATE cfx_gifts SET status = 'claimed', claimed_at = NOW() WHERE id = ?`,
            [giftId]
        );

        await conn.commit();

        // Award cash after transaction using proper engine function (applies bonuses)
        if (cashGiftAmount > 0) {
            const cashResult = await awardCash(playerId, cashGiftAmount);
            newCash = cashResult.newCash;
        }

        res.json({
            success: true,
            giftType: gift.gift_type,
            newCash
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Gifts] Claim failed', { error: error.message });
        res.status(500).json({ error: 'Failed to claim gift', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /gifts/decline
 * Decline a gift (returns to sender)
 */
router.post('/decline', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { giftId } = req.body;

        await conn.beginTransaction();

        const [[gift]] = await conn.execute(
            `SELECT * FROM cfx_gifts WHERE id = ? AND receiver_id = ? AND status = 'pending' FOR UPDATE`,
            [giftId, playerId]
        );

        if (!gift) {
            await conn.rollback();
            return res.status(404).json({ error: 'Gift not found', code: 'NOT_FOUND' });
        }

        // Return items to sender
        if (gift.gift_type === 'cash') {
            await conn.execute(
                'UPDATE cfx_players SET cash = cash + ? WHERE id = ?',
                [gift.cash_amount, gift.sender_id]
            );
        } else if (gift.gift_type === 'item') {
            const [[existing]] = await conn.execute(
                `SELECT id FROM cfx_inventory WHERE player_id = ? AND strain_id = ? AND quality = ?`,
                [gift.sender_id, gift.strain_id, gift.quality]
            );

            if (existing) {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                    [gift.quantity, existing.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality)
                     VALUES (?, ?, ?, ?)`,
                    [gift.sender_id, gift.strain_id, gift.quantity, gift.quality]
                );
            }
        } else if (gift.gift_type === 'seeds') {
            const [[existing]] = await conn.execute(
                `SELECT id FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ?`,
                [gift.sender_id, gift.strain_id]
            );

            if (existing) {
                await conn.execute(
                    'UPDATE cfx_seed_inventory SET quantity = quantity + ? WHERE id = ?',
                    [gift.quantity, existing.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity)
                     VALUES (?, ?, ?)`,
                    [gift.sender_id, gift.strain_id, gift.quantity]
                );
            }
        }

        // Mark as declined
        await conn.execute(
            `UPDATE cfx_gifts SET status = 'declined' WHERE id = ?`,
            [giftId]
        );

        await conn.commit();

        // Notify sender
        await createNotification(
            gift.sender_id,
            'system',
            'Gift Declined',
            `${req.player.display_name} declined your gift. Items returned.`,
            { giftId }
        );

        res.json({ success: true });

    } catch (error) {
        await conn.rollback();
        logger.error('[Gifts] Decline failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

export default router;
