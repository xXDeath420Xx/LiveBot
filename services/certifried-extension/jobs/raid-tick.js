/**
 * Raid Tick Job
 * Periodically checks for and executes DEA raids
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import {
    calculateHeat,
    getHeatThreshold,
    checkRaidEligibility,
    executeRaid,
    getSecurityLevel,
    getRaidProtection
} from '../game/raid-system.js';

/**
 * Execute raid tick - processes all players eligible for raid checks
 */
export async function raidTick() {
    const startTime = Date.now();
    let playersChecked = 0;
    let raidsExecuted = 0;

    try {
        // Get all players with heat records that might need checking
        // Only check players who are level 5+, have some cash, and were active recently
        const [players] = await pool.execute(
            `SELECT p.id, p.level, p.cash, p.last_online_at,
                    h.current_heat, h.last_raid_check, h.raid_immunity_until
             FROM cfx_players p
             LEFT JOIN cfx_player_heat h ON p.id = h.player_id
             WHERE p.level >= 5
             AND p.cash >= 500
             AND p.last_online_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
             AND (h.raid_immunity_until IS NULL OR h.raid_immunity_until < NOW())
             AND (h.current_heat >= 25 OR h.current_heat IS NULL)`
        );

        logger.debug('[RaidTick] Found eligible players', { count: players.length });

        for (const player of players) {
            try {
                playersChecked++;

                // Calculate current heat (with decay applied)
                const currentHeat = await calculateHeat(player.id);
                const threshold = getHeatThreshold(currentHeat);

                // Skip if in cold zone (no raid risk)
                if (threshold.status === 'cold') {
                    continue;
                }

                // Check if enough time has passed since last check
                const lastCheck = player.last_raid_check ? new Date(player.last_raid_check) : null;
                const now = new Date();

                if (lastCheck && threshold.checkInterval) {
                    const timeSinceCheck = now - lastCheck;
                    if (timeSinceCheck < threshold.checkInterval) {
                        continue; // Not time for next check yet
                    }
                }

                // Update last check time
                await pool.execute(
                    'UPDATE cfx_player_heat SET last_raid_check = NOW() WHERE player_id = ?',
                    [player.id]
                );

                // Check eligibility
                const eligibility = await checkRaidEligibility(player.id);
                if (!eligibility.eligible) {
                    continue;
                }

                // Get security protection
                const securityLevel = await getSecurityLevel(player.id);
                const protection = getRaidProtection(securityLevel);

                // Calculate actual raid chance
                const actualChance = threshold.baseChance * (1 - protection.raidChanceReduction);

                // Roll for raid
                const roll = Math.random();

                logger.debug('[RaidTick] Raid check', {
                    playerId: player.id,
                    heat: currentHeat,
                    status: threshold.status,
                    baseChance: threshold.baseChance,
                    actualChance,
                    securityLevel,
                    roll,
                    raided: roll < actualChance
                });

                if (roll < actualChance) {
                    // Execute raid!
                    const result = await executeRaid(player.id);

                    if (result.success) {
                        raidsExecuted++;
                        logger.info('[RaidTick] Raid executed', {
                            playerId: player.id,
                            cashSeized: result.seizure.cashSeized,
                            itemsDestroyed: result.seizure.inventoryDestroyed,
                            plantsDestroyed: result.seizure.plantsDestroyed
                        });
                    }
                }

            } catch (playerError) {
                logger.error('[RaidTick] Player check failed', {
                    playerId: player.id,
                    error: playerError.message
                });
            }
        }

        const duration = Date.now() - startTime;
        if (playersChecked > 0 || raidsExecuted > 0) {
            logger.info('[RaidTick] Complete', {
                playersChecked,
                raidsExecuted,
                duration
            });
        }

    } catch (error) {
        logger.error('[RaidTick] Failed', {
            error: error.message,
            stack: error.stack
        });
    }
}

export default raidTick;
