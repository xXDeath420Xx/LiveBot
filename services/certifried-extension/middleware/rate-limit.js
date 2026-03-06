/**
 * Rate Limiting Middleware
 * Per-player rate limiting for API endpoints using Token Bucket algorithm
 * Allows short bursts while enforcing overall limits
 */

import logger from '../../../utils/logger.js';
import { RATE_LIMITS } from '../config/game-constants.js';

// In-memory rate limit store using token bucket algorithm
// In production, consider Redis for multi-instance support
const rateLimitStore = new Map();

// Token bucket configuration
const BUCKET_CONFIG = {
    maxTokens: 30,          // Maximum burst capacity
    refillRate: 2,          // Tokens to add per interval
    refillIntervalMs: 500   // Refill every 500ms
};

// Clean up old entries periodically
setInterval(() => {
    const now = Date.now();
    const fiveMinutesAgo = now - 300000;

    for (const [key, data] of rateLimitStore.entries()) {
        // Remove entries older than 5 minutes of inactivity
        if (data.lastAccess < fiveMinutesAgo) {
            rateLimitStore.delete(key);
        }
    }
}, 60000); // Every minute

/**
 * Get or create token bucket for a player
 * @param {number} playerId - Player ID
 * @returns {object} Token bucket data
 */
function getTokenBucket(playerId) {
    const key = `player:${playerId}`;
    const now = Date.now();

    let bucket = rateLimitStore.get(key);

    if (!bucket) {
        // Create new bucket with full tokens
        bucket = {
            tokens: BUCKET_CONFIG.maxTokens,
            lastRefill: now,
            lastAccess: now,
            requestCount: 0,      // Track requests for headers
            windowStart: now      // Track window for headers
        };
        rateLimitStore.set(key, bucket);
        return bucket;
    }

    // Refill tokens based on time elapsed
    const timeSinceRefill = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timeSinceRefill / BUCKET_CONFIG.refillIntervalMs) * (BUCKET_CONFIG.refillRate / 2);

    if (tokensToAdd > 0) {
        bucket.tokens = Math.min(BUCKET_CONFIG.maxTokens, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;
    }

    bucket.lastAccess = now;

    // Reset window tracking every minute for headers
    if (now - bucket.windowStart > 60000) {
        bucket.windowStart = now;
        bucket.requestCount = 0;
    }

    return bucket;
}

/**
 * Rate limiter middleware using token bucket algorithm
 * Allows bursts up to maxTokens, then enforces sustained rate
 */
export function rateLimiter(req, res, next) {
    if (!req.player) {
        return next();
    }

    const playerId = req.player.id;
    const bucket = getTokenBucket(playerId);

    // Check if we have tokens available
    if (bucket.tokens < 1) {
        // Calculate time until next token is available
        const timeUntilToken = BUCKET_CONFIG.refillIntervalMs;

        logger.debug(`[RateLimit] Player ${playerId} rate limited (0 tokens)`, {
            playerId,
            path: req.path
        });

        return res.status(429).json({
            error: 'Too many requests, please wait',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: Math.ceil(timeUntilToken / 1000)
        });
    }

    // Consume a token
    bucket.tokens--;
    bucket.requestCount++;

    // Add rate limit headers (informational)
    res.set({
        'X-RateLimit-Limit': RATE_LIMITS.REQUESTS_PER_MINUTE,
        'X-RateLimit-Remaining': Math.floor(bucket.tokens),
        'X-RateLimit-Reset': Math.ceil((bucket.windowStart + 60000) / 1000)
    });

    next();
}

/**
 * Create an endpoint-specific cooldown checker
 * @param {string} action - Action name for logging
 * @param {number} cooldownMs - Cooldown in milliseconds
 */
export function createCooldown(action, cooldownMs) {
    const cooldownStore = new Map();

    return function cooldownMiddleware(req, res, next) {
        if (!req.player) {
            return next();
        }

        const key = `${req.player.id}:${action}`;
        const now = Date.now();
        const lastAction = cooldownStore.get(key) || 0;
        const remaining = cooldownMs - (now - lastAction);

        if (remaining > 0) {
            return res.status(429).json({
                error: `Please wait before ${action} again`,
                code: 'COOLDOWN',
                action,
                retryAfter: Math.ceil(remaining / 1000),
                retryAfterMs: remaining
            });
        }

        // Update last action time
        cooldownStore.set(key, now);

        // Clean up old entries (after 5 minutes of inactivity)
        setTimeout(() => {
            if (Date.now() - cooldownStore.get(key) > 300000) {
                cooldownStore.delete(key);
            }
        }, 300000);

        next();
    };
}

// Pre-built cooldowns for common actions
export const plantCooldown = createCooldown('planting', RATE_LIMITS.PLANT_COOLDOWN_MS);
export const harvestCooldown = createCooldown('harvesting', RATE_LIMITS.HARVEST_COOLDOWN_MS);
export const sellCooldown = createCooldown('selling', RATE_LIMITS.SELL_COOLDOWN_MS);
export const breedCooldown = createCooldown('breeding', RATE_LIMITS.BREED_COOLDOWN_MS);
export const tradeCooldown = createCooldown('trading', RATE_LIMITS.TRADE_COOLDOWN_MS);

export default rateLimiter;
