/**
 * Dispensary Routes
 * Player-owned dispensary management with customers
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash } from '../game/engine.js';
import { awardReputation } from './reputation.js';
import { updateTournamentScore } from './tournaments.js';

const router = Router();

/**
 * GET /dispensary
 * Get player's dispensary or create one
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get or create dispensary
        let [dispensaryRows] = await pool.execute(`
            SELECT * FROM cfx_dispensaries WHERE player_id = ?
        `, [playerId]);

        if (dispensaryRows.length === 0) {
            // Create dispensary
            await pool.execute(`
                INSERT INTO cfx_dispensaries (player_id) VALUES (?)
            `, [playerId]);

            [dispensaryRows] = await pool.execute(`
                SELECT * FROM cfx_dispensaries WHERE player_id = ?
            `, [playerId]);
        }

        const dispensary = dispensaryRows[0];

        // Get inventory listed for sale
        const [inventory] = await pool.execute(`
            SELECT di.*, s.name as strain_name, s.genetics
            FROM cfx_dispensary_inventory di
            JOIN cfx_strains s ON di.strain_id = s.id
            WHERE di.dispensary_id = ?
            ORDER BY di.listed_at DESC
        `, [dispensary.id]);

        // Get active customer orders
        const [orders] = await pool.execute(`
            SELECT o.*, c.name as customer_name, c.icon as customer_icon,
                   c.tip_chance, c.tip_multiplier
            FROM cfx_dispensary_orders o
            JOIN cfx_dispensary_customers c ON o.customer_id = c.id
            WHERE o.dispensary_id = ? AND o.status = 'waiting' AND o.expires_at > NOW()
            ORDER BY o.expires_at ASC
        `, [dispensary.id]);

        // Get recent sales
        const [recentSales] = await pool.execute(`
            SELECT o.*, c.name as customer_name
            FROM cfx_dispensary_orders o
            JOIN cfx_dispensary_customers c ON o.customer_id = c.id
            WHERE o.dispensary_id = ? AND o.status = 'served'
            ORDER BY o.completed_at DESC
            LIMIT 10
        `, [dispensary.id]);

        // Get player inventory (available to list)
        const [playerInventory] = await pool.execute(`
            SELECT i.*, s.name as strain_name
            FROM cfx_inventory i
            JOIN cfx_strains s ON i.strain_id = s.id
            WHERE i.player_id = ? AND i.quantity > 0
            ORDER BY s.name, i.quality DESC
        `, [playerId]);

        res.json({
            success: true,
            dispensary: {
                id: dispensary.id,
                name: dispensary.name,
                tier: dispensary.tier,
                reputation: dispensary.reputation,
                customerCapacity: dispensary.customer_capacity,
                priceModifier: parseFloat(dispensary.price_modifier),
                isOpen: dispensary.is_open,
                totalSales: dispensary.total_sales,
                totalRevenue: dispensary.total_revenue
            },
            inventory: inventory.map(i => ({
                id: i.id,
                inventoryId: i.inventory_id,
                strainId: i.strain_id,
                strainName: i.strain_name,
                quality: i.quality,
                quantity: i.quantity,
                pricePerUnit: i.price_per_unit,
                thc: i.thc,
                cbd: i.cbd
            })),
            waitingCustomers: orders.map(o => ({
                id: o.id,
                customerName: o.customer_name,
                customerIcon: o.customer_icon,
                requestedQualityMin: o.requested_quality_min,
                budget: o.budget,
                tipChance: parseFloat(o.tip_chance),
                expiresAt: o.expires_at,
                timeLeft: Math.max(0, new Date(o.expires_at) - new Date())
            })),
            recentSales: recentSales.map(s => ({
                customerName: s.customer_name,
                saleAmount: s.sale_amount,
                tipAmount: s.tip_amount,
                completedAt: s.completed_at
            })),
            playerInventory: playerInventory.map(i => ({
                id: i.id,
                strainId: i.strain_id,
                strainName: i.strain_name,
                quality: i.quality,
                quantity: i.quantity
            }))
        });
    } catch (error) {
        logger.error('[Dispensary] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load dispensary' });
    }
});

/**
 * POST /dispensary/toggle
 * Open or close the dispensary
 */
router.post('/toggle', async (req, res) => {
    try {
        const playerId = req.player.id;

        const [dispensaryRows] = await pool.execute(`
            SELECT * FROM cfx_dispensaries WHERE player_id = ?
        `, [playerId]);

        if (dispensaryRows.length === 0) {
            return res.status(404).json({ success: false, error: 'No dispensary' });
        }

        const newStatus = !dispensaryRows[0].is_open;

        await pool.execute(`
            UPDATE cfx_dispensaries SET is_open = ? WHERE player_id = ?
        `, [newStatus, playerId]);

        res.json({
            success: true,
            message: newStatus ? 'Dispensary is now open!' : 'Dispensary closed',
            isOpen: newStatus
        });
    } catch (error) {
        logger.error('[Dispensary] Error toggling:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle dispensary' });
    }
});

/**
 * POST /dispensary/list
 * Add item to dispensary inventory
 */
router.post('/list', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { inventoryId, quantity, pricePerUnit } = req.body;

        if (!inventoryId || !quantity || quantity <= 0 || !pricePerUnit || pricePerUnit <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid parameters' });
        }

        await conn.beginTransaction();

        // Get dispensary
        const [dispensaryRows] = await conn.execute(`
            SELECT id FROM cfx_dispensaries WHERE player_id = ?
        `, [playerId]);

        if (dispensaryRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'No dispensary' });
        }

        const dispensaryId = dispensaryRows[0].id;

        // Get inventory item with FOR UPDATE lock to prevent race conditions
        const [invRows] = await conn.execute(`
            SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ? AND quantity >= ?
            FOR UPDATE
        `, [inventoryId, playerId, quantity]);

        if (invRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough inventory' });
        }

        const invItem = invRows[0];

        // Remove from player inventory
        if (invItem.quantity === quantity) {
            await conn.execute(`DELETE FROM cfx_inventory WHERE id = ?`, [inventoryId]);
        } else {
            await conn.execute(`
                UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?
            `, [quantity, inventoryId]);
        }

        // Add to dispensary inventory
        await conn.execute(`
            INSERT INTO cfx_dispensary_inventory (dispensary_id, inventory_id, strain_id, quality, quantity, price_per_unit)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [dispensaryId, inventoryId, invItem.strain_id, invItem.quality, quantity, pricePerUnit]);

        await conn.commit();

        res.json({
            success: true,
            message: `Listed ${quantity} items at $${pricePerUnit} each`
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Dispensary] Error listing:', error);
        res.status(500).json({ success: false, error: 'Failed to list item' });
    } finally {
        conn.release();
    }
});

/**
 * POST /dispensary/unlist
 * Remove item from dispensary (return to inventory)
 */
router.post('/unlist', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { listingId } = req.body;

        await conn.beginTransaction();

        // Get listing
        const [listingRows] = await conn.execute(`
            SELECT di.*, d.player_id FROM cfx_dispensary_inventory di
            JOIN cfx_dispensaries d ON di.dispensary_id = d.id
            WHERE di.id = ? AND d.player_id = ?
        `, [listingId, playerId]);

        if (listingRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Listing not found' });
        }

        const listing = listingRows[0];

        // Return to player inventory
        await conn.execute(`
            INSERT INTO cfx_inventory (player_id, strain_id, quality, quantity)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE quantity = quantity + ?
        `, [playerId, listing.strain_id, listing.quality, listing.quantity, listing.quantity]);

        // Remove listing
        await conn.execute(`DELETE FROM cfx_dispensary_inventory WHERE id = ?`, [listingId]);

        await conn.commit();

        res.json({
            success: true,
            message: 'Item returned to inventory'
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Dispensary] Error unlisting:', error);
        res.status(500).json({ success: false, error: 'Failed to unlist item' });
    } finally {
        conn.release();
    }
});

/**
 * POST /dispensary/serve
 * Serve a waiting customer
 */
router.post('/serve', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { orderId, listingId } = req.body;

        await conn.beginTransaction();

        // Get order with FOR UPDATE lock to prevent double-serve exploit
        const [orderRows] = await conn.execute(`
            SELECT o.*, d.player_id, c.tip_chance, c.tip_multiplier
            FROM cfx_dispensary_orders o
            JOIN cfx_dispensaries d ON o.dispensary_id = d.id
            JOIN cfx_dispensary_customers c ON o.customer_id = c.id
            WHERE o.id = ? AND d.player_id = ? AND o.status = 'waiting' AND o.expires_at > NOW()
            FOR UPDATE
        `, [orderId, playerId]);

        if (orderRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Order not found or expired' });
        }

        const order = orderRows[0];

        // Get listing with FOR UPDATE lock to prevent double-serve exploit
        const [listingRows] = await conn.execute(`
            SELECT di.* FROM cfx_dispensary_inventory di
            WHERE di.id = ? AND di.dispensary_id = ? AND di.quantity > 0
            FOR UPDATE
        `, [listingId, order.dispensary_id]);

        if (listingRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Item not available' });
        }

        const listing = listingRows[0];

        // Check quality requirement
        if (listing.quality < order.requested_quality_min) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Customer wants quality ${order.requested_quality_min}+`
            });
        }

        // Check budget
        if (listing.price_per_unit > order.budget) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Price too high for customer's budget`
            });
        }

        // Calculate sale
        const saleAmount = Math.min(listing.price_per_unit, order.budget);
        const tipRoll = Math.random();
        const tipAmount = tipRoll < order.tip_chance
            ? Math.floor(saleAmount * order.tip_multiplier)
            : 0;

        // Reduce listing quantity
        if (listing.quantity <= 1) {
            await conn.execute(`DELETE FROM cfx_dispensary_inventory WHERE id = ?`, [listingId]);
        } else {
            await conn.execute(`
                UPDATE cfx_dispensary_inventory SET quantity = quantity - 1 WHERE id = ?
            `, [listingId]);
        }

        // Complete order
        await conn.execute(`
            UPDATE cfx_dispensary_orders
            SET status = 'served', sale_amount = ?, tip_amount = ?, completed_at = NOW()
            WHERE id = ?
        `, [saleAmount, tipAmount, orderId]);

        // Update dispensary stats (before commit, inside transaction)
        const totalEarned = saleAmount + tipAmount;
        await conn.execute(`
            UPDATE cfx_dispensaries
            SET total_sales = total_sales + 1, total_revenue = total_revenue + ?, reputation = reputation + 1
            WHERE id = ?
        `, [totalEarned, order.dispensary_id]);

        await conn.commit();

        // Give player money AFTER transaction using proper engine function (applies income bonuses)
        const cashResult = await awardCash(playerId, totalEarned);

        // Award reputation and update tournament scores (fire-and-forget)
        awardReputation(playerId, 'traders_union', 1).catch(() => {});
        updateTournamentScore(playerId, 'sales', totalEarned).catch(() => {});

        res.json({
            success: true,
            message: tipAmount > 0
                ? `Sale complete! +$${cashResult.cashAwarded.toLocaleString()} (+$${tipAmount} tip!)`
                : `Sale complete! +$${cashResult.cashAwarded.toLocaleString()}`,
            saleAmount,
            tipAmount,
            totalEarned: cashResult.cashAwarded
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Dispensary] Error serving:', error);
        res.status(500).json({ success: false, error: 'Failed to serve customer' });
    } finally {
        conn.release();
    }
});

/**
 * POST /dispensary/spawn-customer
 * Spawn a new customer (called by tick or manually in dev)
 */
router.post('/spawn-customer', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get dispensary
        const [dispensaryRows] = await pool.execute(`
            SELECT * FROM cfx_dispensaries WHERE player_id = ? AND is_open = TRUE
        `, [playerId]);

        if (dispensaryRows.length === 0) {
            return res.status(400).json({ success: false, error: 'Dispensary not open' });
        }

        const dispensary = dispensaryRows[0];

        // Check current customer count
        const [countRows] = await pool.execute(`
            SELECT COUNT(*) as count FROM cfx_dispensary_orders
            WHERE dispensary_id = ? AND status = 'waiting' AND expires_at > NOW()
        `, [dispensary.id]);

        if (countRows[0].count >= dispensary.customer_capacity) {
            return res.json({ success: true, message: 'At capacity', spawned: false });
        }

        // Pick a random customer type
        const [customers] = await pool.execute(`
            SELECT * FROM cfx_dispensary_customers WHERE is_active = TRUE
        `);

        // Weighted random selection
        const totalWeight = customers.reduce((sum, c) => sum + c.spawn_weight, 0);
        let roll = Math.random() * totalWeight;
        let selectedCustomer = customers[0];

        for (const c of customers) {
            roll -= c.spawn_weight;
            if (roll <= 0) {
                selectedCustomer = c;
                break;
            }
        }

        // Generate order
        const qualityMin = selectedCustomer.preferred_quality_min +
            Math.floor(Math.random() * (selectedCustomer.preferred_quality_max - selectedCustomer.preferred_quality_min) / 2);
        const budget = selectedCustomer.budget_min +
            Math.floor(Math.random() * (selectedCustomer.budget_max - selectedCustomer.budget_min));
        const expiresAt = new Date(Date.now() + selectedCustomer.patience_seconds * 1000);

        await pool.execute(`
            INSERT INTO cfx_dispensary_orders (dispensary_id, customer_id, requested_quality_min, budget, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `, [dispensary.id, selectedCustomer.id, qualityMin, budget, expiresAt]);

        res.json({
            success: true,
            message: `${selectedCustomer.name} walked in!`,
            spawned: true,
            customer: {
                name: selectedCustomer.name,
                icon: selectedCustomer.icon,
                qualityMin,
                budget
            }
        });
    } catch (error) {
        logger.error('[Dispensary] Error spawning customer:', error);
        res.status(500).json({ success: false, error: 'Failed to spawn customer' });
    }
});

export default router;
