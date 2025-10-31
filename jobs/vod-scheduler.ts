import { Queue, RepeatableJob } from 'bullmq';
import logger from '../utils/logger';
import db from '../utils/db';
import * as dotenvFlow from 'dotenv-flow';
dotenvFlow.config();

const VOD_CHECK_INTERVAL_MS: number = 30 * 60 * 1000; // 30 minutes

interface Streamer {
    streamer_id: number;
    platform: string;
    platform_user_id: string;
    username: string;
}

const vodQueue: Queue = new Queue('vod-uploads', {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
  },
});

async function scheduleVODChecks(): Promise<void> {
  logger.info('[VOD Scheduler] Setting up repeatable jobs for VOD checks...');
  try {
    // Find all unique streamers who have VOD notifications enabled for either platform in at least one subscription
    const [streamersToTrack] = await db.execute(`
        SELECT s.streamer_id, s.platform, s.platform_user_id, s.username
        FROM streamers s
        JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
        WHERE s.platform IN ('youtube', 'tiktok') AND (sub.youtube_vod_notifications = 1 OR sub.tiktok_vod_notifications = 1)
        GROUP BY s.streamer_id
    `) as [Streamer[], any];

    // Clear out old repeatable jobs that may no longer be valid
    const repeatableJobs: RepeatableJob[] = await vodQueue.getRepeatableJobs();
    const activeJobIds: Set<string> = new Set(streamersToTrack.map((s: Streamer) => `vod-check-${s.streamer_id}`));

    for (const job of repeatableJobs) {
        if (job.id && !activeJobIds.has(job.id)) {
            await vodQueue.removeRepeatableByKey(job.key);
        }
    }

    // Add new repeatable jobs
    for (const streamer of streamersToTrack) {
        const jobId: string = `vod-check-${streamer.streamer_id}`;
        await vodQueue.add('check-vod', { streamer }, {
            jobId: jobId,
            repeat: { every: VOD_CHECK_INTERVAL_MS },
            removeOnComplete: true,
            removeOnFail: 50,
        });
    }

    logger.info(`[VOD Scheduler] Sync complete. Tracking VODs for ${streamersToTrack.length} streamers.`);

  } catch (error) {
    logger.error('[VOD Scheduler] Failed to schedule VOD check jobs:', { _error });
  }
}

(async (): Promise<void> => {
  await scheduleVODChecks();
  await vodQueue.close();
  logger.info('[VOD Scheduler] VOD check scheduler finished and disconnected.');
  process.exit(0);
})();