const { Worker } = require('bullmq');
const path = require('path');
require('dotenv-flow').config({ path: path.resolve(__dirname, '..') }); // Corrected path
const { Client, GatewayIntentBits, Partials, EmbedBuilder, Events } = require('discord.js');
const logger = require('../utils/logger');
const db = require('../utils/db');
const axios = require('axios');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.Channel]
});

async function getLatestVideo(channelId) {
    try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                order: 'date',
                maxResults: 1,
                type: 'video',
                key: process.env.YOUTUBE_API_KEY
            }
        });
        return response.data.items?.[0];
    } catch (error) {
        logger.error(`[YouTube Worker] Error fetching latest video for ${channelId}:`, { error: error.response?.data || error.message });
        return null;
    }
}

let worker;

client.once(Events.ClientReady, () => {
    logger.info(`[YouTube Worker] Discord client is ready. Worker is active.`);

    worker = new Worker('youtube-uploads', async job => {
        const { subscription } = job.data;
        logger.info(`[YouTube Worker] Checking channel: ${subscription.channel_name} (${subscription.youtube_channel_id})`);

        try {
            const latestVideo = await getLatestVideo(subscription.youtube_channel_id);
            if (!latestVideo || latestVideo.id.videoId === subscription.last_video_id) {
                return; // No new video found
            }

            logger.info(`[YouTube Worker] New video found for ${subscription.channel_name}: ${latestVideo.snippet.title}`);

            const channel = await client.channels.fetch(subscription.discord_channel_id).catch(() => null);
            if (!channel) {
                logger.warn(`[YouTube Worker] Could not fetch Discord channel ${subscription.discord_channel_id}`);
                return;
            }

            const videoUrl = `https://www.youtube.com/watch?v=${latestVideo.id.videoId}`;
            let content = subscription.custom_message
                ? subscription.custom_message.replace(/{video_title}/g, latestVideo.snippet.title).replace(/{video_url}/g, videoUrl).replace(/{channel_name}/g, latestVideo.snippet.channelTitle)
                : `**${latestVideo.snippet.channelTitle}** just uploaded a new video!`;

            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle(latestVideo.snippet.title)
                .setURL(videoUrl)
                .setAuthor({ name: latestVideo.snippet.channelTitle, url: `https://www.youtube.com/channel/${subscription.youtube_channel_id}` })
                .setImage(latestVideo.snippet.thumbnails.high.url)
                .setTimestamp(new Date(latestVideo.snippet.publishedAt));

            await channel.send({ content, embeds: [embed] });

            await db.execute('UPDATE youtube_subscriptions SET last_video_id = ? WHERE subscription_id = ?', [latestVideo.id.videoId, subscription.subscription_id]);

        } catch (error) {
            logger.error(`[YouTube Worker] Job ${job.id} failed:`, { error });
            throw error;
        }
    }, {
        connection: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: process.env.REDIS_PORT || 6379
        }
    });

    worker.on('completed', job => {
      logger.info(`[YouTube Worker] Job ${job.id} has completed.`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`[YouTube Worker] Job ${job.id} has failed with error: ${err.message}`);
    });
});

client.login(process.env.DISCORD_TOKEN);

async function shutdown(signal) {
    logger.warn(`[YouTube Worker] Received ${signal}. Shutting down...`);
    if (worker) await worker.close();
    await client.destroy();
    await db.end();
    logger.info('[YouTube Worker] Shutdown complete.');
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));