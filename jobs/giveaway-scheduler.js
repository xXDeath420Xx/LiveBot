"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const cache_1 = require("../utils/cache");
const systemQueue = new bullmq_1.Queue('system-tasks', { connection: cache_1.redisOptions });
/**
 * Schedule giveaway check jobs to run every 15 seconds
 */
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
