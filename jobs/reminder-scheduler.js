require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Queue } = require('bullmq');
const { redisOptions } = require('../utils/cache');

const reminderQueue = new Queue('reminders', { connection: redisOptions });

async function scheduleReminderChecks() {
    await reminderQueue.add('check-reminders', {}, {
        repeat: {
            every: 60 * 1000, // Every 60 seconds
        },
        removeOnComplete: true,
        removeOnFail: true,
    });
    console.log('[ReminderScheduler] Reminder check job scheduled to run every minute.');
    await reminderQueue.close();
}

scheduleReminderChecks().catch(console.error);
