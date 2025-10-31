import logger from './logger';
import { getCache, setCache } from './cache';

/**
 * Intelligent API Request Manager
 *
 * Features:
 * - Circuit Breaker pattern to prevent cascading failures
 * - Exponential backoff with jitter for retries
 * - Intelligent caching with TTL and cache warming
 * - Rate limit prediction and management
 * - Request deduplication
 * - Adaptive retry strategies based on error patterns
 * - Health monitoring and metrics collection
 */

// ============================================================================
// INTERFACES
// ============================================================================

interface CircuitBreakerOptions {
    failureThreshold?: number;
    successThreshold?: number;
    timeout?: number;
    resetTimeout?: number;
}

interface CircuitBreakerMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    circuitOpenCount: number;
    lastStateChange: number;
}

interface CircuitBreakerStatus {
    state: CircuitBreakerState;
    failureCount: number;
    successCount: number;
    healthScore: string;
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    circuitOpenCount: number;
    lastStateChange: number;
}

interface RateLimitOptions {
    maxRequests?: number;
    windowMs?: number;
}

interface RateLimitMetrics {
    name: string;
    currentRequests: number;
    maxRequests: number;
    utilizationPercent: string;
    predictedWaitMs: number;
}

interface APIManagerOptions {
    circuitBreaker?: CircuitBreakerOptions;
    rateLimit?: RateLimitOptions;
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    cacheEnabled?: boolean;
    cacheTTL?: number;
}

interface ExecuteOptions {
    cacheKey?: string;
    skipCache?: boolean;
    cacheTTL?: number;
    maxRetries?: number;
}

interface APIManagerMetrics {
    totalRequests: number;
    cachedResponses: number;
    deduplicatedRequests: number;
    retriedRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    responseTimes: number[];
}

interface RequestMetrics {
    name: string;
    requests: {
        total: number;
        cached: number;
        deduplicated: number;
        retried: number;
        failed: number;
        cacheHitRate: string;
    };
    performance: {
        averageResponseTimeMs: number;
        recentResponseTimes: number[];
    };
    circuitBreaker: CircuitBreakerStatus;
    rateLimit: RateLimitMetrics;
}

interface HealthStatus {
    name: string;
    healthy: boolean;
    state: CircuitBreakerState;
    healthScore: string;
    issues: string[];
}

interface WarmCacheRequest {
    fn: () => Promise<any>;
    options: ExecuteOptions;
}

interface ErrorWithResponse {
    response?: {
        status?: number;
    };
    message?: string;
}

type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

class CircuitBreaker {
    public name: string;
    public state: CircuitBreakerState;
    public failureCount: number;
    public successCount: number;
    public lastFailureTime: number | null;
    public nextAttemptTime: number | null;
    public failureThreshold: number;
    public successThreshold: number;
    public timeout: number;
    public resetTimeout: number;
    public metrics: CircuitBreakerMetrics;

    constructor(name: string, options: CircuitBreakerOptions = {}) {
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

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        this.metrics.totalRequests++;

        if (this.state === 'OPEN') {
            if (this.nextAttemptTime && Date.now() < this.nextAttemptTime) {
                throw new Error(`Circuit breaker [${this.name}] is OPEN. Next attempt at ${new Date(this.nextAttemptTime).toISOString()}`);
            }
            // Try to move to HALF_OPEN
            this.state = 'HALF_OPEN';
            logger.info(`Circuit breaker [${this.name}] moving to HALF_OPEN state`, { category: 'circuit-breaker' });
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    onSuccess(): void {
        this.failureCount = 0;
        this.metrics.successfulRequests++;

        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.successThreshold) {
                this.state = 'CLOSED';
                this.successCount = 0;
                this.metrics.lastStateChange = Date.now();
                logger.info(`Circuit breaker [${this.name}] CLOSED - system recovered`, {
                    category: 'circuit-breaker',
                    metrics: this.metrics
                });
            }
        }
    }

    onFailure(): void {
        this.failureCount++;
        this.metrics.failedRequests++;
        this.lastFailureTime = Date.now();

        if (this.state === 'HALF_OPEN') {
            this.tripCircuit();
        } else if (this.failureCount >= this.failureThreshold) {
            this.tripCircuit();
        }
    }

    tripCircuit(): void {
        this.state = 'OPEN';
        this.successCount = 0;
        this.nextAttemptTime = Date.now() + this.resetTimeout;
        this.metrics.circuitOpenCount++;
        this.metrics.lastStateChange = Date.now();

        logger.error(`Circuit breaker [${this.name}] OPEN - system degraded`, {
            category: 'circuit-breaker',
            failureCount: this.failureCount,
            metrics: this.metrics,
            nextAttempt: this.nextAttemptTime ? new Date(this.nextAttemptTime).toISOString() : 'N/A'
        });
    }

    getMetrics(): CircuitBreakerStatus {
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

    reset(): void {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttemptTime = null;
        logger.info(`Circuit breaker [${this.name}] manually reset`, { category: 'circuit-breaker' });
    }
}

// ============================================================================
// RATE LIMIT MANAGER
// ============================================================================

class RateLimitManager {
    public name: string;
    public maxRequests: number;
    public windowMs: number;
    public requests: number[];
    public predictedAvailableAt: number;

    constructor(name: string, options: RateLimitOptions = {}) {
        this.name = name;
        this.maxRequests = options.maxRequests || 100;
        this.windowMs = options.windowMs || 60000; // 1 minute
        this.requests = [];
        this.predictedAvailableAt = Date.now();
    }

    async checkLimit(): Promise<boolean> {
        const now = Date.now();

        // Remove old requests outside the window
        this.requests = this.requests.filter(time => time > now - this.windowMs);

        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            if (oldestRequest) {
                const waitTime = (oldestRequest + this.windowMs) - now;
                this.predictedAvailableAt = now + waitTime;

                logger.warn(`Rate limit reached for [${this.name}]. Waiting ${waitTime}ms`, {
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

    getPredictedWaitTime(): number {
        const now = Date.now();
        if (this.predictedAvailableAt > now) {
            return this.predictedAvailableAt - now;
        }
        return 0;
    }

    getMetrics(): RateLimitMetrics {
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

// ============================================================================
// INTELLIGENT API MANAGER
// ============================================================================

class IntelligentAPIManager {
    public name: string;
    public circuitBreaker: CircuitBreaker;
    public rateLimiter: RateLimitManager;
    public maxRetries: number;
    public baseDelay: number;
    public maxDelay: number;
    public cacheEnabled: boolean;
    public cacheTTL: number;
    public pendingRequests: Map<string, Promise<any>>;
    public metrics: APIManagerMetrics;

    constructor(name: string, options: APIManagerOptions = {}) {
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
    async execute<T>(requestFn: () => Promise<T>, options: ExecuteOptions = {}): Promise<T> {
        const startTime = Date.now();
        const cacheKey = options.cacheKey;
        const skipCache = options.skipCache || false;
        const customTTL = options.cacheTTL || this.cacheTTL;

        this.metrics.totalRequests++;

        // Check cache first
        if (this.cacheEnabled && cacheKey && !skipCache) {
            const cached = await this.getCached<T>(cacheKey);
            if (cached !== null) {
                this.metrics.cachedResponses++;
                logger.debug(`Cache hit for [${this.name}/${cacheKey}]`, { category: 'api-manager' });
                return cached;
            }
        }

        // Request deduplication
        if (cacheKey && this.pendingRequests.has(cacheKey)) {
            this.metrics.deduplicatedRequests++;
            logger.debug(`Deduplicating request for [${this.name}/${cacheKey}]`, { category: 'api-manager' });
            return await this.pendingRequests.get(cacheKey) as T;
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
        } finally {
            if (cacheKey) {
                this.pendingRequests.delete(cacheKey);
            }
        }
    }

    /**
     * Execute request with exponential backoff retry logic
     */
    async executeWithRetry<T>(requestFn: () => Promise<T>, options: ExecuteOptions = {}): Promise<T> {
        const maxRetries = options.maxRetries || this.maxRetries;
        let lastError: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Check rate limit
                await this.rateLimiter.checkLimit();

                // Execute through circuit breaker
                const result = await this.circuitBreaker.execute(requestFn);

                if (attempt > 0) {
                    this.metrics.retriedRequests++;
                    logger.info(`Request succeeded after ${attempt} retries for [${this.name}]`, {
                        category: 'api-manager'
                    });
                }

                return result;

            } catch (error) {
                lastError = error;

                // Don't retry on circuit breaker open
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (errorMessage && errorMessage.includes('Circuit breaker')) {
                    throw error;
                }

                // Don't retry on certain error codes
                if (this.shouldNotRetry(error as ErrorWithResponse)) {
                    throw error;
                }

                if (attempt < maxRetries) {
                    const delay = this.calculateBackoffDelay(attempt);
                    logger.warn(`Request failed for [${this.name}], retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, {
                        category: 'api-manager',
                        error: errorMessage
                    });
                    await this.sleep(delay);
                } else {
                    this.metrics.failedRequests++;
                    logger.error(`Request failed after ${maxRetries} retries for [${this.name}]`, {
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
    calculateBackoffDelay(attempt: number): number {
        const exponentialDelay = Math.min(
            this.baseDelay * Math.pow(2, attempt),
            this.maxDelay
        );

        // Add jitter (random ±25%)
        const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
        return Math.floor(exponentialDelay + jitter);
    }

    /**
     * Determine if error should not be retried
     */
    shouldNotRetry(error: ErrorWithResponse): boolean {
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
    async getCached<T>(key: string): Promise<T | null> {
        try {
            const cached = await getCache(`api:${this.name}:${key}`);
            return cached ? JSON.parse(cached) : null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Failed to get cache for [${this.name}/${key}]`, {
                category: 'api-manager',
                error: errorMessage
            });
            return null;
        }
    }

    async setCached<T>(key: string, value: T, ttlMs: number): Promise<void> {
        try {
            await setCache(`api:${this.name}:${key}`, JSON.stringify(value), Math.floor(ttlMs / 1000));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Failed to set cache for [${this.name}/${key}]`, {
                category: 'api-manager',
                error: errorMessage
            });
        }
    }

    /**
     * Cache warming - proactively fetch data before it's needed
     */
    async warmCache(requests: WarmCacheRequest[]): Promise<PromiseSettledResult<any>[]> {
        logger.info(`Warming cache for [${this.name}] with ${requests.length} requests`, {
            category: 'api-manager'
        });

        const results = await Promise.allSettled(
            requests.map(({ fn, options }) => this.execute(fn, options))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        logger.info(`Cache warming completed for [${this.name}]: ${succeeded}/${requests.length} successful`, {
            category: 'api-manager'
        });

        return results;
    }

    /**
     * Metrics tracking
     */
    trackResponseTime(timeMs: number): void {
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
    getMetrics(): RequestMetrics {
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
    getHealth(): HealthStatus {
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

    getDiagnostics(): string[] {
        const issues: string[] = [];
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
    sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    reset(): void {
        this.circuitBreaker.reset();
        logger.info(`API Manager [${this.name}] reset`, { category: 'api-manager' });
    }
}

// ============================================================================
// GLOBAL REGISTRY
// ============================================================================

const apiManagers = new Map<string, IntelligentAPIManager>();

/**
 * Get or create an API manager
 */
export function getAPIManager(name: string, options: APIManagerOptions = {}): IntelligentAPIManager {
    if (!apiManagers.has(name)) {
        apiManagers.set(name, new IntelligentAPIManager(name, options));
    }
    return apiManagers.get(name)!;
}

/**
 * Get metrics for all API managers
 */
export function getAllMetrics(): Record<string, RequestMetrics> {
    const metrics: Record<string, RequestMetrics> = {};
    for (const [name, manager] of Array.from(apiManagers.entries())) {
        metrics[name] = manager.getMetrics();
    }
    return metrics;
}

/**
 * Get health status for all API managers
 */
export function getAllHealthStatus(): Record<string, HealthStatus> {
    const health: Record<string, HealthStatus> = {};
    for (const [name, manager] of Array.from(apiManagers.entries())) {
        health[name] = manager.getHealth();
    }
    return health;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
    IntelligentAPIManager,
    CircuitBreaker,
    RateLimitManager,
    type CircuitBreakerOptions,
    type RateLimitOptions,
    type APIManagerOptions,
    type ExecuteOptions,
    type RequestMetrics,
    type HealthStatus,
    type WarmCacheRequest
};

export default IntelligentAPIManager;
