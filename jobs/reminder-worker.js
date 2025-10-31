"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startReminderWorker = startReminderWorker;
const bullmq_1 = require("bullmq");
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../.env') });
const cache_1 = require("../utils/cache");
const db_1 = require("../utils/db");
const logger_1 = require("../utils/logger");
const discord_js_1 = require("discord.js");
/**
 * Start the reminder worker for processing due reminders
 * @param client - The Discord client instance
 * @returns The BullMQ Worker instance
 */
function startReminderWorker(client) {
    logger_1.logger.info('[Reminder Worker] Initializing BullMQ Worker.');
    const reminderWorker = new bullmq_1.Worker('reminders', async (job) => {
        if (!client.isReady()) {
            logger_1.logger.warn(`[ReminderWorker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error('Discord client not ready');
        }
        if (job.name === 'check-reminders') {
            try {
                const [reminders] = await db_1.db.execute('SELECT * FROM reminders WHERE remind_at <= NOW()');
                if (reminders.length === 0)
                    return;
                logger_1.logger.info(`[ReminderWorker] Found ${reminders.length} due reminders.`);
                for (const reminder of reminders) {
                    try {
                        const user = await client.users.fetch(reminder.user_id).catch(() => null);
                        if (!user) {
                            logger_1.logger.warn(`[ReminderWorker] Could not find user ${reminder.user_id} for reminder ${reminder.id}. Deleting.`);
                            await db_1.db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                            continue;
                        }
                        const embed = new discord_js_1.EmbedBuilder()
                            .setColor(0x5865F2)
                            .setTitle('🔔 Reminder!')
                            .setDescription(reminder.reminder_text)
                            .setFooter({ text: `You set this reminder on ${new Date(reminder.created_at).toLocaleString()}` });
                        const isDm = reminder.is_dm;
                        if (isDm) {
                            await user.send({ embeds: [embed] });
                        }
                        else {
                            const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
                            if (channel && channel.isTextBased()) {
                                await channel.send({ content: `${user}`, embeds: [embed] });
                            }
                            else {
                                logger_1.logger.warn(`[ReminderWorker] Channel ${reminder.channel_id} not found for reminder ${reminder.id}. Deleting.`);
                            }
                        }
                    }
                    catch (sendError) {
                        if (sendError instanceof Error) {
                            logger_1.logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id}.`, { error: sendError.message });
                        }
                        else {
                            logger_1.logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id} with unknown error.`, { error: sendError });
                        }
                    }
                    finally {
                        // Always delete the reminder after attempting to send it
                        await db_1.db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                    }
                }
            }
            catch (dbError) {
                if (dbError instanceof Error) {
                    logger_1.logger.error('[ReminderWorker] Database error while checking reminders:', { error: dbError.message, stack: dbError.stack });
                }
                else {
                    logger_1.logger.error('[ReminderWorker] Unknown database error while checking reminders:', { error: dbError });
                }
                throw dbError;
            }
        }
    }, { connection: cache_1.redisOptions });
    reminderWorker.on('completed', (job) => {
        logger_1.logger.info(`[ReminderWorker] Job ${job.id} has completed.`);
    });
    reminderWorker.on('failed', (job, err) => {
        logger_1.logger.error(`[ReminderWorker] Job ${job?.id} has failed.`, { error: err.message });
    });
    return reminderWorker;
}
