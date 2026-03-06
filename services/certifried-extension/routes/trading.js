/**
 * Trading Routes
 * Player-to-player item trading
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { tradeCooldown } from '../middleware/rate-limit.js';

const router = Router();

/**
 * GET /trade/pending
 * Get pending trades (sent and received)
 */
router.get('/pending', async (req, res) => {
    try {
        const [trades] = await pool.execute(
            `SELECT t.*,
                    po.display_name as offerer_name,
                    pr.display_name as receiver_name
             FROM cfx_trades t
             JOIN cfx_players po ON t.offerer_id = po.id
             LEFT JOIN cfx_players pr ON t.receiver_id = pr.id
             WHERE (t.offerer_id = ? OR t.receiver_id = ?) AND t.status = 'pending'
             ORDER BY t.created_at DESC`,
            [req.player.id, req.player.id]
        );

        res.json({
            success: true,
            trades: trades.map(t => ({
                id: t.id,
                offerer: { id: t.offerer_id, name: t.offerer_name },
                receiver: t.receiver_id ? { id: t.receiver_id, name: t.receiver_name } : null,
                offererItems: typeof t.offerer_items === 'string' ? JSON.parse(t.offerer_items) : t.offerer_items,
                offererCash: t.offerer_cash,
                receiverItems: t.receiver_items ? (typeof t.receiver_items === 'string' ? JSON.parse(t.receiver_items) : t.receiver_items) : [],
                receiverCash: t.receiver_cash,
                status: t.status,
                createdAt: t.created_at,
                expiresAt: t.expires_at,
                isOfferer: t.offerer_id === req.player.id
            }))
        });

    } catch (error) {
        logger.error('[Trading] Get pending failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /trade/create
 * Create a new trade offer
 */
router.post('/create', tradeCooldown, async (req, res) => {
    try {
        const { receiverId, offeredItems = [], offeredCash = 0 } = req.body;

        if (!receiverId) {
            return res.status(400).json({ error: 'Receiver ID required', code: 'NO_RECEIVER' });
        }

        if (receiverId === req.player.id) {
            return res.status(400).json({ error: 'Cannot trade with yourself', code: 'SELF_TRADE' });
        }

        // Verify receiver exists
        const [[receiver]] = await pool.execute(
            'SELECT id, display_name FROM cfx_players WHERE id = ?',
            [receiverId]
        );

        if (!receiver) {
            return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
        }

        // Verify player has the items and cash
        if (offeredCash > 0 && req.player.cash < offeredCash) {
            return res.status(400).json({ error: 'Insufficient funds', code: 'INSUFFICIENT_CASH' });
        }

        // Lock items (mark as in trade) - simplified for now
        for (const item of offeredItems) {
            const [[inv]] = await pool.execute(
                'SELECT quantity FROM cfx_inventory WHERE id = ? AND player_id = ?',
                [item.inventoryId, req.player.id]
            );
            if (!inv || inv.quantity < item.quantity) {
                return res.status(400).json({
                    error: `Insufficient quantity for item ${item.inventoryId}`,
                    code: 'INSUFFICIENT_ITEMS'
                });
            }
        }

        // Create trade
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        const [result] = await pool.execute(
            `INSERT INTO cfx_trades (offerer_id, offerer_items, offerer_cash, receiver_id, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
            [req.player.id, JSON.stringify(offeredItems), offeredCash, receiverId, expiresAt]
        );

        res.json({
            success: true,
            tradeId: result.insertId,
            expiresAt
        });

    } catch (error) {
        logger.error('[Trading] Create failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /trade/accept
 * Accept a trade offer
 */
router.post('/accept', tradeCooldown, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { tradeId } = req.body;

        if (!tradeId) {
            return res.status(400).json({ error: 'Trade ID required', code: 'NO_ID' });
        }

        await conn.beginTransaction();

        const [[trade]] = await conn.execute(
            `SELECT * FROM cfx_trades WHERE id = ? AND receiver_id = ? AND status = 'pending' FOR UPDATE`,
            [tradeId, req.player.id]
        );

        if (!trade) {
            await conn.rollback();
            return res.status(404).json({ error: 'Trade not found', code: 'NOT_FOUND' });
        }

        const offererItems = typeof trade.offerer_items === 'string'
            ? JSON.parse(trade.offerer_items)
            : trade.offerer_items;

        // Verify offerer still has required cash
        if (trade.offerer_cash > 0) {
            const [[offerer]] = await conn.execute(
                'SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE',
                [trade.offerer_id]
            );
            if (!offerer || offerer.cash < trade.offerer_cash) {
                await conn.rollback();
                return res.status(400).json({ error: 'Offerer no longer has sufficient cash', code: 'INSUFFICIENT_CASH' });
            }
        }

        // Verify offerer still has all items and store item details
        const itemDetails = [];
        for (const item of offererItems) {
            const [[inv]] = await conn.execute(
                'SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ? FOR UPDATE',
                [item.inventoryId, trade.offerer_id]
            );
            if (!inv || inv.quantity < item.quantity) {
                await conn.rollback();
                return res.status(400).json({ error: 'Offerer no longer has required items', code: 'INSUFFICIENT_ITEMS' });
            }
            itemDetails.push({ ...item, inv });
        }

        // Transfer items from offerer to receiver
        for (const { inventoryId, quantity, inv } of itemDetails) {
            // Deduct from offerer
            if (inv.quantity === quantity) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [quantity, inventoryId]
                );
            }

            // Add to receiver
            const [[existing]] = await conn.execute(
                `SELECT id FROM cfx_inventory WHERE player_id = ? AND strain_id = ? AND quality = ?`,
                [req.player.id, inv.strain_id, inv.quality]
            );

            if (existing) {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                    [quantity, existing.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality, source)
                     VALUES (?, ?, ?, ?, 'traded')`,
                    [req.player.id, inv.strain_id, quantity, inv.quality]
                );
            }
        }

        // Transfer cash
        if (trade.offerer_cash > 0) {
            await conn.execute(
                'UPDATE cfx_players SET cash = cash - ? WHERE id = ?',
                [trade.offerer_cash, trade.offerer_id]
            );
            await conn.execute(
                'UPDATE cfx_players SET cash = cash + ? WHERE id = ?',
                [trade.offerer_cash, req.player.id]
            );
        }

        // Mark trade as accepted
        await conn.execute(
            `UPDATE cfx_trades SET status = 'accepted', resolved_at = NOW() WHERE id = ?`,
            [tradeId]
        );

        await conn.commit();

        res.json({ success: true });

    } catch (error) {
        await conn.rollback();
        logger.error('[Trading] Accept failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /trade/decline
 * Decline a trade offer
 */
router.post('/decline', async (req, res) => {
    try {
        const { tradeId } = req.body;

        if (!tradeId) {
            return res.status(400).json({ error: 'Trade ID required', code: 'NO_ID' });
        }

        const [result] = await pool.execute(
            `UPDATE cfx_trades SET status = 'declined', resolved_at = NOW()
             WHERE id = ? AND receiver_id = ? AND status = 'pending'`,
            [tradeId, req.player.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Trade not found', code: 'NOT_FOUND' });
        }

        res.json({ success: true });

    } catch (error) {
        logger.error('[Trading] Decline failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /trade/cancel
 * Cancel own trade offer
 */
router.post('/cancel', async (req, res) => {
    try {
        const { tradeId } = req.body;

        if (!tradeId) {
            return res.status(400).json({ error: 'Trade ID required', code: 'NO_ID' });
        }

        const [result] = await pool.execute(
            `UPDATE cfx_trades SET status = 'cancelled', resolved_at = NOW()
             WHERE id = ? AND offerer_id = ? AND status = 'pending'`,
            [tradeId, req.player.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Trade not found', code: 'NOT_FOUND' });
        }

        res.json({ success: true });

    } catch (error) {
        logger.error('[Trading] Cancel failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
