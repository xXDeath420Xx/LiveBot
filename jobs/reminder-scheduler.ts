import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { Queue } from 'bullmq';
import { redisOptions } from '../utils/cache';

const reminderQueue = new Queue('reminders', { connection: redisOptions });

/**
 * Schedule reminder check jobs to run every minute
 */
async function scheduleReminderChecks(): Promise<void> {
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
