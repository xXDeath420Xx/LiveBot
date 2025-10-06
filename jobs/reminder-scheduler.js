const { Queue } = require('bullmq');
const Redis = require('ioredis');
require('dotenv').config();

const redisClient = new Redis(process.env.REDIS_URL);
const reminderQueue = new Queue('reminders', { connection: redisClient });

async function scheduleReminderChecks() {
    await reminderQueue.add('check-reminders', {}, {
        repeat: {
            every: 60 * 1000, // Every 60 seconds
        },
        removeOnComplete: true,
        removeOnFail: true,
    });
    console.log('[ReminderScheduler] Reminder check job scheduled to run every minute.');
}

scheduleReminderChecks().catch(console.error);