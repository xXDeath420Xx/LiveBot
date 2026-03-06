import cron from 'node-cron';
import logger from '../utils/logger.js';

let scheduledTask = null;

/**
 * Start the server stats scheduler
 * Takes daily snapshots of server statistics
 * @param {Client} client - Discord client instance
 */
export function startServerStatsScheduler(client) {
  if (scheduledTask) {
    logger.info('[ServerStatsScheduler] Scheduler already running');
    return;
  }

  // Run daily at 1 AM to take server snapshots
  scheduledTask = cron.schedule('0 1 * * *', async () => {
    logger.info('[ServerStatsScheduler] Taking daily server snapshots');

    try {
      if (!client.serverStatsManager) {
        logger.warn('[ServerStatsScheduler] ServerStatsManager not initialized');
        return;
      }

      let snapshotCount = 0;

      // Take a snapshot for each guild the bot is in
      for (const guild of client.guilds.cache.values()) {
        try {
          await client.serverStatsManager.takeSnapshot(guild);
          snapshotCount++;
          logger.debug(`[ServerStatsScheduler] Snapshot taken for guild ${guild.id} (${guild.name})`);
        } catch (error) {
          logger.error(`[ServerStatsScheduler] Error taking snapshot for guild ${guild.id}`, {
            error: error.message,
            stack: error.stack,
            guildId: guild.id,
            guildName: guild.name
          });
        }
      }

      logger.info(`[ServerStatsScheduler] Completed daily snapshots - ${snapshotCount} guild(s) processed`);
    } catch (error) {
      logger.error('[ServerStatsScheduler] Error taking server snapshots', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  logger.info('[ServerStatsScheduler] Scheduler started (runs daily at 1 AM)');
  scheduledTask.start();
}

/**
 * Stop the server stats scheduler
 */
export function stopServerStatsScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[ServerStatsScheduler] Scheduler stopped');
  }
}
