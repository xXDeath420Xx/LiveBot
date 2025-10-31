import { Worker, Job } from 'bullmq';
import * as path from 'path';
import * as dotenvFlow from 'dotenv-flow';
dotenvFlow.config({ path: path.resolve(__dirname, '..') });
import { Client, GatewayIntentBits, Partials, Events, EmbedBuilder, WebhookClient } from 'discord.js';
import logger from '../utils/logger';
import db from '../utils/db';
import * as cache from '../utils/cache';
import { getLatestYouTubeVideo } from '../utils/api_checks';
import { getOrCreateWebhook } from '../utils/announcer';

const getWebhookClient = getOrCreateWebhook;

interface Streamer {
    streamer_id: number;
    platform: string;
    platform_user_id: string;
    username: string;
}

interface VODJobData {
    streamer: Streamer;
}

interface LatestVideo {
    videoId: string;
    title: string;
    url: string;
    thumbnailUrl: string;
    publishedAt: string;
    channelTitle: string;
}

interface Subscription {
    announcement_channel_id: string;
    custom_message?: string;
    bot_nickname?: string;
    webhook_avatar_url?: string;
}

interface DBStreamer {
    last_vod_id?: string;
}

const workerClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

let worker: Worker | undefined;

async function processVOD(streamer: Streamer): Promise<void> {
    let latestVideo: LatestVideo | null = null;
    if (streamer.platform === 'youtube') {
        latestVideo = await getLatestYouTubeVideo(streamer.platform_user_id);
    } else {
        // TikTok VOD logic would go here if/when a reliable method is found.
        logger.debug(`[VOD Worker] Skipping VOD check for TikTok user ${streamer.username} as it is not yet supported.`);
        return;
    }

    if (!latestVideo || !latestVideo.videoId) {
        logger.debug(`[VOD Worker] No recent VOD found for ${streamer.username} on ${streamer.platform}.`);
        return;
    }

    const [[dbStreamer]] = await db.execute('SELECT last_vod_id FROM streamers WHERE streamer_id = ?', [streamer.streamer_id]) as [DBStreamer[], any];

    if (dbStreamer && dbStreamer.last_vod_id === latestVideo.videoId) {
        logger.debug(`[VOD Worker] Latest VOD for ${streamer.username} has already been announced.`);
        return;
    }

    logger.info(`[VOD Worker] New VOD found for ${streamer.username}: ${latestVideo.title} (${latestVideo.videoId})`);

    const [subscriptions] = await db.execute(
        `SELECT sub.announcement_channel_id, sub.custom_message, g.bot_nickname, g.webhook_avatar_url
         FROM subscriptions sub
         JOIN guilds g ON sub.guild_id = g.guild_id
         WHERE sub.streamer_id = ? AND sub.youtube_vod_notifications = 1`,
        [streamer.streamer_id]
    ) as [Subscription[], any];

    if (subscriptions.length === 0) return;

    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setAuthor({ name: `${latestVideo.channelTitle} has a new video!`, url: `https://www.youtube.com/channel/${streamer.platform_user_id}` })
        .setTitle(latestVideo.title)
        .setURL(latestVideo.url)
        .setImage(latestVideo.thumbnailUrl)
        .setTimestamp(new Date(latestVideo.publishedAt))
        .setFooter({ text: 'New VOD' });

    for (const sub of subscriptions) {
        const channelId = sub.announcement_channel_id;
        if (!channelId) continue;

        try {
            const webhookClient = await getWebhookClient(workerClient, channelId, '', sub.webhook_avatar_url || workerClient.user!.displayAvatarURL()) as WebhookClient | null;
            if (!webhookClient) continue;

            let content = sub.custom_message
                ? sub.custom_message.replace(/{video_title}/g, latestVideo.title).replace(/{video_url}/g, latestVideo.url).replace(/{channel_name}/g, latestVideo.channelTitle)
                : `**${latestVideo.channelTitle}** just uploaded a new video!`;

            await webhookClient.send({
                content,
                username: sub.bot_nickname || 'LiveBot VOD Announcer',
                avatarURL: sub.webhook_avatar_url || workerClient.user!.displayAvatarURL(),
                embeds: [embed]
            });
            logger.info(`[VOD Worker] Announced VOD for ${streamer.username} in channel ${channelId}.`);
        } catch (e) {
            logger.error(`[VOD Worker] Failed to announce in channel ${channelId} for ${streamer.username}:`, { error: e });
        }
    }

    await db.execute('UPDATE streamers SET last_vod_id = ? WHERE streamer_id = ?', [latestVideo.videoId, streamer.streamer_id]);
}

workerClient.once(Events.ClientReady, async (c: Client) => {
  logger.info(`[VOD Worker] Discord client is ready as ${c.user!.tag}. Worker is active.`);

  worker = new Worker<VODJobData>('vod-uploads', async (job: Job<VODJobData>) => {
    const { streamer } = job.data;
    logger.info(`[VOD Worker] Processing VOD check for ${streamer.username} (${streamer.platform})`);
    await processVOD(streamer);
  }, {
    connection: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379,
    },
    concurrency: 5,
  });

  worker.on('completed', (job: Job) => {
    logger.info(`[VOD Worker] Job ${job.id} has completed.`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[VOD Worker] Job ${job?.id} has failed with error: ${err.message}`);
  });
});

workerClient.login(process.env.DISCORD_TOKEN)
  .then(() => logger.info('[VOD Worker] Logging in...'));

async function shutdown(signal: string): Promise<void> {
  logger.warn(`[VOD Worker] Received ${signal}. Shutting down...`);
  if (worker) await worker.close();
  await workerClient.destroy();
  await db.end();
  await cache.connection.quit();
  logger.info('[VOD Worker] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
