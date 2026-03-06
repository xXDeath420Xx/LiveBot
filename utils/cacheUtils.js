/**
 * Shared Cache Utilities
 * Provides reusable functions for cache management across all managers
 */

import logger from './logger.js';

/**
 * Enforce maximum size on a Map with FIFO eviction
 * @param {Map} map - The map to enforce size on
 * @param {number} maxSize - Maximum allowed size
 * @param {string} mapName - Name for logging purposes
 * @returns {number} Number of entries evicted
 */
export function enforceSizeLimit(map, maxSize, mapName = 'cache') {
    if (map.size <= maxSize) return 0;

    const entriesToDelete = map.size - maxSize;
    const iterator = map.keys();

    for (let i = 0; i < entriesToDelete; i++) {
        const key = iterator.next().value;
        map.delete(key);
    }

    logger.debug(`[CacheUtils] ${mapName} evicted ${entriesToDelete} entries (max: ${maxSize})`);
    return entriesToDelete;
}

/**
 * Clean up expired entries from a Map based on timestamp
 * @param {Map} map - Map with timestamp values or objects containing timestamps
 * @param {number} maxAge - Maximum age in milliseconds
 * @param {string} timestampKey - Key to access timestamp if values are objects (null if value is timestamp)
 * @param {string} mapName - Name for logging purposes
 * @returns {number} Number of entries removed
 */
export function cleanupExpiredEntries(map, maxAge, timestampKey = null, mapName = 'cache') {
    const now = Date.now();
    let removed = 0;

    for (const [key, value] of map.entries()) {
        const timestamp = timestampKey ? value[timestampKey] : value;
        if (typeof timestamp === 'number' && now - timestamp > maxAge) {
            map.delete(key);
            removed++;
        }
    }

    if (removed > 0) {
        logger.debug(`[CacheUtils] ${mapName} cleaned up ${removed} expired entries`);
    }

    return removed;
}

/**
 * Start a periodic cleanup interval with proper lifecycle management
 * @param {Function} cleanupFn - The cleanup function to run
 * @param {number} intervalMs - Interval in milliseconds
 * @param {string} name - Name for logging purposes
 * @returns {Object} Controller object with stop() method
 */
export function startPeriodicCleanup(cleanupFn, intervalMs, name = 'cleanup') {
    let interval = null;
    let running = true;

    const runCleanup = async () => {
        if (!running) return;
        try {
            await cleanupFn();
        } catch (error) {
            logger.error(`[CacheUtils] ${name} cleanup error:`, error);
        }
    };

    interval = setInterval(runCleanup, intervalMs);

    // Run initial cleanup after a short delay
    setTimeout(runCleanup, 5000);

    logger.debug(`[CacheUtils] Started ${name} cleanup interval (${intervalMs}ms)`);

    return {
        stop: () => {
            running = false;
            if (interval) {
                clearInterval(interval);
                interval = null;
                logger.debug(`[CacheUtils] Stopped ${name} cleanup interval`);
            }
        },
        isRunning: () => running
    };
}

/**
 * Create a TTL cache with automatic expiration
 * @param {number} defaultTTL - Default TTL in milliseconds
 * @param {number} maxSize - Maximum cache size
 * @param {string} name - Cache name for logging
 * @returns {Object} Cache object with get, set, delete, clear methods
 */
export function createTTLCache(defaultTTL = 60000, maxSize = 10000, name = 'ttl-cache') {
    const cache = new Map();

    const cleanup = startPeriodicCleanup(() => {
        cleanupExpiredEntries(cache, 0, 'expires', name);
        enforceSizeLimit(cache, maxSize, name);
    }, Math.min(defaultTTL, 60000), `${name}-ttl`);

    return {
        get: (key) => {
            const entry = cache.get(key);
            if (!entry) return undefined;
            if (Date.now() > entry.expires) {
                cache.delete(key);
                return undefined;
            }
            return entry.value;
        },

        set: (key, value, ttl = defaultTTL) => {
            cache.set(key, {
                value,
                expires: Date.now() + ttl
            });
            // Async size enforcement
            if (cache.size > maxSize * 1.1) {
                enforceSizeLimit(cache, maxSize, name);
            }
        },

        has: (key) => {
            const entry = cache.get(key);
            if (!entry) return false;
            if (Date.now() > entry.expires) {
                cache.delete(key);
                return false;
            }
            return true;
        },

        delete: (key) => cache.delete(key),

        clear: () => cache.clear(),

        size: () => cache.size,

        stop: () => cleanup.stop()
    };
}

/**
 * Create a deduplication tracker with time window
 * @param {number} windowMs - Deduplication window in milliseconds
 * @param {number} maxSize - Maximum tracked items
 * @param {string} name - Name for logging
 * @returns {Object} Deduplication tracker
 */
export function createDedupeTracker(windowMs = 60000, maxSize = 10000, name = 'dedupe') {
    const tracker = new Map();

    const cleanup = startPeriodicCleanup(() => {
        cleanupExpiredEntries(tracker, windowMs, null, name);
        enforceSizeLimit(tracker, maxSize, name);
    }, Math.min(windowMs, 60000), `${name}-cleanup`);

    return {
        /**
         * Check if key is duplicate and mark it
         * @param {string} key - The key to check
         * @returns {boolean} True if duplicate, false if new
         */
        isDuplicate: (key) => {
            const lastSeen = tracker.get(key);
            const now = Date.now();

            if (lastSeen && now - lastSeen < windowMs) {
                return true;
            }

            tracker.set(key, now);
            return false;
        },

        /**
         * Mark a key without checking
         * @param {string} key - The key to mark
         */
        mark: (key) => {
            tracker.set(key, Date.now());
        },

        /**
         * Check without marking
         * @param {string} key - The key to check
         * @returns {boolean} True if exists and not expired
         */
        exists: (key) => {
            const lastSeen = tracker.get(key);
            if (!lastSeen) return false;
            if (Date.now() - lastSeen >= windowMs) {
                tracker.delete(key);
                return false;
            }
            return true;
        },

        clear: () => tracker.clear(),

        size: () => tracker.size,

        stop: () => cleanup.stop()
    };
}

export default {
    enforceSizeLimit,
    cleanupExpiredEntries,
    startPeriodicCleanup,
    createTTLCache,
    createDedupeTracker
};
