const { Worker } = require('bullmq');
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { redisOptions } = require('../utils/cache'); // Import redisOptions
const db = require('../utils/db');
const logger = require('../utils/logger');
const { checkRedditFeeds } = require('../core/reddit-feed');
const { checkTwitterFeeds } = require('../core/twitter-feed');

const workerClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.Channel]
});

logger.init(workerClient, db);

const socialFeedWorker = new Worker('social-feeds', async job => {
    if (!workerClient.isReady()) {
        throw new Error("Discord client not ready");
    }

    if (job.name === 'check-social-feeds') {
        logger.info('[SocialFeedWorker] Checking for new posts from Reddit and Twitter.');
        try {
            await checkRedditFeeds();
            await checkTwitterFeeds();
        } catch (error) {
            logger.error('[SocialFeedWorker] Error during social feed check:', error);
        }
    }
}, { connection: redisOptions }); // Use redisOptions here

workerClient.login(process.env.DISCORD_TOKEN).catch(err => {
    logger.error("[SocialFeedWorker] Failed to log in.", { error: err });
    process.exit(1);
});

logger.info('[Social Feed Worker] BullMQ Worker for social feeds is active.');