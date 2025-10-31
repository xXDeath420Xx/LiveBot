import { Worker, Job } from 'bullmq';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { redisOptions } from '../utils/cache';
import db from '../utils/db';
import logger from '../utils/logger';
import { ExtendedClient, Reminder } from '../types';
import { EmbedBuilder } from 'discord.js';

/**
 * Start the reminder worker for processing due reminders
 * @param client - The Discord client instance
 * @returns The BullMQ Worker instance
 */
export = function startReminderWorker(client: ExtendedClient): Worker {
    logger.info('[Reminder Worker] Initializing BullMQ Worker.');

    const reminderWorker = new Worker(
        'reminders',
        async (job: Job) => {
            if (!client.isReady()) {
                logger.warn(`[ReminderWorker] Discord client not ready. Retrying job ${job.id}...`);
                throw new Error('Discord client not ready');
            }

            if (job.name === 'check-reminders') {
                try {
                    const [reminders] = await db.execute<Reminder[]>('SELECT * FROM reminders WHERE remind_at <= NOW()');
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

                            const embed = new EmbedBuilder()
                                .setColor(0x5865F2)
                                .setTitle('🔔 Reminder!')
                                .setDescription(reminder.reminder_text)
                                .setFooter({ text: `You set this reminder on ${new Date(reminder.created_at).toLocaleString()}` });

                            const isDm = (reminder as any).is_dm;

                            if (isDm) {
                                await user.send({ embeds: [embed] });
                            } else {
                                const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
                                if (channel && 'send' in channel && typeof (channel as any).send === 'function') {
                                    await (channel as any).send({ content: `${user}`, embeds: [embed] });
                                } else {
                                    logger.warn(`[ReminderWorker] Channel ${reminder.channel_id} not found for reminder ${reminder.id}. Deleting.`);
                                }
                            }
                        } catch (sendError: unknown) {
                            if (sendError instanceof Error) {
                                logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id}.`, { error: sendError.message });
                            } else {
                                logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id} with unknown error.`, { error: sendError });
                            }
                        } finally {
                            // Always delete the reminder after attempting to send it
                            await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                        }
                    }
                } catch (dbError: unknown) {
                    if (dbError instanceof Error) {
                        logger.error('[ReminderWorker] Database error while checking reminders:', { error: dbError.message, stack: dbError.stack });
                    } else {
                        logger.error('[ReminderWorker] Unknown database error while checking reminders:', { error: dbError });
                    }
                    throw dbError;
                }
            }
        },
        { connection: redisOptions }
    );

    reminderWorker.on('completed', (job: Job) => {
        logger.info(`[ReminderWorker] Job ${job.id} has completed.`);
    });

    reminderWorker.on('failed', (job: Job | undefined, err: Error) => {
        logger.error(`[ReminderWorker] Job ${job?.id} has failed.`, { error: err.message });
    });

    return reminderWorker;
};
