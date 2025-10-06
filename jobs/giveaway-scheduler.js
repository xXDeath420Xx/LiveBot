const { Queue } = require('bullmq');
const Redis = require('ioredis');
require('dotenv').config();

const redisClient = new Redis(process.env.REDIS_URL);
const systemQueue = new Queue('system-tasks', { connection: redisClient });

async function scheduleGiveawayChecks() {
    await systemQueue.removeRepeatable('check-giveaways');
    await systemQueue.add('check-giveaways', {}, {
        repeat: { every: 15 * 1000 }, // Every 15 seconds
        jobId: 'check-giveaways'
    });
    console.log('[GiveawayScheduler] Giveaway check job scheduled to run every 15 seconds.');
}

scheduleGiveawayChecks().catch(console.error);