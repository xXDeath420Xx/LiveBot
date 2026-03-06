import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let scheduledTask = null;

/**
 * Start the pet stat decay scheduler
 * Decreases pet hunger, energy, and happiness over time
 * @param {Client} client - Discord client instance
 */
export function startPetStatDecayScheduler(client) {
  if (scheduledTask) {
    logger.info('[PetStatDecayScheduler] Scheduler already running');
    return;
  }

  // Run every 6 hours to decay pet stats
  scheduledTask = cron.schedule('0 */6 * * *', async () => {
    logger.info('[PetStatDecayScheduler] Decaying pet stats');

    try {
      // Decrease hunger (pets get more hungry over time)
      // Hunger increases by 10 every 6 hours (max 100)
      await pool.execute(
        `UPDATE user_pets
         SET hunger = LEAST(hunger + 10, 100)
         WHERE hunger < 100`
      );

      // Decrease energy (pets get tired over time)
      // Energy decreases by 15 every 6 hours (min 0)
      await pool.execute(
        `UPDATE user_pets
         SET energy = GREATEST(energy - 15, 0)
         WHERE energy > 0`
      );

      // Decrease happiness based on hunger and energy
      // If pet is very hungry (hunger > 80) or very tired (energy < 20), happiness decreases faster
      await pool.execute(
        `UPDATE user_pets
         SET happiness = GREATEST(
           CASE
             WHEN hunger > 80 OR energy < 20 THEN happiness - 15
             WHEN hunger > 50 OR energy < 50 THEN happiness - 10
             ELSE happiness - 5
           END,
           0
         )
         WHERE happiness > 0`
      );

      // Get stats on how many pets were affected
      const [[stats]] = await pool.execute(
        `SELECT
           COUNT(*) as total_pets,
           AVG(hunger) as avg_hunger,
           AVG(energy) as avg_energy,
           AVG(happiness) as avg_happiness
         FROM user_pets`
      );

      logger.info('[PetStatDecayScheduler] Pet stats decayed', {
        totalPets: stats?.total_pets || 0,
        avgHunger: Math.round(stats?.avg_hunger || 0),
        avgEnergy: Math.round(stats?.avg_energy || 0),
        avgHappiness: Math.round(stats?.avg_happiness || 0)
      });
    } catch (error) {
      logger.error('[PetStatDecayScheduler] Error decaying pet stats', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  logger.info('[PetStatDecayScheduler] Scheduler started (runs every 6 hours)');
  scheduledTask.start();
}

/**
 * Stop the pet stat decay scheduler
 */
export function stopPetStatDecayScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[PetStatDecayScheduler] Scheduler stopped');
  }
}
