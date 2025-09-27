const {youtubeQueue} = require("./youtube-queue");
const db = require("../utils/db");
const logger = require("../utils/logger");
require("dotenv-flow").config();

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function syncYouTubeRepeatableJobs() {
  logger.info("[YouTube Scheduler] Starting sync of repeatable YouTube jobs...");
  try {
    // 1. Get all subscriptions from the database
    const [subscriptions] = await db.execute("SELECT * FROM youtube_subscriptions");
    const activeSubIds = new Set(subscriptions.map(s => `check-${s.subscription_id}`))

    // 2. Get all existing repeatable jobs from the queue
    const repeatableJobs = await youtubeQueue.getRepeatableJobs();

    // 3. Remove jobs that are no longer in the database
    let removedCount = 0;
    for (const job of repeatableJobs) {
      if (!activeSubIds.has(job.id)) {
        await youtubeQueue.removeRepeatableByKey(job.key);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      logger.info(`[YouTube Scheduler] Removed ${removedCount} stale repeatable jobs.`);
    }

    // 4. Add new jobs for subscriptions that don't have one yet
    let addedCount = 0;
    const existingJobIds = new Set(repeatableJobs.map(j => j.id));
    for (const sub of subscriptions) {
      const jobId = `check-${sub.subscription_id}`;
      if (!existingJobIds.has(jobId)) {
        // Add a random delay to stagger the checks and avoid a thundering herd
        const delay = Math.floor(Math.random() * CHECK_INTERVAL_MS);
        await youtubeQueue.add(`check-${sub.subscription_id}`, {subscription: sub}, {
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
    logger.error("[YouTube Scheduler] Critical error during job sync:", {error});
  }
}

// Run the synchronization on startup.
// This script is intended to be run as a separate process or once during application boot.
(async () => {
  await syncYouTubeRepeatableJobs();
  // After syncing, the process can exit as BullMQ now manages the schedule.
  logger.info("[YouTube Scheduler] Initial sync finished. Exiting scheduler process.");
  // In a real-world scenario, you might not exit if this is part of a larger boot process.
  // For a standalone cron-style script, exiting is correct.
  process.exit(0);
})();