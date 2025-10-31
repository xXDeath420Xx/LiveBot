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
const axios_1 = __importDefault(require("axios"));
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMessages
    ],
    partials: [discord_js_1.Partials.Channel]
});
async function getLatestVideo(channelId) {
    try {
        const response = await axios_1.default.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                order: 'date',
                maxResults: 1,
                type: 'video',
                key: process.env.YOUTUBE_API_KEY
            }
        });
        return response.data.items?.[0] || null;
    }
    catch (error) {
        logger_1.default.error(`[YouTube Worker] Error fetching latest video for ${channelId}:`, { error: error.response?.data || error.message });
        return null;
    }
}
let worker;
client.once(discord_js_1.Events.ClientReady, () => {
    logger_1.default.info(`[YouTube Worker] Discord client is ready. Worker is active.`);
    worker = new bullmq_1.Worker('youtube-uploads', async (job) => {
        const { subscription } = job.data;
        logger_1.default.info(`[YouTube Worker] Checking channel: ${subscription.channel_name} (${subscription.youtube_channel_id})`);
        try {
            const latestVideo = await getLatestVideo(subscription.youtube_channel_id);
            if (!latestVideo || latestVideo.id.videoId === subscription.last_video_id) {
                return; // No new video found
            }
            logger_1.default.info(`[YouTube Worker] New video found for ${subscription.channel_name}: ${latestVideo.snippet.title}`);
            const channel = await client.channels.fetch(subscription.discord_channel_id).catch(() => null);
            if (!channel) {
                logger_1.default.warn(`[YouTube Worker] Could not fetch Discord channel ${subscription.discord_channel_id}`);
                return;
            }
            const videoUrl = `https://www.youtube.com/watch?v=${latestVideo.id.videoId}`;
            let content = subscription.custom_message
                ? subscription.custom_message.replace(/{video_title}/g, latestVideo.snippet.title).replace(/{video_url}/g, videoUrl).replace(/{channel_name}/g, latestVideo.snippet.channelTitle)
                : `**${latestVideo.snippet.channelTitle}** just uploaded a new video!`;
            const embed = new discord_js_1.EmbedBuilder()
                .setColor('#FF0000')
                .setTitle(latestVideo.snippet.title)
                .setURL(videoUrl)
                .setAuthor({ name: latestVideo.snippet.channelTitle, url: `https://www.youtube.com/channel/${subscription.youtube_channel_id}` })
                .setImage(latestVideo.snippet.thumbnails.high.url)
                .setTimestamp(new Date(latestVideo.snippet.publishedAt));
            await channel.send({ content, embeds: [embed] });
            await db_1.default.execute('UPDATE youtube_subscriptions SET last_video_id = ? WHERE subscription_id = ?', [latestVideo.id.videoId, subscription.subscription_id]);
        }
        catch (error) {
            logger_1.default.error(`[YouTube Worker] Job ${job.id} failed:`, { error });
            throw error;
        }
    }, {
        connection: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT) || 6379
        }
    });
    worker.on('completed', (job) => {
        logger_1.default.info(`[YouTube Worker] Job ${job.id} has completed.`);
    });
    worker.on('failed', (job, err) => {
        logger_1.default.error(`[YouTube Worker] Job ${job?.id} has failed with error: ${err.message}`);
    });
});
client.login(process.env.DISCORD_TOKEN)
    .then(() => logger_1.default.info('[YouTube Worker] Successfully logged in'));
async function shutdown(signal) {
    logger_1.default.warn(`[YouTube Worker] Received ${signal}. Shutting down...`);
    if (worker) {
        await worker.close();
    }
    await client.destroy();
    await db_1.default.end();
    await cache.redis.quit(); // Gracefully close the Redis connection
    logger_1.default.info('[YouTube Worker] Shutdown complete.');
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
