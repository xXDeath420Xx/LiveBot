import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let scheduledTask = null;

/**
 * Start the habit tracker scheduler
 * Checks for broken streaks and resets them daily
 * @param {Client} client - Discord client instance
 */
export function startHabitTrackerScheduler(client) {
  if (scheduledTask) {
    logger.info('[HabitTrackerScheduler] Scheduler already running');
    return;
  }

  // Run daily at midnight to check for broken streaks
  scheduledTask = cron.schedule('0 0 * * *', async () => {
    logger.info('[HabitTrackerScheduler] Checking for broken habit streaks');

    try {
      // Get all habits that have a current streak
      const [habits] = await pool.execute(
        'SELECT * FROM habits WHERE streak > 0'
      );

      if (habits.length === 0) {
        logger.debug('[HabitTrackerScheduler] No active habit streaks found');
        return;
      }

      logger.info(`[HabitTrackerScheduler] Checking ${habits.length} habit(s) with active streaks`);

      let brokenStreaks = 0;

      for (const habit of habits) {
        try {
          // Check if habit was completed yesterday
          const [[completion]] = await pool.execute(
            `SELECT * FROM habit_completions
             WHERE habit_id = ? AND completed_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
            [habit.id]
          );

          // If habit was NOT completed yesterday, the streak is broken
          if (!completion) {
            await pool.execute(
              'UPDATE habits SET streak = 0 WHERE id = ?',
              [habit.id]
            );

            brokenStreaks++;

            logger.debug(`[HabitTrackerScheduler] Streak broken for habit ${habit.id} (${habit.habit_name})`);
          }
        } catch (error) {
          logger.error(`[HabitTrackerScheduler] Error checking habit ${habit.id}`, {
            error: error.message,
            stack: error.stack
          });
        }
      }

      logger.info(`[HabitTrackerScheduler] Completed habit check - ${brokenStreaks} streak(s) broken`);
    } catch (error) {
      logger.error('[HabitTrackerScheduler] Error checking habits', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  logger.info('[HabitTrackerScheduler] Scheduler started (runs daily at midnight)');
  scheduledTask.start();
}

/**
 * Stop the habit tracker scheduler
 */
export function stopHabitTrackerScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[HabitTrackerScheduler] Scheduler stopped');
  }
}
