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
dotenvFlow.config({ path: path.resolve(__dirname, '..') });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const cache = __importStar(require("../utils/cache"));
const api_checks_1 = require("../utils/api_checks"); // I will add this function later
const announcer_1 = require("../utils/announcer");
const workerClient = new discord_js_1.Client({
    intents: [discord_js_1.GatewayIntentBits.Guilds, discord_js_1.GatewayIntentBits.GuildMessages],
    partials: [discord_js_1.Partials.Channel],
});
let worker;
async function processVOD(streamer) {
    let latestVideo = null;
    if (streamer.platform === 'youtube') {
        latestVideo = await (0, api_checks_1.getLatestYouTubeVideo)(streamer.platform_user_id);
    }
    else {
        // TikTok VOD logic would go here if/when a reliable method is found.
        logger_1.default.debug(`[VOD Worker] Skipping VOD check for TikTok user ${streamer.username} as it is not yet supported.`);
        return;
    }
    if (!latestVideo || !latestVideo.videoId) {
        logger_1.default.debug(`[VOD Worker] No recent VOD found for ${streamer.username} on ${streamer.platform}.`);
        return;
    }
    const [[dbStreamer]] = await db_1.default.execute('SELECT last_vod_id FROM streamers WHERE streamer_id = ?', [streamer.streamer_id]);
    if (dbStreamer && dbStreamer.last_vod_id === latestVideo.videoId) {
        logger_1.default.debug(`[VOD Worker] Latest VOD for ${streamer.username} has already been announced.`);
        return;
    }
    logger_1.default.info(`[VOD Worker] New VOD found for ${streamer.username}: ${latestVideo.title} (${latestVideo.videoId})`);
    const [subscriptions] = await db_1.default.execute(`SELECT sub.announcement_channel_id, sub.custom_message, g.bot_nickname, g.webhook_avatar_url
         FROM subscriptions sub
         JOIN guilds g ON sub.guild_id = g.guild_id
         WHERE sub.streamer_id = ? AND sub.youtube_vod_notifications = 1`, [streamer.streamer_id]);
    if (subscriptions.length === 0)
        return;
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#FF0000')
        .setAuthor({ name: `${latestVideo.channelTitle} has a new video!`, url: `https://www.youtube.com/channel/${streamer.platform_user_id}` })
        .setTitle(latestVideo.title)
        .setURL(latestVideo.url)
        .setImage(latestVideo.thumbnailUrl)
        .setTimestamp(new Date(latestVideo.publishedAt))
        .setFooter({ text: 'New VOD' });
    for (const sub of subscriptions) {
        const channelId = sub.announcement_channel_id;
        if (!channelId)
            continue;
        try {
            const webhookClient = await (0, announcer_1.getOrCreateWebhook)(workerClient, channelId, sub.webhook_avatar_url || workerClient.user.displayAvatarURL());
            if (!webhookClient)
                continue;
            let content = sub.custom_message
                ? sub.custom_message.replace(/{video_title}/g, latestVideo.title).replace(/{video_url}/g, latestVideo.url).replace(/{channel_name}/g, latestVideo.channelTitle)
                : `**${latestVideo.channelTitle}** just uploaded a new video!`;
            await webhookClient.send({
                content,
                username: sub.bot_nickname || 'LiveBot VOD Announcer',
                avatarURL: sub.webhook_avatar_url || workerClient.user.displayAvatarURL(),
                embeds: [embed]
            });
            logger_1.default.info(`[VOD Worker] Announced VOD for ${streamer.username} in channel ${channelId}.`);
        }
        catch (e) {
            logger_1.default.error(`[VOD Worker] Failed to announce in channel ${channelId} for ${streamer.username}:`, { error: e });
        }
    }
    await db_1.default.execute('UPDATE streamers SET last_vod_id = ? WHERE streamer_id = ?', [latestVideo.videoId, streamer.streamer_id]);
}
workerClient.once(discord_js_1.Events.ClientReady, async (c) => {
    logger_1.default.info(`[VOD Worker] Discord client is ready as ${c.user.tag}. Worker is active.`);
    worker = new bullmq_1.Worker('vod-uploads', async (job) => {
        const { streamer } = job.data;
        logger_1.default.info(`[VOD Worker] Processing VOD check for ${streamer.username} (${streamer.platform})`);
        await processVOD(streamer);
    }, {
        connection: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT) || 6379,
        },
        concurrency: 5,
    });
    worker.on('completed', (job) => {
        logger_1.default.info(`[VOD Worker] Job ${job.id} has completed.`);
    });
    worker.on('failed', (job, err) => {
        logger_1.default.error(`[VOD Worker] Job ${job?.id} has failed with error: ${err.message}`);
    });
});
workerClient.login(process.env.DISCORD_TOKEN)
    .then(() => logger_1.default.info('[VOD Worker] Logging in...'));
async function shutdown(signal) {
    logger_1.default.warn(`[VOD Worker] Received ${signal}. Shutting down...`);
    if (worker)
        await worker.close();
    await workerClient.destroy();
    await db_1.default.end();
    await cache.redis.quit();
    logger_1.default.info('[VOD Worker] Shutdown complete.');
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
