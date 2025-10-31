import { getCache, setCache } from './cache';
import { logger } from './logger';
import { Guild } from 'discord.js';

/**
 * Dashboard Cache Manager
 * Provides intelligent caching for expensive dashboard operations with:
 * - Configurable TTL per cache type
 * - Pattern-based cache invalidation
 * - Graceful fallback on Redis failures
 * - Automatic cache key generation
 * - Cache warming strategies
 */

// ============================================================================
// CACHE CONFIGURATION
// ============================================================================

export interface CacheConfig {
    ttl: number;  // Time to live in seconds
    prefix: string;
    invalidateOn?: string[];  // Event patterns that should invalidate this cache
}

const CACHE_CONFIGS: Record<string, CacheConfig> = {
    // Page data cache - moderate TTL, frequently invalidated
    pageData: {
        ttl: 120,  // 2 minutes - increased for better performance
        prefix: 'dashboard:page:',
        invalidateOn: ['config:*', 'subscription:*', 'guild:*']
    },

    // Static data cache - longer TTL, rarely changes
    staticData: {
        ttl: 300,  // 5 minutes
        prefix: 'dashboard:static:',
        invalidateOn: ['guild:structure']
    },

    // User data cache - short TTL for accuracy
    userData: {
        ttl: 30,
        prefix: 'dashboard:user:',
        invalidateOn: ['user:*']
    },

    // Statistics cache - moderate TTL
    statistics: {
        ttl: 60,
        prefix: 'dashboard:stats:',
        invalidateOn: ['stats:*']
    },

    // Economy data cache - short TTL for transactions
    economy: {
        ttl: 20,
        prefix: 'dashboard:economy:',
        invalidateOn: ['economy:*', 'transaction:*']
    }
};

// ============================================================================
// CACHE KEY GENERATION
// ============================================================================

function generateCacheKey(type: string, identifier: string, ...parts: string[]): string {
    const config = CACHE_CONFIGS[type];
    if (!config) {
        logger.warn(`[Dashboard Cache] Unknown cache type: ${type}`);
        return `dashboard:unknown:${identifier}:${parts.join(':')}`;
    }

    const key = [config.prefix + identifier, ...parts].filter(Boolean).join(':');
    return key;
}

// ============================================================================
// CACHE STATISTICS
// ============================================================================

interface CacheStats {
    hits: number;
    misses: number;
    errors: number;
    invalidations: number;
    lastHit?: Date;
    lastMiss?: Date;
}

const cacheStats: Map<string, CacheStats> = new Map();

function recordHit(type: string): void {
    const stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.hits++;
    stats.lastHit = new Date();
    cacheStats.set(type, stats);
}

function recordMiss(type: string): void {
    const stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.misses++;
    stats.lastMiss = new Date();
    cacheStats.set(type, stats);
}

function recordError(type: string): void {
    const stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.errors++;
    cacheStats.set(type, stats);
}

function recordInvalidation(type: string): void {
    const stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.invalidations++;
    cacheStats.set(type, stats);
}

export function getCacheStats(): Record<string, CacheStats> {
    const result: Record<string, CacheStats> = {};
    cacheStats.forEach((stats, type) => {
        result[type] = { ...stats };
    });
    return result;
}

export function getCacheHitRate(type?: string): number {
    if (type) {
        const stats = cacheStats.get(type);
        if (!stats || (stats.hits + stats.misses) === 0) return 0;
        return (stats.hits / (stats.hits + stats.misses)) * 100;
    }

    // Overall hit rate
    let totalHits = 0;
    let totalMisses = 0;
    cacheStats.forEach((stats) => {
        totalHits += stats.hits;
        totalMisses += stats.misses;
    });
    if ((totalHits + totalMisses) === 0) return 0;
    return (totalHits / (totalHits + totalMisses)) * 100;
}

// ============================================================================
// CORE CACHE OPERATIONS
// ============================================================================

/**
 * Get data from cache or execute the provided function and cache the result
 */
export async function getCachedOrFetch<T>(
    type: string,
    identifier: string,
    fetchFunction: () => Promise<T>,
    options?: {
        ttl?: number;
        skipCache?: boolean;
        parts?: string[];
    }
): Promise<T> {
    // Skip cache if requested
    if (options?.skipCache) {
        return await fetchFunction();
    }

    const cacheKey = generateCacheKey(type, identifier, ...(options?.parts || []));

    try {
        // Try to get from cache
        const cached = await getCache(cacheKey);
        if (cached !== null) {
            recordHit(type);
            logger.debug(`[Dashboard Cache] Cache hit for ${type}:${identifier}`);
            return JSON.parse(cached) as T;
        }

        recordMiss(type);
        logger.debug(`[Dashboard Cache] Cache miss for ${type}:${identifier}`);
    } catch (error: any) {
        recordError(type);
        logger.error(`[Dashboard Cache] Error reading cache for ${type}:${identifier}`, {
            error: error.message,
            stack: error.stack
        });
        // Fall through to fetch
    }

    // Fetch fresh data
    const data = await fetchFunction();

    // Cache the result
    try {
        const config = CACHE_CONFIGS[type];
        const ttl = options?.ttl || config?.ttl || 60;
        await setCache(cacheKey, JSON.stringify(data), ttl);
        logger.debug(`[Dashboard Cache] Cached ${type}:${identifier} with TTL ${ttl}s`);
    } catch (error: any) {
        recordError(type);
        logger.error(`[Dashboard Cache] Error setting cache for ${type}:${identifier}`, {
            error: error.message
        });
        // Don't throw - just return the data uncached
    }

    return data;
}

/**
 * Invalidate cache entries matching a pattern
 */
export async function invalidateCache(pattern: string): Promise<number> {
    try {
        // Import connection from cache module to use scan
        const { connection } = await import('./cache');

        let cursor = '0';
        let deletedCount = 0;
        const matchPattern = pattern.includes('*') ? pattern : `${pattern}*`;

        // Use Redis SCAN to find matching keys
        do {
            const [newCursor, keys] = await connection.scan(
                cursor,
                'MATCH',
                matchPattern,
                'COUNT',
                100
            );
            cursor = newCursor;

            if (keys.length > 0) {
                await connection.del(...keys);
                deletedCount += keys.length;
            }
        } while (cursor !== '0');

        if (deletedCount > 0) {
            logger.info(`[Dashboard Cache] Invalidated ${deletedCount} cache entries matching pattern: ${pattern}`);

            // Record invalidation for stats
            for (const type of Object.keys(CACHE_CONFIGS)) {
                recordInvalidation(type);
            }
        }

        return deletedCount;
    } catch (error: any) {
        logger.error(`[Dashboard Cache] Error invalidating cache pattern ${pattern}`, {
            error: error.message,
            stack: error.stack
        });
        return 0;
    }
}

/**
 * Invalidate cache for a specific guild
 */
export async function invalidateGuildCache(guildId: string): Promise<void> {
    await invalidateCache(`dashboard:*:${guildId}:*`);
    await invalidateCache(`dashboard:*:${guildId}`);
    logger.debug(`[Dashboard Cache] Invalidated all cache for guild ${guildId}`);
}

/**
 * Invalidate specific cache type for a guild
 */
export async function invalidateCacheType(type: string, guildId: string): Promise<void> {
    const config = CACHE_CONFIGS[type];
    if (!config) {
        logger.warn(`[Dashboard Cache] Cannot invalidate unknown cache type: ${type}`);
        return;
    }

    await invalidateCache(`${config.prefix}${guildId}*`);
    logger.debug(`[Dashboard Cache] Invalidated ${type} cache for guild ${guildId}`);
}

// ============================================================================
// SPECIALIZED CACHING FUNCTIONS
// ============================================================================

/**
 * Cache wrapper specifically for getManagePageData
 */
export async function getCachedManagePageData<T>(
    guildId: string,
    page: string,
    fetchFunction: () => Promise<T>,
    skipCache = false
): Promise<T> {
    return getCachedOrFetch(
        'pageData',
        guildId,
        fetchFunction,
        {
            parts: [page],
            skipCache
        }
    );
}

/**
 * Cache wrapper for roles and channels (static Discord data)
 */
export async function getCachedGuildStructure<T>(
    guildId: string,
    fetchFunction: () => Promise<T>
): Promise<T> {
    return getCachedOrFetch(
        'staticData',
        guildId,
        fetchFunction,
        {
            parts: ['structure']
        }
    );
}

/**
 * Cache wrapper for user-specific data
 */
export async function getCachedUserData<T>(
    guildId: string,
    userId: string,
    dataType: string,
    fetchFunction: () => Promise<T>
): Promise<T> {
    return getCachedOrFetch(
        'userData',
        guildId,
        fetchFunction,
        {
            parts: [userId, dataType]
        }
    );
}

/**
 * Cache wrapper for statistics
 */
export async function getCachedStatistics<T>(
    guildId: string,
    statType: string,
    fetchFunction: () => Promise<T>
): Promise<T> {
    return getCachedOrFetch(
        'statistics',
        guildId,
        fetchFunction,
        {
            parts: [statType]
        }
    );
}

// ============================================================================
// CACHE WARMING
// ============================================================================

/**
 * Pre-warm cache for a guild by loading common pages
 */
export async function warmGuildCache(
    guildId: string,
    botGuild: Guild,
    getManagePageDataFn: (guildId: string, guild: Guild) => Promise<any>
): Promise<void> {
    try {
        logger.info(`[Dashboard Cache] Warming cache for guild ${guildId}`);

        // Load the main page data to warm the cache
        await getCachedManagePageData(
            guildId,
            'streamers',
            () => getManagePageDataFn(guildId, botGuild)
        );

        logger.info(`[Dashboard Cache] Cache warmed for guild ${guildId}`);
    } catch (error: any) {
        logger.error(`[Dashboard Cache] Error warming cache for guild ${guildId}`, {
            error: error.message
        });
    }
}

// ============================================================================
// MIDDLEWARE FOR AUTOMATIC CACHE INVALIDATION
// ============================================================================

/**
 * Middleware to invalidate cache after POST operations
 */
export function createCacheInvalidationMiddleware() {
    return async (req: any, res: any, next: any) => {
        const originalJson = res.json.bind(res);
        const originalRedirect = res.redirect.bind(res);

        const invalidateIfNeeded = async () => {
            // Only invalidate on successful POST/PUT/DELETE/PATCH
            if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
                const guildId = req.params?.guildId;
                if (guildId) {
                    await invalidateGuildCache(guildId);
                }
            }
        };

        // Override json response
        res.json = function(data: any) {
            invalidateIfNeeded().finally(() => {
                originalJson(data);
            });
        };

        // Override redirect
        res.redirect = function(...args: any[]) {
            invalidateIfNeeded().finally(() => {
                originalRedirect(...args);
            });
        };

        next();
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    getCachedOrFetch,
    getCachedManagePageData,
    getCachedGuildStructure,
    getCachedUserData,
    getCachedStatistics,
    invalidateCache,
    invalidateGuildCache,
    invalidateCacheType,
    warmGuildCache,
    createCacheInvalidationMiddleware,
    getCacheStats,
    getCacheHitRate
};
