import { Worker, Job } from 'bullmq';
import * as path from 'path';
import * as dotenvFlow from 'dotenv-flow';
dotenvFlow.config({ path: path.resolve(__dirname, '..') }); // Corrected path
import { Client, GatewayIntentBits, Partials, EmbedBuilder, Events, TextChannel } from 'discord.js';
import logger from '../utils/logger';
import db from '../utils/db';
import * as cache from '../utils/cache'; // Import cache for Redis connection
import axios, { AxiosResponse } from 'axios';

interface YouTubeSubscription {
    subscription_id: number;
    channel_name: string;
    youtube_channel_id: string;
    discord_channel_id: string;
    custom_message?: string;
    last_video_id?: string;
}

interface YouTubeJobData {
    subscription: YouTubeSubscription;
}

interface YouTubeVideoItem {
    id: {
        videoId: string;
    };
    snippet: {
        title: string;
        channelTitle: string;
        publishedAt: string;
        thumbnails: {
            high: {
                url: string;
            };
        };
    };
}

interface YouTubeSearchResponse {
    items?: YouTubeVideoItem[];
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

async function getLatestVideo(channelId: string): Promise<YouTubeVideoItem | null> {
  try {
    const response: AxiosResponse<YouTubeSearchResponse> = await axios.get('https://www.googleapis.com/youtube/v3/search', {
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
  } catch (error: any) {
    logger.error(`[YouTube Worker] Error fetching latest video for ${channelId}:`, { error: error.response?.data || error.message });
    return null;
  }
}

let worker: Worker | undefined;

client.once(Events.ClientReady, () => {
  logger.info(`[YouTube Worker] Discord client is ready. Worker is active.`);

  worker = new Worker<YouTubeJobData>('youtube-uploads', async (job: Job<YouTubeJobData>) => {
    const { subscription } = job.data;
    logger.info(`[YouTube Worker] Checking channel: ${subscription.channel_name} (${subscription.youtube_channel_id})`);

    try {
      const latestVideo = await getLatestVideo(subscription.youtube_channel_id);
      if (!latestVideo || latestVideo.id.videoId === subscription.last_video_id) {
        return; // No new video found
      }

      logger.info(`[YouTube Worker] New video found for ${subscription.channel_name}: ${latestVideo.snippet.title}`);

      const channel = await client.channels.fetch(subscription.discord_channel_id).catch(() => null) as TextChannel | null;
      if (!channel) {
        logger.warn(`[YouTube Worker] Could not fetch Discord channel ${subscription.discord_channel_id}`);
        return;
      }

      const videoUrl: string = `https://www.youtube.com/watch?v=${latestVideo.id.videoId}`;
      let content: string = subscription.custom_message
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
      logger.error(`[YouTube Worker] Job ${job.id} failed:`, { _error });
      throw _error;
    }
  }, {
    connection: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379
    }
  });

  worker.on('completed', (job: Job) => {
    logger.info(`[YouTube Worker] Job ${job.id} has completed.`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[YouTube Worker] Job ${job?.id} has failed with error: ${err.message}`);
  });
});

client.login(process.env.DISCORD_TOKEN)
  .then(() => logger.info('[YouTube Worker] Successfully logged in'));

async function shutdown(signal: string): Promise<void> {
  logger.warn(`[YouTube Worker] Received ${signal}. Shutting down...`);
  if (worker) {
    await worker.close();
  }
  await client.destroy();
  await db.end();
  await cache.connection.quit(); // Gracefully close the Redis connection
  logger.info('[YouTube Worker] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));