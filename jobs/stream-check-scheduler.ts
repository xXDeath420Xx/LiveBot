import { Queue, RepeatableJob } from 'bullmq';
import logger from '../utils/logger';
import { redisOptions } from '../utils/cache';

const TEAM_SYNC_INTERVAL_MS: number = 60 * 60 * 1000; // 1 hour
const STREAM_CHECK_INTERVAL_MS: number = 60 * 1000; // 1 minute - check streams frequently for accurate live status
const OLD_STREAM_CHECK_JOB_ID: string = 'check-all-streams';
const NEW_STREAM_CHECK_JOB_ID: string = 'check-streamers-recurring';
const TEAM_SYNC_JOB_ID: string = 'sync-all-teams';

const systemQueue: Queue = new Queue('system-tasks', { connection: redisOptions });

async function setupSystemJobs(): Promise<void> {
  logger.info('[Scheduler] Setting up system jobs and cleaning up old ones...');
  try {
    const repeatableJobs: RepeatableJob[] = await systemQueue.getRepeatableJobs();

    // Aggressively find and remove any old, conflicting stream check jobs.
    for (const job of repeatableJobs) {
        if (job.id === OLD_STREAM_CHECK_JOB_ID || job.name === 'check-streams') {
            await systemQueue.removeRepeatableByKey(job.key);
            logger.warn(`[Scheduler] Found and removed obsolete job '${job.name}' (ID: ${job.id}).`);
        }
    }

    // Ensure the stream check job is scheduled
    const streamCheckJob = repeatableJobs.find((job: RepeatableJob) => job.id === NEW_STREAM_CHECK_JOB_ID);
    if (!streamCheckJob) {
        await systemQueue.add('check-streamers', {}, {
            jobId: NEW_STREAM_CHECK_JOB_ID,
            repeat: {
              every: STREAM_CHECK_INTERVAL_MS,
            },
            removeOnComplete: true,
            removeOnFail: 10,
          });
        logger.info(`[Scheduler] Repeatable job '${NEW_STREAM_CHECK_JOB_ID}' scheduled (every ${STREAM_CHECK_INTERVAL_MS / 1000}s).`);
    } else {
        logger.info(`[Scheduler] Stream check job already scheduled.`);
    }

    // Ensure the team sync job is scheduled if it doesn't exist
    const teamSyncJob = repeatableJobs.find((job: RepeatableJob) => job.id === TEAM_SYNC_JOB_ID);
    if (!teamSyncJob) {
        await systemQueue.add('sync-teams', {}, {
            jobId: TEAM_SYNC_JOB_ID,
            repeat: {
              every: TEAM_SYNC_INTERVAL_MS,
            },
            removeOnComplete: true,
            removeOnFail: 10,
          });
        logger.info(`[Scheduler] Repeatable job '${TEAM_SYNC_JOB_ID}' scheduled.`);
    } else {
        logger.info(`[Scheduler] Team sync job already scheduled.`);
    }

  } catch (error: any) {
    logger.error('[Scheduler] Failed during system job setup:', { error: error.stack });
  }
}

// Initialize scheduler on startup
setupSystemJobs().catch((error: any) => {
  logger.error('[Scheduler] Fatal error during initialization:', { error: error.stack });
  process.exit(1);
});

export { setupSystemJobs };