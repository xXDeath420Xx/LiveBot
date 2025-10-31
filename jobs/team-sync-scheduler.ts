import { Queue } from 'bullmq';
import logger from '../utils/logger';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { redisOptions } from '../utils/cache';

const CHECK_INTERVAL_MS: number = 60 * 60 * 1000; // 1 hour
const JOB_ID: string = 'sync-all-teams';

const systemQueue: Queue = new Queue('system-tasks', { connection: redisOptions });

async function addTeamSyncJob(): Promise<void> {
  logger.info('[Scheduler] Setting up repeatable job for team syncs...');
  try {
    await systemQueue.add('sync-teams', {}, {
      jobId: JOB_ID,
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      removeOnComplete: true,
      removeOnFail: 50,
    });
    logger.info(`[Scheduler] Repeatable job '${JOB_ID}' scheduled to run every ${CHECK_INTERVAL_MS / 1000 / 60} minutes.`);
  } catch (error) {
    logger.error('[Scheduler] Failed to add team sync job:', { _error });
  }
}

(async (): Promise<void> => {
  await addTeamSyncJob();
  await systemQueue.close();
  logger.info('[Scheduler] Team sync scheduler finished and disconnected.');
  process.exit(0);
})();