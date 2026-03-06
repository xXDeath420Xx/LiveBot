/**
 * Rate Limiter Utility
 * Provides flexible rate limiting for commands and actions
 */
import logger from './logger.js';

class RateLimiter {
  constructor() {
    // Map<key, { count: number, resetTime: number, blocked: boolean }>
    this.limits = new Map();
    // Default limits by category
    this.defaultLimits = {
      command: { max: 5, windowMs: 10000 },       // 5 per 10 seconds
      economy: { max: 10, windowMs: 60000 },      // 10 per minute
      music: { max: 20, windowMs: 60000 },        // 20 per minute
      moderation: { max: 5, windowMs: 30000 },    // 5 per 30 seconds
      api: { max: 30, windowMs: 60000 },          // 30 per minute (external APIs)
      expensive: { max: 3, windowMs: 60000 },     // 3 per minute (heavy operations)
    };
    // Max entries before cleanup
    this.maxEntries = 50000;
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);

    logger.info('[RateLimiter] Rate limiter initialized');
  }

  /**
   * Generate a rate limit key
   * @param {string} category - Rate limit category
   * @param {string} identifier - User ID, guild ID, or other identifier
   * @param {string} action - Optional action name for granular limiting
   * @returns {string} Rate limit key
   */
  getKey(category, identifier, action = '') {
    return `${category}:${identifier}${action ? `:${action}` : ''}`;
  }

  /**
   * Check if action is rate limited
   * @param {string} category - Rate limit category
   * @param {string} identifier - User ID, guild ID, etc.
   * @param {string} action - Optional action name
   * @param {Object} options - Optional custom limits { max, windowMs }
   * @returns {{ limited: boolean, remaining: number, resetIn: number }}
   */
  check(category, identifier, action = '', options = {}) {
    const key = this.getKey(category, identifier, action);
    const limits = options.max ? options : (this.defaultLimits[category] || this.defaultLimits.command);
    const now = Date.now();

    let entry = this.limits.get(key);

    // No entry or expired window - create new
    if (!entry || now >= entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + limits.windowMs,
        blocked: false
      };
    }

    const remaining = Math.max(0, limits.max - entry.count);
    const resetIn = Math.max(0, entry.resetTime - now);

    return {
      limited: entry.count >= limits.max,
      remaining,
      resetIn,
      retryAfter: entry.count >= limits.max ? resetIn : 0
    };
  }

  /**
   * Consume a rate limit token
   * @param {string} category - Rate limit category
   * @param {string} identifier - User ID, guild ID, etc.
   * @param {string} action - Optional action name
   * @param {Object} options - Optional custom limits { max, windowMs }
   * @returns {{ limited: boolean, remaining: number, resetIn: number }}
   */
  consume(category, identifier, action = '', options = {}) {
    const key = this.getKey(category, identifier, action);
    const limits = options.max ? options : (this.defaultLimits[category] || this.defaultLimits.command);
    const now = Date.now();

    let entry = this.limits.get(key);

    // No entry or expired window - create new
    if (!entry || now >= entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + limits.windowMs,
        blocked: false
      };
    }

    // Check if already limited
    if (entry.count >= limits.max) {
      return {
        limited: true,
        remaining: 0,
        resetIn: Math.max(0, entry.resetTime - now),
        retryAfter: Math.max(0, entry.resetTime - now)
      };
    }

    // Consume token
    entry.count++;
    this.limits.set(key, entry);

    // Enforce max entries
    if (this.limits.size > this.maxEntries) {
      this.evictOldest();
    }

    const remaining = Math.max(0, limits.max - entry.count);
    return {
      limited: false,
      remaining,
      resetIn: Math.max(0, entry.resetTime - now),
      retryAfter: 0
    };
  }

  /**
   * Reset rate limit for a key
   * @param {string} category - Rate limit category
   * @param {string} identifier - User ID, guild ID, etc.
   * @param {string} action - Optional action name
   */
  reset(category, identifier, action = '') {
    const key = this.getKey(category, identifier, action);
    this.limits.delete(key);
  }

  /**
   * Check and consume in one call (most common use case)
   * Returns true if action is allowed, false if rate limited
   * @param {string} category - Rate limit category
   * @param {string} identifier - User ID, guild ID, etc.
   * @param {string} action - Optional action name
   * @param {Object} options - Optional custom limits { max, windowMs }
   * @returns {{ allowed: boolean, remaining: number, resetIn: number, message: string }}
   */
  attempt(category, identifier, action = '', options = {}) {
    const result = this.consume(category, identifier, action, options);

    if (result.limited) {
      const seconds = Math.ceil(result.retryAfter / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetIn: result.retryAfter,
        message: `You're doing that too fast! Please wait ${seconds} second${seconds !== 1 ? 's' : ''}.`
      };
    }

    return {
      allowed: true,
      remaining: result.remaining,
      resetIn: result.resetIn,
      message: null
    };
  }

  /**
   * Evict oldest entry when max size is reached
   * @private
   */
  evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, value] of this.limits.entries()) {
      if (value.resetTime < oldestTime) {
        oldestTime = value.resetTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.limits.delete(oldestKey);
    }
  }

  /**
   * Clean up expired entries
   * @private
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.limits.entries()) {
      if (now >= value.resetTime) {
        this.limits.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[RateLimiter] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Get statistics
   * @returns {Object} Rate limiter stats
   */
  getStats() {
    return {
      entries: this.limits.size,
      maxEntries: this.maxEntries,
      categories: Object.keys(this.defaultLimits)
    };
  }

  /**
   * Stop the rate limiter (cleanup interval)
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.limits.clear();
    logger.info('[RateLimiter] Stopped and cleared');
  }
}

// Singleton instance
const rateLimiter = new RateLimiter();

export default rateLimiter;
export { RateLimiter };
