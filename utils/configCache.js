import logger from './logger.js';

/**
 * TTL-based configuration cache to reduce database queries
 * Addresses: slow responses, database connection exhaustion
 */
class ConfigCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.ttl = options.ttl || 60000; // Default 60 seconds
    this.maxSize = options.maxSize || 10000; // Prevent unbounded growth
    this.cleanupInterval = options.cleanupInterval || 30000; // Cleanup every 30s

    // Start automatic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);

    logger.info('[ConfigCache] Initialized', { ttl: this.ttl, maxSize: this.maxSize });
  }

  /**
   * Generate cache key from type and identifier
   */
  _key(type, id) {
    return `${type}:${id}`;
  }

  /**
   * Get cached value or fetch from database
   * @param {string} type - Config type (e.g., 'level_config', 'automod')
   * @param {string} id - Identifier (usually guild_id)
   * @param {Function} fetcher - Async function to fetch from DB if not cached
   * @returns {Promise<any>} Cached or fetched value
   */
  async get(type, id, fetcher) {
    const key = this._key(type, id);
    const cached = this.cache.get(key);

    // Return cached value if still valid
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.value;
    }

    // Fetch fresh data
    try {
      const value = await fetcher();
      this.set(type, id, value);
      return value;
    } catch (error) {
      logger.error('[ConfigCache] Fetch error', { type, id, error: error.message });
      // Return stale cache if available, otherwise throw
      if (cached) {
        logger.warn('[ConfigCache] Returning stale cache due to fetch error', { type, id });
        return cached.value;
      }
      throw error;
    }
  }

  /**
   * Manually set a cache entry
   */
  set(type, id, value) {
    const key = this._key(type, id);

    // Enforce max size with LRU-like eviction
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate a specific cache entry
   * Call this when config is updated
   */
  invalidate(type, id) {
    const key = this._key(type, id);
    this.cache.delete(key);
    logger.debug('[ConfigCache] Invalidated', { type, id });
  }

  /**
   * Invalidate all entries of a specific type
   */
  invalidateType(type) {
    const prefix = `${type}:`;
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    logger.debug('[ConfigCache] Invalidated type', { type, count });
  }

  /**
   * Invalidate all entries for a guild
   */
  invalidateGuild(guildId) {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${guildId}`)) {
        this.cache.delete(key);
        count++;
      }
    }
    logger.debug('[ConfigCache] Invalidated guild', { guildId, count });
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('[ConfigCache] Cleanup complete', { cleaned, remaining: this.cache.size });
    }
  }

  /**
   * Get cache statistics
   */
  stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }

  /**
   * Stop the cleanup timer (call on shutdown)
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('[ConfigCache] Stopped');
    }
  }

  /**
   * Clear all cached entries
   */
  clear() {
    this.cache.clear();
    logger.info('[ConfigCache] Cleared all entries');
  }
}

// Export singleton instance
const configCache = new ConfigCache();

export default configCache;
export { ConfigCache };
