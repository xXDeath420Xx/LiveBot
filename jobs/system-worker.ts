import { Worker, Job } from 'bullmq';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import logger from '../utils/logger';
import { redisOptions } from '../utils/cache';
import { checkTeams } from '../core/stream-checker';
import userSyncModule from '../core/user-sync';
import { collectServerStats } from '../core/stats-manager';
import { checkStreamers } from '../core/stream-manager';
import { Client } from 'discord.js';

const { syncDiscordUserIds } = userSyncModule;

interface SystemJobData {
    [key: string]: any;
}

// Export a function that takes the main client instance
export = function startSystemWorker(client: Client): Worker {
  // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

  logger.info(`[System Worker] Initializing BullMQ worker.`);

  const worker = new Worker<SystemJobData>('system-tasks', async (job: Job<SystemJobData>) => {
    logger.info(`[System Worker] Processing job '${job.name}' (ID: ${job.id}).`);
    try {
      switch (job.name) {
        case 'check-streamers':
          await checkStreamers(client);
          break;
        case 'sync-teams':
          await checkTeams(client);
          break;
        case 'sync-users':
          await syncDiscordUserIds(client);
          break;
        case 'collect-server-stats':
          await collectServerStats(client);
          break;
        default:
          logger.warn(`[System Worker] Unknown job name: ${job.name}`);
      }
    } catch (error) {
      logger.error(`[System Worker] Job '${job.name}' failed:`, { error });
      throw error; // Re-throw to let BullMQ handle the failure
    }
  }, {
    connection: redisOptions,
    concurrency: 1, // System tasks should probably run one at a time
  });

  worker.on('completed', (job: Job) => {
    logger.info(`[System Worker] Job '${job.name}' (ID: ${job.id}) has completed.`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[System Worker] Job '${job?.name}' (ID: ${job?.id}) has failed.`, { error: err });
  });

  // Graceful shutdown is handled by the main process.

  return worker;
};
