import { youtubeQueue } from './youtube-queue';
import db from '../utils/db';
import logger from '../utils/logger';
import * as dotenvFlow from 'dotenv-flow';
import { RepeatableJob } from 'bullmq';
dotenvFlow.config();

const CHECK_INTERVAL_MS: number = 15 * 60 * 1000; // 15 minutes

interface YouTubeSubscription {
    subscription_id: number;
    [key: string]: any;
}

async function syncYouTubeRepeatableJobs(): Promise<void> {
  logger.info('[YouTube Scheduler] Starting sync of repeatable YouTube jobs...');
  try {
    // 1. Get all subscriptions from the database
    const [subscriptions] = await db.execute('SELECT * FROM youtube_subscriptions') as [YouTubeSubscription[], any];
    const activeSubIds: Set<string | undefined> = new Set(subscriptions.map((s: YouTubeSubscription) => `check-${s.subscription_id}`));

    // 2. Get all existing repeatable jobs from the queue
    const repeatableJobs: RepeatableJob[] = await youtubeQueue.getRepeatableJobs();

    // 3. Remove jobs that are no longer in the database
    let removedCount: number = 0;
    for (const job of repeatableJobs) {
      if (job.id && !activeSubIds.has(job.id)) {
        await youtubeQueue.removeRepeatableByKey(job.key);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      logger.info(`[YouTube Scheduler] Removed ${removedCount} stale repeatable jobs.`);
    }

    // 4. Add new jobs for subscriptions that don't have one yet
    let addedCount: number = 0;
    const existingJobIds: Set<string | null | undefined> = new Set(repeatableJobs.map((j: RepeatableJob) => j.id));
    for (const sub of subscriptions) {
      const jobId: string = `check-${sub.subscription_id}`;
      if (!existingJobIds.has(jobId)) {
        // Add a random delay to stagger the checks and avoid a thundering herd
        const delay: number = Math.floor(Math.random() * CHECK_INTERVAL_MS);
        await youtubeQueue.add(`check-${sub.subscription_id}`, { subscription: sub }, {
          jobId: jobId,
          repeat: {
            every: CHECK_INTERVAL_MS,
            immediately: true // Run once immediately with a delay, then repeat on schedule
          },
          delay: delay,
          removeOnComplete: true,
          removeOnFail: 50
        });
        addedCount++;
      }
    }
    if (addedCount > 0) {
      logger.info(`[YouTube Scheduler] Added ${addedCount} new repeatable jobs.`);
    }

    logger.info(`[YouTube Scheduler] Sync complete. Total active repeatable jobs: ${activeSubIds.size}.`);

  } catch (error) {
    logger.error('[YouTube Scheduler] Critical _error during job sync:', { _error });
  }
}

// Run the synchronization on startup.
// This script is intended to be run as a separate process or once during application boot.
(async (): Promise<void> => {
  await syncYouTubeRepeatableJobs();
  // After syncing, the process can exit as BullMQ now manages the schedule.
  logger.info('[YouTube Scheduler] Initial sync finished. Exiting scheduler process.');
  // In a real-world scenario, you might not exit if this is part of a larger boot process.
  // For a standalone cron-style script, exiting is correct.
  process.exit(0);
})();