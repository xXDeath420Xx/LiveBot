/**
 * Platform API Response Cache
 * Caches Twitch/YouTube/Kick API responses to reduce rate limit pressure
 * and improve performance when multiple bots check the same streamers
 */
import logger from './logger.js';

class PlatformCache {
  constructor(options = {}) {
    // Default TTL: 30 seconds (stream status doesn't need real-time updates)
    this.ttl = options.ttl || 30000;
    // Cache storage: Map<cacheKey, { data, timestamp }>
    this.cache = new Map();
    // Max cache size to prevent memory issues
    this.maxSize = options.maxSize || 5000;
    // In-flight requests for deduplication
    this.pendingRequests = new Map();

    // Cleanup interval - run every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);

    logger.info('[PlatformCache] Platform API cache initialized', {
      ttl: this.ttl,
      maxSize: this.maxSize
    });
  }

  /**
   * Generate cache key for a platform API request
   * @param {string} platform - Platform name (twitch, youtube, kick)
   * @param {string} method - API method (isLive, getDetails, etc.)
   * @param {string} identifier - Streamer username or ID
   * @returns {string} Cache key
   */
  generateKey(platform, method, identifier) {
    return `${platform}:${method}:${identifier.toLowerCase()}`;
  }

  /**
   * Get cached response or fetch fresh data
   * Automatically deduplicates concurrent requests for the same resource
   * @param {string} platform - Platform name
   * @param {string} method - API method
   * @param {string} identifier - Streamer identifier
   * @param {Function} fetcher - Async function to fetch fresh data
   * @returns {Promise<*>} Cached or fresh data
   */
  async get(platform, method, identifier, fetcher) {
    const key = this.generateKey(platform, method, identifier);

    // Check cache first
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      logger.debug(`[PlatformCache] Cache HIT: ${key}`);
      return cached.data;
    }

    // Check if there's already a pending request for this key
    if (this.pendingRequests.has(key)) {
      logger.debug(`[PlatformCache] Deduplicating request: ${key}`);
      return this.pendingRequests.get(key);
    }

    // Create new request and store it for deduplication
    const requestPromise = this.fetchAndCache(key, fetcher);
    this.pendingRequests.set(key, requestPromise);

    try {
      return await requestPromise;
    } finally {
      // Clean up pending request
      this.pendingRequests.delete(key);
    }
  }

  /**
   * Fetch data and cache the result
   * @private
   */
  async fetchAndCache(key, fetcher) {
    try {
      logger.debug(`[PlatformCache] Cache MISS, fetching: ${key}`);
      const data = await fetcher();

      // Enforce max size before adding new entry
      if (this.cache.size >= this.maxSize) {
        this.evictOldest();
      }

      this.cache.set(key, {
        data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      logger.error(`[PlatformCache] Fetch error for ${key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Evict the oldest cache entry
   * @private
   */
  evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug(`[PlatformCache] Evicted oldest entry: ${oldestKey}`);
    }
  }

  /**
   * Invalidate cache for a specific streamer
   * @param {string} platform - Platform name
   * @param {string} identifier - Streamer identifier
   */
  invalidate(platform, identifier) {
    const prefix = `${platform}:`;
    const suffix = `:${identifier.toLowerCase()}`;

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.cache.delete(key);
        logger.debug(`[PlatformCache] Invalidated: ${key}`);
      }
    }
  }

  /**
   * Invalidate all cache entries for a platform
   * @param {string} platform - Platform name
   */
  invalidatePlatform(platform) {
    const prefix = `${platform}:`;
    let count = 0;

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }

    if (count > 0) {
      logger.info(`[PlatformCache] Invalidated ${count} entries for platform: ${platform}`);
    }
  }

  /**
   * Clean up expired entries
   * @private
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[PlatformCache] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      pendingRequests: this.pendingRequests.size
    };
  }

  /**
   * Stop the cache (cleanup intervals)
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
    this.pendingRequests.clear();
    logger.info('[PlatformCache] Stopped and cleared');
  }
}

// Singleton instance
const platformCache = new PlatformCache();

export default platformCache;
export { PlatformCache };
