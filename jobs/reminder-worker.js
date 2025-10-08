const { Worker } = require('bullmq');
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const { redis } = require('../utils/cache');
const db = require('../utils/db');
const logger = require('../utils/logger');

const workerClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.User, Partials.Channel]
});

// Initialize the logger for this worker process
logger.init(workerClient, db);

const reminderWorker = new Worker('reminders', async job => {
    if (!workerClient.isReady()) {
        logger.warn(`[ReminderWorker] Discord client not ready. Retrying job ${job.id}...`);
        throw new Error("Discord client not ready");
    }

    if (job.name === 'check-reminders') {
        try {
            const [reminders] = await db.execute('SELECT * FROM reminders WHERE remind_at <= NOW()');
            if (reminders.length === 0) return;

            logger.info(`[ReminderWorker] Found ${reminders.length} due reminders.`);

            for (const reminder of reminders) {
                const user = await workerClient.users.fetch(reminder.user_id).catch(() => null);
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

                try {
                    if (reminder.is_dm) {
                        await user.send({ embeds: [embed] });
                    } else {
                        const channel = await workerClient.channels.fetch(reminder.channel_id).catch(() => null);
                        if (channel) {
                            await channel.send({ content: `${user}`, embeds: [embed] });
                        } else {
                            logger.warn(`[ReminderWorker] Channel ${reminder.channel_id} not found for reminder ${reminder.id}. Deleting.`);
                            await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                        }
                    }
                    await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                } catch (sendError) {
                    logger.error(`[ReminderWorker] Failed to send reminder ${reminder.id}:`, sendError);
                    await db.execute('DELETE FROM reminders WHERE id = ?', [reminder.id]);
                }
            }
        } catch (dbError) {
            logger.error('[ReminderWorker] Database error while checking reminders:', dbError);
            throw dbError;
        }
    }
}, { connection: redis });

logger.info('[Reminder Worker] BullMQ Worker instantiated and listening for jobs.');

workerClient.login(process.env.DISCORD_TOKEN)
    .then(() => logger.info("[Reminder Worker] Logged in and ready."))
    .catch(err => {
        logger.error("[Reminder Worker] Failed to log in.", { error: err });
        process.exit(1);
    });

async function shutdown(signal) {
    logger.warn(`[Reminder Worker] Received ${signal}. Shutting down...`);
    if (reminderWorker) await reminderWorker.close();
    await workerClient.destroy();
    await db.end();
    await redis.quit();
    logger.info("[Reminder Worker] Shutdown complete.");
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));