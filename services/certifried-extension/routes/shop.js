/**
 * NPC Shop Routes - "Green Thumb Supply Co."
 * The local seed shop run by Old Man Jenkins
 *
 * Seeds are CONSUMABLE items - buy them, they go to your seed inventory,
 * and you consume 1 seed each time you plant.
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { deductCash, awardCash } from '../game/engine.js';

const router = Router();

// ============================================
// SHOP INVENTORY - Seeds are consumable!
// ============================================
const SHOP_SEEDS = {
    // Common seeds - affordable for beginners
    'og-kush': { name: 'OG Kush Seeds', price: 150, pack: 3, rarity: 'uncommon', description: 'The legendary OG. Complex terpene profile with earthy, pine notes.' },
    'jack-herer': { name: 'Jack Herer Seeds', price: 150, pack: 3, rarity: 'uncommon', description: 'Award-winning sativa named after the cannabis activist. Creative, clear-headed buzz.' },
    'white-widow': { name: 'White Widow Seeds', price: 150, pack: 3, rarity: 'uncommon', description: 'Dutch coffeeshop classic. Frosty white trichomes, balanced high.' },
    'gorilla-glue': { name: 'Gorilla Glue Seeds', price: 200, pack: 3, rarity: 'uncommon', description: 'Sticky and potent hybrid. Heavy-handed relaxation.' },
    'gsc': { name: 'GSC Seeds', price: 200, pack: 3, rarity: 'uncommon', description: 'Girl Scout Cookies - sweet, powerful, and a fan favorite worldwide.' },

    // Rare seeds - mid-tier investment
    'wedding-cake': { name: 'Wedding Cake Seeds', price: 400, pack: 2, rarity: 'rare', description: 'Rich and tangy with high THC. Celebration-worthy genetics.' },
    'gelato': { name: 'Gelato Seeds', price: 400, pack: 2, rarity: 'rare', description: 'Dessert strain with beautiful purple hues. Smooth and creamy.' },
    'zkittlez': { name: 'Zkittlez Seeds', price: 400, pack: 2, rarity: 'rare', description: 'Taste the rainbow! Fruity indica with tropical vibes.' },
    'purple-punch': { name: 'Purple Punch Seeds', price: 400, pack: 2, rarity: 'rare', description: 'Grape soda meets blueberry muffins. Knockout indica.' },
    'gdp': { name: 'GDP Seeds', price: 400, pack: 2, rarity: 'rare', description: 'Granddaddy Purple - the OG purple strain. Deep relaxation.' },

    // Epic seeds - premium genetics
    'runtz': { name: 'Runtz Seeds', price: 1000, pack: 1, rarity: 'epic', description: 'Candy-like flavor, top-shelf genetics. The hype is real.' },
    'gary-payton': { name: 'Gary Payton Seeds', price: 1000, pack: 1, rarity: 'epic', description: 'Cookies collab with the NBA legend. Elite genetics.' },
    'biscotti': { name: 'Biscotti Seeds', price: 1000, pack: 1, rarity: 'epic', description: 'Italian dessert terps from the Cookie family tree.' },

    // Legendary seeds - investment pieces
    'ghost-train-haze': { name: 'Ghost Train Haze Seeds', price: 3000, pack: 1, rarity: 'legendary', description: 'Extreme potency warning. Not for beginners. Mind-bending sativa.' },
    'bruce-banner': { name: 'Bruce Banner Seeds', price: 3000, pack: 1, rarity: 'legendary', description: 'Smash your expectations. Incredible THC levels.' },
    'alien-og': { name: 'Alien OG Seeds', price: 3000, pack: 1, rarity: 'legendary', description: 'Out of this world genetics. Otherworldly effects.' }
};

// Boosters and upgrades
const SHOP_BOOSTERS = [
    { id: 'boost_speed_1', name: 'Quick Grow Tonic', price: 100, effect: 'speed', multiplier: 1.25, duration: 1800000, description: '+25% growth speed for 30 minutes' },
    { id: 'boost_speed_2', name: 'Rapid Growth Elixir', price: 250, effect: 'speed', multiplier: 1.5, duration: 1800000, description: '+50% growth speed for 30 minutes' },
    { id: 'boost_yield_1', name: 'Harvest Boost', price: 150, effect: 'yield', multiplier: 1.25, uses: 5, description: '+25% yield for next 5 harvests' },
    { id: 'boost_yield_2', name: 'Mega Harvest', price: 350, effect: 'yield', multiplier: 1.5, uses: 5, description: '+50% yield for next 5 harvests' },
    { id: 'boost_xp_1', name: 'Experience Tea', price: 200, effect: 'xp', multiplier: 1.5, duration: 3600000, description: '+50% XP for 1 hour' },
    { id: 'boost_quality_1', name: 'Quality Nutrients', price: 175, effect: 'quality', bonus: 10, uses: 5, description: '+10% quality for next 5 plants' }
];

const SHOP_UPGRADES = [
    { id: 'upgrade_slot', name: 'Grow Room Expansion', price: 2500, effect: 'slot', maxOwned: 8, description: 'Add 1 grow slot to your facility' },
    { id: 'upgrade_auto_water', name: 'Irrigation System', price: 5000, effect: 'auto_water', maxOwned: 1, description: 'Plants never wither while offline' },
    { id: 'upgrade_storage', name: 'Storage Expansion', price: 1000, effect: 'storage', bonus: 50, maxOwned: 10, description: 'Add 50 inventory slots' }
];

const SHOP_WORKERS = [
    { id: 'worker_harvester', name: 'Trimmer', price: 10000, effect: 'auto_harvest', interval: 300000, maxOwned: 1, description: 'Auto-harvests ready plants every 5 min' },
    { id: 'worker_planter', name: 'Propagation Tech', price: 15000, effect: 'auto_plant', interval: 300000, maxOwned: 1, description: 'Auto-replants empty slots' },
    { id: 'worker_seller', name: 'Sales Rep', price: 20000, effect: 'auto_sell', interval: 600000, maxOwned: 1, description: 'Auto-sells harvested product' }
];

/**
 * GET /shop/items
 * Get shop catalog with player's seed inventory
 */
router.get('/items', async (req, res) => {
    try {
        logger.info('[Shop] GET /items', { playerId: req.player.id });

        // Get player's seed inventory
        const [seedInventory] = await pool.execute(
            `SELECT si.*, s.slug, s.name as strain_name, s.rarity
             FROM cfx_seed_inventory si
             JOIN cfx_strains s ON si.strain_id = s.id
             WHERE si.player_id = ? AND si.quantity > 0`,
            [req.player.id]
        );

        // Get player's owned upgrades/workers
        const [ownedItems] = await pool.execute(
            `SELECT item_id, COUNT(*) as count FROM cfx_player_shop_items
             WHERE player_id = ? AND (expires_at IS NULL OR expires_at > NOW())
             GROUP BY item_id`,
            [req.player.id]
        );

        const ownedMap = {};
        ownedItems.forEach(o => { ownedMap[o.item_id] = o.count; });

        // Build seed catalog with ownership info
        const seeds = [];
        for (const [slug, seed] of Object.entries(SHOP_SEEDS)) {
            const owned = seedInventory.find(s => s.slug === slug);
            seeds.push({
                id: `seed_${slug}`,
                slug,
                ...seed,
                category: 'seeds',
                owned: owned ? owned.quantity : 0
            });
        }

        // Build other items
        const boosters = SHOP_BOOSTERS.map(b => ({
            ...b,
            category: 'boosters',
            owned: ownedMap[b.id] || 0
        }));

        const upgrades = SHOP_UPGRADES.map(u => ({
            ...u,
            category: 'upgrades',
            owned: ownedMap[u.id] || 0,
            canBuy: !u.maxOwned || (ownedMap[u.id] || 0) < u.maxOwned
        }));

        const workers = SHOP_WORKERS.map(w => ({
            ...w,
            category: 'workers',
            owned: ownedMap[w.id] || 0,
            canBuy: !w.maxOwned || (ownedMap[w.id] || 0) < w.maxOwned
        }));

        res.json({
            success: true,
            playerCash: parseFloat(req.player.cash),
            seeds,
            boosters,
            upgrades,
            workers,
            seedInventory: seedInventory.map(s => ({
                strainSlug: s.slug,
                strainName: s.strain_name,
                quantity: s.quantity,
                rarity: s.rarity
            }))
        });

    } catch (error) {
        logger.error('[Shop] GET /items failed', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to load shop', code: 'ERROR' });
    }
});

/**
 * POST /shop/buy
 * Purchase items from the shop
 */
router.post('/buy', async (req, res) => {
    const conn = await pool.getConnection();
    let cashDeducted = false;
    let totalPrice = 0;

    try {
        const { itemId, quantity = 1 } = req.body;
        logger.info('[Shop] POST /buy', { playerId: req.player.id, itemId, quantity });

        if (!itemId) {
            return res.status(400).json({ error: 'Item ID required', code: 'NO_ITEM' });
        }

        // Determine item type and find it
        let item = null;
        let itemType = null;

        if (itemId.startsWith('seed_')) {
            const slug = itemId.replace('seed_', '');
            if (SHOP_SEEDS[slug]) {
                item = { ...SHOP_SEEDS[slug], slug };
                itemType = 'seed';
            }
        } else if (itemId.startsWith('boost_')) {
            item = SHOP_BOOSTERS.find(b => b.id === itemId);
            itemType = 'booster';
        } else if (itemId.startsWith('upgrade_')) {
            item = SHOP_UPGRADES.find(u => u.id === itemId);
            itemType = 'upgrade';
        } else if (itemId.startsWith('worker_')) {
            item = SHOP_WORKERS.find(w => w.id === itemId);
            itemType = 'worker';
        }

        if (!item) {
            return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });
        }

        totalPrice = item.price * quantity;

        // Check max owned for upgrades/workers
        if (item.maxOwned) {
            const [[ownedCount]] = await pool.execute(
                `SELECT COUNT(*) as count FROM cfx_player_shop_items
                 WHERE player_id = ? AND item_id = ?`,
                [req.player.id, itemId]
            );

            if (ownedCount.count >= item.maxOwned) {
                return res.status(400).json({
                    error: `You already own the maximum (${item.maxOwned})`,
                    code: 'MAX_OWNED'
                });
            }
        }

        // Deduct cash
        const cashResult = await deductCash(req.player.id, totalPrice);
        if (!cashResult.success) {
            return res.status(400).json({
                error: `Insufficient funds. Need $${totalPrice.toLocaleString()}, have $${parseFloat(cashResult.newCash).toLocaleString()}`,
                code: 'INSUFFICIENT_FUNDS'
            });
        }
        cashDeducted = true;

        await conn.beginTransaction();

        const results = [];

        // Handle seed purchase - add to seed inventory
        if (itemType === 'seed') {
            // Get strain ID
            const [[strain]] = await conn.execute(
                'SELECT id FROM cfx_strains WHERE slug = ?',
                [item.slug]
            );

            if (!strain) {
                throw new Error(`Strain not found: ${item.slug}`);
            }

            const seedsToAdd = item.pack * quantity;

            // Insert or update seed inventory
            await conn.execute(
                `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity, total_purchased)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    quantity = quantity + VALUES(quantity),
                    total_purchased = total_purchased + VALUES(total_purchased)`,
                [req.player.id, strain.id, seedsToAdd, seedsToAdd]
            );

            // Also mark strain as discovered (so player can see its stats)
            await conn.execute(
                `INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id, discovery_method)
                 VALUES (?, ?, 'purchase')`,
                [req.player.id, strain.id]
            );

            results.push({
                type: 'seeds_purchased',
                strain: item.name,
                quantity: seedsToAdd
            });

        } else if (itemType === 'booster') {
            // Add booster to player's items
            const expiresAt = item.duration ? new Date(Date.now() + item.duration) : null;

            for (let i = 0; i < quantity; i++) {
                await conn.execute(
                    `INSERT INTO cfx_player_shop_items
                     (player_id, item_id, item_type, effect_type, multiplier, bonus, uses_remaining, expires_at)
                     VALUES (?, ?, 'booster', ?, ?, ?, ?, ?)`,
                    [req.player.id, itemId, item.effect, item.multiplier || 1, item.bonus || 0, item.uses || null, expiresAt]
                );
            }

            results.push({ type: 'booster_activated', name: item.name, quantity });

        } else if (itemType === 'upgrade') {
            if (item.effect === 'slot') {
                // Add grow slot
                const [[currentSlots]] = await conn.execute(
                    'SELECT MAX(slot_number) as max_slot FROM cfx_grow_slots WHERE player_id = ?',
                    [req.player.id]
                );
                const nextSlot = (currentSlots.max_slot || 0) + 1;

                await conn.execute(
                    'INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, ?)',
                    [req.player.id, nextSlot]
                );

                await conn.execute(
                    'UPDATE cfx_players SET max_grow_slots = max_grow_slots + 1 WHERE id = ?',
                    [req.player.id]
                );

                results.push({ type: 'slot_added', newSlot: nextSlot });
            }

            // Track purchase
            await conn.execute(
                `INSERT INTO cfx_player_shop_items (player_id, item_id, item_type, effect_type, bonus)
                 VALUES (?, ?, 'upgrade', ?, ?)`,
                [req.player.id, itemId, item.effect, item.bonus || 0]
            );

            results.push({ type: 'upgrade_purchased', name: item.name });

        } else if (itemType === 'worker') {
            await conn.execute(
                `INSERT INTO cfx_player_shop_items
                 (player_id, item_id, item_type, effect_type, worker_interval)
                 VALUES (?, ?, 'worker', ?, ?)`,
                [req.player.id, itemId, item.effect, item.interval]
            );

            results.push({ type: 'worker_hired', name: item.name });
        }

        await conn.commit();

        logger.info('[Shop] Purchase successful', {
            playerId: req.player.id,
            itemId,
            spent: totalPrice,
            results
        });

        res.json({
            success: true,
            message: `Purchased ${item.name}!`,
            spent: totalPrice,
            currency: cashResult.newCash,
            results
        });

    } catch (error) {
        await conn.rollback();

        // Refund if cash was deducted
        if (cashDeducted && totalPrice > 0) {
            try {
                await awardCash(req.player.id, totalPrice);
                logger.info('[Shop] Refunded cash after error', { playerId: req.player.id, refund: totalPrice });
            } catch (refundError) {
                logger.error('[Shop] Refund failed', { error: refundError.message });
            }
        }

        logger.error('[Shop] Purchase failed', {
            playerId: req.player.id,
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({ error: 'Purchase failed: ' + error.message, code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * GET /shop/seeds
 * Get player's seed inventory
 */
router.get('/seeds', async (req, res) => {
    try {
        const [seeds] = await pool.execute(
            `SELECT si.quantity, si.total_used, s.id as strain_id, s.name, s.slug, s.rarity,
                    s.base_grow_time_ms, s.base_yield_min, s.base_yield_max, s.description
             FROM cfx_seed_inventory si
             JOIN cfx_strains s ON si.strain_id = s.id
             WHERE si.player_id = ? AND si.quantity > 0
             ORDER BY s.rarity DESC, s.name`,
            [req.player.id]
        );

        res.json({
            success: true,
            seeds: seeds.map(s => ({
                strainId: s.strain_id,
                name: s.name,
                slug: s.slug,
                rarity: s.rarity,
                quantity: s.quantity,
                totalUsed: s.total_used,
                growTimeMs: s.base_grow_time_ms,
                yieldMin: s.base_yield_min,
                yieldMax: s.base_yield_max,
                description: s.description
            }))
        });

    } catch (error) {
        logger.error('[Shop] GET /seeds failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /shop/owned
 * Get player's owned upgrades, boosters, workers
 */
router.get('/owned', async (req, res) => {
    try {
        const [items] = await pool.execute(
            `SELECT * FROM cfx_player_shop_items
             WHERE player_id = ? AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY purchased_at DESC`,
            [req.player.id]
        );

        res.json({
            success: true,
            items: items.map(i => ({
                id: i.id,
                itemId: i.item_id,
                type: i.item_type,
                effect: i.effect_type,
                multiplier: i.multiplier,
                bonus: i.bonus,
                usesRemaining: i.uses_remaining,
                expiresAt: i.expires_at,
                activated: i.activated === 1,
                workerInterval: i.worker_interval,
                purchasedAt: i.purchased_at
            }))
        });

    } catch (error) {
        logger.error('[Shop] GET /owned failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * GET /shop/active-boosters
 * Get currently active boosters for the player
 */
router.get('/active-boosters', async (req, res) => {
    try {
        const [boosters] = await pool.execute(
            `SELECT * FROM cfx_player_shop_items
             WHERE player_id = ?
             AND item_type = 'booster'
             AND activated = 1
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (uses_remaining IS NULL OR uses_remaining > 0)`,
            [req.player.id]
        );

        res.json({
            success: true,
            boosters: boosters.map(b => ({
                id: b.id,
                itemId: b.item_id,
                effect: b.effect_type,
                multiplier: parseFloat(b.multiplier) || 1,
                bonus: b.bonus || 0,
                usesRemaining: b.uses_remaining,
                expiresAt: b.expires_at
            }))
        });

    } catch (error) {
        logger.error('[Shop] GET /active-boosters failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /shop/use
 * Use/activate a booster item
 */
router.post('/use', async (req, res) => {
    try {
        const { itemId } = req.body;
        logger.info('[Shop] POST /use', { playerId: req.player.id, itemId });

        if (!itemId) {
            return res.status(400).json({ error: 'Item ID required', code: 'NO_ITEM' });
        }

        // Find the item in player's inventory (by primary key id)
        const [[item]] = await pool.execute(
            `SELECT * FROM cfx_player_shop_items
             WHERE id = ? AND player_id = ?`,
            [itemId, req.player.id]
        );

        if (!item) {
            return res.status(404).json({ error: 'Item not found in inventory', code: 'NOT_FOUND' });
        }

        // Check if already activated (for time-based boosters)
        if (item.activated && item.expires_at && new Date(item.expires_at) > new Date()) {
            return res.status(400).json({ error: 'Booster already active', code: 'ALREADY_ACTIVE' });
        }

        // Check if it has uses remaining
        if (item.uses_remaining !== null && item.uses_remaining <= 0) {
            return res.status(400).json({ error: 'No uses remaining', code: 'NO_USES' });
        }

        // Get the booster definition
        const boosterDef = SHOP_BOOSTERS.find(b => b.id === item.item_id);
        if (!boosterDef && item.item_type === 'booster') {
            return res.status(400).json({ error: 'Unknown booster type', code: 'UNKNOWN' });
        }

        let updateQuery, updateParams;
        let message = '';

        if (boosterDef?.duration) {
            // Time-based booster - set expiration
            const expiresAt = new Date(Date.now() + boosterDef.duration);
            updateQuery = `UPDATE cfx_player_shop_items
                          SET activated = 1, expires_at = ?
                          WHERE id = ?`;
            updateParams = [expiresAt, itemId];

            const durationMins = Math.round(boosterDef.duration / 60000);
            message = `${boosterDef.name} activated for ${durationMins} minutes!`;

        } else if (item.uses_remaining !== null) {
            // Uses-based booster - already activated, just confirm
            updateQuery = `UPDATE cfx_player_shop_items SET activated = 1 WHERE id = ?`;
            updateParams = [itemId];
            message = `${boosterDef?.name || 'Booster'} is ready! ${item.uses_remaining} uses remaining.`;

        } else {
            // Permanent item activation
            updateQuery = `UPDATE cfx_player_shop_items SET activated = 1 WHERE id = ?`;
            updateParams = [itemId];
            message = `${boosterDef?.name || item.item_id} activated!`;
        }

        await pool.execute(updateQuery, updateParams);

        logger.info('[Shop] Item used', {
            playerId: req.player.id,
            itemId,
            itemType: item.item_type,
            effect: item.effect_type
        });

        res.json({
            success: true,
            message,
            item: {
                id: item.id,
                itemId: item.item_id,
                effect: item.effect_type,
                multiplier: parseFloat(item.multiplier) || 1,
                usesRemaining: item.uses_remaining,
                activated: true
            }
        });

    } catch (error) {
        logger.error('[Shop] POST /use failed', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to use item', code: 'ERROR' });
    }
});

/**
 * GET /shop/deals
 * Get current rotating deals (daily/weekly specials)
 */
router.get('/deals', async (req, res) => {
    try {
        const now = new Date();

        const [deals] = await pool.execute(
            `SELECT sr.*, s.name as strain_name, s.slug, s.rarity, s.base_price, s.description as strain_description
             FROM cfx_shop_rotation sr
             JOIN cfx_strains s ON sr.strain_id = s.id
             WHERE sr.is_active = TRUE AND sr.starts_at <= ? AND sr.ends_at > ?
             ORDER BY sr.rotation_type, sr.ends_at`,
            [now, now]
        );

        // Calculate discounted prices
        const formattedDeals = deals.map(deal => {
            const basePrice = SHOP_SEEDS[deal.slug]?.price || deal.base_price * 3; // Default seed pack price
            const discountedPrice = Math.floor(basePrice * (1 - deal.discount_percent / 100));

            return {
                id: deal.id,
                type: deal.rotation_type,
                strainId: deal.strain_id,
                strainName: deal.strain_name,
                strainSlug: deal.slug,
                rarity: deal.rarity,
                description: deal.strain_description,
                originalPrice: basePrice,
                discountedPrice,
                discountPercent: deal.discount_percent,
                bonusSeeds: deal.bonus_seeds,
                endsAt: deal.ends_at,
                maxPurchases: deal.max_purchases,
                currentPurchases: deal.current_purchases,
                available: !deal.max_purchases || deal.current_purchases < deal.max_purchases
            };
        });

        res.json({
            success: true,
            deals: formattedDeals,
            serverTime: now
        });

    } catch (error) {
        logger.error('[Shop] GET /deals failed', { error: error.message });
        res.status(500).json({ error: 'Failed to load deals', code: 'ERROR' });
    }
});

/**
 * POST /shop/buy-deal
 * Purchase a rotating deal
 */
router.post('/buy-deal', async (req, res) => {
    const conn = await pool.getConnection();
    let cashDeducted = false;
    let totalPrice = 0;

    try {
        const { dealId, quantity = 1 } = req.body;
        const playerId = req.player.id;

        if (!dealId) {
            return res.status(400).json({ error: 'Deal ID required', code: 'NO_DEAL' });
        }

        await conn.beginTransaction();

        // Get the deal
        const [[deal]] = await conn.execute(
            `SELECT sr.*, s.name as strain_name, s.slug, s.base_price
             FROM cfx_shop_rotation sr
             JOIN cfx_strains s ON sr.strain_id = s.id
             WHERE sr.id = ? AND sr.is_active = TRUE AND sr.starts_at <= NOW() AND sr.ends_at > NOW()
             FOR UPDATE`,
            [dealId]
        );

        if (!deal) {
            await conn.rollback();
            return res.status(404).json({ error: 'Deal not found or expired', code: 'NOT_FOUND' });
        }

        // Check purchase limit
        if (deal.max_purchases && deal.current_purchases + quantity > deal.max_purchases) {
            await conn.rollback();
            return res.status(400).json({ error: 'Deal limit reached', code: 'LIMIT_REACHED' });
        }

        // Calculate price
        const basePrice = SHOP_SEEDS[deal.slug]?.price || deal.base_price * 3;
        const discountedPrice = Math.floor(basePrice * (1 - deal.discount_percent / 100));
        totalPrice = discountedPrice * quantity;

        // Deduct cash
        const { deductCash } = await import('../game/engine.js');
        const cashResult = await deductCash(playerId, totalPrice);
        if (!cashResult.success) {
            await conn.rollback();
            return res.status(400).json({
                error: `Insufficient funds. Need $${totalPrice.toLocaleString()}`,
                code: 'INSUFFICIENT_FUNDS'
            });
        }
        cashDeducted = true;

        // Calculate seeds to add (base pack + bonus)
        const basePack = SHOP_SEEDS[deal.slug]?.pack || 3;
        const seedsToAdd = (basePack + deal.bonus_seeds) * quantity;

        // Get strain ID
        const [[strain]] = await conn.execute('SELECT id FROM cfx_strains WHERE slug = ?', [deal.slug]);

        // Add to seed inventory
        await conn.execute(
            `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity, total_purchased)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                quantity = quantity + VALUES(quantity),
                total_purchased = total_purchased + VALUES(total_purchased)`,
            [playerId, strain.id, seedsToAdd, seedsToAdd]
        );

        // Mark strain as discovered
        await conn.execute(
            `INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id, discovery_method)
             VALUES (?, ?, 'deal_purchase')`,
            [playerId, strain.id]
        );

        // Update deal purchase count
        await conn.execute(
            'UPDATE cfx_shop_rotation SET current_purchases = current_purchases + ? WHERE id = ?',
            [quantity, dealId]
        );

        await conn.commit();

        logger.info('[Shop] Deal purchased', {
            playerId,
            dealId,
            strain: deal.strain_name,
            seeds: seedsToAdd,
            spent: totalPrice
        });

        res.json({
            success: true,
            message: `Purchased ${seedsToAdd}x ${deal.strain_name} seeds!`,
            seedsReceived: seedsToAdd,
            bonusSeeds: deal.bonus_seeds * quantity,
            spent: totalPrice,
            newCash: cashResult.newCash
        });

    } catch (error) {
        await conn.rollback();

        if (cashDeducted && totalPrice > 0) {
            try {
                const { awardCash } = await import('../game/engine.js');
                await awardCash(req.player.id, totalPrice);
            } catch (e) {
                logger.error('[Shop] Deal refund failed', { error: e.message });
            }
        }

        logger.error('[Shop] Deal purchase failed', { error: error.message });
        res.status(500).json({ error: 'Purchase failed', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

export default router;
