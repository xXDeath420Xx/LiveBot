const { Worker } = require('bullmq');
const Redis = require('ioredis');
const db = require('../utils/db');
const logger = require('../utils/logger');
require('dotenv').config();

const redisClient = new Redis(process.env.REDIS_URL);

// A separate client instance for the worker to avoid conflicts
let workerClient;

const reminderWorker = new Worker('reminders', async job => {
    if (!workerClient) {
        // This lazy initialization is a simple way to get a Discord client instance.
        // In a sharded environment, you'd need a more complex way to communicate with the correct shard.
        workerClient = global.client; 
    }
    
    if (!workerClient) {
        logger.warn('[ReminderWorker] Worker running but Discord client is not yet available.');
        return;
    }

    if (job.name === 'check-reminders') {
        try {
            const [reminders] = await db.execute('SELECT * FROM reminders WHERE remind_at <= NOW()');
            if (reminders.length === 0) return;

            logger.info(`[ReminderWorker] Found ${reminders.length} due reminders.`);

            for (const reminder of reminders) {
                const user = await workerClient.users.fetch(reminder.user_id).catch(() => null);
                if (!user) {
                    await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                    continue;
                }

                const embed = {
                    color: 0x5865F2,
                    title: '🔔 Reminder!',
                    description: reminder.message,
                    footer: { text: `You set this reminder on ${new Date(reminder.created_at).toLocaleString()}` }
                };

                try {
                    if (reminder.is_dm) {
                        await user.send({ embeds: [embed] });
                    } else {
                        const channel = await workerClient.channels.fetch(reminder.channel_id).catch(() => null);
                        if (channel) {
                            await channel.send({ content: `${user}`, embeds: [embed] });
                        }
                    }
                    await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                } catch (sendError) {
                    logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id}:`, sendError);
                    // Decide if you want to delete failed reminders or retry
                    await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                }
            }
        } catch (dbError) {
            logger.error('[ReminderWorker] Database error while checking reminders:', dbError);
        }
    }
}, { connection: redisClient });

logger.info('[ReminderWorker] Reminder worker started.');