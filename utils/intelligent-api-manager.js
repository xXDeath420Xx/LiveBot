"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimitManager = exports.CircuitBreaker = exports.IntelligentAPIManager = void 0;
exports.getAPIManager = getAPIManager;
exports.getAllMetrics = getAllMetrics;
exports.getAllHealthStatus = getAllHealthStatus;
const logger_1 = __importDefault(require("./logger"));
const cache_1 = require("./cache");
// ============================================================================
// CIRCUIT BREAKER
// ============================================================================
class CircuitBreaker {
    constructor(name, options = {}) {
        this.name = name;
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.nextAttemptTime = null;
        // Configuration
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 60000; // 60 seconds
        this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
        // Metrics
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            circuitOpenCount: 0,
            lastStateChange: Date.now()
        };
    }
    async execute(fn) {
        this.metrics.totalRequests++;
        if (this.state === 'OPEN') {
            if (this.nextAttemptTime && Date.now() < this.nextAttemptTime) {
                throw new Error(`Circuit breaker [${this.name}] is OPEN. Next attempt at ${new Date(this.nextAttemptTime).toISOString()}`);
            }
            // Try to move to HALF_OPEN
            this.state = 'HALF_OPEN';
            logger_1.default.info(`Circuit breaker [${this.name}] moving to HALF_OPEN state`, { category: 'circuit-breaker' });
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        this.failureCount = 0;
        this.metrics.successfulRequests++;
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.successThreshold) {
                this.state = 'CLOSED';
                this.successCount = 0;
                this.metrics.lastStateChange = Date.now();
                logger_1.default.info(`Circuit breaker [${this.name}] CLOSED - system recovered`, {
                    category: 'circuit-breaker',
                    metrics: this.metrics
                });
            }
        }
    }
    onFailure() {
        this.failureCount++;
        this.metrics.failedRequests++;
        this.lastFailureTime = Date.now();
        if (this.state === 'HALF_OPEN') {
            this.tripCircuit();
        }
        else if (this.failureCount >= this.failureThreshold) {
            this.tripCircuit();
        }
    }
    tripCircuit() {
        this.state = 'OPEN';
        this.successCount = 0;
        this.nextAttemptTime = Date.now() + this.resetTimeout;
        this.metrics.circuitOpenCount++;
        this.metrics.lastStateChange = Date.now();
        logger_1.default.error(`Circuit breaker [${this.name}] OPEN - system degraded`, {
            category: 'circuit-breaker',
            failureCount: this.failureCount,
            metrics: this.metrics,
            nextAttempt: this.nextAttemptTime ? new Date(this.nextAttemptTime).toISOString() : 'N/A'
        });
    }
    getMetrics() {
        return {
            ...this.metrics,
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            healthScore: this.metrics.totalRequests > 0
                ? (this.metrics.successfulRequests / this.metrics.totalRequests * 100).toFixed(2)
                : '100'
        };
    }
    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttemptTime = null;
        logger_1.default.info(`Circuit breaker [${this.name}] manually reset`, { category: 'circuit-breaker' });
    }
}
exports.CircuitBreaker = CircuitBreaker;
// ============================================================================
// RATE LIMIT MANAGER
// ============================================================================
class RateLimitManager {
    constructor(name, options = {}) {
        this.name = name;
        this.maxRequests = options.maxRequests || 100;
        this.windowMs = options.windowMs || 60000; // 1 minute
        this.requests = [];
        this.predictedAvailableAt = Date.now();
    }
    async checkLimit() {
        const now = Date.now();
        // Remove old requests outside the window
        this.requests = this.requests.filter(time => time > now - this.windowMs);
        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            if (oldestRequest) {
                const waitTime = (oldestRequest + this.windowMs) - now;
                this.predictedAvailableAt = now + waitTime;
                logger_1.default.warn(`Rate limit reached for [${this.name}]. Waiting ${waitTime}ms`, {
                    category: 'rate-limit',
                    currentRequests: this.requests.length,
                    maxRequests: this.maxRequests
                });
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return this.checkLimit(); // Re-check after waiting
            }
        }
        this.requests.push(now);
        return true;
    }
    getPredictedWaitTime() {
        const now = Date.now();
        if (this.predictedAvailableAt > now) {
            return this.predictedAvailableAt - now;
        }
        return 0;
    }
    getMetrics() {
        const now = Date.now();
        const activeRequests = this.requests.filter(time => time > now - this.windowMs);
        return {
            name: this.name,
            currentRequests: activeRequests.length,
            maxRequests: this.maxRequests,
            utilizationPercent: (activeRequests.length / this.maxRequests * 100).toFixed(2),
            predictedWaitMs: this.getPredictedWaitTime()
        };
    }
}
exports.RateLimitManager = RateLimitManager;
// ============================================================================
// INTELLIGENT API MANAGER
// ============================================================================
class IntelligentAPIManager {
    constructor(name, options = {}) {
        this.name = name;
        this.circuitBreaker = new CircuitBreaker(name, options.circuitBreaker);
        this.rateLimiter = new RateLimitManager(name, options.rateLimit);
        // Retry configuration
        this.maxRetries = options.maxRetries || 3;
        this.baseDelay = options.baseDelay || 1000;
        this.maxDelay = options.maxDelay || 30000;
        // Cache configuration
        this.cacheEnabled = options.cacheEnabled !== false;
        this.cacheTTL = options.cacheTTL || 60000; // 1 minute default
        // Request deduplication
        this.pendingRequests = new Map();
        // Metrics
        this.metrics = {
            totalRequests: 0,
            cachedResponses: 0,
            deduplicatedRequests: 0,
            retriedRequests: 0,
            failedRequests: 0,
            averageResponseTime: 0,
            responseTimes: []
        };
    }
    /**
     * Execute an API request with full intelligence
     */
    async execute(requestFn, options = {}) {
        const startTime = Date.now();
        const cacheKey = options.cacheKey;
        const skipCache = options.skipCache || false;
        const customTTL = options.cacheTTL || this.cacheTTL;
        this.metrics.totalRequests++;
        // Check cache first
        if (this.cacheEnabled && cacheKey && !skipCache) {
            const cached = await this.getCached(cacheKey);
            if (cached !== null) {
                this.metrics.cachedResponses++;
                logger_1.default.debug(`Cache hit for [${this.name}/${cacheKey}]`, { category: 'api-manager' });
                return cached;
            }
        }
        // Request deduplication
        if (cacheKey && this.pendingRequests.has(cacheKey)) {
            this.metrics.deduplicatedRequests++;
            logger_1.default.debug(`Deduplicating request for [${this.name}/${cacheKey}]`, { category: 'api-manager' });
            return await this.pendingRequests.get(cacheKey);
        }
        // Create the request promise
        const requestPromise = this.executeWithRetry(requestFn, options);
        if (cacheKey) {
            this.pendingRequests.set(cacheKey, requestPromise);
        }
        try {
            const result = await requestPromise;
            // Cache the result
            if (this.cacheEnabled && cacheKey && result !== null && result !== undefined) {
                await this.setCached(cacheKey, result, customTTL);
            }
            // Track response time
            const responseTime = Date.now() - startTime;
            this.trackResponseTime(responseTime);
            return result;
        }
        finally {
            if (cacheKey) {
                this.pendingRequests.delete(cacheKey);
            }
        }
    }
    /**
     * Execute request with exponential backoff retry logic
     */
    async executeWithRetry(requestFn, options = {}) {
        const maxRetries = options.maxRetries || this.maxRetries;
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Check rate limit
                await this.rateLimiter.checkLimit();
                // Execute through circuit breaker
                const result = await this.circuitBreaker.execute(requestFn);
                if (attempt > 0) {
                    this.metrics.retriedRequests++;
                    logger_1.default.info(`Request succeeded after ${attempt} retries for [${this.name}]`, {
                        category: 'api-manager'
                    });
                }
                return result;
            }
            catch (error) {
                lastError = error;
                // Don't retry on circuit breaker open
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (errorMessage && errorMessage.includes('Circuit breaker')) {
                    throw error;
                }
                // Don't retry on certain error codes
                if (this.shouldNotRetry(error)) {
                    throw error;
                }
                if (attempt < maxRetries) {
                    const delay = this.calculateBackoffDelay(attempt);
                    logger_1.default.warn(`Request failed for [${this.name}], retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, {
                        category: 'api-manager',
                        error: errorMessage
                    });
                    await this.sleep(delay);
                }
                else {
                    this.metrics.failedRequests++;
                    logger_1.default.error(`Request failed after ${maxRetries} retries for [${this.name}]`, {
                        category: 'api-manager',
                        error: errorMessage
                    });
                }
            }
        }
        throw lastError;
    }
    /**
     * Calculate exponential backoff delay with jitter
     */
    calculateBackoffDelay(attempt) {
        const exponentialDelay = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);
        // Add jitter (random ±25%)
        const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
        return Math.floor(exponentialDelay + jitter);
    }
    /**
     * Determine if error should not be retried
     */
    shouldNotRetry(error) {
        // 4xx errors (except 429) should not be retried
        if (error.response?.status && error.response.status >= 400 && error.response.status < 500 && error.response.status !== 429) {
            return true;
        }
        // Authentication errors
        if (error.message && error.message.toLowerCase().includes('unauthorized')) {
            return true;
        }
        return false;
    }
    /**
     * Cache management
     */
    async getCached(key) {
        try {
            const cached = await (0, cache_1.getCache)(`api:${this.name}:${key}`);
            return cached ? JSON.parse(cached) : null;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.warn(`Failed to get cache for [${this.name}/${key}]`, {
                category: 'api-manager',
                error: errorMessage
            });
            return null;
        }
    }
    async setCached(key, value, ttlMs) {
        try {
            await (0, cache_1.setCache)(`api:${this.name}:${key}`, JSON.stringify(value), Math.floor(ttlMs / 1000));
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.warn(`Failed to set cache for [${this.name}/${key}]`, {
                category: 'api-manager',
                error: errorMessage
            });
        }
    }
    /**
     * Cache warming - proactively fetch data before it's needed
     */
    async warmCache(requests) {
        logger_1.default.info(`Warming cache for [${this.name}] with ${requests.length} requests`, {
            category: 'api-manager'
        });
        const results = await Promise.allSettled(requests.map(({ fn, options }) => this.execute(fn, options)));
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        logger_1.default.info(`Cache warming completed for [${this.name}]: ${succeeded}/${requests.length} successful`, {
            category: 'api-manager'
        });
        return results;
    }
    /**
     * Metrics tracking
     */
    trackResponseTime(timeMs) {
        this.metrics.responseTimes.push(timeMs);
        // Keep only last 100 response times
        if (this.metrics.responseTimes.length > 100) {
            this.metrics.responseTimes.shift();
        }
        // Calculate average
        const sum = this.metrics.responseTimes.reduce((a, b) => a + b, 0);
        this.metrics.averageResponseTime = Math.round(sum / this.metrics.responseTimes.length);
    }
    /**
     * Get comprehensive metrics
     */
    getMetrics() {
        return {
            name: this.name,
            requests: {
                total: this.metrics.totalRequests,
                cached: this.metrics.cachedResponses,
                deduplicated: this.metrics.deduplicatedRequests,
                retried: this.metrics.retriedRequests,
                failed: this.metrics.failedRequests,
                cacheHitRate: this.metrics.totalRequests > 0
                    ? ((this.metrics.cachedResponses / this.metrics.totalRequests) * 100).toFixed(2) + '%'
                    : 'N/A'
            },
            performance: {
                averageResponseTimeMs: this.metrics.averageResponseTime,
                recentResponseTimes: this.metrics.responseTimes.slice(-10)
            },
            circuitBreaker: this.circuitBreaker.getMetrics(),
            rateLimit: this.rateLimiter.getMetrics()
        };
    }
    /**
     * Health check
     */
    getHealth() {
        const cbMetrics = this.circuitBreaker.getMetrics();
        const isHealthy = cbMetrics.state !== 'OPEN' && parseFloat(cbMetrics.healthScore) > 50;
        return {
            name: this.name,
            healthy: isHealthy,
            state: cbMetrics.state,
            healthScore: cbMetrics.healthScore,
            issues: !isHealthy ? this.getDiagnostics() : []
        };
    }
    getDiagnostics() {
        const issues = [];
        const cbMetrics = this.circuitBreaker.getMetrics();
        if (cbMetrics.state === 'OPEN') {
            issues.push('Circuit breaker is OPEN - service experiencing failures');
        }
        if (parseFloat(cbMetrics.healthScore) < 50) {
            issues.push(`Low health score: ${cbMetrics.healthScore}%`);
        }
        if (this.metrics.averageResponseTime > 5000) {
            issues.push(`High response time: ${this.metrics.averageResponseTime}ms`);
        }
        return issues;
    }
    /**
     * Utility methods
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    reset() {
        this.circuitBreaker.reset();
        logger_1.default.info(`API Manager [${this.name}] reset`, { category: 'api-manager' });
    }
}
exports.IntelligentAPIManager = IntelligentAPIManager;
// ============================================================================
// GLOBAL REGISTRY
// ============================================================================
const apiManagers = new Map();
/**
 * Get or create an API manager
 */
function getAPIManager(name, options = {}) {
    if (!apiManagers.has(name)) {
        apiManagers.set(name, new IntelligentAPIManager(name, options));
    }
    return apiManagers.get(name);
}
/**
 * Get metrics for all API managers
 */
function getAllMetrics() {
    const metrics = {};
    for (const [name, manager] of Array.from(apiManagers.entries())) {
        metrics[name] = manager.getMetrics();
    }
    return metrics;
}
/**
 * Get health status for all API managers
 */
function getAllHealthStatus() {
    const health = {};
    for (const [name, manager] of Array.from(apiManagers.entries())) {
        health[name] = manager.getHealth();
    }
    return health;
}
exports.default = IntelligentAPIManager;
