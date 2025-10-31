import { Queue, QueueOptions } from 'bullmq';
import { connection as redis } from '../utils/cache';
import logger from '../utils/logger';

// Create a new queue and reuse the existing ioredis client.
const announcementQueue: Queue = new Queue('announcements', {
  connection: redis
} as QueueOptions);

announcementQueue.on('error', (err: Error) => {
  logger.error('[BullMQ] Queue Error:', { error: err });
});

export { announcementQueue };