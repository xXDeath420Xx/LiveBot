const { Queue } = require('bullmq');
const { redisOptions } = require('../utils/cache');

const systemQueue = new Queue('system-tasks', { connection: redisOptions });

async function scheduleStatsCollection() {
    // Remove any old scheduled job to avoid duplicates
    await systemQueue.removeRepeatable('collect-server-stats', { cron: '0 0 * * *' }, 'collect-server-stats');

    // Add the new job, scheduled to run once a day at midnight UTC
    await systemQueue.add('collect-server-stats', {}, {
        repeat: {
            cron: '0 0 * * *', // Every day at 00:00 UTC
        },
        jobId: 'collect-server-stats',
        removeOnComplete: true,
        removeOnFail: true,
    });
    console.log('[StatsScheduler] Daily server stats collection job scheduled.');
    await systemQueue.close();
}

scheduleStatsCollection().catch(console.error);
