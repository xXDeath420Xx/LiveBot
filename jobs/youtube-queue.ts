import { Queue } from 'bullmq';
import logger from '../utils/logger';

const youtubeQueue: Queue = new Queue('youtube-uploads', {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379
  }
});

youtubeQueue.on('error', (err: Error) => {
  logger.error('[BullMQ] YouTube Queue Error:', { error: err });
});

export { youtubeQueue };