/**
 * Locations Routes
 * Multiple grow locations with different climates and bonuses
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { hasResearch } from './research.js';

const router = Router();

/**
 * GET /locations
 * Get all locations and player's owned locations
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all locations with player ownership
        const [locations] = await pool.execute(`
            SELECT
                l.*,
                pl.id as owned_id,
                pl.current_slots,
                pl.is_primary,
                pl.purchased_at
            FROM cfx_locations l
            LEFT JOIN cfx_player_locations pl ON l.id = pl.location_id AND pl.player_id = ?
            WHERE l.is_active = TRUE
            ORDER BY l.unlock_level, l.price
        `, [playerId]);

        // Get player info
        const [playerRows] = await pool.execute(`
            SELECT cash, level FROM cfx_players WHERE id = ?
        `, [playerId]);
        const player = playerRows[0] || { cash: 0, level: 1 };

        // Get completed research for requirement checking
        const [completedResearch] = await pool.execute(`
            SELECT rn.research_key FROM cfx_player_research pr
            JOIN cfx_research_nodes rn ON pr.research_id = rn.id
            WHERE pr.player_id = ? AND pr.status = 'completed'
        `, [playerId]);
        const researchKeys = new Set(completedResearch.map(r => r.research_key));

        // Ensure player has at least the starter location (price = 0)
        const hasStarter = locations.some(l => parseFloat(l.price) === 0 && l.owned_id);
        if (!hasStarter) {
            // Auto-grant starter location
            const starter = locations.find(l => parseFloat(l.price) === 0);
            if (starter) {
                await pool.execute(`
                    INSERT IGNORE INTO cfx_player_locations (player_id, location_id, current_slots, is_primary)
                    VALUES (?, ?, ?, TRUE)
                `, [playerId, starter.id, starter.base_slots]);

                // Refresh locations
                const [refreshed] = await pool.execute(`
                    SELECT
                        l.*,
                        pl.id as owned_id,
                        pl.current_slots,
                        pl.is_primary,
                        pl.purchased_at
                    FROM cfx_locations l
                    LEFT JOIN cfx_player_locations pl ON l.id = pl.location_id AND pl.player_id = ?
                    WHERE l.is_active = TRUE
                    ORDER BY l.unlock_level, l.price
                `, [playerId]);
                locations.length = 0;
                locations.push(...refreshed);
            }
        }

        // Process locations
        const processedLocations = locations.map(loc => {
            const meetsResearch = !loc.required_research || researchKeys.has(loc.required_research);
            const meetsLevel = player.level >= loc.unlock_level;
            const canAfford = player.cash >= loc.price;
            const currentSlots = loc.current_slots || loc.base_slots;
            const nextUpgradeCost = loc.slot_upgrade_cost * (currentSlots - loc.base_slots + 1);

            return {
                id: loc.id,
                key: loc.location_key,
                name: loc.name,
                description: loc.description,
                climate: loc.climate,
                climateBonusType: loc.climate_bonus_type,
                climateBonusValue: parseFloat(loc.climate_bonus_value) || 0,
                baseSlots: loc.base_slots,
                maxSlots: loc.max_slots,
                slotUpgradeCost: loc.slot_upgrade_cost,
                purchasePrice: loc.price,
                requiredResearch: loc.required_research,
                requiredLevel: loc.unlock_level,
                heatModifier: parseFloat(loc.heat_modifier),
                icon: loc.icon,
                isStarter: !!loc.is_starter,
                isOwned: !!loc.owned_id,
                isPrimary: loc.is_primary === 1,
                currentSlots,
                nextUpgradeCost,
                canUpgrade: loc.owned_id && currentSlots < loc.max_slots && player.cash >= nextUpgradeCost,
                purchasedAt: loc.purchased_at,
                meetsResearch,
                meetsLevel,
                canAfford,
                canPurchase: !loc.owned_id && !loc.is_starter && meetsResearch && meetsLevel && canAfford
            };
        });

        // Find primary location
        const primaryLocation = processedLocations.find(l => l.isPrimary);

        // Calculate total slots
        const totalSlots = processedLocations
            .filter(l => l.isOwned)
            .reduce((sum, l) => sum + l.currentSlots, 0);

        res.json({
            success: true,
            locations: processedLocations,
            primaryLocation: primaryLocation ? {
                id: primaryLocation.id,
                name: primaryLocation.name,
                icon: primaryLocation.icon,
                currentSlots: primaryLocation.currentSlots,
                climate: primaryLocation.climate
            } : null,
            stats: {
                total: processedLocations.length,
                owned: processedLocations.filter(l => l.isOwned).length,
                totalSlots
            },
            player: {
                cash: player.cash,
                level: player.level
            }
        });
    } catch (error) {
        logger.error('[Locations] Error loading locations:', error);
        res.status(500).json({ success: false, error: 'Failed to load locations' });
    }
});

/**
 * POST /locations/buy
 * Purchase a new location
 */
router.post('/buy', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { locationId } = req.body;

        if (!locationId) {
            return res.status(400).json({ success: false, error: 'Location ID required' });
        }

        await conn.beginTransaction();

        // Get location
        const [locRows] = await conn.execute(`
            SELECT * FROM cfx_locations WHERE id = ? AND is_active = TRUE
        `, [locationId]);

        if (locRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Location not found' });
        }

        const location = locRows[0];

        if (location.is_starter) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Starter location is free' });
        }

        // Check if already owned
        const [ownedRows] = await conn.execute(`
            SELECT id FROM cfx_player_locations WHERE player_id = ? AND location_id = ?
        `, [playerId, locationId]);

        if (ownedRows.length > 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Already owned' });
        }

        // Check player requirements
        const [playerRows] = await conn.execute(`
            SELECT cash, level FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (playerRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Player not found' });
        }

        const player = playerRows[0];

        if (player.level < location.unlock_level) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Requires level ${location.unlock_level}`
            });
        }

        // Check research requirement
        if (location.required_research) {
            const hasReq = await hasResearch(playerId, location.required_research);
            if (!hasReq) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: `Requires research: ${location.required_research}`
                });
            }
        }

        if (player.cash < location.price) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        // Deduct cash
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ? WHERE id = ?
        `, [location.price, playerId]);

        // Add to player locations
        await conn.execute(`
            INSERT INTO cfx_player_locations (player_id, location_id, current_slots, is_primary)
            VALUES (?, ?, ?, FALSE)
        `, [playerId, locationId, location.base_slots]);

        await conn.commit();

        res.json({
            success: true,
            message: `Purchased "${location.name}" with ${location.base_slots} slots`,
            location: {
                id: location.id,
                name: location.name,
                slots: location.base_slots
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Locations] Error purchasing:', error);
        res.status(500).json({ success: false, error: 'Failed to purchase location' });
    } finally {
        conn.release();
    }
});

/**
 * POST /locations/:id/upgrade
 * Add a slot to a location
 */
router.post('/:id/upgrade', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const locationId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get player location
        const [plRows] = await conn.execute(`
            SELECT pl.*, l.name, l.max_slots, l.slot_upgrade_cost, l.base_slots
            FROM cfx_player_locations pl
            JOIN cfx_locations l ON pl.location_id = l.id
            WHERE pl.player_id = ? AND pl.location_id = ?
        `, [playerId, locationId]);

        if (plRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Location not owned' });
        }

        const playerLoc = plRows[0];

        if (playerLoc.current_slots >= playerLoc.max_slots) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Already at max slots' });
        }

        // Calculate upgrade cost (increases per slot)
        const slotNumber = playerLoc.current_slots - playerLoc.base_slots + 1;
        const upgradeCost = playerLoc.slot_upgrade_cost * slotNumber;

        // Check player cash
        const [playerRows] = await conn.execute(`
            SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (playerRows[0].cash < upgradeCost) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        // Deduct cash and add slot
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ? WHERE id = ?
        `, [upgradeCost, playerId]);

        await conn.execute(`
            UPDATE cfx_player_locations SET current_slots = current_slots + 1
            WHERE player_id = ? AND location_id = ?
        `, [playerId, locationId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Added slot to "${playerLoc.name}"`,
            newSlots: playerLoc.current_slots + 1,
            cost: upgradeCost
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Locations] Error upgrading:', error);
        res.status(500).json({ success: false, error: 'Failed to upgrade location' });
    } finally {
        conn.release();
    }
});

/**
 * PUT /locations/:id/set-primary
 * Set a location as the primary growing location
 */
router.put('/:id/set-primary', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const locationId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Verify player owns this location
        const [plRows] = await conn.execute(`
            SELECT pl.*, l.name FROM cfx_player_locations pl
            JOIN cfx_locations l ON pl.location_id = l.id
            WHERE pl.player_id = ? AND pl.location_id = ?
        `, [playerId, locationId]);

        if (plRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Location not owned' });
        }

        const location = plRows[0];

        // Clear all primary flags
        await conn.execute(`
            UPDATE cfx_player_locations SET is_primary = FALSE WHERE player_id = ?
        `, [playerId]);

        // Set this as primary
        await conn.execute(`
            UPDATE cfx_player_locations SET is_primary = TRUE
            WHERE player_id = ? AND location_id = ?
        `, [playerId, locationId]);

        await conn.commit();

        res.json({
            success: true,
            message: `"${location.name}" is now your primary location`,
            locationId
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Locations] Error setting primary:', error);
        res.status(500).json({ success: false, error: 'Failed to set primary location' });
    } finally {
        conn.release();
    }
});

/**
 * Helper: Get player's primary location bonuses
 */
export async function getLocationBonuses(playerId) {
    const [rows] = await pool.execute(`
        SELECT l.climate_bonus_type, l.climate_bonus_value, l.heat_modifier
        FROM cfx_player_locations pl
        JOIN cfx_locations l ON pl.location_id = l.id
        WHERE pl.player_id = ? AND pl.is_primary = TRUE
        LIMIT 1
    `, [playerId]);

    if (rows.length === 0) {
        return { bonuses: {}, heatModifier: 1.0 };
    }

    const loc = rows[0];
    const bonuses = {};

    if (loc.climate_bonus_type && loc.climate_bonus_value) {
        bonuses[loc.climate_bonus_type] = parseFloat(loc.climate_bonus_value) || 0;
    }

    return {
        bonuses,
        heatModifier: parseFloat(loc.heat_modifier) || 1.0
    };
}

/**
 * Helper: Get total available slots across all locations
 */
export async function getTotalSlots(playerId) {
    const [rows] = await pool.execute(`
        SELECT SUM(current_slots) as total FROM cfx_player_locations WHERE player_id = ?
    `, [playerId]);

    return rows[0]?.total || 0;
}

export default router;
