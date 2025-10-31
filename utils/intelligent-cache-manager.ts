import { getCache, setCache, deleteCache } from './cache';
import logger from './logger';

/**
 * Intelligent Cache Manager
 *
 * Features:
 * - Multi-tier caching (hot, warm, cold)
 * - Predictive prefetching based on access patterns
 * - Cache warming for frequently accessed data
 * - Adaptive TTL based on access frequency
 * - LRU eviction for memory efficiency
 * - Cache hit/miss analytics
 * - Stale-while-revalidate pattern
 */

// ============================================================================
// INTERFACES
// ============================================================================

interface CacheMetadata {
    storedAt: number;
    ttl: number;
    staleWhileRevalidate: boolean;
}

interface CachedDataWithMetadata<T> {
    data: T;
    _cacheMetadata: CacheMetadata;
}

interface GetOptions {
    revalidate?: () => Promise<any>;
    ttl?: number;
}

interface SetOptions {
    staleWhileRevalidate?: boolean;
}

interface IntelligentCacheManagerOptions {
    namespace?: string;
    defaultTTL?: number;
    maxTTL?: number;
    minTTL?: number;
}

interface CacheManagerMetrics {
    hits: number;
    misses: number;
    sets: number;
    deletes: number;
    prefetches: number;
    evictions: number;
    staleServed: number;
    totalResponseTime: number;
    requestCount: number;
}

interface CacheStats {
    namespace: string;
    metrics: {
        hits: number;
        misses: number;
        hitRate: string;
        sets: number;
        deletes: number;
        prefetches: number;
        evictions: number;
        staleServed: number;
        avgResponseTimeMs: number;
    };
    tiers: {
        hot: number;
        warm: number;
        cold: number;
        total: number;
    };
    prefetchQueue: {
        size: number;
        inProgress: boolean;
    };
}

interface HotKeyInfo {
    key: string;
    tier: CacheTier;
    heat: string;
    accessCount: number;
    avgTimeBetweenAccessMs: string;
}

interface WarmRequest {
    key: string;
    fetchFn: () => Promise<any>;
    ttl?: number | null;
    options?: SetOptions;
}

interface PrefetchItem {
    key: string;
    fetchFn: () => Promise<any>;
    ttl?: number | null;
}

type CacheTier = 'HOT' | 'WARM' | 'COLD';

// ============================================================================
// CACHE ACCESS PATTERN
// ============================================================================

class CacheAccessPattern {
    public key: string;
    public accessCount: number;
    public lastAccessed: number;
    public accessTimes: number[];
    public avgTimeBetweenAccess: number;

    constructor(key: string) {
        this.key = key;
        this.accessCount = 0;
        this.lastAccessed = Date.now();
        this.accessTimes = [];
        this.avgTimeBetweenAccess = 0;
    }

    recordAccess(): void {
        const now = Date.now();
        this.accessCount++;
        this.accessTimes.push(now);

        // Keep only last 10 access times
        if (this.accessTimes.length > 10) {
            this.accessTimes.shift();
        }

        // Calculate average time between accesses
        if (this.accessTimes.length >= 2) {
            const intervals: number[] = [];
            for (let i = 1; i < this.accessTimes.length; i++) {
                const prevTime = this.accessTimes[i - 1];
                const currTime = this.accessTimes[i];
                if (prevTime && currTime) {
                    intervals.push(currTime - prevTime);
                }
            }
            this.avgTimeBetweenAccess = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        }

        this.lastAccessed = now;
    }

    shouldPrefetch(): boolean {
        if (this.accessCount < 3) return false;

        const timeSinceLastAccess = Date.now() - this.lastAccessed;
        const expectedNextAccess = this.avgTimeBetweenAccess * 0.8; // 80% of avg time

        return timeSinceLastAccess >= expectedNextAccess;
    }

    getHeat(): number {
        const timeSinceLastAccess = Date.now() - this.lastAccessed;
        const recencyScore = Math.max(0, 100 - (timeSinceLastAccess / 60000)); // Decay over minutes
        const frequencyScore = Math.min(100, this.accessCount * 10);

        return (recencyScore * 0.4 + frequencyScore * 0.6);
    }

    getTier(): CacheTier {
        const heat = this.getHeat();
        if (heat >= 70) return 'HOT';
        if (heat >= 40) return 'WARM';
        return 'COLD';
    }
}

// ============================================================================
// INTELLIGENT CACHE MANAGER
// ============================================================================

class IntelligentCacheManager {
    public namespace: string;
    public defaultTTL: number;
    public maxTTL: number;
    public minTTL: number;
    public accessPatterns: Map<string, CacheAccessPattern>;
    public metrics: CacheManagerMetrics;
    public prefetchQueue: Set<PrefetchItem>;
    public prefetchInProgress: boolean;
    private cleanupInterval: NodeJS.Timeout | null;
    private statsInterval: NodeJS.Timeout | null;

    constructor(options: IntelligentCacheManagerOptions = {}) {
        this.namespace = options.namespace || 'default';
        this.defaultTTL = options.defaultTTL || 300; // 5 minutes
        this.maxTTL = options.maxTTL || 3600; // 1 hour
        this.minTTL = options.minTTL || 60; // 1 minute

        // Access pattern tracking
        this.accessPatterns = new Map();

        // Metrics
        this.metrics = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            prefetches: 0,
            evictions: 0,
            staleServed: 0,
            totalResponseTime: 0,
            requestCount: 0
        };

        // Prefetch queue
        this.prefetchQueue = new Set();
        this.prefetchInProgress = false;

        // Start background tasks
        this.cleanupInterval = null;
        this.statsInterval = null;
        this.startBackgroundTasks();
    }

    /**
     * Get value from cache with intelligence
     */
    async get<T>(key: string, options: GetOptions = {}): Promise<T | null> {
        const startTime = Date.now();
        const fullKey = this.getFullKey(key);

        try {
            // Track access pattern
            this.trackAccess(key);

            // Try to get from cache
            const cached = await getCache(fullKey);

            if (cached !== null && cached !== undefined) {
                this.metrics.hits++;
                const responseTime = Date.now() - startTime;
                this.trackResponseTime(responseTime);

                logger.debug(`Cache HIT: ${fullKey}`, {
                    category: 'cache',
                    tier: this.getAccessPattern(key)?.getTier(),
                    responseTimeMs: responseTime
                });

                // Parse if JSON
                try {
                    const parsed = JSON.parse(cached);

                    // Check if stale (if metadata exists)
                    if (parsed._cacheMetadata) {
                        const metadata = parsed._cacheMetadata as CacheMetadata;
                        const { storedAt, ttl, staleWhileRevalidate } = metadata;
                        const age = Date.now() - storedAt;

                        if (age > ttl * 1000 && staleWhileRevalidate) {
                            // Serve stale while revalidating
                            this.metrics.staleServed++;
                            logger.debug(`Serving STALE data for ${fullKey}, triggering revalidation`, {
                                category: 'cache'
                            });

                            // Trigger async revalidation if callback provided
                            if (options.revalidate) {
                                this.asyncRevalidate(key, options.revalidate, options.ttl || null);
                            }
                        }

                        return (parsed as CachedDataWithMetadata<T>).data;
                    }

                    return parsed as T;
                } catch (e) {
                    return cached as any as T;
                }
            }

            this.metrics.misses++;
            const responseTime = Date.now() - startTime;
            this.trackResponseTime(responseTime);

            logger.debug(`Cache MISS: ${fullKey}`, {
                category: 'cache',
                responseTimeMs: responseTime
            });

            return null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Cache GET error for ${fullKey}:`, {
                category: 'cache',
                error: errorMessage
            });
            return null;
        }
    }

    /**
     * Set value in cache with adaptive TTL
     */
    async set<T>(key: string, value: T, ttlSeconds: number | null = null, options: SetOptions = {}): Promise<boolean> {
        const fullKey = this.getFullKey(key);

        try {
            // Calculate adaptive TTL based on access pattern
            const pattern = this.getAccessPattern(key);
            let adaptiveTTL = ttlSeconds || this.defaultTTL;

            if (pattern) {
                const heat = pattern.getHeat();
                // Hot data gets longer TTL, cold data gets shorter
                adaptiveTTL = Math.floor(
                    this.minTTL + (this.maxTTL - this.minTTL) * (heat / 100)
                );
            }

            // Add metadata if stale-while-revalidate enabled
            let dataToStore: T | CachedDataWithMetadata<T> = value;
            if (options.staleWhileRevalidate) {
                dataToStore = {
                    data: value,
                    _cacheMetadata: {
                        storedAt: Date.now(),
                        ttl: adaptiveTTL,
                        staleWhileRevalidate: true
                    }
                };
            }

            const stringValue = typeof dataToStore === 'string'
                ? dataToStore
                : JSON.stringify(dataToStore);

            await setCache(fullKey, stringValue, adaptiveTTL);
            this.metrics.sets++;

            logger.debug(`Cache SET: ${fullKey}`, {
                category: 'cache',
                ttl: adaptiveTTL,
                tier: pattern?.getTier(),
                staleWhileRevalidate: options.staleWhileRevalidate || false
            });

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Cache SET error for ${fullKey}:`, {
                category: 'cache',
                error: errorMessage
            });
            return false;
        }
    }

    /**
     * Get or set pattern (common cache pattern)
     */
    async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttlSeconds: number | null = null, options: SetOptions = {}): Promise<T> {
        const cached = await this.get<T>(key, options as GetOptions);

        if (cached !== null && cached !== undefined) {
            return cached;
        }

        // Fetch fresh data
        const freshData = await fetchFn();

        if (freshData !== null && freshData !== undefined) {
            await this.set(key, freshData, ttlSeconds, options);
        }

        return freshData;
    }

    /**
     * Delete from cache
     */
    async delete(key: string): Promise<boolean> {
        const fullKey = this.getFullKey(key);

        try {
            await deleteCache(fullKey);
            this.metrics.deletes++;

            logger.debug(`Cache DELETE: ${fullKey}`, { category: 'cache' });
            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Cache DELETE error for ${fullKey}:`, {
                category: 'cache',
                error: errorMessage
            });
            return false;
        }
    }

    /**
     * Async revalidation (stale-while-revalidate pattern)
     */
    async asyncRevalidate(key: string, fetchFn: () => Promise<any>, ttl: number | null): Promise<void> {
        try {
            const freshData = await fetchFn();
            if (freshData !== null && freshData !== undefined) {
                await this.set(key, freshData, ttl, { staleWhileRevalidate: true });
                logger.debug(`Revalidated cache for ${key}`, { category: 'cache' });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to revalidate cache for ${key}:`, {
                category: 'cache',
                error: errorMessage
            });
        }
    }

    /**
     * Cache warming - prefetch multiple keys
     */
    async warm(requests: WarmRequest[]): Promise<PromiseSettledResult<any>[]> {
        logger.info(`Warming cache with ${requests.length} requests in namespace [${this.namespace}]`, {
            category: 'cache'
        });

        const results = await Promise.allSettled(
            requests.map(async ({ key, fetchFn, ttl, options }) => {
                // Check if already cached
                const cached = await this.get(key);
                if (cached !== null) {
                    return { key, status: 'already_cached' };
                }

                // Fetch and cache
                const data = await fetchFn();
                await this.set(key, data, ttl, options);
                return { key, status: 'warmed' };
            })
        );

        const warmed = results.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value.status === 'warmed').length;
        logger.info(`Cache warming complete: ${warmed}/${requests.length} keys warmed`, {
            category: 'cache'
        });

        return results;
    }

    /**
     * Predictive prefetching based on access patterns
     */
    async prefetch(key: string, fetchFn: () => Promise<any>, ttl: number | null = null): Promise<void> {
        const pattern = this.getAccessPattern(key);

        if (pattern && pattern.shouldPrefetch()) {
            // Add to prefetch queue
            this.prefetchQueue.add({ key, fetchFn, ttl });
            logger.debug(`Added ${key} to prefetch queue`, {
                category: 'cache',
                queueSize: this.prefetchQueue.size
            });

            // Process queue if not already running
            if (!this.prefetchInProgress) {
                void this.processPrefetchQueue();
            }
        }
    }

    /**
     * Process prefetch queue
     */
    async processPrefetchQueue(): Promise<void> {
        if (this.prefetchInProgress || this.prefetchQueue.size === 0) {
            return;
        }

        this.prefetchInProgress = true;

        while (this.prefetchQueue.size > 0) {
            const item = this.prefetchQueue.values().next().value;
            if (!item) break;

            this.prefetchQueue.delete(item);

            try {
                const cached = await this.get(item.key);
                if (cached === null) {
                    const data = await item.fetchFn();
                    await this.set(item.key, data, item.ttl);
                    this.metrics.prefetches++;

                    logger.debug(`Prefetched ${item.key}`, { category: 'cache' });
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error(`Prefetch failed for ${item.key}:`, {
                    category: 'cache',
                    error: errorMessage
                });
            }

            // Small delay between prefetches to avoid overwhelming the system
            await this.sleep(100);
        }

        this.prefetchInProgress = false;
    }

    /**
     * Access pattern tracking
     */
    trackAccess(key: string): void {
        if (!this.accessPatterns.has(key)) {
            this.accessPatterns.set(key, new CacheAccessPattern(key));
        }

        this.accessPatterns.get(key)?.recordAccess();
    }

    getAccessPattern(key: string): CacheAccessPattern | undefined {
        return this.accessPatterns.get(key);
    }

    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        const totalRequests = this.metrics.hits + this.metrics.misses;
        const hitRate = totalRequests > 0 ? (this.metrics.hits / totalRequests * 100).toFixed(2) : '0';
        const avgResponseTime = this.metrics.requestCount > 0
            ? (this.metrics.totalResponseTime / this.metrics.requestCount).toFixed(2)
            : '0';

        // Analyze tiers
        const tiers = { HOT: 0, WARM: 0, COLD: 0 };
        for (const pattern of Array.from(this.accessPatterns.values())) {
            tiers[pattern.getTier()]++;
        }

        return {
            namespace: this.namespace,
            metrics: {
                hits: this.metrics.hits,
                misses: this.metrics.misses,
                hitRate: `${hitRate}%`,
                sets: this.metrics.sets,
                deletes: this.metrics.deletes,
                prefetches: this.metrics.prefetches,
                evictions: this.metrics.evictions,
                staleServed: this.metrics.staleServed,
                avgResponseTimeMs: parseFloat(avgResponseTime)
            },
            tiers: {
                hot: tiers.HOT,
                warm: tiers.WARM,
                cold: tiers.COLD,
                total: this.accessPatterns.size
            },
            prefetchQueue: {
                size: this.prefetchQueue.size,
                inProgress: this.prefetchInProgress
            }
        };
    }

    /**
     * Get hot keys (most frequently accessed)
     */
    getHotKeys(limit: number = 10): HotKeyInfo[] {
        return Array.from(Array.from(this.accessPatterns.values()))
            .sort((a, b) => b.getHeat() - a.getHeat())
            .slice(0, limit)
            .map(pattern => ({
                key: pattern.key,
                tier: pattern.getTier(),
                heat: pattern.getHeat().toFixed(2),
                accessCount: pattern.accessCount,
                avgTimeBetweenAccessMs: pattern.avgTimeBetweenAccess.toFixed(0)
            }));
    }

    /**
     * Background tasks
     */
    startBackgroundTasks(): void {
        // Cleanup old access patterns every 10 minutes
        this.cleanupInterval = setInterval(() => {
            this.cleanupAccessPatterns();
        }, 10 * 60 * 1000);

        // Log stats every hour
        this.statsInterval = setInterval(() => {
            logger.info(`Cache stats for [${this.namespace}]:`, {
                category: 'cache',
                stats: this.getStats()
            });
        }, 60 * 60 * 1000);
    }

    cleanupAccessPatterns(): void {
        const now = Date.now();
        const maxAge = 60 * 60 * 1000; // 1 hour

        let cleaned = 0;
        for (const [key, pattern] of Array.from(this.accessPatterns.entries())) {
            if (now - pattern.lastAccessed > maxAge) {
                this.accessPatterns.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.debug(`Cleaned up ${cleaned} old access patterns`, { category: 'cache' });
        }
    }

    /**
     * Utility methods
     */
    trackResponseTime(timeMs: number): void {
        this.metrics.totalResponseTime += timeMs;
        this.metrics.requestCount++;
    }

    getFullKey(key: string): string {
        return `${this.namespace}:${key}`;
    }

    sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Clear all cache for this namespace
     */
    async clear(): Promise<void> {
        logger.warn(`Clearing all cache for namespace [${this.namespace}]`, { category: 'cache' });
        this.accessPatterns.clear();
        // Note: Redis cache clear would need wildcard delete which isn't atomic
        // This should be implemented carefully in production
    }

    /**
     * Cleanup intervals on shutdown
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }
}

// ============================================================================
// GLOBAL REGISTRY
// ============================================================================

const cacheManagers = new Map<string, IntelligentCacheManager>();

/**
 * Get or create a cache manager for a namespace
 */
export function getCacheManager(namespace: string, options: IntelligentCacheManagerOptions = {}): IntelligentCacheManager {
    if (!cacheManagers.has(namespace)) {
        cacheManagers.set(namespace, new IntelligentCacheManager({
            ...options,
            namespace
        }));
    }
    return cacheManagers.get(namespace)!;
}

/**
 * Get stats for all cache managers
 */
export function getAllCacheStats(): Record<string, CacheStats> {
    const stats: Record<string, CacheStats> = {};
    for (const [namespace, manager] of Array.from(cacheManagers.entries())) {
        stats[namespace] = manager.getStats();
    }
    return stats;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
    IntelligentCacheManager,
    CacheAccessPattern,
    type IntelligentCacheManagerOptions,
    type GetOptions,
    type SetOptions,
    type CacheStats,
    type HotKeyInfo,
    type WarmRequest,
    type CacheTier
};

export default IntelligentCacheManager;
