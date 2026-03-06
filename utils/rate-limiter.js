import logger from './logger.js';

/**
 * Rate Limiter Utility for Discord API operations
 * Handles 429 rate limits with exponential backoff and queue management
 */

// Global rate limit state per bucket
const rateLimitBuckets = new Map();

// Default configuration
const DEFAULT_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 60000,
  cleanupInterval: 300000, // 5 minutes
};

// Track global rate limit (Discord sometimes issues global limits)
let globalRateLimitUntil = 0;

/**
 * Rate limit bucket tracker
 */
class RateLimitBucket {
  constructor(name) {
    this.name = name;
    this.remaining = Infinity;
    this.resetAt = 0;
    this.retryAfter = 0;
    this.queue = [];
    this.processing = false;
  }

  async waitIfNeeded() {
    const now = Date.now();

    // Check global rate limit first
    if (globalRateLimitUntil > now) {
      const waitTime = globalRateLimitUntil - now;
      logger.warn(`[RateLimiter] Global rate limit active, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }

    // Check bucket-specific limit
    if (this.remaining <= 0 && this.resetAt > now) {
      const waitTime = this.resetAt - now + 100; // Add small buffer
      logger.debug(`[RateLimiter] Bucket ${this.name} rate limited, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }

    // Check retry-after
    if (this.retryAfter > now) {
      const waitTime = this.retryAfter - now;
      logger.debug(`[RateLimiter] Bucket ${this.name} retry-after, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }
  }

  updateFromHeaders(headers) {
    if (headers.get('x-ratelimit-remaining')) {
      this.remaining = parseInt(headers.get('x-ratelimit-remaining'), 10);
    }
    if (headers.get('x-ratelimit-reset')) {
      this.resetAt = parseFloat(headers.get('x-ratelimit-reset')) * 1000;
    }
    if (headers.get('x-ratelimit-reset-after')) {
      const resetAfter = parseFloat(headers.get('x-ratelimit-reset-after')) * 1000;
      this.resetAt = Date.now() + resetAfter;
    }
  }

  setRetryAfter(ms) {
    this.retryAfter = Date.now() + ms;
    this.remaining = 0;
  }
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get or create a rate limit bucket
 */
function getBucket(bucketName) {
  if (!rateLimitBuckets.has(bucketName)) {
    rateLimitBuckets.set(bucketName, new RateLimitBucket(bucketName));
  }
  return rateLimitBuckets.get(bucketName);
}

/**
 * Execute a Discord API operation with rate limit handling
 * @param {Function} operation - Async function to execute
 * @param {Object} options - Configuration options
 * @returns {Promise} - Result of the operation
 */
export async function withRateLimit(operation, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const bucketName = options.bucket || 'default';
  const bucket = getBucket(bucketName);

  let lastError;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      // Wait if bucket is rate limited
      await bucket.waitIfNeeded();

      // Execute the operation
      const result = await operation();

      // Decrement remaining (estimate until we get headers)
      bucket.remaining = Math.max(0, bucket.remaining - 1);

      return result;
    } catch (error) {
      lastError = error;

      // Handle Discord rate limit errors
      if (error.status === 429 || error.httpStatus === 429) {
        const retryAfter = error.retryAfter || error.retry_after || 5000;
        const isGlobal = error.global || false;

        if (isGlobal) {
          globalRateLimitUntil = Date.now() + retryAfter;
          logger.warn(`[RateLimiter] Global rate limit hit, waiting ${retryAfter}ms`, {
            bucket: bucketName,
            attempt,
          });
        } else {
          bucket.setRetryAfter(retryAfter);
          logger.warn(`[RateLimiter] Rate limit hit on bucket ${bucketName}, waiting ${retryAfter}ms`, {
            attempt,
            remaining: bucket.remaining,
          });
        }

        // Wait and retry
        await sleep(retryAfter);
        continue;
      }

      // Handle Discord.js specific rate limit structure
      if (error.code === 'RateLimited') {
        const retryAfter = error.timeout || 5000;
        bucket.setRetryAfter(retryAfter);
        logger.warn(`[RateLimiter] Discord.js rate limit on ${bucketName}, waiting ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      // Non-rate-limit error - throw immediately
      throw error;
    }
  }

  logger.error(`[RateLimiter] Max retries exceeded for bucket ${bucketName}`, {
    maxRetries: config.maxRetries,
    error: lastError?.message,
  });
  throw lastError;
}

/**
 * Batch execute operations with rate limit awareness
 * Useful for bulk operations like banning multiple users
 * @param {Array} items - Items to process
 * @param {Function} operation - Async function(item) to execute for each item
 * @param {Object} options - Configuration options
 * @returns {Promise<Array>} - Results array with {success, result/error} for each item
 */
export async function batchWithRateLimit(items, operation, options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
    concurrency: options.concurrency || 1,
    delayBetween: options.delayBetween || 100,
  };

  const results = [];
  const bucket = getBucket(options.bucket || 'batch');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    try {
      await bucket.waitIfNeeded();

      const result = await withRateLimit(
        () => operation(item),
        { bucket: options.bucket || 'batch', maxRetries: config.maxRetries }
      );

      results.push({ success: true, result, item });

      // Add delay between operations to avoid hitting rate limits
      if (i < items.length - 1 && config.delayBetween > 0) {
        await sleep(config.delayBetween);
      }
    } catch (error) {
      logger.error(`[RateLimiter] Batch operation failed for item`, {
        item: typeof item === 'object' ? item.id || item : item,
        error: error.message,
      });
      results.push({ success: false, error, item });

      // Continue with other items unless it's a critical error
      if (error.code === 'MISSING_ACCESS' || error.code === 50001) {
        logger.error('[RateLimiter] Missing permissions, aborting batch');
        break;
      }
    }
  }

  return results;
}

/**
 * Queue an operation to be executed with rate limiting
 * Operations are executed in order
 */
export function queueOperation(operation, options = {}) {
  const bucket = getBucket(options.bucket || 'queue');

  return new Promise((resolve, reject) => {
    bucket.queue.push({ operation, resolve, reject, options });
    processQueue(bucket);
  });
}

/**
 * Process queued operations
 */
async function processQueue(bucket) {
  if (bucket.processing || bucket.queue.length === 0) return;

  bucket.processing = true;

  while (bucket.queue.length > 0) {
    const { operation, resolve, reject, options } = bucket.queue.shift();

    try {
      const result = await withRateLimit(operation, options);
      resolve(result);
    } catch (error) {
      reject(error);
    }

    // Small delay between queue items
    await sleep(50);
  }

  bucket.processing = false;
}

/**
 * Clean up old buckets to prevent memory leaks
 */
function cleanupBuckets() {
  const now = Date.now();
  const staleThreshold = 600000; // 10 minutes

  for (const [name, bucket] of rateLimitBuckets.entries()) {
    if (bucket.queue.length === 0 && bucket.resetAt < now - staleThreshold) {
      rateLimitBuckets.delete(name);
    }
  }

  // Limit total buckets to prevent memory issues
  if (rateLimitBuckets.size > 1000) {
    const oldestBuckets = Array.from(rateLimitBuckets.entries())
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, 500);

    for (const [name] of oldestBuckets) {
      rateLimitBuckets.delete(name);
    }

    logger.warn(`[RateLimiter] Cleaned up ${oldestBuckets.length} stale buckets`);
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupBuckets, DEFAULT_CONFIG.cleanupInterval);

/**
 * Stop the rate limiter cleanup
 */
export function stopRateLimiter() {
  clearInterval(cleanupInterval);
  rateLimitBuckets.clear();
}

/**
 * Get current rate limit status
 */
export function getRateLimitStatus() {
  const status = {};
  for (const [name, bucket] of rateLimitBuckets.entries()) {
    status[name] = {
      remaining: bucket.remaining,
      resetAt: bucket.resetAt,
      queueLength: bucket.queue.length,
      processing: bucket.processing,
    };
  }
  return status;
}

export default {
  withRateLimit,
  batchWithRateLimit,
  queueOperation,
  stopRateLimiter,
  getRateLimitStatus,
};
