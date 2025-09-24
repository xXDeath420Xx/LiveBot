const {youtubeQueue} = require("./youtube-queue");
const db = require("../utils/db");
const logger = require("../utils/logger");
require("dotenv-flow").config(); // Corrected

async function scheduleYouTubeChecks() {
  logger.info("[YouTube Scheduler] Fetching all YouTube subscriptions...");
  try {
    const [subscriptions] = await db.execute("SELECT * FROM youtube_subscriptions");
    logger.info(`[YouTube Scheduler] Found ${subscriptions.length} subscriptions to check.`);

    for (const sub of subscriptions) {
      await youtubeQueue.add(`check-${sub.subscription_id}`, {subscription: sub}, {
        jobId: `check-${sub.subscription_id}`,
        removeOnComplete: true,
        removeOnFail: 50
      });
    }
  } catch (error) {
    logger.error("[YouTube Scheduler] Error fetching or queuing subscriptions:", {error});
  }
}

// Run on startup
scheduleYouTubeChecks();

// Schedule to run every 15 minutes
setInterval(scheduleYouTubeChecks, 15 * 60 * 1000);
