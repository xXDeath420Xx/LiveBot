import logger from './logger.js';

/**
 * BoundedMap - A Map with automatic size limits and TTL-based expiration
 * Prevents memory leaks by enforcing maximum size and cleaning up stale entries
 */
export class BoundedMap extends Map {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.maxSize - Maximum number of entries (default: 10000)
   * @param {number} options.ttl - Time-to-live in milliseconds (default: 0 = no expiration)
   * @param {number} options.cleanupInterval - Cleanup interval in ms (default: 60000)
   * @param {string} options.name - Name for logging (default: 'BoundedMap')
   * @param {Function} options.onEvict - Callback when entry is evicted (optional)
   */
  constructor(options = {}) {
    super();
    this.maxSize = options.maxSize || 10000;
    this.ttl = options.ttl || 0;
    this.name = options.name || 'BoundedMap';
    this.onEvict = options.onEvict || null;

    // Track insertion timestamps for TTL
    this._timestamps = new Map();

    // Track access order for LRU eviction
    this._accessOrder = [];

    // Setup cleanup interval if TTL is set
    this._cleanupInterval = null;
    if (this.ttl > 0 && options.cleanupInterval !== 0) {
      const interval = options.cleanupInterval || 60000;
      this._cleanupInterval = setInterval(() => this._cleanupExpired(), interval);
    }

    // Stats for monitoring
    this._stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Set a value with automatic eviction of oldest entries if at capacity
   */
  set(key, value) {
    const now = Date.now();

    // If key exists, update access order
    if (super.has(key)) {
      this._updateAccessOrder(key);
      this._timestamps.set(key, now);
      return super.set(key, value);
    }

    // Evict oldest entries if at capacity
    while (super.size >= this.maxSize) {
      this._evictOldest();
    }

    // Add new entry
    this._timestamps.set(key, now);
    this._accessOrder.push(key);

    return super.set(key, value);
  }

  /**
   * Get a value, checking TTL and updating access order
   */
  get(key) {
    if (!super.has(key)) {
      this._stats.misses++;
      return undefined;
    }

    // Check TTL
    if (this.ttl > 0) {
      const timestamp = this._timestamps.get(key);
      if (timestamp && Date.now() - timestamp > this.ttl) {
        this._deleteEntry(key, 'expired');
        this._stats.misses++;
        return undefined;
      }
    }

    this._stats.hits++;
    this._updateAccessOrder(key);
    return super.get(key);
  }

  /**
   * Check if key exists and is not expired
   */
  has(key) {
    if (!super.has(key)) return false;

    // Check TTL
    if (this.ttl > 0) {
      const timestamp = this._timestamps.get(key);
      if (timestamp && Date.now() - timestamp > this.ttl) {
        this._deleteEntry(key, 'expired');
        return false;
      }
    }

    return true;
  }

  /**
   * Delete an entry
   */
  delete(key) {
    this._timestamps.delete(key);
    this._accessOrder = this._accessOrder.filter(k => k !== key);
    return super.delete(key);
  }

  /**
   * Clear all entries
   */
  clear() {
    this._timestamps.clear();
    this._accessOrder = [];
    return super.clear();
  }

  /**
   * Get entry age in milliseconds
   */
  getAge(key) {
    const timestamp = this._timestamps.get(key);
    if (!timestamp) return null;
    return Date.now() - timestamp;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this._stats,
      size: super.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      hitRate: this._stats.hits + this._stats.misses > 0
        ? (this._stats.hits / (this._stats.hits + this._stats.misses) * 100).toFixed(2) + '%'
        : 'N/A',
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this._stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  /**
   * Stop the cleanup interval
   */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.clear();
  }

  /**
   * Update access order for LRU
   */
  _updateAccessOrder(key) {
    const index = this._accessOrder.indexOf(key);
    if (index > -1) {
      this._accessOrder.splice(index, 1);
    }
    this._accessOrder.push(key);
  }

  /**
   * Evict the oldest entry
   */
  _evictOldest() {
    if (this._accessOrder.length === 0) return;

    const oldestKey = this._accessOrder[0];
    this._deleteEntry(oldestKey, 'evicted');
  }

  /**
   * Delete entry with callback
   */
  _deleteEntry(key, reason) {
    const value = super.get(key);

    if (this.onEvict && value !== undefined) {
      try {
        this.onEvict(key, value, reason);
      } catch (err) {
        logger.error(`[${this.name}] Error in onEvict callback`, { error: err.message });
      }
    }

    this._timestamps.delete(key);
    this._accessOrder = this._accessOrder.filter(k => k !== key);
    super.delete(key);

    if (reason === 'evicted') {
      this._stats.evictions++;
    } else if (reason === 'expired') {
      this._stats.expirations++;
    }
  }

  /**
   * Clean up expired entries
   */
  _cleanupExpired() {
    if (this.ttl <= 0) return;

    const now = Date.now();
    let cleaned = 0;

    for (const [key, timestamp] of this._timestamps.entries()) {
      if (now - timestamp > this.ttl) {
        this._deleteEntry(key, 'expired');
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[${this.name}] Cleaned up ${cleaned} expired entries`);
    }
  }
}

/**
 * BoundedNestedMap - A Map of Maps with automatic cleanup
 * Useful for structures like Map<guildId, Map<userId, data>>
 */
export class BoundedNestedMap {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.maxOuterSize - Max number of outer keys (default: 1000)
   * @param {number} options.maxInnerSize - Max entries per inner map (default: 10000)
   * @param {number} options.ttl - TTL for inner entries in ms (default: 300000 = 5 min)
   * @param {number} options.cleanupInterval - Cleanup interval in ms (default: 60000)
   * @param {string} options.name - Name for logging
   */
  constructor(options = {}) {
    this.maxOuterSize = options.maxOuterSize || 1000;
    this.maxInnerSize = options.maxInnerSize || 10000;
    this.ttl = options.ttl || 300000;
    this.name = options.name || 'BoundedNestedMap';

    this._outer = new Map();
    this._cleanupInterval = setInterval(() => this._cleanup(), options.cleanupInterval || 60000);
  }

  /**
   * Get inner map for outer key, creating if necessary
   */
  getInner(outerKey) {
    if (!this._outer.has(outerKey)) {
      // Check outer size limit
      if (this._outer.size >= this.maxOuterSize) {
        // Remove oldest outer key
        const firstKey = this._outer.keys().next().value;
        this._outer.get(firstKey)?.destroy?.();
        this._outer.delete(firstKey);
        logger.debug(`[${this.name}] Evicted outer key: ${firstKey}`);
      }

      this._outer.set(outerKey, new BoundedMap({
        maxSize: this.maxInnerSize,
        ttl: this.ttl,
        name: `${this.name}:${outerKey}`,
        cleanupInterval: 0, // Parent handles cleanup
      }));
    }
    return this._outer.get(outerKey);
  }

  /**
   * Set a value
   */
  set(outerKey, innerKey, value) {
    return this.getInner(outerKey).set(innerKey, value);
  }

  /**
   * Get a value
   */
  get(outerKey, innerKey) {
    const inner = this._outer.get(outerKey);
    if (!inner) return undefined;
    return inner.get(innerKey);
  }

  /**
   * Check if value exists
   */
  has(outerKey, innerKey) {
    const inner = this._outer.get(outerKey);
    if (!inner) return false;
    return inner.has(innerKey);
  }

  /**
   * Delete a value
   */
  delete(outerKey, innerKey) {
    const inner = this._outer.get(outerKey);
    if (!inner) return false;
    return inner.delete(innerKey);
  }

  /**
   * Delete entire inner map
   */
  deleteOuter(outerKey) {
    const inner = this._outer.get(outerKey);
    if (inner) {
      inner.destroy?.();
    }
    return this._outer.delete(outerKey);
  }

  /**
   * Get total size across all inner maps
   */
  get totalSize() {
    let total = 0;
    for (const inner of this._outer.values()) {
      total += inner.size;
    }
    return total;
  }

  /**
   * Get outer size
   */
  get outerSize() {
    return this._outer.size;
  }

  /**
   * Cleanup empty inner maps and expired entries
   */
  _cleanup() {
    for (const [outerKey, inner] of this._outer.entries()) {
      inner._cleanupExpired?.();

      if (inner.size === 0) {
        inner.destroy?.();
        this._outer.delete(outerKey);
        logger.debug(`[${this.name}] Removed empty inner map: ${outerKey}`);
      }
    }
  }

  /**
   * Stop cleanup and clear all data
   */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    for (const inner of this._outer.values()) {
      inner.destroy?.();
    }
    this._outer.clear();
  }

  /**
   * Get all outer keys
   */
  outerKeys() {
    return this._outer.keys();
  }

  /**
   * Iterate over all entries
   */
  *entries() {
    for (const [outerKey, inner] of this._outer.entries()) {
      for (const [innerKey, value] of inner.entries()) {
        yield [outerKey, innerKey, value];
      }
    }
  }
}

export default { BoundedMap, BoundedNestedMap };
