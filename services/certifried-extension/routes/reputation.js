/**
 * Reputation Routes
 * Faction-based reputation system with tiered perks
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /reputation
 * Get player's reputation with all factions
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Get all factions with player's reputation
        const [factions] = await pool.execute(`
            SELECT
                f.*,
                COALESCE(pr.reputation, 0) as reputation,
                COALESCE(pr.current_tier, 0) as current_tier,
                COALESCE(pr.total_earned, 0) as total_earned
            FROM cfx_factions f
            LEFT JOIN cfx_player_reputation pr ON f.id = pr.faction_id AND pr.player_id = ?
            WHERE f.is_active = TRUE
            ORDER BY f.name
        `, [playerId]);

        // Get all tiers
        const [allTiers] = await pool.execute(`
            SELECT * FROM cfx_reputation_tiers ORDER BY faction_id, tier_level
        `);

        // Group tiers by faction
        const tiersByFaction = {};
        for (const tier of allTiers) {
            if (!tiersByFaction[tier.faction_id]) {
                tiersByFaction[tier.faction_id] = [];
            }
            tiersByFaction[tier.faction_id].push(tier);
        }

        // Process factions
        const processedFactions = factions.map(faction => {
            const tiers = tiersByFaction[faction.id] || [];
            const currentTier = tiers.find(t => t.tier_level === faction.current_tier);
            const nextTier = tiers.find(t => t.tier_level === faction.current_tier + 1);

            let perks = {};
            try {
                perks = currentTier?.perks ? JSON.parse(currentTier.perks) : {};
            } catch (e) {
                perks = {};
            }

            return {
                id: faction.id,
                key: faction.faction_key,
                name: faction.name,
                description: faction.description,
                icon: faction.icon,
                reputation: faction.reputation,
                totalEarned: faction.total_earned,
                currentTier: {
                    level: faction.current_tier,
                    name: currentTier?.name || 'Unknown',
                    icon: currentTier?.icon || '',
                    perks
                },
                nextTier: nextTier ? {
                    level: nextTier.tier_level,
                    name: nextTier.name,
                    repRequired: nextTier.rep_required,
                    progress: Math.min(100, Math.round((faction.reputation / nextTier.rep_required) * 100))
                } : null,
                tiers: tiers.map(t => {
                    let tierPerks = {};
                    try {
                        tierPerks = t.perks ? JSON.parse(t.perks) : {};
                    } catch (e) {
                        tierPerks = {};
                    }
                    return {
                        level: t.tier_level,
                        name: t.name,
                        repRequired: t.rep_required,
                        icon: t.icon,
                        perks: tierPerks,
                        isUnlocked: faction.reputation >= t.rep_required
                    };
                })
            };
        });

        res.json({
            success: true,
            factions: processedFactions
        });
    } catch (error) {
        logger.error('[Reputation] Error loading:', error);
        res.status(500).json({ success: false, error: 'Failed to load reputation' });
    }
});

/**
 * GET /reputation/:factionKey
 * Get detailed info for a specific faction
 */
router.get('/:factionKey', async (req, res) => {
    try {
        const playerId = req.player.id;
        const factionKey = req.params.factionKey;

        // Get faction
        const [factionRows] = await pool.execute(`
            SELECT
                f.*,
                COALESCE(pr.reputation, 0) as reputation,
                COALESCE(pr.current_tier, 0) as current_tier,
                COALESCE(pr.total_earned, 0) as total_earned,
                pr.last_action_at
            FROM cfx_factions f
            LEFT JOIN cfx_player_reputation pr ON f.id = pr.faction_id AND pr.player_id = ?
            WHERE f.faction_key = ? AND f.is_active = TRUE
        `, [playerId, factionKey]);

        if (factionRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Faction not found' });
        }

        const faction = factionRows[0];

        // Get all tiers for this faction
        const [tiers] = await pool.execute(`
            SELECT * FROM cfx_reputation_tiers WHERE faction_id = ? ORDER BY tier_level
        `, [faction.id]);

        res.json({
            success: true,
            faction: {
                id: faction.id,
                key: faction.faction_key,
                name: faction.name,
                description: faction.description,
                icon: faction.icon,
                reputation: faction.reputation,
                totalEarned: faction.total_earned,
                currentTier: faction.current_tier,
                lastActionAt: faction.last_action_at,
                tiers: tiers.map(t => {
                    let perks = {};
                    try {
                        perks = t.perks ? JSON.parse(t.perks) : {};
                    } catch (e) {
                        perks = {};
                    }
                    return {
                        level: t.tier_level,
                        name: t.name,
                        repRequired: t.rep_required,
                        icon: t.icon,
                        perks,
                        isUnlocked: faction.reputation >= t.rep_required
                    };
                })
            }
        });
    } catch (error) {
        logger.error('[Reputation] Error loading faction:', error);
        res.status(500).json({ success: false, error: 'Failed to load faction' });
    }
});

/**
 * Helper: Award reputation to a player
 * Called from other game systems when certain actions are performed
 */
export async function awardReputation(playerId, factionKey, amount, reason = null) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Get faction
        const [factionRows] = await conn.execute(`
            SELECT id FROM cfx_factions WHERE faction_key = ? AND is_active = TRUE
        `, [factionKey]);

        if (factionRows.length === 0) {
            await conn.rollback();
            return { success: false, error: 'Faction not found' };
        }

        const factionId = factionRows[0].id;

        // Upsert reputation
        await conn.execute(`
            INSERT INTO cfx_player_reputation (player_id, faction_id, reputation, total_earned, last_action_at)
            VALUES (?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                reputation = reputation + VALUES(reputation),
                total_earned = total_earned + VALUES(reputation),
                last_action_at = NOW()
        `, [playerId, factionId, amount, amount]);

        // Get updated reputation and check for tier up
        const [repRows] = await conn.execute(`
            SELECT pr.*, rt.tier_level, rt.name as tier_name
            FROM cfx_player_reputation pr
            LEFT JOIN cfx_reputation_tiers rt ON rt.faction_id = pr.faction_id
                AND rt.rep_required <= pr.reputation
            WHERE pr.player_id = ? AND pr.faction_id = ?
            ORDER BY rt.tier_level DESC
            LIMIT 1
        `, [playerId, factionId]);

        let tierUp = false;
        let newTierName = null;

        if (repRows.length > 0 && repRows[0].tier_level !== null) {
            const currentDbTier = repRows[0].current_tier || 0;
            const earnedTier = repRows[0].tier_level;

            if (earnedTier > currentDbTier) {
                // Tier up!
                await conn.execute(`
                    UPDATE cfx_player_reputation SET current_tier = ? WHERE player_id = ? AND faction_id = ?
                `, [earnedTier, playerId, factionId]);
                tierUp = true;
                newTierName = repRows[0].tier_name;
            }
        }

        await conn.commit();

        return {
            success: true,
            amount,
            newReputation: repRows[0]?.reputation || amount,
            tierUp,
            newTierName
        };
    } catch (error) {
        await conn.rollback();
        logger.error('[Reputation] Error awarding:', error);
        return { success: false, error: 'Failed to award reputation' };
    } finally {
        conn.release();
    }
}

/**
 * Helper: Get reputation bonuses for a player
 */
export async function getReputationBonuses(playerId) {
    const [rows] = await pool.execute(`
        SELECT f.faction_key, rt.perks
        FROM cfx_player_reputation pr
        JOIN cfx_factions f ON pr.faction_id = f.id
        JOIN cfx_reputation_tiers rt ON rt.faction_id = pr.faction_id AND rt.tier_level = pr.current_tier
        WHERE pr.player_id = ? AND pr.current_tier > 0
    `, [playerId]);

    const bonuses = {};

    for (const row of rows) {
        try {
            const perks = JSON.parse(row.perks || '{}');
            for (const [key, value] of Object.entries(perks)) {
                if (typeof value === 'number') {
                    if (!bonuses[key]) bonuses[key] = 0;
                    bonuses[key] += value;
                } else if (typeof value === 'boolean' && value) {
                    bonuses[key] = true;
                }
            }
        } catch (e) {
            // Skip invalid perks
        }
    }

    return bonuses;
}

/**
 * Reputation actions mapping - which actions give rep to which factions
 */
export const REPUTATION_ACTIONS = {
    harvest: { faction: 'growers_guild', baseAmount: 1 },
    breed_success: { faction: 'research_collective', baseAmount: 10 },
    mutation_discover: { faction: 'research_collective', baseAmount: 25 },
    market_sell: { faction: 'traders_union', baseAmount: 1 },
    black_market_sell: { faction: 'shadow_syndicate', baseAmount: 5 },
    contract_complete: { faction: 'traders_union', baseAmount: 15 },
    raid_defend: { faction: 'enforcement_division', baseAmount: 20 },
    extraction_complete: { faction: 'research_collective', baseAmount: 5 },
    quality_milestone: { faction: 'growers_guild', baseAmount: 10 }
};

export default router;
