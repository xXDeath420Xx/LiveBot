import { Worker, Job } from 'bullmq';
import * as path from 'path';
import * as dotenvFlow from 'dotenv-flow';
dotenvFlow.config({ path: path.resolve(__dirname, '..') }); // Corrected path
import { Client, GatewayIntentBits, Partials, EmbedBuilder, Events, TextChannel, Message } from 'discord.js';
import logger from '../utils/logger';
import db from '../utils/db';
import * as cache from '../utils/cache'; // Import cache for Redis connection

interface SummaryJobData {
  announcementId: number;
}

interface StreamSession {
  announcement_id: number;
  start_time: Date;
  end_time: Date | null;
}

interface Announcement {
  announcement_id: number;
  channel_id: string;
  message_id: string;
  stream_title?: string;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)} seconds`;
  }
  const hours: number = Math.floor(seconds / 3600);
  const minutes: number = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

let worker: Worker | undefined;

client.once(Events.ClientReady, () => {
  logger.info(`[Summary Worker] Discord client is ready. Worker is active.`);

  worker = new Worker<SummaryJobData>('stream-summary', async (job: Job<SummaryJobData>) => {
    const { announcementId } = job.data;
    logger.info(`[Summary Worker] Processing summary for announcement ID: ${announcementId}`);

    try {
      const [[session]] = await db.execute('SELECT * FROM stream_sessions WHERE announcement_id = ?', [announcementId]) as [StreamSession[], any];
      if (!session || !session.end_time) {
        logger.warn(`[Summary Worker] No completed session found for announcement ID: ${announcementId}`);
        return;
      }

      const [[announcement]] = await db.execute('SELECT * FROM announcements WHERE announcement_id = ?', [announcementId]) as [Announcement[], any];
      if (!announcement) {
        logger.warn(`[Summary Worker] No announcement record found for ID: ${announcementId}`);
        return;
      }

      const channel = await client.channels.fetch(announcement.channel_id).catch(() => null) as TextChannel | null;
      if (!channel) {
        logger.warn(`[Summary Worker] Could not fetch channel ${announcement.channel_id}. Message might be in a deleted channel.`);
        return;
      }

      const message = await channel.messages.fetch(announcement.message_id).catch((err: any) => {
        if (err.code !== 10008) { // Ignore "Unknown Message"
            logger.error(`[Summary Worker] Failed to fetch message ${announcement.message_id} in channel ${announcement.channel_id}:`, { error: err.message });
        }
        return null;
      }) as Message | null;

      if (!message || !message.embeds[0]) {
        logger.warn(`[Summary Worker] Message ${announcement.message_id} not found or has no embed. Cannot post summary.`);
        return;
      }

      const durationSeconds: number = (new Date(session.end_time).getTime() - new Date(session.start_time).getTime()) / 1000;
      const summaryText: string = `Stream ended. Total duration: **${formatDuration(durationSeconds)}**.`;

      const originalEmbed = message.embeds[0]!;
      const summaryEmbed = new EmbedBuilder(originalEmbed.toJSON())
        .setAuthor(null)
        .setTitle(`Summary of ${originalEmbed.author?.name || announcement.stream_title || 'Stream'}`)
        .setDescription(summaryText)
        .setTimestamp(new Date(session.end_time));

      await message.edit({ embeds: [summaryEmbed] });
      logger.info(`[Summary Worker] Successfully posted summary for announcement ID: ${announcementId}`);

    } catch (error) {
      logger.error(`[Summary Worker] Job ${job.id} failed:`, { _error });
      throw _error;
    }
  }, {
    connection: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379
    }
  });

  worker.on('completed', (job: Job) => {
    logger.info(`[Summary Worker] Job ${job.id} has completed.`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[Summary Worker] Job ${job?.id} has failed with error: ${err.message}`);
  });
});

client.login(process.env.DISCORD_TOKEN)
  .then(() => logger.info('[Summary Worker] Successfully logged in'));

async function shutdown(signal: string): Promise<void> {
  logger.warn(`[Summary Worker] Received ${signal}. Shutting down...`);
  if (worker) {
    await worker.close();
  }
  await client.destroy();
  await db.end();
  await cache.connection.quit(); // Gracefully close the Redis connection
  logger.info('[Summary Worker] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));