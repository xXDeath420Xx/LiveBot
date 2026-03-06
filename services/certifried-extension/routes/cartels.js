/**
 * Cartels Routes
 * Guild/clan system for players
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { deductCash } from '../game/engine.js';

const router = Router();

/**
 * GET /cartels
 * Get player's cartel info or list available cartels
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Check if player is in a cartel
        const [memberRows] = await pool.execute(`
            SELECT cm.*, c.*, cm.role as member_role
            FROM cfx_cartel_members cm
            JOIN cfx_cartels c ON cm.cartel_id = c.id
            WHERE cm.player_id = ?
        `, [playerId]);

        if (memberRows.length > 0) {
            const cartel = memberRows[0];

            // Get all members
            const [members] = await pool.execute(`
                SELECT cm.*, p.display_name, p.level
                FROM cfx_cartel_members cm
                JOIN cfx_players p ON cm.player_id = p.id
                WHERE cm.cartel_id = ?
                ORDER BY
                    CASE cm.role WHEN 'leader' THEN 1 WHEN 'officer' THEN 2 ELSE 3 END,
                    cm.contribution_cash + cm.contribution_xp DESC
            `, [cartel.cartel_id]);

            // Get upgrades
            const [upgrades] = await pool.execute(`
                SELECT cu.*, COALESCE(cus.current_level, 0) as current_level
                FROM cfx_cartel_upgrades cu
                LEFT JOIN cfx_cartel_upgrade_status cus ON cu.id = cus.upgrade_id AND cus.cartel_id = ?
                WHERE cu.is_active = TRUE
                ORDER BY cu.base_cost
            `, [cartel.cartel_id]);

            // Get pending invites (for officers/leaders)
            let pendingInvites = [];
            if (cartel.member_role !== 'member') {
                const [invites] = await pool.execute(`
                    SELECT ci.*, p.display_name
                    FROM cfx_cartel_invites ci
                    JOIN cfx_players p ON ci.player_id = p.id
                    WHERE ci.cartel_id = ? AND ci.status = 'pending' AND ci.expires_at > NOW()
                `, [cartel.cartel_id]);
                pendingInvites = invites;
            }

            // Get controlled territories
            const [territories] = await pool.execute(`
                SELECT t.*, tc.control_points, tc.captured_at
                FROM cfx_territory_control tc
                JOIN cfx_territories t ON tc.territory_id = t.id
                WHERE tc.cartel_id = ?
            `, [cartel.cartel_id]);

            return res.json({
                success: true,
                inCartel: true,
                cartel: {
                    id: cartel.cartel_id,
                    name: cartel.name,
                    tag: cartel.tag,
                    description: cartel.description,
                    level: cartel.level,
                    xp: cartel.xp,
                    xpToNextLevel: cartel.xp_to_next_level,
                    cashBank: cartel.cash_bank,
                    maxMembers: cartel.max_members,
                    isRecruiting: cartel.is_recruiting,
                    icon: cartel.icon,
                    createdAt: cartel.created_at
                },
                myRole: cartel.member_role,
                myContribution: {
                    cash: cartel.contribution_cash,
                    xp: cartel.contribution_xp,
                    wars: cartel.contribution_wars
                },
                members: members.map(m => ({
                    playerId: m.player_id,
                    displayName: m.display_name,
                    level: m.level,
                    role: m.role,
                    contributionCash: m.contribution_cash,
                    contributionXp: m.contribution_xp,
                    joinedAt: m.joined_at
                })),
                upgrades: upgrades.map(u => ({
                    id: u.id,
                    key: u.upgrade_key,
                    name: u.name,
                    description: u.description,
                    effectType: u.effect_type,
                    effectValuePerLevel: parseFloat(u.effect_value_per_level),
                    maxLevel: u.max_level,
                    currentLevel: u.current_level,
                    baseCost: u.base_cost,
                    costMultiplier: parseFloat(u.cost_multiplier),
                    nextCost: Math.floor(u.base_cost * Math.pow(u.cost_multiplier, u.current_level)),
                    icon: u.icon
                })),
                pendingInvites,
                territories: territories.map(t => ({
                    id: t.id,
                    name: t.name,
                    bonusType: t.bonus_type,
                    bonusValue: parseFloat(t.bonus_value),
                    capturedAt: t.captured_at
                }))
            });
        }

        // Not in a cartel - show available cartels to join
        const [cartels] = await pool.execute(`
            SELECT c.*,
                   (SELECT COUNT(*) FROM cfx_cartel_members WHERE cartel_id = c.id) as member_count
            FROM cfx_cartels c
            WHERE c.is_recruiting = TRUE
            ORDER BY c.level DESC, member_count DESC
            LIMIT 20
        `);

        // Check for pending invites
        const [invites] = await pool.execute(`
            SELECT ci.*, c.name as cartel_name, c.tag, c.level
            FROM cfx_cartel_invites ci
            JOIN cfx_cartels c ON ci.cartel_id = c.id
            WHERE ci.player_id = ? AND ci.status = 'pending' AND ci.expires_at > NOW()
        `, [playerId]);

        res.json({
            success: true,
            inCartel: false,
            availableCartels: cartels.map(c => ({
                id: c.id,
                name: c.name,
                tag: c.tag,
                description: c.description,
                level: c.level,
                memberCount: c.member_count,
                maxMembers: c.max_members,
                minLevelRequirement: c.min_level_requirement,
                icon: c.icon
            })),
            pendingInvites: invites.map(i => ({
                inviteId: i.id,
                cartelId: i.cartel_id,
                cartelName: i.cartel_name,
                tag: i.tag,
                level: i.level,
                expiresAt: i.expires_at
            }))
        });
    } catch (error) {
        logger.error('[Cartels] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load cartel data' });
    }
});

/**
 * POST /cartels/create
 * Create a new cartel
 */
router.post('/create', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { name, tag, description } = req.body;

        if (!name || name.length < 3 || name.length > 50) {
            return res.status(400).json({ success: false, error: 'Name must be 3-50 characters' });
        }

        if (!tag || tag.length < 2 || tag.length > 5) {
            return res.status(400).json({ success: false, error: 'Tag must be 2-5 characters' });
        }

        await conn.beginTransaction();

        // Check if already in a cartel
        const [existing] = await conn.execute(`
            SELECT id FROM cfx_cartel_members WHERE player_id = ?
        `, [playerId]);

        if (existing.length > 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Already in a cartel' });
        }

        // Check and deduct creation cost using engine function
        const creationCost = 50000;
        const cashResult = await deductCash(playerId, creationCost);
        if (!cashResult.success) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: `Need $${creationCost.toLocaleString()} to create a cartel` });
        }

        // Create cartel
        const [result] = await conn.execute(`
            INSERT INTO cfx_cartels (name, tag, description, leader_id)
            VALUES (?, ?, ?, ?)
        `, [name, tag.toUpperCase(), description || '', playerId]);

        const cartelId = result.insertId;

        // Add creator as leader
        await conn.execute(`
            INSERT INTO cfx_cartel_members (cartel_id, player_id, role)
            VALUES (?, ?, 'leader')
        `, [cartelId, playerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Created cartel "${name}" [${tag.toUpperCase()}]`,
            cartelId
        });
    } catch (error) {
        await conn.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, error: 'Cartel name already taken' });
        }
        logger.error('[Cartels] Error creating:', error);
        res.status(500).json({ success: false, error: 'Failed to create cartel' });
    } finally {
        conn.release();
    }
});

/**
 * POST /cartels/join
 * Join a cartel (from invite or open recruitment)
 */
router.post('/join', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { cartelId, inviteId } = req.body;

        await conn.beginTransaction();

        // Check if already in a cartel
        const [existing] = await conn.execute(`
            SELECT id FROM cfx_cartel_members WHERE player_id = ?
        `, [playerId]);

        if (existing.length > 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Already in a cartel' });
        }

        let targetCartelId = cartelId;

        // If using invite
        if (inviteId) {
            const [inviteRows] = await conn.execute(`
                SELECT * FROM cfx_cartel_invites
                WHERE id = ? AND player_id = ? AND status = 'pending' AND expires_at > NOW()
            `, [inviteId, playerId]);

            if (inviteRows.length === 0) {
                await conn.rollback();
                return res.status(400).json({ success: false, error: 'Invalid or expired invite' });
            }

            targetCartelId = inviteRows[0].cartel_id;

            // Mark invite as accepted
            await conn.execute(`
                UPDATE cfx_cartel_invites SET status = 'accepted', responded_at = NOW() WHERE id = ?
            `, [inviteId]);
        }

        // Get cartel info
        const [cartelRows] = await conn.execute(`
            SELECT c.*, (SELECT COUNT(*) FROM cfx_cartel_members WHERE cartel_id = c.id) as member_count
            FROM cfx_cartels c WHERE c.id = ?
        `, [targetCartelId]);

        if (cartelRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Cartel not found' });
        }

        const cartel = cartelRows[0];

        if (cartel.member_count >= cartel.max_members) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Cartel is full' });
        }

        if (!inviteId && !cartel.is_recruiting) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Cartel is not recruiting' });
        }

        // Check level requirement
        const [playerRows] = await conn.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);

        if (playerRows[0].level < cartel.min_level_requirement) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: `Requires level ${cartel.min_level_requirement}`
            });
        }

        // Join cartel
        await conn.execute(`
            INSERT INTO cfx_cartel_members (cartel_id, player_id, role)
            VALUES (?, ?, 'member')
        `, [targetCartelId, playerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Joined "${cartel.name}"!`
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Cartels] Error joining:', error);
        res.status(500).json({ success: false, error: 'Failed to join cartel' });
    } finally {
        conn.release();
    }
});

/**
 * POST /cartels/leave
 * Leave current cartel
 */
router.post('/leave', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;

        await conn.beginTransaction();

        const [memberRows] = await conn.execute(`
            SELECT cm.*, c.leader_id FROM cfx_cartel_members cm
            JOIN cfx_cartels c ON cm.cartel_id = c.id
            WHERE cm.player_id = ?
        `, [playerId]);

        if (memberRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not in a cartel' });
        }

        const membership = memberRows[0];

        // Leaders can't leave, they must transfer or disband
        if (membership.role === 'leader') {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                error: 'Leaders must transfer leadership or disband the cartel'
            });
        }

        await conn.execute(`
            DELETE FROM cfx_cartel_members WHERE player_id = ?
        `, [playerId]);

        await conn.commit();

        res.json({
            success: true,
            message: 'Left the cartel'
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Cartels] Error leaving:', error);
        res.status(500).json({ success: false, error: 'Failed to leave cartel' });
    } finally {
        conn.release();
    }
});

/**
 * POST /cartels/invite
 * Invite a player to the cartel
 */
router.post('/invite', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { targetPlayerId } = req.body;

        if (!targetPlayerId) {
            return res.status(400).json({ success: false, error: 'Target player required' });
        }

        // Get inviter's cartel and role
        const [memberRows] = await pool.execute(`
            SELECT cm.*, c.name as cartel_name FROM cfx_cartel_members cm
            JOIN cfx_cartels c ON cm.cartel_id = c.id
            WHERE cm.player_id = ?
        `, [playerId]);

        if (memberRows.length === 0) {
            return res.status(400).json({ success: false, error: 'Not in a cartel' });
        }

        const membership = memberRows[0];

        if (membership.role === 'member') {
            return res.status(403).json({ success: false, error: 'Only officers and leaders can invite' });
        }

        // Check if target is already in a cartel
        const [targetMember] = await pool.execute(`
            SELECT id FROM cfx_cartel_members WHERE player_id = ?
        `, [targetPlayerId]);

        if (targetMember.length > 0) {
            return res.status(400).json({ success: false, error: 'Player is already in a cartel' });
        }

        // Check for existing pending invite
        const [existingInvite] = await pool.execute(`
            SELECT id FROM cfx_cartel_invites
            WHERE cartel_id = ? AND player_id = ? AND status = 'pending' AND expires_at > NOW()
        `, [membership.cartel_id, targetPlayerId]);

        if (existingInvite.length > 0) {
            return res.status(400).json({ success: false, error: 'Already invited this player' });
        }

        // Create invite (expires in 7 days)
        await pool.execute(`
            INSERT INTO cfx_cartel_invites (cartel_id, player_id, invited_by, expires_at)
            VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))
        `, [membership.cartel_id, targetPlayerId, playerId]);

        res.json({
            success: true,
            message: `Invited player to ${membership.cartel_name}`
        });
    } catch (error) {
        logger.error('[Cartels] Error inviting:', error);
        res.status(500).json({ success: false, error: 'Failed to send invite' });
    }
});

/**
 * POST /cartels/contribute
 * Contribute cash to the cartel bank
 */
router.post('/contribute', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount' });
        }

        await conn.beginTransaction();

        // Get membership
        const [memberRows] = await conn.execute(`
            SELECT cm.*, c.cash_bank FROM cfx_cartel_members cm
            JOIN cfx_cartels c ON cm.cartel_id = c.id
            WHERE cm.player_id = ?
        `, [playerId]);

        if (memberRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not in a cartel' });
        }

        // Check player cash
        const [playerRows] = await conn.execute(`
            SELECT cash FROM cfx_players WHERE id = ? FOR UPDATE
        `, [playerId]);

        if (playerRows[0].cash < amount) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough cash' });
        }

        // Transfer
        await conn.execute(`
            UPDATE cfx_players SET cash = cash - ? WHERE id = ?
        `, [amount, playerId]);

        await conn.execute(`
            UPDATE cfx_cartels SET cash_bank = cash_bank + ? WHERE id = ?
        `, [amount, memberRows[0].cartel_id]);

        await conn.execute(`
            UPDATE cfx_cartel_members SET contribution_cash = contribution_cash + ? WHERE player_id = ?
        `, [amount, playerId]);

        await conn.commit();

        res.json({
            success: true,
            message: `Contributed $${amount.toLocaleString()} to the cartel`
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Cartels] Error contributing:', error);
        res.status(500).json({ success: false, error: 'Failed to contribute' });
    } finally {
        conn.release();
    }
});

/**
 * POST /cartels/upgrade
 * Purchase a cartel upgrade
 */
router.post('/upgrade', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const { upgradeId } = req.body;

        await conn.beginTransaction();

        // Get membership and role
        const [memberRows] = await conn.execute(`
            SELECT cm.*, c.cash_bank FROM cfx_cartel_members cm
            JOIN cfx_cartels c ON cm.cartel_id = c.id
            WHERE cm.player_id = ?
        `, [playerId]);

        if (memberRows.length === 0) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not in a cartel' });
        }

        if (memberRows[0].role === 'member') {
            await conn.rollback();
            return res.status(403).json({ success: false, error: 'Only officers and leaders can purchase upgrades' });
        }

        const cartelId = memberRows[0].cartel_id;

        // Get upgrade info
        const [upgradeRows] = await conn.execute(`
            SELECT cu.*, COALESCE(cus.current_level, 0) as current_level
            FROM cfx_cartel_upgrades cu
            LEFT JOIN cfx_cartel_upgrade_status cus ON cu.id = cus.upgrade_id AND cus.cartel_id = ?
            WHERE cu.id = ?
        `, [cartelId, upgradeId]);

        if (upgradeRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Upgrade not found' });
        }

        const upgrade = upgradeRows[0];

        if (upgrade.current_level >= upgrade.max_level) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Upgrade already maxed' });
        }

        const cost = Math.floor(upgrade.base_cost * Math.pow(upgrade.cost_multiplier, upgrade.current_level));

        if (memberRows[0].cash_bank < cost) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough in cartel bank' });
        }

        // Deduct from bank
        await conn.execute(`
            UPDATE cfx_cartels SET cash_bank = cash_bank - ? WHERE id = ?
        `, [cost, cartelId]);

        // Update or insert upgrade status
        await conn.execute(`
            INSERT INTO cfx_cartel_upgrade_status (cartel_id, upgrade_id, current_level, last_upgraded_at)
            VALUES (?, ?, 1, NOW())
            ON DUPLICATE KEY UPDATE current_level = current_level + 1, last_upgraded_at = NOW()
        `, [cartelId, upgradeId]);

        // Apply member slot increase if applicable
        if (upgrade.effect_type === 'max_members') {
            await conn.execute(`
                UPDATE cfx_cartels SET max_members = max_members + ? WHERE id = ?
            `, [Math.floor(upgrade.effect_value_per_level), cartelId]);
        }

        await conn.commit();

        res.json({
            success: true,
            message: `Upgraded "${upgrade.name}" to level ${upgrade.current_level + 1}`
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[Cartels] Error upgrading:', error);
        res.status(500).json({ success: false, error: 'Failed to purchase upgrade' });
    } finally {
        conn.release();
    }
});

/**
 * Helper: Get cartel bonuses for a player
 */
export async function getCartelBonuses(playerId) {
    const [rows] = await pool.execute(`
        SELECT cu.effect_type, cu.effect_value_per_level, cus.current_level
        FROM cfx_cartel_members cm
        JOIN cfx_cartel_upgrade_status cus ON cm.cartel_id = cus.cartel_id
        JOIN cfx_cartel_upgrades cu ON cus.upgrade_id = cu.id
        WHERE cm.player_id = ? AND cus.current_level > 0
    `, [playerId]);

    const bonuses = {};
    for (const row of rows) {
        if (!bonuses[row.effect_type]) {
            bonuses[row.effect_type] = 0;
        }
        bonuses[row.effect_type] += parseFloat(row.effect_value_per_level) * row.current_level;
    }

    return bonuses;
}

export default router;
