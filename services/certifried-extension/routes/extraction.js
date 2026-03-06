/**
 * Extraction Lab Routes
 * Convert raw cannabis into concentrated products
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { hasFeatureUnlock } from '../game/research-helper.js';
import { awardCash } from '../game/engine.js';
import { awardReputation } from './reputation.js';

const router = Router();

const MAX_EXTRACTION_SLOTS = 2;

/**
 * GET /extraction
 * Get extraction lab status - recipes, slots, products
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;
        const playerLevel = req.player.level || 1;

        // Check if extraction is unlocked via research
        const hasExtraction = await hasFeatureUnlock(playerId, 'extraction') ||
                              await hasFeatureUnlock(playerId, 'extraction_lab');
        if (!hasExtraction) {
            return res.json({
                success: true,
                locked: true,
                message: 'Extraction Lab requires research: "Extraction Basics"',
                requiredResearch: 'extraction',
                recipes: [],
                slots: [],
                products: []
            });
        }

        // Get available recipes (all active recipes for now, research unlock handled separately)
        const [recipes] = await pool.execute(
            `SELECT * FROM cfx_extraction_recipes
             WHERE is_active = TRUE
             ORDER BY id ASC`
        );

        // Get player's extraction slots (create if not exist)
        let [slots] = await pool.execute(
            `SELECT es.*, er.name as recipe_name, er.product_type, er.process_time_ms,
                    s.name as strain_name
             FROM cfx_extraction_slots es
             LEFT JOIN cfx_extraction_recipes er ON es.recipe_id = er.id
             LEFT JOIN cfx_strains s ON es.strain_id = s.id
             WHERE es.player_id = ?
             ORDER BY es.slot_number`,
            [playerId]
        );

        // Create default slots if none exist
        if (slots.length === 0) {
            for (let i = 1; i <= MAX_EXTRACTION_SLOTS; i++) {
                await pool.execute(
                    `INSERT INTO cfx_extraction_slots (player_id, slot_number) VALUES (?, ?)`,
                    [playerId, i]
                );
            }
            // Re-fetch
            [slots] = await pool.execute(
                `SELECT * FROM cfx_extraction_slots WHERE player_id = ? ORDER BY slot_number`,
                [playerId]
            );
        }

        // Get player's products inventory
        const [products] = await pool.execute(
            `SELECT pp.*, er.name as recipe_name, s.name as strain_name
             FROM cfx_player_products pp
             JOIN cfx_extraction_recipes er ON pp.recipe_id = er.id
             LEFT JOIN cfx_strains s ON pp.strain_id = s.id
             WHERE pp.player_id = ?
             ORDER BY pp.created_at DESC`,
            [playerId]
        );

        res.json({
            success: true,
            recipes: recipes.map(r => ({
                id: r.id,
                key: r.recipe_key,
                name: r.name,
                description: r.description,
                productType: r.product_type,
                inputQuantity: r.input_quantity,
                outputQuantity: r.output_quantity,
                processTimeMs: r.process_time_ms,
                processTimeMinutes: Math.round(r.process_time_ms / 60000),
                valueMultiplier: parseFloat(r.value_multiplier || 1),
                qualityBonus: r.quality_bonus || 0,
                unlockResearchKey: r.unlock_research_key
            })),
            slots: slots.map(s => ({
                id: s.id,
                slotNumber: s.slot_number,
                status: s.status,
                recipeId: s.recipe_id,
                recipeName: s.recipe_name,
                productType: s.product_type,
                strainId: s.strain_id,
                strainName: s.strain_name,
                inputQuality: s.input_quality,
                inputQuantity: s.input_quantity,
                startedAt: s.started_at,
                completesAt: s.completes_at,
                timeRemaining: s.completes_at
                    ? Math.max(0, new Date(s.completes_at) - new Date())
                    : null
            })),
            products: products.map(p => ({
                id: p.id,
                recipeName: p.recipe_name,
                productName: p.product_name,
                productType: p.product_type,
                strainName: p.strain_name,
                quality: p.quality,
                quantity: p.quantity,
                baseValue: parseFloat(p.base_value),
                createdAt: p.created_at
            })),
            maxSlots: MAX_EXTRACTION_SLOTS
        });

    } catch (error) {
        logger.error('[Extraction] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get extraction lab', code: 'ERROR' });
    }
});

/**
 * POST /extraction/start
 * Start an extraction process
 */
router.post('/start', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { slotId, recipeId, inventoryId } = req.body;

        // Check if extraction is unlocked via research
        const hasExtraction = await hasFeatureUnlock(playerId, 'extraction') ||
                              await hasFeatureUnlock(playerId, 'extraction_lab');
        if (!hasExtraction) {
            return res.status(403).json({
                error: 'Extraction Lab requires research: "Extraction Basics"',
                code: 'FEATURE_LOCKED'
            });
        }

        if (!slotId || !recipeId || !inventoryId) {
            return res.status(400).json({
                error: 'Slot, recipe, and inventory item required',
                code: 'MISSING_FIELDS'
            });
        }

        // Get the slot
        const [[slot]] = await pool.execute(
            `SELECT * FROM cfx_extraction_slots WHERE id = ? AND player_id = ?`,
            [slotId, playerId]
        );

        if (!slot) {
            return res.status(404).json({ error: 'Slot not found', code: 'SLOT_NOT_FOUND' });
        }

        if (slot.status !== 'empty') {
            return res.status(400).json({ error: 'Slot is not empty', code: 'SLOT_BUSY' });
        }

        // Get the recipe
        const [[recipe]] = await pool.execute(
            `SELECT * FROM cfx_extraction_recipes WHERE id = ?`,
            [recipeId]
        );

        if (!recipe) {
            return res.status(404).json({ error: 'Recipe not found', code: 'RECIPE_NOT_FOUND' });
        }

        // Check research requirement
        if (recipe.unlock_research_key) {
            const [researchRows] = await pool.execute(
                `SELECT 1 FROM cfx_player_research pr
                 JOIN cfx_research_nodes rn ON pr.research_id = rn.id
                 WHERE pr.player_id = ? AND rn.research_key = ? AND pr.status = 'completed'`,
                [playerId, recipe.unlock_research_key]
            );
            if (researchRows.length === 0) {
                return res.status(400).json({
                    error: `Requires research: ${recipe.unlock_research_key}`,
                    code: 'RESEARCH_REQUIRED'
                });
            }
        }

        // Get inventory item
        const [[invItem]] = await pool.execute(
            `SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ?`,
            [inventoryId, playerId]
        );

        if (!invItem) {
            return res.status(404).json({ error: 'Inventory item not found', code: 'ITEM_NOT_FOUND' });
        }

        // Check sufficient quantity
        if (invItem.quantity < recipe.input_quantity) {
            return res.status(400).json({
                error: `Need ${recipe.input_quantity} units, have ${invItem.quantity}`,
                code: 'INSUFFICIENT_QTY'
            });
        }

        const completesAt = new Date(Date.now() + recipe.process_time_ms);

        // Transaction
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Deduct from inventory
            if (invItem.quantity <= recipe.input_quantity) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [recipe.input_quantity, inventoryId]
                );
            }

            // Update slot
            await conn.execute(
                `UPDATE cfx_extraction_slots
                 SET recipe_id = ?, strain_id = ?, input_quality = ?, input_quantity = ?,
                     status = 'processing', started_at = NOW(), completes_at = ?
                 WHERE id = ?`,
                [recipeId, invItem.strain_id, invItem.quality, recipe.input_quantity, completesAt, slotId]
            );

            await conn.commit();

            logger.info('[Extraction] Started', {
                playerId,
                slotId,
                recipeId,
                strainId: invItem.strain_id
            });

            res.json({
                success: true,
                message: `Extraction started! Ready in ${Math.round(recipe.process_time_ms / 60000)} minutes.`,
                completesAt
            });

        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

    } catch (error) {
        logger.error('[Extraction] Start failed', { error: error.message });
        res.status(500).json({ error: 'Failed to start extraction', code: 'ERROR' });
    }
});

/**
 * POST /extraction/claim
 * Claim a completed extraction
 */
router.post('/claim', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { slotId } = req.body;

        if (!slotId) {
            return res.status(400).json({ error: 'Slot ID required', code: 'MISSING_SLOT' });
        }

        // Get the slot with recipe info
        const [[slot]] = await pool.execute(
            `SELECT es.*, er.name as recipe_name, er.product_type, er.output_quantity,
                    er.value_multiplier, er.quality_bonus, s.name as strain_name, s.base_price
             FROM cfx_extraction_slots es
             JOIN cfx_extraction_recipes er ON es.recipe_id = er.id
             LEFT JOIN cfx_strains s ON es.strain_id = s.id
             WHERE es.id = ? AND es.player_id = ?`,
            [slotId, playerId]
        );

        if (!slot) {
            return res.status(404).json({ error: 'Slot not found', code: 'SLOT_NOT_FOUND' });
        }

        if (slot.status !== 'processing' && slot.status !== 'ready') {
            return res.status(400).json({ error: 'Nothing to claim', code: 'NOTHING_TO_CLAIM' });
        }

        // Check if complete
        if (new Date(slot.completes_at) > new Date()) {
            return res.status(400).json({
                error: 'Extraction not complete yet',
                code: 'NOT_COMPLETE',
                timeRemaining: new Date(slot.completes_at) - new Date()
            });
        }

        // Calculate output quality and value
        const outputQuality = Math.min(100, (slot.input_quality || 0) + (slot.quality_bonus || 0));
        const baseValue = (parseFloat(slot.base_price) || 100) * (parseFloat(slot.value_multiplier) || 1) * (outputQuality / 50);
        const productName = `${slot.strain_name || 'Cannabis'} ${slot.recipe_name}`;

        // Transaction
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Create product in inventory (stack if duplicate exists)
            await conn.execute(
                `INSERT INTO cfx_player_products
                 (player_id, recipe_id, strain_id, product_name, product_type, quality, quantity, base_value)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
                [
                    playerId,
                    slot.recipe_id,
                    slot.strain_id,
                    productName,
                    slot.product_type,
                    outputQuality,
                    slot.output_quantity,
                    baseValue,
                    slot.output_quantity
                ]
            );

            // Reset slot
            await conn.execute(
                `UPDATE cfx_extraction_slots
                 SET recipe_id = NULL, strain_id = NULL, input_quality = NULL, input_quantity = NULL,
                     status = 'empty', started_at = NULL, completes_at = NULL
                 WHERE id = ?`,
                [slotId]
            );

            await conn.commit();

            // Award reputation for extraction work (fire-and-forget)
            awardReputation(playerId, 'research_collective', 5).catch(() => {});

            logger.info('[Extraction] Claimed', {
                playerId,
                slotId,
                productName,
                quality: outputQuality
            });

            res.json({
                success: true,
                product: {
                    name: productName,
                    type: slot.product_type,
                    quality: outputQuality,
                    quantity: slot.output_quantity,
                    value: baseValue
                },
                message: `Claimed ${slot.output_quantity}x ${productName}!`
            });

        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

    } catch (error) {
        logger.error('[Extraction] Claim failed', { error: error.message });
        res.status(500).json({ error: 'Failed to claim', code: 'ERROR' });
    }
});

/**
 * POST /extraction/sell-product
 * Sell extracted products
 */
router.post('/sell-product', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { productId, quantity } = req.body;

        if (!productId || !quantity || quantity < 1) {
            return res.status(400).json({ error: 'Product ID and quantity required', code: 'MISSING_FIELDS' });
        }

        // Get product
        const [[product]] = await pool.execute(
            `SELECT * FROM cfx_player_products WHERE id = ? AND player_id = ?`,
            [productId, playerId]
        );

        if (!product) {
            return res.status(404).json({ error: 'Product not found', code: 'NOT_FOUND' });
        }

        const sellQty = Math.min(quantity, product.quantity);
        const saleAmount = product.base_value * sellQty;

        // Transaction
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Update or delete product
            if (product.quantity <= sellQty) {
                await conn.execute('DELETE FROM cfx_player_products WHERE id = ?', [productId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_player_products SET quantity = quantity - ? WHERE id = ?',
                    [sellQty, productId]
                );
            }

            await conn.commit();

            // Award cash using engine function AFTER transaction (applies income bonus)
            const cashResult = await awardCash(playerId, saleAmount);

            logger.info('[Extraction] Product sold', {
                playerId,
                productId,
                quantity: sellQty,
                saleAmount: cashResult.cashAwarded
            });

            res.json({
                success: true,
                sold: sellQty,
                earned: cashResult.cashAwarded,
                newCash: cashResult.newCash
            });

        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

    } catch (error) {
        logger.error('[Extraction] Sell product failed', { error: error.message });
        res.status(500).json({ error: 'Failed to sell', code: 'ERROR' });
    }
});

export default router;
