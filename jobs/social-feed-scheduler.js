const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Queue } = require('bullmq');
const { redisOptions } = require('../utils/cache');
const logger = require('../utils/logger');

const socialQueue = new Queue('social-feeds', { connection: redisOptions });

async function scheduleSocialFeedChecks() {
    const repeatableJobs = await socialQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await socialQueue.removeRepeatableByKey(job.key);
    }

    await socialQueue.add('check-social-feeds', {}, {
        repeat: {
            every: 5 * 60 * 1000, // Every 5 minutes
        },
        removeOnComplete: true,
        removeOnFail: true,
    });
    logger.info('[SocialFeedScheduler] Social feed check job scheduled to run every 5 minutes.');
}

module.exports = { scheduleSocialFeedChecks };