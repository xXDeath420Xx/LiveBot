/**
 * Production-ready mutex utilities using async-mutex
 * Provides proper locking with timeouts, deadlock prevention, and error handling
 */
import { Mutex, withTimeout, E_TIMEOUT, E_CANCELED } from 'async-mutex';
import logger from './logger.js';

// Default timeout for lock acquisition (10 seconds)
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Create a mutex with timeout support
 * @param {number} timeoutMs - Timeout in milliseconds for lock acquisition
 * @returns {Mutex} Mutex instance with timeout wrapper
 */
export function createMutex(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const mutex = new Mutex();
    return withTimeout(mutex, timeoutMs);
}

/**
 * Execute a function with mutex protection and proper error handling
 * @param {Mutex} mutex - The mutex to acquire
 * @param {Function} fn - Async function to execute while holding the lock
 * @param {Object} options - Options
 * @param {string} options.name - Name for logging purposes
 * @param {number} options.timeout - Override default timeout
 * @returns {Promise<*>} Result of the function
 */
export async function withMutex(mutex, fn, options = {}) {
    const { name = 'unknown', timeout } = options;
    const startTime = Date.now();

    try {
        const release = await mutex.acquire();
        const acquireTime = Date.now() - startTime;

        // Log slow lock acquisitions
        if (acquireTime > 1000) {
            logger.warn(`[Mutex] Slow lock acquisition for ${name}`, {
                acquireTimeMs: acquireTime
            });
        }

        try {
            return await fn();
        } finally {
            release();
        }
    } catch (error) {
        if (error === E_TIMEOUT) {
            logger.error(`[Mutex] Lock acquisition timeout for ${name}`, {
                timeoutMs: timeout || DEFAULT_TIMEOUT_MS
            });
            throw new Error(`Mutex timeout: Failed to acquire lock for ${name}`);
        }
        if (error === E_CANCELED) {
            logger.warn(`[Mutex] Lock acquisition canceled for ${name}`);
            throw new Error(`Mutex canceled: Lock acquisition canceled for ${name}`);
        }
        throw error;
    }
}

/**
 * Create a named mutex manager for tracking multiple mutexes
 * Useful for per-resource locking (e.g., per-guild locks)
 */
export class MutexManager {
    constructor(options = {}) {
        this.mutexes = new Map();
        this.maxSize = options.maxSize || 10000;
        this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.name = options.name || 'MutexManager';
    }

    /**
     * Get or create a mutex for a given key
     * @param {string} key - Unique key for the mutex
     * @returns {Mutex} Mutex instance
     */
    getMutex(key) {
        if (!this.mutexes.has(key)) {
            // Evict old mutexes if at capacity
            if (this.mutexes.size >= this.maxSize) {
                const keysToDelete = [];
                for (const [k, m] of this.mutexes) {
                    if (!m.isLocked()) {
                        keysToDelete.push(k);
                        if (this.mutexes.size - keysToDelete.length < this.maxSize * 0.9) {
                            break;
                        }
                    }
                }
                for (const k of keysToDelete) {
                    this.mutexes.delete(k);
                }
                logger.debug(`[${this.name}] Evicted ${keysToDelete.length} unused mutexes`);
            }
            this.mutexes.set(key, createMutex(this.timeoutMs));
        }
        return this.mutexes.get(key);
    }

    /**
     * Run a function with a mutex for the given key
     * @param {string} key - Unique key for the mutex
     * @param {Function} fn - Function to execute
     * @returns {Promise<*>} Result of the function
     */
    async runExclusive(key, fn) {
        const mutex = this.getMutex(key);
        return withMutex(mutex, fn, { name: `${this.name}:${key}` });
    }

    /**
     * Get the number of active mutexes
     * @returns {number}
     */
    get size() {
        return this.mutexes.size;
    }

    /**
     * Clear all mutexes (use with caution)
     */
    clear() {
        this.mutexes.clear();
    }
}

// Export the raw Mutex class for simple use cases
export { Mutex, E_TIMEOUT, E_CANCELED };

// Default export for backwards compatibility
export default {
    createMutex,
    withMutex,
    MutexManager,
    Mutex,
    DEFAULT_TIMEOUT_MS
};
