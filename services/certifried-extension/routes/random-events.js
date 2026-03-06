/**
 * Random Events Routes
 * Dynamic events that affect gameplay
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { awardCash, awardXp, deductCash } from '../game/engine.js';

const router = Router();

/**
 * GET /random-events/active
 * Get player's active random events
 */
router.get('/active', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get active events
        const [events] = await pool.execute(`
            SELECT pe.*, re.name, re.description, re.event_type, re.effect_type,
                   re.effect_value, re.duration_minutes, re.icon
            FROM cfx_player_events pe
            JOIN cfx_random_events re ON pe.event_id = re.id
            WHERE pe.player_id = ?
            AND pe.resolved = FALSE
            AND (pe.expires_at IS NULL OR pe.expires_at > NOW())
            ORDER BY pe.triggered_at DESC
        `, [playerId]);

        res.json({
            success: true,
            events: events.map(e => ({
                id: e.id,
                eventId: e.event_id,
                name: e.name,
                description: e.description,
                eventType: e.event_type,
                effectType: e.effect_type,
                effectValue: parseFloat(e.effect_value),
                icon: e.icon,
                triggeredAt: e.triggered_at,
                expiresAt: e.expires_at,
                requiresChoice: e.event_type === 'choice' && !e.outcome
            }))
        });
    } catch (error) {
        logger.error('[RandomEvents] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load events' });
    }
});

/**
 * POST /random-events/:id/resolve
 * Resolve an event (for choice events)
 */
router.post('/:id/resolve', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const playerId = req.player.id;
        const eventId = parseInt(req.params.id, 10);
        const { choice } = req.body; // 'accept' or 'decline'

        await conn.beginTransaction();

        // Get player event
        const [eventRows] = await conn.execute(`
            SELECT pe.*, re.name, re.event_type, re.effect_type, re.effect_value
            FROM cfx_player_events pe
            JOIN cfx_random_events re ON pe.event_id = re.id
            WHERE pe.id = ? AND pe.player_id = ? AND pe.resolved = FALSE
        `, [eventId, playerId]);

        if (eventRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Event not found' });
        }

        const event = eventRows[0];

        if (event.event_type !== 'choice') {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Event does not require a choice' });
        }

        let outcomeMessage = '';
        let outcomeValue = 0;

        // Determine outcome first, then mark as resolved in transaction
        let pendingCashAward = 0;
        let pendingCashDeduct = 0;
        let pendingXpAward = 0;

        if (choice === 'accept') {
            // Risky choice - random outcome
            const roll = Math.random();

            switch (event.effect_type) {
                case 'risky_deal':
                    if (roll < 0.4) {
                        // Bad outcome - lose some cash
                        const loss = Math.floor(Math.random() * 5000) + 1000;
                        pendingCashDeduct = loss;
                        outcomeMessage = `The deal went bad! Lost $${loss.toLocaleString()}`;
                        outcomeValue = -loss;
                    } else {
                        // Good outcome - gain cash
                        const gain = Math.floor(Math.random() * 15000) + 5000;
                        pendingCashAward = gain;
                        outcomeMessage = `Great deal! Gained $${gain.toLocaleString()}`;
                        outcomeValue = gain;
                    }
                    break;

                case 'research_choice':
                    if (roll < 0.3) {
                        outcomeMessage = 'The research hit a dead end. No benefit.';
                    } else {
                        const xpGain = Math.floor(Math.random() * 500) + 200;
                        pendingXpAward = xpGain;
                        outcomeMessage = `Research breakthrough! +${xpGain} XP`;
                        outcomeValue = xpGain;
                    }
                    break;

                case 'faction_choice':
                    if (roll < 0.5) {
                        // Heat gain
                        outcomeMessage = 'The cartel favor increased your heat by 10';
                        outcomeValue = 10;
                    } else {
                        // Cash gain
                        const reward = Math.floor(Math.random() * 10000) + 5000;
                        pendingCashAward = reward;
                        outcomeMessage = `Favor completed! +$${reward.toLocaleString()}`;
                        outcomeValue = reward;
                    }
                    break;

                default:
                    outcomeMessage = 'Event resolved';
            }
        } else {
            outcomeMessage = 'You declined the opportunity.';
            outcomeValue = 0;
        }

        // Mark as resolved
        await conn.execute(`
            UPDATE cfx_player_events
            SET resolved = TRUE, outcome = ?, outcome_value = ?
            WHERE id = ?
        `, [choice, outcomeValue, eventId]);

        await conn.commit();

        // Apply cash/xp awards using proper engine functions (after transaction)
        if (pendingCashAward > 0) {
            const result = await awardCash(playerId, pendingCashAward);
            outcomeValue = result.cashAwarded; // Update with actual amount after bonuses
        }
        if (pendingCashDeduct > 0) {
            await deductCash(playerId, pendingCashDeduct);
        }
        if (pendingXpAward > 0) {
            const result = await awardXp(playerId, pendingXpAward);
            outcomeValue = result.xpAwarded; // Update with actual amount after bonuses
        }

        res.json({
            success: true,
            message: outcomeMessage,
            outcome: choice,
            outcomeValue
        });
    } catch (error) {
        await conn.rollback();
        logger.error('[RandomEvents] Error resolving:', error);
        res.status(500).json({ success: false, error: 'Failed to resolve event' });
    } finally {
        conn.release();
    }
});

/**
 * POST /random-events/dismiss
 * Dismiss an expired or resolved event
 */
router.post('/dismiss', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { eventId } = req.body;

        await pool.execute(`
            UPDATE cfx_player_events
            SET resolved = TRUE
            WHERE id = ? AND player_id = ?
        `, [eventId, playerId]);

        res.json({
            success: true,
            message: 'Event dismissed'
        });
    } catch (error) {
        logger.error('[RandomEvents] Error dismissing:', error);
        res.status(500).json({ success: false, error: 'Failed to dismiss event' });
    }
});

/**
 * Helper: Roll for random events (called by game tick)
 */
export async function rollRandomEvent(playerId) {
    try {
        // Get player level
        const [playerRows] = await pool.execute(`
            SELECT level FROM cfx_players WHERE id = ?
        `, [playerId]);

        if (playerRows.length === 0) return null;
        const playerLevel = playerRows[0].level;

        // Get eligible events (not on cooldown)
        const [events] = await pool.execute(`
            SELECT re.* FROM cfx_random_events re
            WHERE re.is_active = TRUE
            AND re.min_level <= ?
            AND NOT EXISTS (
                SELECT 1 FROM cfx_player_events pe
                WHERE pe.event_id = re.id
                AND pe.player_id = ?
                AND pe.triggered_at > DATE_SUB(NOW(), INTERVAL re.cooldown_hours HOUR)
            )
        `, [playerLevel, playerId]);

        if (events.length === 0) return null;

        // Roll for each event
        for (const event of events) {
            const roll = Math.random();
            if (roll < event.base_chance) {
                // Trigger this event
                const expiresAt = event.duration_minutes
                    ? new Date(Date.now() + event.duration_minutes * 60 * 1000)
                    : null;

                await pool.execute(`
                    INSERT INTO cfx_player_events (player_id, event_id, expires_at)
                    VALUES (?, ?, ?)
                `, [playerId, event.id, expiresAt]);

                return {
                    name: event.name,
                    description: event.description,
                    eventType: event.event_type,
                    icon: event.icon
                };
            }
        }

        return null;
    } catch (error) {
        logger.error('[RandomEvents] Error rolling:', error);
        return null;
    }
}

/**
 * Helper: Get active event bonuses for a player
 */
export async function getEventBonuses(playerId) {
    const [rows] = await pool.execute(`
        SELECT re.effect_type, re.effect_value
        FROM cfx_player_events pe
        JOIN cfx_random_events re ON pe.event_id = re.id
        WHERE pe.player_id = ?
        AND pe.resolved = FALSE
        AND re.event_type IN ('positive', 'negative')
        AND (pe.expires_at IS NULL OR pe.expires_at > NOW())
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
