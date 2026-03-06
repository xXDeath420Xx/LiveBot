/**
 * Territory Routes
 * Territory control and turf war system for cartels
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /territories
 * Get all territories with control status
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get player's cartel membership
        const [[membership]] = await pool.execute(
            `SELECT cm.cartel_id, cm.role, c.name as cartel_name, c.tag as cartel_tag
             FROM cfx_cartel_members cm
             JOIN cfx_cartels c ON cm.cartel_id = c.id
             WHERE cm.player_id = ? AND cm.status = 'active'`,
            [playerId]
        );

        const playerCartelId = membership?.cartel_id || null;

        const [territories] = await pool.execute(
            `SELECT t.*,
                    tc.cartel_id as controlling_cartel_id,
                    c.name as controlling_cartel_name,
                    c.tag as controlling_cartel_tag
             FROM cfx_territories t
             LEFT JOIN cfx_territory_control tc ON t.id = tc.territory_id
             LEFT JOIN cfx_cartels c ON tc.cartel_id = c.id
             WHERE t.is_active = TRUE
             ORDER BY t.region, t.name`
        );

        // Get active wars
        const [wars] = await pool.execute(
            `SELECT tw.*,
                    t.name as territory_name,
                    ac.name as attacker_name, ac.tag as attacker_tag,
                    dc.name as defender_name, dc.tag as defender_tag
             FROM cfx_turf_wars tw
             JOIN cfx_territories t ON tw.territory_id = t.id
             JOIN cfx_cartels ac ON tw.attacker_cartel_id = ac.id
             LEFT JOIN cfx_cartels dc ON tw.defender_cartel_id = dc.id
             WHERE tw.status = 'active'`
        );

        res.json({
            success: true,
            // Include player's cartel info so frontend knows if they can attack
            playerCartel: membership ? {
                id: membership.cartel_id,
                name: membership.cartel_name,
                tag: membership.cartel_tag,
                role: membership.role,
                canStartWar: membership.role === 'leader' || membership.role === 'officer'
            } : null,
            inCartel: !!membership,
            territories: territories.map(t => ({
                id: t.id,
                name: t.name,
                region: t.region,
                description: t.description,
                bonusType: t.bonus_type,
                bonusValue: parseFloat(t.bonus_value),
                controlPointsRequired: t.control_points_required,
                controlledBy: t.controlling_cartel_id ? {
                    cartelId: t.controlling_cartel_id,
                    name: t.controlling_cartel_name,
                    tag: t.controlling_cartel_tag
                } : null,
                // Mark if this is owned by player's cartel
                isOwned: t.controlling_cartel_id === playerCartelId,
                ownerCartelName: t.controlling_cartel_name,
                isContested: wars.some(w => w.territory_id === t.id)
            })),
            activeWars: wars.map(w => ({
                id: w.id,
                territoryId: w.territory_id,
                territoryName: w.territory_name,
                attacker: {
                    id: w.attacker_cartel_id,
                    name: w.attacker_name || 'Unknown Cartel',
                    tag: w.attacker_tag || '???'
                },
                defender: w.defender_cartel_id
                    ? {
                        id: w.defender_cartel_id,
                        name: w.defender_name || 'Unknown Cartel',
                        tag: w.defender_tag || '???'
                    }
                    : { id: null, name: 'Unclaimed', tag: null },
                attackerScore: w.attacker_score || 0,
                defenderScore: w.defender_score || 0,
                startedAt: w.started_at,
                endsAt: w.ends_at,
                // Mark if player's cartel is involved
                isOurs: w.attacker_cartel_id === playerCartelId || w.defender_cartel_id === playerCartelId
            }))
        });

    } catch (error) {
        logger.error('[Territories] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed to load territories', code: 'ERROR' });
    }
});

/**
 * POST /territories/:id/attack
 * Start a turf war for a territory
 */
router.post('/:id/attack', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const territoryId = parseInt(req.params.id, 10);
        const playerId = req.player.id;

        await conn.beginTransaction();

        // Get player's cartel
        const [[membership]] = await conn.execute(
            `SELECT cm.*, c.id as cartel_id, c.name as cartel_name, c.level as cartel_level, c.cash_bank
             FROM cfx_cartel_members cm
             JOIN cfx_cartels c ON cm.cartel_id = c.id
             WHERE cm.player_id = ? AND cm.status = 'active'`,
            [playerId]
        );

        if (!membership) {
            await conn.rollback();
            return res.status(400).json({ error: 'You must be in a cartel to attack territories', code: 'NO_CARTEL' });
        }

        if (membership.role !== 'leader' && membership.role !== 'officer') {
            await conn.rollback();
            return res.status(403).json({ error: 'Only leaders and officers can start wars', code: 'INSUFFICIENT_RANK' });
        }

        // Get territory
        const [[territory]] = await conn.execute(
            `SELECT t.*, tc.cartel_id as current_controller
             FROM cfx_territories t
             LEFT JOIN cfx_territory_control tc ON t.id = tc.territory_id
             WHERE t.id = ? AND t.is_active = TRUE`,
            [territoryId]
        );

        if (!territory) {
            await conn.rollback();
            return res.status(404).json({ error: 'Territory not found', code: 'NOT_FOUND' });
        }

        if (territory.current_controller === membership.cartel_id) {
            await conn.rollback();
            return res.status(400).json({ error: 'Your cartel already controls this territory', code: 'ALREADY_OWNED' });
        }

        // Check for existing war on this territory
        const [[existingWar]] = await conn.execute(
            `SELECT id FROM cfx_turf_wars WHERE territory_id = ? AND status = 'active'`,
            [territoryId]
        );

        if (existingWar) {
            await conn.rollback();
            return res.status(400).json({ error: 'Territory is already contested', code: 'ALREADY_CONTESTED' });
        }

        // Check cartel cooldown
        const [[recentWar]] = await conn.execute(
            `SELECT id FROM cfx_turf_wars
             WHERE attacker_cartel_id = ? AND ended_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
            [membership.cartel_id]
        );

        if (recentWar) {
            await conn.rollback();
            return res.status(400).json({ error: 'Your cartel must wait before starting another war', code: 'COOLDOWN' });
        }

        // War cost: 10000 * cartel level
        const warCost = 10000 * (membership.cartel_level || 1);
        if (membership.cash_bank < warCost) {
            await conn.rollback();
            return res.status(400).json({
                error: `Insufficient cartel funds. Need $${warCost.toLocaleString()}`,
                code: 'INSUFFICIENT_FUNDS'
            });
        }

        // Deduct war cost
        await conn.execute(
            'UPDATE cfx_cartels SET cash_bank = cash_bank - ? WHERE id = ?',
            [warCost, membership.cartel_id]
        );

        // Create the war (lasts 24 hours)
        const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const [warResult] = await conn.execute(
            `INSERT INTO cfx_turf_wars
             (territory_id, attacker_cartel_id, defender_cartel_id, status, ends_at)
             VALUES (?, ?, ?, 'active', ?)`,
            [territoryId, membership.cartel_id, territory.current_controller, endsAt]
        );

        await conn.commit();

        logger.info('[Territories] War started', {
            warId: warResult.insertId,
            territoryId,
            attacker: membership.cartel_name,
            defender: territory.current_controller
        });

        res.json({
            success: true,
            message: `War declared on ${territory.name}!`,
            warId: warResult.insertId,
            endsAt,
            cost: warCost
        });

    } catch (error) {
        await conn.rollback();
        logger.error('[Territories] Attack failed', { error: error.message });
        res.status(500).json({ error: 'Failed to start war', code: 'ERROR' });
    } finally {
        conn.release();
    }
});

/**
 * POST /territories/wars/:warId/contribute
 * Contribute to a turf war (earn points for your cartel)
 */
router.post('/wars/:warId/contribute', async (req, res) => {
    try {
        const warId = parseInt(req.params.warId, 10);
        const playerId = req.player.id;
        const { contributionType } = req.body; // 'cash', 'actions', etc.
        let { amount } = req.body;

        // Get player's cartel
        const [[membership]] = await pool.execute(
            `SELECT cm.cartel_id FROM cfx_cartel_members cm
             WHERE cm.player_id = ? AND cm.status = 'active'`,
            [playerId]
        );

        if (!membership) {
            return res.status(400).json({ error: 'You must be in a cartel', code: 'NO_CARTEL' });
        }

        // Get war
        const [[war]] = await pool.execute(
            `SELECT * FROM cfx_turf_wars WHERE id = ? AND status = 'active'`,
            [warId]
        );

        if (!war) {
            return res.status(404).json({ error: 'War not found or ended', code: 'NOT_FOUND' });
        }

        // Determine if player is attacker or defender
        const isAttacker = war.attacker_cartel_id === membership.cartel_id;
        const isDefender = war.defender_cartel_id === membership.cartel_id;

        if (!isAttacker && !isDefender) {
            return res.status(400).json({ error: 'Your cartel is not involved in this war', code: 'NOT_INVOLVED' });
        }

        // Per-player contribution limits: 500 points per war per day, 5 min cooldown between contributions
        const DAILY_POINT_CAP = 500;
        const CONTRIBUTION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

        const [[playerWarStats]] = await pool.execute(
            `SELECT COALESCE(SUM(points), 0) as total_today,
                    MAX(created_at) as last_contribution
             FROM cfx_turf_war_contributions
             WHERE war_id = ? AND player_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
            [warId, playerId]
        );

        const todayPoints = playerWarStats?.total_today || 0;
        const lastContribution = playerWarStats?.last_contribution ? new Date(playerWarStats.last_contribution) : null;
        // Also get the most recent contribution across all wars for cooldown
        const [[recentContrib]] = await pool.execute(
            `SELECT MAX(created_at) as last_at FROM cfx_turf_war_contributions
             WHERE player_id = ? ORDER BY created_at DESC LIMIT 1`,
            [playerId]
        );
        const lastAnyContribution = recentContrib?.last_at ? new Date(recentContrib.last_at) : null;

        if (todayPoints >= DAILY_POINT_CAP) {
            return res.status(400).json({
                error: `Daily contribution limit reached (${DAILY_POINT_CAP} points). Resets in 24 hours.`,
                code: 'DAILY_LIMIT'
            });
        }

        const cooldownRef = lastAnyContribution || lastContribution;
        if (cooldownRef && (Date.now() - cooldownRef.getTime()) < CONTRIBUTION_COOLDOWN_MS) {
            const remaining = Math.ceil((CONTRIBUTION_COOLDOWN_MS - (Date.now() - cooldownRef.getTime())) / 60000);
            return res.status(400).json({
                error: `Cooldown active. Wait ${remaining} more minute(s).`,
                code: 'COOLDOWN'
            });
        }

        // Calculate points based on contribution
        let pointsEarned = 0;
        let cashToDeduct = 0;

        if (contributionType === 'cash') {
            // 1 point per $100 contributed
            const cashAmount = Math.max(0, parseInt(amount) || 0);
            pointsEarned = Math.floor(cashAmount / 100);
            cashToDeduct = cashAmount;

        } else if (contributionType === 'troops') {
            // Troops contribution - costs cash but earns more points
            const troopCost = 5000;
            const maxTroopsPerAction = 10;
            const troopsToSend = Math.min(maxTroopsPerAction, Math.max(1, parseInt(amount) || 1));
            cashToDeduct = troopCost * troopsToSend;
            // Each troop = 10 war points
            pointsEarned = troopsToSend * 10;

        } else if (contributionType === 'actions') {
            // Points from completing game actions (harvesting, selling, etc.)
            pointsEarned = Math.max(0, parseInt(amount) || 1);
        }

        if (pointsEarned < 1) {
            return res.status(400).json({ error: 'Invalid contribution', code: 'INVALID' });
        }

        // Clamp to remaining daily allowance
        const pointsRemaining = DAILY_POINT_CAP - todayPoints;
        if (pointsEarned > pointsRemaining) {
            pointsEarned = pointsRemaining;
            // Reduce cash to deduct proportionally for troops/cash
            if (contributionType === 'troops') {
                const actualTroops = Math.ceil(pointsEarned / 10);
                cashToDeduct = actualTroops * 5000;
            } else if (contributionType === 'cash') {
                cashToDeduct = pointsEarned * 100;
            }
        }

        // Atomic cash deduction: UPDATE with WHERE cash >= amount prevents race conditions
        if (cashToDeduct > 0) {
            const [deductResult] = await pool.execute(
                'UPDATE cfx_players SET cash = cash - ? WHERE id = ? AND cash >= ?',
                [cashToDeduct, playerId, cashToDeduct]
            );
            if (deductResult.affectedRows === 0) {
                return res.status(400).json({
                    error: `Insufficient funds. Need $${cashToDeduct.toLocaleString()}`,
                    code: 'INSUFFICIENT_FUNDS'
                });
            }
        }

        // Update war scores (scoreColumn is safe - derived from boolean, only 'attacker_score' or 'defender_score')
        const scoreColumn = isAttacker ? 'attacker_score' : 'defender_score';
        await pool.execute(
            `UPDATE cfx_turf_wars SET ${scoreColumn} = ${scoreColumn} + ? WHERE id = ?`,
            [pointsEarned, warId]
        );

        // Record individual contribution (separate rows for cooldown tracking)
        await pool.execute(
            `INSERT INTO cfx_turf_war_contributions (war_id, player_id, cartel_id, contribution_type, points)
             VALUES (?, ?, ?, ?, ?)`,
            [warId, playerId, membership.cartel_id, contributionType, pointsEarned]
        );

        res.json({
            success: true,
            pointsEarned,
            message: `Contributed ${pointsEarned} war points!`
        });

    } catch (error) {
        logger.error('[Territories] Contribution failed', { error: error.message });
        res.status(500).json({ error: 'Failed to contribute', code: 'ERROR' });
    }
});

/**
 * GET /territories/wars/:warId
 * Get detailed war status
 */
router.get('/wars/:warId', async (req, res) => {
    try {
        const warId = parseInt(req.params.warId, 10);

        const [[war]] = await pool.execute(
            `SELECT tw.*,
                    t.name as territory_name, t.bonus_type, t.bonus_value,
                    ac.name as attacker_name, ac.tag as attacker_tag,
                    dc.name as defender_name, dc.tag as defender_tag
             FROM cfx_turf_wars tw
             JOIN cfx_territories t ON tw.territory_id = t.id
             JOIN cfx_cartels ac ON tw.attacker_cartel_id = ac.id
             LEFT JOIN cfx_cartels dc ON tw.defender_cartel_id = dc.id
             WHERE tw.id = ?`,
            [warId]
        );

        if (!war) {
            return res.status(404).json({ error: 'War not found', code: 'NOT_FOUND' });
        }

        // Get top contributors
        const [contributors] = await pool.execute(
            `SELECT twc.*, p.display_name, c.name as cartel_name
             FROM cfx_turf_war_contributions twc
             JOIN cfx_players p ON twc.player_id = p.id
             JOIN cfx_cartels c ON twc.cartel_id = c.id
             WHERE twc.war_id = ?
             ORDER BY twc.points DESC
             LIMIT 10`,
            [warId]
        );

        res.json({
            success: true,
            war: {
                id: war.id,
                territory: {
                    id: war.territory_id,
                    name: war.territory_name,
                    bonusType: war.bonus_type,
                    bonusValue: parseFloat(war.bonus_value)
                },
                attacker: {
                    id: war.attacker_cartel_id,
                    name: war.attacker_name,
                    tag: war.attacker_tag,
                    score: war.attacker_score
                },
                defender: war.defender_cartel_id ? {
                    id: war.defender_cartel_id,
                    name: war.defender_name,
                    tag: war.defender_tag,
                    score: war.defender_score
                } : null,
                status: war.status,
                startedAt: war.started_at,
                endsAt: war.ends_at,
                winnerId: war.winner_cartel_id
            },
            topContributors: contributors.map(c => ({
                playerId: c.player_id,
                playerName: c.display_name,
                cartelName: c.cartel_name,
                points: c.points
            }))
        });

    } catch (error) {
        logger.error('[Territories] Get war failed', { error: error.message });
        res.status(500).json({ error: 'Failed to get war info', code: 'ERROR' });
    }
});

/**
 * Resolve ended wars (called by cron job)
 */
export async function resolveEndedWars() {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get ended wars
        const [endedWars] = await conn.execute(
            `SELECT * FROM cfx_turf_wars WHERE status = 'active' AND ends_at <= NOW()`
        );

        for (const war of endedWars) {
            // Determine winner (higher score wins, defender wins ties)
            let winnerId = null;
            if (war.attacker_score > war.defender_score) {
                winnerId = war.attacker_cartel_id;
            } else if (war.defender_cartel_id) {
                winnerId = war.defender_cartel_id;
            } else if (war.attacker_score >= war.control_points_required) {
                // Uncontested territory - attacker needs minimum points
                winnerId = war.attacker_cartel_id;
            }

            // Update war status
            await conn.execute(
                `UPDATE cfx_turf_wars SET status = 'ended', ended_at = NOW(), winner_cartel_id = ? WHERE id = ?`,
                [winnerId, war.id]
            );

            // Update territory control if attacker won
            if (winnerId === war.attacker_cartel_id) {
                // Remove old control
                await conn.execute('DELETE FROM cfx_territory_control WHERE territory_id = ?', [war.territory_id]);

                // Add new control
                await conn.execute(
                    'INSERT INTO cfx_territory_control (territory_id, cartel_id) VALUES (?, ?)',
                    [war.territory_id, winnerId]
                );

                logger.info('[Territories] Territory control changed', {
                    territoryId: war.territory_id,
                    newController: winnerId
                });
            }
        }

        await conn.commit();
        return endedWars.length;

    } catch (error) {
        await conn.rollback();
        logger.error('[Territories] War resolution failed', { error: error.message });
        throw error;
    } finally {
        conn.release();
    }
}

export default router;
