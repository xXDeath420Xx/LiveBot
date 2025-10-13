const { Worker } = require('bullmq');
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { redisOptions } = require('../utils/cache');
const db = require('../utils/db');
const logger = require('../utils/logger');

// Export a function that takes the main client instance
module.exports = function startReminderWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

    logger.info('[Reminder Worker] Initializing BullMQ Worker.');

    const reminderWorker = new Worker('reminders', async job => {
        if (!client.isReady()) {
            logger.warn(`[ReminderWorker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error("Discord client not ready");
        }

        if (job.name === 'check-reminders') {
            try {
                const [reminders] = await db.execute('SELECT * FROM reminders WHERE remind_at <= NOW()');
                if (reminders.length === 0) return;

                logger.info(`[ReminderWorker] Found ${reminders.length} due reminders.`);

                for (const reminder of reminders) {
                    try {
                        const user = await client.users.fetch(reminder.user_id).catch(() => null);
                        if (!user) {
                            logger.warn(`[ReminderWorker] Could not find user ${reminder.user_id} for reminder ${reminder.id}. Deleting.`);
                            await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                            continue;
                        }

                        const embed = {
                            color: 0x5865F2,
                            title: '🔔 Reminder!',
                            description: reminder.message,
                            footer: { text: `You set this reminder on ${new Date(reminder.created_at).toLocaleString()}` }
                        };

                        if (reminder.is_dm) {
                            await user.send({ embeds: [embed] });
                        } else {
                            const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
                            if (channel) {
                                await channel.send({ content: `${user}`, embeds: [embed] });
                            } else {
                                logger.warn(`[ReminderWorker] Channel ${reminder.channel_id} not found for reminder ${reminder.id}. Deleting.`);
                            }
                        }
                    } catch (sendError) {
                        logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id}.`, { error: sendError });
                    } finally {
                        // Always delete the reminder after attempting to send it.
                        await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                    }
                }
            } catch (dbError) {
                logger.error('[ReminderWorker] Database error while checking reminders:', { error: dbError });
                throw dbError;
            }
        }
    }, { connection: redisOptions });

    reminderWorker.on("completed", job => logger.info(`[ReminderWorker] Job ${job.id} has completed.`));
    reminderWorker.on("failed", (job, err) => logger.error(`[ReminderWorker] Job ${job.id} has failed.`, { error: err }));

    // Graceful shutdown is handled by the main process.

    return reminderWorker;
};