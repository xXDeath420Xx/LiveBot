/**
 * Equipment Routes
 * Tools and upgrades that provide passive bonuses
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { hasResearch } from './research.js';

const router = Router();

/**
 * GET /equipment
 * Get all equipment and player's owned items
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all equipment with player ownership
        const [equipment] = await pool.execute(`
            SELECT
                e.*,
                pe.id as owned_id,
                pe.is_active,
                pe.purchased_at
            FROM cfx_equipment e
            LEFT JOIN cfx_player_equipment pe ON e.id = pe.equipment_id AND pe.player_id = ?
            WHERE e.is_active = TRUE
            ORDER BY e.category, e.tier, e.name
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

        // Process equipment
        const processedEquipment = equipment.map(item => {
            const meetsResearch = !item.unlock_research_key || researchKeys.has(item.unlock_research_key);
            const canAfford = parseFloat(player.cash) >= parseFloat(item.price);

            return {
                id: item.id,
                key: item.equipment_key,
                name: item.name,
                description: item.description,
                category: item.category,
                tier: item.tier,
                effectType: item.effect_type,
                effectValue: parseFloat(item.effect_value),
                price: parseFloat(item.price),
                unlockResearchKey: item.unlock_research_key,
                icon: item.icon,
                isOwned: !!item.owned_id,
                isActive: item.is_active === 1,
                purchasedAt: item.purchased_at,
                meetsResearch,
                canAfford,
                canPurchase: !item.owned_id && meetsResearch && canAfford
            };
        });

        // Group by category
        const byCategory = {
            lighting: [],
            irrigation: [],
            climate: [],
            security: [],
            processing: [],
            storage: []
        };

        for (const item of processedEquipment) {
            if (byCategory[item.category]) {
                byCategory[item.category].push(item);
            }
        }

        // Calculate active bonuses
        const activeBonuses = {};
        for (const item of processedEquipment) {
            if (item.isOwned && item.isActive) {
                if (!activeBonuses[item.effectType]) {
                    activeBonuses[item.effectType] = 0;
                }
                activeBonuses[item.effectType] += item.effectValue;
            }
        }

        // Stats
        const ownedCount = processedEquipment.filter(e => e.isOwned).length;
        const activeCount = processedEquipment.filter(e => e.isOwned && e.isActive).length;

        res.json({
            success: true,
            equipment: byCategory,
            allEquipment: processedEquipment,
            activeBonuses,
            stats: {
                total: processedEquipment.length,
                owned: ownedCount,
                active: activeCount
            },
            player: {
                cash: player.cash,
                level: player.level
            }
        });
    } catch (error) {
        logger.error('[Equipment] Error loading equipment:', error);
        res.status(500).json({ success: false, error: 'Failed to load equipment' });
    }
});

/**
 * POST /equipment/buy
 * Purchase equipment
 */
router.post('/buy', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { equipmentId } = req.body;

        if (!equipmentId) {
            return res.status(400).json({ success: false, error: 'Equipment ID required' });
        }

        await conn.beginTransaction();

        // Get equipment
        const [equipRows] = await conn.execute(`
            SELECT * FROM cfx_equipment WHERE id = ? AND is_active = TRUE
        `, [equipmentId]);

        if (equipRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Equipment not found' });
        }

        const equipment = equipRows[0];

        // Check if already owned
        const [ownedRows] = await conn.execute(`
            SELECT id FROM cfx_player_equipment WHERE player_id = ? AND equipment_id = ?
        `, [playerId, equipmentId]);

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

        // Check research requirement
        if (equipment.unlock_research_key) {
            const hasReq = await hasResearch(playerId, equipment.unlock_research_key);
            if (!hasReq) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    error: `Requires research: ${equipment.unlock_research_key}`
                });
            }
        }

        if (player.cash < equipment.price) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        // Deduct cash
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ? WHERE id = ?
        `, [equipment.price, playerId]);

        // Add to player equipment (active by default)
        await conn.execute(`
            INSERT INTO cfx_player_equipment (player_id, equipment_id, is_active)
            VALUES (?, ?, TRUE)
        `, [playerId, equipmentId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Purchased "${equipment.name}"`,
            equipment: {
                id: equipment.id,
                name: equipment.name,
                effectType: equipment.effect_type,
                effectValue: parseFloat(equipment.effect_value)
            }
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Equipment] Error purchasing:', error);
        res.status(500).json({ success: false, error: 'Failed to purchase equipment' });
    } finally {
        conn.release();
    }
});

/**
 * PUT /equipment/:id/toggle
 * Toggle equipment active status
 */
router.put('/:id/toggle', async (req, res) => {
    try {
        const playerId = req.player.id;
        const equipmentId = parseInt(req.params.id, 10);

        // Get current status
        const [rows] = await pool.execute(`
            SELECT pe.*, e.name FROM cfx_player_equipment pe
            JOIN cfx_equipment e ON pe.equipment_id = e.id
            WHERE pe.player_id = ? AND pe.equipment_id = ?
        `, [playerId, equipmentId]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Equipment not owned' });
        }

        const current = rows[0];
        const newStatus = !current.is_active;

        await pool.execute(`
            UPDATE cfx_player_equipment SET is_active = ? WHERE player_id = ? AND equipment_id = ?
        `, [newStatus, playerId, equipmentId]);

        res.json({
            success: true,
            message: `${current.name} ${newStatus ? 'activated' : 'deactivated'}`,
            isActive: newStatus
        });
    } catch (error) {
        logger.error('[Equipment] Error toggling:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle equipment' });
    }
});

/**
 * POST /equipment/:id/sell
 * Sell equipment for 50% of original price
 */
router.post('/:id/sell', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const equipmentId = parseInt(req.params.id, 10);

        await conn.beginTransaction();

        // Get owned equipment
        const [rows] = await conn.execute(`
            SELECT pe.*, e.name, e.price FROM cfx_player_equipment pe
            JOIN cfx_equipment e ON pe.equipment_id = e.id
            WHERE pe.player_id = ? AND pe.equipment_id = ?
        `, [playerId, equipmentId]);

        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Equipment not owned' });
        }

        const equipment = rows[0];
        const sellPrice = Math.floor(equipment.price / 2);

        // Remove from player
        await conn.execute(`
            DELETE FROM cfx_player_equipment WHERE player_id = ? AND equipment_id = ?
        `, [playerId, equipmentId]);

        // Add cash
        await conn.execute(`
            UPDATE cfx_players SET cash = cash + ? WHERE id = ?
        `, [sellPrice, playerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Sold "${equipment.name}" for $${sellPrice.toLocaleString()}`,
            cashGained: sellPrice
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Equipment] Error selling:', error);
        res.status(500).json({ success: false, error: 'Failed to sell equipment' });
    } finally {
        conn.release();
    }
});

/**
 * Helper: Get all active equipment bonuses for a player
 */
export async function getEquipmentBonuses(playerId) {
    const [rows] = await pool.execute(`
        SELECT e.effect_type, e.effect_value
        FROM cfx_player_equipment pe
        JOIN cfx_equipment e ON pe.equipment_id = e.id
        WHERE pe.player_id = ? AND pe.is_active = TRUE
    `, [playerId]);

    const bonuses = {};
    for (const row of rows) {
        if (!bonuses[row.effect_type]) {
            bonuses[row.effect_type] = 0;
        }
        bonuses[row.effect_type] += parseFloat(row.effect_value) || 0;
    }

    return bonuses;
}

export default router;
