/**
 * Database Fallback Utility
 * Provides graceful degradation when database is unavailable
 * Caches critical data and queues writes for retry
 */
import logger from './logger.js';
import pool from './db.js';

class DatabaseFallback {
  constructor() {
    // In-memory cache for critical data
    this.cache = new Map();
    // Write queue for operations that failed
    this.writeQueue = [];
    // Max queue size
    this.maxQueueSize = 1000;
    // Database health status
    this.isHealthy = true;
    this.lastHealthCheck = 0;
    this.healthCheckInterval = 30000; // 30 seconds
    // Retry interval for queued writes
    this.retryInterval = null;
    // Stats
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      queuedWrites: 0,
      failedWrites: 0,
      retriedWrites: 0
    };

    logger.info('[DBFallback] Database fallback system initialized');
  }

  /**
   * Check database health
   * @returns {Promise<boolean>} True if database is healthy
   */
  async checkHealth() {
    const now = Date.now();

    // Don't check too frequently
    if (now - this.lastHealthCheck < this.healthCheckInterval) {
      return this.isHealthy;
    }

    this.lastHealthCheck = now;

    try {
      await pool.execute('SELECT 1');
      if (!this.isHealthy) {
        logger.info('[DBFallback] Database connection restored');
        this.isHealthy = true;
        // Process queued writes
        this.processQueue();
      }
      return true;
    } catch (error) {
      if (this.isHealthy) {
        logger.error('[DBFallback] Database connection lost', { error: error.message });
        this.isHealthy = false;
        // Start retry interval if not already running
        this.startRetryInterval();
      }
      return false;
    }
  }

  /**
   * Execute a query with fallback handling
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @param {Object} options - Options { cache: boolean, cacheKey: string, cacheTTL: number, critical: boolean }
   * @returns {Promise<Array>} Query result or cached data
   */
  async query(sql, params = [], options = {}) {
    const { cache = false, cacheKey = null, cacheTTL = 60000, critical = false } = options;

    // Check cache first if enabled
    if (cache && cacheKey) {
      const cached = this.getFromCache(cacheKey);
      if (cached !== null) {
        this.stats.cacheHits++;
        return cached;
      }
      this.stats.cacheMisses++;
    }

    try {
      const result = await pool.execute(sql, params);

      // Update cache if enabled
      if (cache && cacheKey) {
        this.setCache(cacheKey, result, cacheTTL);
      }

      // Mark healthy on success
      if (!this.isHealthy) {
        this.isHealthy = true;
        logger.info('[DBFallback] Database connection restored');
      }

      return result;
    } catch (error) {
      this.isHealthy = false;

      // For critical queries, try to return cached data
      if (cache && cacheKey) {
        const cached = this.getFromCache(cacheKey, true); // Allow expired
        if (cached !== null) {
          logger.warn('[DBFallback] Returning stale cached data', { cacheKey });
          return cached;
        }
      }

      // Log and rethrow
      logger.error('[DBFallback] Database query failed', {
        error: error.message,
        sql: sql.substring(0, 100)
      });
      throw error;
    }
  }

  /**
   * Execute a write operation with queue fallback
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @param {Object} options - Options { retryable: boolean, priority: number }
   * @returns {Promise<Object>} Query result or queue confirmation
   */
  async write(sql, params = [], options = {}) {
    const { retryable = true, priority = 0 } = options;

    try {
      const result = await pool.execute(sql, params);

      if (!this.isHealthy) {
        this.isHealthy = true;
        logger.info('[DBFallback] Database connection restored');
      }

      return result;
    } catch (error) {
      this.isHealthy = false;

      if (retryable && this.writeQueue.length < this.maxQueueSize) {
        // Queue for retry
        this.writeQueue.push({
          sql,
          params,
          priority,
          timestamp: Date.now(),
          retries: 0
        });
        this.stats.queuedWrites++;

        logger.warn('[DBFallback] Write queued for retry', {
          queueSize: this.writeQueue.length,
          sql: sql.substring(0, 50)
        });

        // Start retry interval if not running
        this.startRetryInterval();

        return { queued: true, queuePosition: this.writeQueue.length };
      }

      this.stats.failedWrites++;
      throw error;
    }
  }

  /**
   * Get value from cache
   * @private
   */
  getFromCache(key, allowExpired = false) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (!allowExpired && now > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set cache value
   * @private
   */
  setCache(key, data, ttl) {
    // Enforce max cache size
    if (this.cache.size >= 10000) {
      // Remove oldest entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttl,
      createdAt: Date.now()
    });
  }

  /**
   * Invalidate cache entry
   * @param {string} key - Cache key
   */
  invalidateCache(key) {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries matching a pattern
   * @param {string} pattern - Pattern to match (uses startsWith)
   */
  invalidateCachePattern(pattern) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Start retry interval for queued writes
   * @private
   */
  startRetryInterval() {
    if (this.retryInterval) return;

    this.retryInterval = setInterval(async () => {
      if (this.writeQueue.length === 0) {
        clearInterval(this.retryInterval);
        this.retryInterval = null;
        return;
      }

      // Check health first
      const healthy = await this.checkHealth();
      if (healthy) {
        this.processQueue();
      }
    }, 30000); // Retry every 30 seconds
  }

  /**
   * Process queued writes
   * @private
   */
  async processQueue() {
    if (this.writeQueue.length === 0) return;

    logger.info(`[DBFallback] Processing ${this.writeQueue.length} queued writes`);

    // Sort by priority (higher first) then by timestamp (older first)
    this.writeQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.timestamp - b.timestamp;
    });

    const processed = [];
    const failed = [];

    for (const item of this.writeQueue) {
      try {
        await pool.execute(item.sql, item.params);
        processed.push(item);
        this.stats.retriedWrites++;
      } catch (error) {
        item.retries++;
        if (item.retries >= 3) {
          logger.error('[DBFallback] Write permanently failed after 3 retries', {
            sql: item.sql.substring(0, 50)
          });
          this.stats.failedWrites++;
        } else {
          failed.push(item);
        }
      }
    }

    // Keep only failed items that haven't exceeded retries
    this.writeQueue = failed;

    if (processed.length > 0) {
      logger.info(`[DBFallback] Processed ${processed.length} queued writes, ${failed.length} remaining`);
    }
  }

  /**
   * Get system status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      healthy: this.isHealthy,
      cacheSize: this.cache.size,
      queueSize: this.writeQueue.length,
      stats: { ...this.stats }
    };
  }

  /**
   * Stop the fallback system
   */
  stop() {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    this.cache.clear();
    this.writeQueue = [];
    logger.info('[DBFallback] Stopped and cleared');
  }
}

// Singleton instance
const dbFallback = new DatabaseFallback();

export default dbFallback;
export { DatabaseFallback };
