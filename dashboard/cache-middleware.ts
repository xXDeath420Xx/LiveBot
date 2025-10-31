/**
 * Redis Cache Middleware for CertiFried Announcer Dashboard
 * Provides caching layer with automatic fallback to database
 */

import Redis from 'ioredis';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import logger from '../utils/logger';

// Cache TTL configurations (in seconds)
export const CACHE_TTL = {
    MANAGE_PAGE_DATA: 60,      // 60 seconds for manage page data
    SERVER_LIST: 30,            // 30 seconds for server list
    LIVE_STREAMS: 15,           // 15 seconds for live stream data
    STATUS_PAGE: 10,            // 10 seconds for status page
    COMMANDS_LIST: 300,         // 5 minutes for commands list
    USER_SPECIFIC: 120,         // 2 minutes for user-specific data
    STATIC_CONFIG: 600          // 10 minutes for static configurations
};

// Redis connection configuration
const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Redis connection attempt ${times}, retrying in ${delay}ms`, { category: 'cache' });
        return delay;
    },
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: true
};

// Create Redis client with error handling
let redis: Redis | null = null;
let redisAvailable = false;

/**
 * Initialize Redis connection
 */
export async function initializeRedis(): Promise<void> {
    try {
        redis = new Redis(redisConfig);

        redis.on('connect', () => {
            redisAvailable = true;
            logger.info('Redis cache connected successfully', { category: 'cache' });
        });

        redis.on('error', (error) => {
            redisAvailable = false;
            logger.error('Redis cache error:', { error: error.message, category: 'cache' });
        });

        redis.on('close', () => {
            redisAvailable = false;
            logger.warn('Redis connection closed', { category: 'cache' });
        });

        // Test connection
        await redis.ping();
        redisAvailable = true;

    } catch (error) {
        redisAvailable = false;
        logger.error('Failed to initialize Redis:', { _error, category: 'cache' });
    }
}

/**
 * Generate cache key from request parameters
 */
function generateCacheKey(prefix: string, ...params: any[]): string {
    const hash = crypto
        .createHash('md5')
        .update(JSON.stringify(params))
        .digest('hex');
    return `certifried:${prefix}:${hash}`;
}

/**
 * Get data from cache with automatic fallback
 */
export async function getCachedData<T>(
    key: string,
    fallbackFn: () => Promise<T>,
    ttl: number = 60
): Promise<T> {
    // If Redis is not available, fallback immediately
    if (!redisAvailable || !redis) {
        logger.debug('Redis not available, using fallback', { key, category: 'cache' });
        return await fallbackFn();
    }

    try {
        // Try to get from cache
        const cached = await redis.get(key);

        if (cached) {
            logger.debug('Cache hit', { key, category: 'cache' });
            return JSON.parse(cached);
        }

        // Cache miss - get from fallback
        logger.debug('Cache miss', { key, category: 'cache' });
        const data = await fallbackFn();

        // Store in cache (fire and forget)
        redis.setex(key, ttl, JSON.stringify(data)).catch(err => {
            logger.error('Failed to store in cache:', { error: err.message, key, category: 'cache' });
        });

        return data;

    } catch (error) {
        logger.error('Cache operation failed, using fallback:', { _error, key, category: 'cache' });
        return await fallbackFn();
    }
}

/**
 * Invalidate cache entries matching pattern
 */
export async function invalidateCache(pattern: string): Promise<void> {
    if (!redisAvailable || !redis) {
        return;
    }

    try {
        const keys = await redis.keys(`certifried:${pattern}:*`);

        if (keys.length > 0) {
            await redis.del(...keys);
            logger.debug('Cache invalidated', { pattern, count: keys.length, category: 'cache' });
        }
    } catch (error) {
        logger.error('Failed to invalidate cache:', { _error, pattern, category: 'cache' });
    }
}

/**
 * Middleware for caching manage page data
 */
export function cacheManagePageData() {
    return async (req: Request, res: Response, next: NextFunction) => {
        const { guildId } = req.params;
        const page = req.path.split('/').pop();
        const cacheKey = generateCacheKey('manage', guildId, page);

        try {
            // Store original render function
            const originalRender = res.render.bind(res);

            // Override render to cache the data
            res.render = function(view: string, options?: any) {
                // Cache the options (data) being passed to render
                if (options && redisAvailable && redis) {
                    const dataToCache = {
                        ...options,
                        cached: true,
                        cachedAt: new Date().toISOString()
                    };

                    redis.setex(cacheKey, CACHE_TTL.MANAGE_PAGE_DATA, JSON.stringify(dataToCache))
                        .catch(err => {
                            logger.error('Failed to cache manage page data:', { error: err.message, category: 'cache' });
                        });
                }

                return originalRender(view, options);
            };
        } catch (error) {
            logger.error('Cache middleware _error:', { _error, category: 'cache' });
        }

        next();
    };
}

/**
 * Middleware for caching server list data
 */
export function cacheServerList() {
    return async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
        if (!req.user) {
            return next();
        }

        const cacheKey = generateCacheKey('servers', req.user.id);

        try {
            if (redisAvailable && redis) {
                const cached = await redis.get(cacheKey);
                if (cached) {
                    const data = JSON.parse(cached);
                    logger.debug('Server list cache hit', { userId: req.user.id, category: 'cache' });
                    return res.render('servers-modern', data);
                }
            }

            // Store original render function
            const originalRender = res.render.bind(res);

            // Override render to cache the data
            res.render = function(view: string, options?: any) {
                if (options && redisAvailable && redis) {
                    redis.setex(cacheKey, CACHE_TTL.SERVER_LIST, JSON.stringify(options))
                        .catch(err => {
                            logger.error('Failed to cache server list:', { error: err.message, category: 'cache' });
                        });
                }

                return originalRender(view, options);
            };
        } catch (error) {
            logger.error('Server list cache _error:', { _error, category: 'cache' });
        }

        next();
    };
}

/**
 * Middleware for caching live stream data
 */
export function cacheLiveStreams() {
    return async (req: Request, res: Response, next: NextFunction) => {
        const cacheKey = 'livestreams:all';

        try {
            // Store original json function
            const originalJson = res.json.bind(res);

            // Override json to cache the data
            res.json = function(data: any) {
                if (data && redisAvailable && redis) {
                    redis.setex(cacheKey, CACHE_TTL.LIVE_STREAMS, JSON.stringify(data))
                        .catch(err => {
                            logger.error('Failed to cache live streams:', { error: err.message, category: 'cache' });
                        });
                }

                return originalJson(data);
            };
        } catch (error) {
            logger.error('Live streams cache _error:', { _error, category: 'cache' });
        }

        next();
    };
}

/**
 * Cache invalidation handlers for data updates
 */

export async function invalidateGuildCache(guildId: string): Promise<void> {
    await invalidateCache(`manage:${guildId}`);
    await invalidateCache(`guild:${guildId}`);
    logger.info('Guild cache invalidated', { guildId, category: 'cache' });
}

export async function invalidateUserCache(userId: string): Promise<void> {
    await invalidateCache(`servers:${userId}`);
    await invalidateCache(`user:${userId}`);
    logger.info('User cache invalidated', { userId, category: 'cache' });
}

export async function invalidateLiveStreamCache(): Promise<void> {
    await invalidateCache('livestreams');
    logger.info('Live stream cache invalidated', { category: 'cache' });
}

export async function invalidateAllCache(): Promise<void> {
    if (!redisAvailable || !redis) {
        return;
    }

    try {
        const keys = await redis.keys('certifried:*');
        if (keys.length > 0) {
            await redis.del(...keys);
            logger.info('All cache invalidated', { count: keys.length, category: 'cache' });
        }
    } catch (error) {
        logger.error('Failed to invalidate all cache:', { _error, category: 'cache' });
    }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
    available: boolean;
    keys: number;
    memory: string;
    hits: number;
    misses: number;
}> {
    if (!redisAvailable || !redis) {
        return {
            available: false,
            keys: 0,
            memory: '0 MB',
            hits: 0,
            misses: 0
        };
    }

    try {
        const keys = await redis.keys('certifried:*');
        const info = await redis.info('memory');
        const memoryMatch = info.match(/used_memory_human:(.+)/);
        const memory = memoryMatch ? memoryMatch[1].trim() : 'Unknown';

        // Get hit/miss stats if available
        const statsInfo = await redis.info('stats');
        const hitsMatch = statsInfo.match(/keyspace_hits:(\d+)/);
        const missesMatch = statsInfo.match(/keyspace_misses:(\d+)/);

        return {
            available: true,
            keys: keys.length,
            memory,
            hits: hitsMatch ? parseInt(hitsMatch[1]) : 0,
            misses: missesMatch ? parseInt(missesMatch[1]) : 0
        };
    } catch (error) {
        logger.error('Failed to get cache stats:', { _error, category: 'cache' });
        return {
            available: false,
            keys: 0,
            memory: '0 MB',
            hits: 0,
            misses: 0
        };
    }
}

/**
 * Gracefully close Redis connection
 */
export async function closeRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
        redisAvailable = false;
        logger.info('Redis connection closed gracefully', { category: 'cache' });
    }
}

// Export Redis client for direct access if needed
export function getRedisClient(): Redis | null {
    return redis;
}

export default {
    initializeRedis,
    getCachedData,
    invalidateCache,
    invalidateGuildCache,
    invalidateUserCache,
    invalidateLiveStreamCache,
    invalidateAllCache,
    cacheManagePageData,
    cacheServerList,
    cacheLiveStreams,
    getCacheStats,
    closeRedis,
    getRedisClient,
    CACHE_TTL
};