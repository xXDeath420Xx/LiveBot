import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { postQOTD, shouldPost } from '../core/qotd-poster.js';

let schedulerTask = null;

/**
 * Start the QOTD scheduler
 * Checks every 5 minutes if any channels need to post
 */
export function startQOTDScheduler(client) {
    if (schedulerTask) {
        logger.warn('[QOTD Scheduler] Scheduler already running');
        return;
    }

    // Run every 5 minutes
    schedulerTask = cron.schedule('*/5 * * * *', async () => {
        logger.debug('[QOTD Scheduler] Running scheduled check');

        try {
            // Get all enabled QOTD channels
            const [channels] = await pool.execute(`
                SELECT * FROM qotd_channels
                WHERE enabled = 1 AND active_deck_id IS NOT NULL
            `);

            if (channels.length === 0) {
                logger.debug('[QOTD Scheduler] No enabled channels found');
                return;
            }

            logger.info(`[QOTD Scheduler] Checking ${channels.length} channel(s)`);

            for (const channelConfig of channels) {
                try {
                    // Check if this channel should post based on schedule
                    if (shouldPost(channelConfig)) {
                        logger.info('[QOTD Scheduler] Posting to channel', {
                            channelId: channelConfig.channel_id,
                            guildId: channelConfig.guild_id
                        });

                        // Get appropriate client (default or custom bot)
                        let botClient = client;
                        if (global.botManager && channelConfig.guild_id) {
                            const botId = global.botManager.guildBotMapping.get(channelConfig.guild_id);
                            if (botId) {
                                botClient = global.botManager.clients.get(botId) || client;
                            }
                        }

                        const result = await postQOTD(botClient, channelConfig);

                        if (result.success) {
                            logger.info('[QOTD Scheduler] Posted successfully', {
                                channelId: channelConfig.channel_id,
                                messageId: result.messageId
                            });
                        } else {
                            logger.error('[QOTD Scheduler] Failed to post', {
                                channelId: channelConfig.channel_id,
                                error: result.error
                            });
                        }
                    } else {
                        logger.debug('[QOTD Scheduler] Channel not ready to post', {
                            channelId: channelConfig.channel_id,
                            scheduleType: channelConfig.schedule_type,
                            lastPosted: channelConfig.last_posted_at
                        });
                    }

                    // Small delay between posts to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (error) {
                    logger.error('[QOTD Scheduler] Error processing channel', {
                        channelId: channelConfig.channel_id,
                        error: error.message,
                        stack: error.stack
                    });
                }
            }

        } catch (error) {
            logger.error('[QOTD Scheduler] Error in scheduler', {
                error: error.message,
                stack: error.stack
            });
        }
    });

    logger.info('[QOTD Scheduler] Scheduler started (every 5 minutes)');
}

/**
 * Stop the QOTD scheduler
 */
export function stopQOTDScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[QOTD Scheduler] Scheduler stopped');
    }
}
