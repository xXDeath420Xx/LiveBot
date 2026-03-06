/**
 * Growth Tick Job
 * Checks for ready plants and sends notifications
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { notifyPlayer } from '../ws/broadcaster.js';
import { isPlayerConnected } from '../ws/handler.js';

/**
 * Run growth tick
 */
export async function growthTick() {
    const start = Date.now();
    const now = new Date();

    // Find plants that just became ready (within last 10 seconds)
    const windowAgo = new Date(now.getTime() - 10000);

    const [readyPlants] = await pool.execute(
        `SELECT gs.player_id, gs.slot_number, s.name as strain_name, s.rarity
         FROM cfx_grow_slots gs
         JOIN cfx_strains s ON gs.strain_id = s.id
         WHERE gs.status = 'growing' AND gs.ready_at <= ? AND gs.ready_at > ?`,
        [now, windowAgo]
    );

    // Update status and notify
    for (const plant of readyPlants) {
        // Update status
        await pool.execute(
            `UPDATE cfx_grow_slots
             SET status = 'ready', wither_at = ?
             WHERE player_id = ? AND slot_number = ? AND status = 'growing'`,
            [new Date(now.getTime() + 2 * 60 * 60 * 1000), plant.player_id, plant.slot_number] // 2 hour wither
        );

        // Notify if online
        if (isPlayerConnected(plant.player_id)) {
            notifyPlayer(plant.player_id, 'plant_ready', {
                slotNumber: plant.slot_number,
                strainName: plant.strain_name,
                rarity: plant.rarity
            });
        }
    }

    // Find plants about to wither (within 10 minutes)
    const tenMinutes = 10 * 60 * 1000;

    const [witheringPlants] = await pool.execute(
        `SELECT gs.player_id, gs.slot_number, s.name as strain_name, gs.wither_at
         FROM cfx_grow_slots gs
         JOIN cfx_strains s ON gs.strain_id = s.id
         WHERE gs.status = 'ready' AND gs.wither_at IS NOT NULL
               AND gs.wither_at > ? AND gs.wither_at <= ?`,
        [now, new Date(now.getTime() + tenMinutes)]
    );

    // Notify about upcoming wither
    for (const plant of witheringPlants) {
        if (isPlayerConnected(plant.player_id)) {
            notifyPlayer(plant.player_id, 'plant_withering_soon', {
                slotNumber: plant.slot_number,
                strainName: plant.strain_name,
                witherAt: plant.wither_at,
                timeRemaining: new Date(plant.wither_at).getTime() - now.getTime()
            });
        }
    }

    // Check for breeding operations ready
    const [readyBreeding] = await pool.execute(
        `SELECT bo.player_id, bo.id as operation_id, s1.name as parent1_name, s2.name as parent2_name
         FROM cfx_breeding_operations bo
         JOIN cfx_strains s1 ON bo.parent_1_strain_id = s1.id
         JOIN cfx_strains s2 ON bo.parent_2_strain_id = s2.id
         WHERE bo.status = 'breeding' AND bo.ready_at <= ?`,
        [now]
    );

    for (const breed of readyBreeding) {
        // Update status
        await pool.execute(
            `UPDATE cfx_breeding_operations SET status = 'ready' WHERE id = ?`,
            [breed.operation_id]
        );

        if (isPlayerConnected(breed.player_id)) {
            notifyPlayer(breed.player_id, 'breeding_ready', {
                operationId: breed.operation_id,
                parent1Name: breed.parent1_name,
                parent2Name: breed.parent2_name
            });
        }
    }

    const notificationCount = readyPlants.length + witheringPlants.length + readyBreeding.length;
    if (notificationCount > 0) {
        logger.debug('[GrowthTick] Complete', {
            duration: Date.now() - start,
            readyPlants: readyPlants.length,
            withering: witheringPlants.length,
            breeding: readyBreeding.length
        });
    }
}

export default growthTick;
