import cron from 'node-cron';
import logger from '../utils/logger.js';

/**
 * VC Sound Drop Scheduler
 * Handles both random interval drops and scheduled time drops.
 * Runs every minute, checks which guilds are due for a drop.
 * Supports multi-bot system.
 */

let vcSoundTask = null;

/**
 * Start the VC sound drop scheduler
 */
export function startVCSoundScheduler(vcSoundManager) {
    if (!vcSoundManager) {
        logger.warn('[VCSoundScheduler] VC sound manager not provided, scheduler not started');
        return;
    }

    if (vcSoundTask) {
        logger.warn('[VCSoundScheduler] VC sound scheduler already running');
        return;
    }

    // Run every minute to check for due drops
    vcSoundTask = cron.schedule('* * * * *', async () => {
        try {
            const enabledGuilds = await vcSoundManager.getEnabledGuilds();
            if (enabledGuilds.length === 0) return;

            const now = new Date();
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

            for (const config of enabledGuilds) {
                try {
                    const mode = config.mode || 'random';

                    // Handle scheduled drops
                    if (mode === 'scheduled' || mode === 'both') {
                        const scheduleTimes = config.schedule_times || [];
                        if (scheduleTimes.includes(currentTimeStr)) {
                            logger.info(`[VCSoundScheduler] Scheduled drop triggered for guild ${config.guild_id} at ${currentTimeStr}`);
                            await vcSoundManager.executeDrop(config.guild_id);
                            continue; // Don't also do random on the same tick
                        }
                    }

                    // Handle random drops
                    if (mode === 'random' || mode === 'both') {
                        if (!vcSoundManager.canDrop(config.guild_id, config)) continue;

                        // Random chance each minute based on interval settings
                        // Average interval = (min + max) / 2 minutes
                        // Probability per minute = 1 / average_interval
                        const minInterval = config.min_interval_minutes || 30;
                        const maxInterval = config.max_interval_minutes || 120;
                        const avgInterval = (minInterval + maxInterval) / 2;
                        const probability = 1 / avgInterval;

                        if (Math.random() < probability) {
                            logger.info(`[VCSoundScheduler] Random drop triggered for guild ${config.guild_id} (probability: ${(probability * 100).toFixed(1)}%)`);
                            await vcSoundManager.executeDrop(config.guild_id);
                        }
                    }
                } catch (error) {
                    logger.error(`[VCSoundScheduler] Error processing guild ${config.guild_id}:`, {
                        error: error.message,
                        stack: error.stack
                    });
                }
            }
        } catch (error) {
            logger.error('[VCSoundScheduler] Error in scheduler tick:', {
                error: error.message,
                stack: error.stack
            });
        }
    });

    logger.info('[VCSoundScheduler] VC sound scheduler started (checks every minute, multi-bot support)');

    // Register default sounds on startup
    setTimeout(async () => {
        try {
            await vcSoundManager.registerDefaultSounds();
        } catch (error) {
            logger.error('[VCSoundScheduler] Error registering default sounds:', error);
        }
    }, 3000);

    return vcSoundTask;
}

/**
 * Stop the VC sound drop scheduler
 */
export function stopVCSoundScheduler() {
    if (vcSoundTask) {
        vcSoundTask.stop();
        vcSoundTask = null;
        logger.info('[VCSoundScheduler] VC sound scheduler stopped');
    }
}

export default { startVCSoundScheduler, stopVCSoundScheduler };
