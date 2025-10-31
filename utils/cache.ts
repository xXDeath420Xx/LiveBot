import Redis from 'ioredis';
import { logger } from './logger';
import * as dotenv from 'dotenv-flow';

dotenv.config(); // Ensure dotenv-flow is loaded in this process

// Debugging: Log Redis environment variables
console.log('[DEBUG] REDIS_HOST from process.env in cache.ts:', process.env.REDIS_HOST || 'NOT SET');
console.log('[DEBUG] REDIS_PORT from process.env in cache.ts:', process.env.REDIS_PORT || 'NOT SET');
console.log('[DEBUG] REDIS_PASSWORD from process.env in cache.ts:', process.env.REDIS_PASSWORD ? '********' + process.env.REDIS_PASSWORD.slice(-5) : 'NOT SET');

interface RedisOptions {
    host: string;
    port: number;
    password?: string;
    maxRetriesPerRequest: null;
    enableReadyCheck: boolean;
}

const redisOptions: RedisOptions = {
    host: process.env.REDIS_HOST as string,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

const connection: Redis = new Redis(redisOptions);

connection.on('error', (err: Error) => {
    logger.error('[Cache] Redis connection error:', { category: 'system', error: err.message });
});

connection.on('connect', () => {
    logger.info('[Cache] Connected to Redis.', { category: 'system' });
});

interface QueueOptions {
    connection: Redis;
}

const queueOptions: QueueOptions = {
    connection: connection,
};

// Helper functions for cache operations
async function getCache(key: string): Promise<string | null> {
    try {
        return await connection.get(key);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Cache] Failed to get key "${key}":`, { category: 'system', error: errorMessage });
        return null;
    }
}

async function setCache(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
        if (ttlSeconds) {
            await connection.setex(key, ttlSeconds, value);
        } else {
            await connection.set(key, value);
        }
        return true;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Cache] Failed to set key "${key}":`, { category: 'system', error: errorMessage });
        return false;
    }
}

async function deleteCache(key: string): Promise<boolean> {
    try {
        await connection.del(key);
        return true;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Cache] Failed to delete key "${key}":`, { category: 'system', error: errorMessage });
        return false;
    }
}

export {
    redisOptions,
    connection,
    connection as redis,
    queueOptions,
    getCache,
    setCache,
    deleteCache
};
