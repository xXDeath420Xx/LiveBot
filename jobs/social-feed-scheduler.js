import cron from 'node-cron';
import { checkRedditFeeds } from '../core/reddit-feed.js';
import { checkTwitterFeeds } from '../core/twitter-feed.js';
import { checkYouTubeFeeds } from '../core/youtube-feed.js';
import logger from '../utils/logger.js';

let generalScheduledTask = null;
let twitterScheduledTask = null;
let client = null;

/**
 * Start the social feed scheduler
 * General feeds (Reddit, YouTube): Every 15 minutes
 * Twitter feeds: Every 5 minutes (faster for real-time updates)
 * Supports multi-bot system - checks feeds for all bots
 */
function startSocialFeedScheduler(discordClient) {
    client = discordClient;

    if (generalScheduledTask || twitterScheduledTask) {
        logger.warn('[SocialFeedScheduler] Scheduler already running');
        return;
    }

    // Twitter - Run every 5 minutes for faster updates
    twitterScheduledTask = cron.schedule('*/5 * * * *', async () => {
        logger.info('[SocialFeedScheduler] Checking Twitter feeds for all bots...');
        await checkAllBotFeeds('twitter');
        logger.info('[SocialFeedScheduler] Twitter feed check completed');
    });

    // Reddit & YouTube - Run every 15 minutes
    generalScheduledTask = cron.schedule('*/15 * * * *', async () => {
        logger.info('[SocialFeedScheduler] Checking Reddit & YouTube feeds for all bots...');
        await checkAllBotFeeds('general');
        logger.info('[SocialFeedScheduler] Reddit & YouTube feed check completed');
    });

    logger.info('[SocialFeedScheduler] Social feed scheduler started');
    logger.info('[SocialFeedScheduler] - Twitter: every 5 minutes');
    logger.info('[SocialFeedScheduler] - Reddit/YouTube: every 15 minutes');
}

/**
 * Check feeds for all bots
 */
async function checkAllBotFeeds(type) {
    // Check feeds for default bot
    const defaultClient = global.botManager?.getDefaultClient() || client;
    if (defaultClient) {
        try {
            if (type === 'twitter') {
                await checkTwitterFeeds(defaultClient);
            } else {
                await Promise.allSettled([
                    checkRedditFeeds(defaultClient),
                    checkYouTubeFeeds(defaultClient)
                ]);
            }
        } catch (error) {
            logger.error(`[SocialFeedScheduler] Error during ${type} feed check (default bot):`, error);
        }
    }

    // Check feeds for all custom bots
    if (global.botManager?.clients) {
        for (const [botId, botClient] of global.botManager.clients.entries()) {
            if (botId === 'default') continue;

            try {
                if (type === 'twitter') {
                    await checkTwitterFeeds(botClient);
                } else {
                    await Promise.allSettled([
                        checkRedditFeeds(botClient),
                        checkYouTubeFeeds(botClient)
                    ]);
                }
            } catch (error) {
                logger.error(`[SocialFeedScheduler] Error during ${type} feed check (bot ${botId}):`, error, { botId });
            }
        }
    }
}

/**
 * Stop the social feed scheduler
 */
function stopSocialFeedScheduler() {
    if (generalScheduledTask) {
        generalScheduledTask.stop();
        generalScheduledTask = null;
    }
    if (twitterScheduledTask) {
        twitterScheduledTask.stop();
        twitterScheduledTask = null;
    }
    logger.info('[SocialFeedScheduler] Social feed scheduler stopped');
}

/**
 * Manually trigger a Twitter feed check (for testing)
 */
async function triggerTwitterCheck() {
    logger.info('[SocialFeedScheduler] Manual Twitter check triggered');
    await checkAllBotFeeds('twitter');
}

export { startSocialFeedScheduler, stopSocialFeedScheduler, triggerTwitterCheck };
