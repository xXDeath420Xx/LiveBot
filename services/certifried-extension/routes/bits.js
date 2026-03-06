/**
 * Bits Routes
 * Twitch Bits purchases and boosts
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /bits/products
 * Get available Bits products
 */
router.get('/products', async (req, res) => {
    try {
        const [products] = await pool.execute(
            `SELECT * FROM cfx_bits_products WHERE is_active = 1 ORDER BY display_order`
        );

        res.json({
            success: true,
            products: products.map(p => ({
                id: p.id,
                sku: p.sku,
                name: p.name,
                description: p.description,
                bitsCost: p.bits_cost,
                productType: p.product_type,
                effect: typeof p.effect_json === 'string' ? JSON.parse(p.effect_json) : p.effect_json
            }))
        });

    } catch (error) {
        logger.error('[Bits] Get products failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /bits/transaction or /bits/redeem
 * Process a Bits transaction (called after Twitch confirms purchase)
 */
async function processBitsTransaction(req, res) {
    try {
        // Support both formats: {sku, transactionId} and {product_id, transaction_id}
        const sku = req.body.sku || req.body.product_id;
        const transactionId = req.body.transactionId || req.body.transaction_id;
        const receipt = req.body.receipt;

        if (!sku || !transactionId) {
            return res.status(400).json({ error: 'SKU and transaction ID required', code: 'MISSING_FIELDS' });
        }

        // Check if transaction already processed
        const [[existing]] = await pool.execute(
            'SELECT id FROM cfx_bits_transactions WHERE twitch_transaction_id = ?',
            [transactionId]
        );

        if (existing) {
            return res.status(400).json({ error: 'Transaction already processed', code: 'DUPLICATE' });
        }

        // Get product
        const [[product]] = await pool.execute(
            'SELECT * FROM cfx_bits_products WHERE sku = ? AND is_active = 1',
            [sku]
        );

        if (!product) {
            return res.status(404).json({ error: 'Product not found', code: 'NOT_FOUND' });
        }

        // Record transaction
        const [result] = await pool.execute(
            `INSERT INTO cfx_bits_transactions
             (player_id, product_id, twitch_transaction_id, bits_amount, status, receipt_json)
             VALUES (?, ?, ?, ?, 'pending', ?)`,
            [req.player.id, product.id, transactionId, product.bits_cost, JSON.stringify(receipt || {})]
        );

        const transactionDbId = result.insertId;

        // Process the purchase
        const effect = typeof product.effect_json === 'string'
            ? JSON.parse(product.effect_json)
            : product.effect_json;

        let fulfillmentResult = {};

        try {
            switch (product.product_type) {
                case 'speed_boost':
                case 'xp_boost': {
                    const expiresAt = Date.now() + (effect.duration_ms || 3600000);
                    await pool.execute(
                        `INSERT INTO cfx_active_boosts (player_id, boost_type, multiplier, expires_at, source_transaction_id)
                         VALUES (?, ?, ?, ?, ?)`,
                        [req.player.id, effect.boost_type, effect.multiplier, expiresAt, transactionDbId]
                    );
                    fulfillmentResult = { boostType: effect.boost_type, expiresAt };
                    break;
                }

                case 'extra_slot': {
                    if (effect.permanent) {
                        await pool.execute(
                            'UPDATE cfx_players SET max_grow_slots = max_grow_slots + ? WHERE id = ?',
                            [effect.slot_count, req.player.id]
                        );

                        const [[player]] = await pool.execute(
                            'SELECT max_grow_slots FROM cfx_players WHERE id = ?',
                            [req.player.id]
                        );

                        await pool.execute(
                            'INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, ?)',
                            [req.player.id, player.max_grow_slots]
                        );

                        fulfillmentResult = { slotsAdded: effect.slot_count, permanent: true };
                    } else {
                        const expiresAt = Date.now() + (effect.duration_ms || 86400000);
                        await pool.execute(
                            `INSERT INTO cfx_active_boosts (player_id, boost_type, multiplier, expires_at, source_transaction_id)
                             VALUES (?, 'temp_slot', ?, ?, ?)`,
                            [req.player.id, effect.slot_count, expiresAt, transactionDbId]
                        );
                        fulfillmentResult = { slotsAdded: effect.slot_count, expiresAt };
                    }
                    break;
                }

                case 'premium_seeds': {
                    // Get random strains of the specified rarity
                    const [strains] = await pool.execute(
                        'SELECT id FROM cfx_strains WHERE rarity = ? ORDER BY RAND() LIMIT ?',
                        [effect.rarity, effect.quantity]
                    );

                    for (const strain of strains) {
                        await pool.execute(
                            'INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id) VALUES (?, ?)',
                            [req.player.id, strain.id]
                        );
                    }

                    fulfillmentResult = {
                        strainsUnlocked: strains.length,
                        rarity: effect.rarity
                    };
                    break;
                }
            }

            // Mark as fulfilled
            await pool.execute(
                `UPDATE cfx_bits_transactions SET status = 'fulfilled', fulfilled_at = NOW() WHERE id = ?`,
                [transactionDbId]
            );

            logger.info('[Bits] Transaction fulfilled', {
                playerId: req.player.id,
                sku,
                transactionId
            });

            res.json({
                success: true,
                transactionId: transactionDbId,
                product: {
                    name: product.name,
                    type: product.product_type
                },
                result: fulfillmentResult
            });

        } catch (fulfillError) {
            // Mark as failed
            await pool.execute(
                `UPDATE cfx_bits_transactions SET status = 'failed', failure_reason = ? WHERE id = ?`,
                [fulfillError.message, transactionDbId]
            );

            throw fulfillError;
        }

    } catch (error) {
        logger.error('[Bits] Transaction failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Transaction failed', code: 'ERROR' });
    }
}

// Register both endpoints
router.post('/transaction', processBitsTransaction);
router.post('/redeem', processBitsTransaction);

/**
 * GET /bits/boosts
 * Get player's active boosts
 */
router.get('/boosts', async (req, res) => {
    try {
        const now = Date.now();

        const [boosts] = await pool.execute(
            `SELECT * FROM cfx_active_boosts
             WHERE player_id = ? AND expires_at > ?
             ORDER BY expires_at ASC`,
            [req.player.id, now]
        );

        res.json({
            success: true,
            boosts: boosts.map(b => ({
                id: b.id,
                boostType: b.boost_type,
                multiplier: parseFloat(b.multiplier),
                expiresAt: b.expires_at,
                remainingMs: b.expires_at - now
            }))
        });

    } catch (error) {
        logger.error('[Bits] Get boosts failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /bits/history
 * Get transaction history
 */
router.get('/history', async (req, res) => {
    try {
        const [transactions] = await pool.execute(
            `SELECT bt.*, bp.name as product_name, bp.product_type
             FROM cfx_bits_transactions bt
             JOIN cfx_bits_products bp ON bt.product_id = bp.id
             WHERE bt.player_id = ?
             ORDER BY bt.created_at DESC
             LIMIT 50`,
            [req.player.id]
        );

        res.json({
            success: true,
            transactions: transactions.map(t => ({
                id: t.id,
                productName: t.product_name,
                productType: t.product_type,
                bitsAmount: t.bits_amount,
                status: t.status,
                createdAt: t.created_at,
                fulfilledAt: t.fulfilled_at
            }))
        });

    } catch (error) {
        logger.error('[Bits] Get history failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
