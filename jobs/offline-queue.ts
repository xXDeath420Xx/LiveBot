import { Queue } from 'bullmq';
import { redisOptions } from '../utils/cache';
import logger from '../utils/logger';

interface OfflineJobData {
    subscription_id: number;
    streamer_id: number;
    guild_id: string;
    username: string;
    platform: string;
    discord_user_id?: string;
    channel_id: string;
    message_id?: string;
    delete_on_end: boolean;
    role_ids: string[];  // All roles to remove (guild, team, subscription)
}

export const offlineQueue = new Queue<OfflineJobData>('offline-queue', {
    connection: redisOptions,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000
        },
        removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 1000
        },
        removeOnFail: {
            age: 86400 // Keep failed jobs for 24 hours
        }
    }
});

offlineQueue.on('error', (err: Error) => {
    logger.error('[Offline Queue] Queue error:', { error: err, category: 'streams' });
});

logger.info('[Offline Queue] Initialized offline queue');

export type { OfflineJobData };
