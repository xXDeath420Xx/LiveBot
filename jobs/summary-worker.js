"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const path = __importStar(require("path"));
const dotenvFlow = __importStar(require("dotenv-flow"));
dotenvFlow.config({ path: path.resolve(__dirname, '..') }); // Corrected path
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const cache = __importStar(require("../utils/cache")); // Import cache for Redis connection
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMessages
    ],
    partials: [discord_js_1.Partials.Channel]
});
function formatDuration(seconds) {
    if (seconds < 60) {
        return `${Math.floor(seconds)} seconds`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}
let worker;
client.once(discord_js_1.Events.ClientReady, () => {
    logger_1.default.info(`[Summary Worker] Discord client is ready. Worker is active.`);
    worker = new bullmq_1.Worker('stream-summary', async (job) => {
        const { announcementId } = job.data;
        logger_1.default.info(`[Summary Worker] Processing summary for announcement ID: ${announcementId}`);
        try {
            const [[session]] = await db_1.default.execute('SELECT * FROM stream_sessions WHERE announcement_id = ?', [announcementId]);
            if (!session || !session.end_time) {
                logger_1.default.warn(`[Summary Worker] No completed session found for announcement ID: ${announcementId}`);
                return;
            }
            const [[announcement]] = await db_1.default.execute('SELECT * FROM announcements WHERE announcement_id = ?', [announcementId]);
            if (!announcement) {
                logger_1.default.warn(`[Summary Worker] No announcement record found for ID: ${announcementId}`);
                return;
            }
            const channel = await client.channels.fetch(announcement.channel_id).catch(() => null);
            if (!channel) {
                logger_1.default.warn(`[Summary Worker] Could not fetch channel ${announcement.channel_id}. Message might be in a deleted channel.`);
                return;
            }
            const message = await channel.messages.fetch(announcement.message_id).catch((err) => {
                if (err.code !== 10008) { // Ignore "Unknown Message"
                    logger_1.default.error(`[Summary Worker] Failed to fetch message ${announcement.message_id} in channel ${announcement.channel_id}:`, { error: err.message });
                }
                return null;
            });
            if (!message || !message.embeds[0]) {
                logger_1.default.warn(`[Summary Worker] Message ${announcement.message_id} not found or has no embed. Cannot post summary.`);
                return;
            }
            const durationSeconds = (new Date(session.end_time).getTime() - new Date(session.start_time).getTime()) / 1000;
            const summaryText = `Stream ended. Total duration: **${formatDuration(durationSeconds)}**.`;
            const originalEmbed = message.embeds[0];
            const summaryEmbed = new discord_js_1.EmbedBuilder(originalEmbed.toJSON())
                .setAuthor(null)
                .setTitle(`Summary of ${originalEmbed.author?.name || announcement.stream_title || 'Stream'}`)
                .setDescription(summaryText)
                .setTimestamp(new Date(session.end_time));
            await message.edit({ embeds: [summaryEmbed] });
            logger_1.default.info(`[Summary Worker] Successfully posted summary for announcement ID: ${announcementId}`);
        }
        catch (error) {
            logger_1.default.error(`[Summary Worker] Job ${job.id} failed:`, { error });
            throw error;
        }
    }, {
        connection: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT) || 6379
        }
    });
    worker.on('completed', (job) => {
        logger_1.default.info(`[Summary Worker] Job ${job.id} has completed.`);
    });
    worker.on('failed', (job, err) => {
        logger_1.default.error(`[Summary Worker] Job ${job?.id} has failed with error: ${err.message}`);
    });
});
client.login(process.env.DISCORD_TOKEN)
    .then(() => logger_1.default.info('[Summary Worker] Successfully logged in'));
async function shutdown(signal) {
    logger_1.default.warn(`[Summary Worker] Received ${signal}. Shutting down...`);
    if (worker) {
        await worker.close();
    }
    await client.destroy();
    await db_1.default.end();
    await cache.redis.quit(); // Gracefully close the Redis connection
    logger_1.default.info('[Summary Worker] Shutdown complete.');
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
