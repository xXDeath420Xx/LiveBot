const { Queue } = require('bullmq');
const { redisOptions } = require('../utils/cache');

const systemQueue = new Queue('system-tasks', { connection: redisOptions });

async function scheduleGiveawayChecks() {
    await systemQueue.removeRepeatable('check-giveaways');
    await systemQueue.add('check-giveaways', {}, {
        repeat: { every: 15 * 1000 }, // Every 15 seconds
        jobId: 'check-giveaways'
    });
    console.log('[GiveawayScheduler] Giveaway check job scheduled to run every 15 seconds.');
    await systemQueue.close();
}

scheduleGiveawayChecks().catch(console.error);
