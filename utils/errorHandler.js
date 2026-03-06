/**
 * Standardized Error Handler Utility
 * Provides consistent error handling across the codebase
 */

import logger from './logger.js';
import { RETRY, ERROR_CODES } from './constants.js';

/**
 * Error categories for different handling strategies
 */
export const ErrorCategory = {
    TRANSIENT: 'transient',     // Retry-able errors (network, rate limits)
    PERMANENT: 'permanent',     // Non-retry-able errors (validation, permissions)
    CRITICAL: 'critical',       // Requires immediate attention
    EXPECTED: 'expected',       // Expected errors (not found, etc.)
};

/**
 * Classify an error into a category
 * @param {Error} error - The error to classify
 * @returns {string} Error category
 */
export function classifyError(error) {
    const message = error.message?.toLowerCase() || '';
    const code = error.code?.toString() || '';

    // Transient errors (retry-able)
    if (
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED' ||
        code === 'EAI_AGAIN' ||
        message.includes('rate limit') ||
        message.includes('timeout') ||
        message.includes('temporarily unavailable') ||
        error.status === 429 ||
        error.status === 503 ||
        error.status === 502
    ) {
        return ErrorCategory.TRANSIENT;
    }

    // Expected errors (don't log as errors)
    if (
        code === '10008' ||  // Unknown Message
        code === '10003' ||  // Unknown Channel
        code === '10004' ||  // Unknown Guild
        error.status === 404 ||
        message.includes('unknown message') ||
        message.includes('unknown channel') ||
        message.includes('missing access')
    ) {
        return ErrorCategory.EXPECTED;
    }

    // Critical errors
    if (
        message.includes('out of memory') ||
        message.includes('fatal') ||
        message.includes('cannot connect to database') ||
        code === 'ER_CON_COUNT_ERROR'
    ) {
        return ErrorCategory.CRITICAL;
    }

    // Default to permanent
    return ErrorCategory.PERMANENT;
}

/**
 * Handle an error with consistent logging and optional fallback
 * @param {string} context - Where the error occurred
 * @param {Error} error - The error object
 * @param {*} fallbackValue - Value to return on error
 * @param {Object} options - Additional options
 * @returns {*} Fallback value
 */
export function handleError(context, error, fallbackValue = null, options = {}) {
    const { silent = false, metadata = {} } = options;
    const category = classifyError(error);

    const errorInfo = {
        context,
        category,
        message: error.message,
        code: error.code,
        status: error.status,
        ...metadata
    };

    // Log based on category
    switch (category) {
        case ErrorCategory.CRITICAL:
            logger.error(`[CRITICAL] ${context}:`, errorInfo);
            logger.error(error.stack);
            break;

        case ErrorCategory.TRANSIENT:
            if (!silent) {
                logger.warn(`[Transient] ${context}:`, errorInfo);
            }
            break;

        case ErrorCategory.EXPECTED:
            logger.debug(`[Expected] ${context}:`, errorInfo);
            break;

        case ErrorCategory.PERMANENT:
        default:
            if (!silent) {
                logger.error(`[Error] ${context}:`, errorInfo);
            }
            break;
    }

    return fallbackValue;
}

/**
 * Retry an async operation with exponential backoff
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<*>} Operation result
 */
export async function withRetry(operation, options = {}) {
    const {
        maxAttempts = RETRY.MAX_ATTEMPTS,
        initialDelay = RETRY.INITIAL_DELAY,
        maxDelay = RETRY.MAX_DELAY,
        backoffMultiplier = RETRY.BACKOFF_MULTIPLIER,
        context = 'operation',
        retryOn = (error) => classifyError(error) === ErrorCategory.TRANSIENT
    } = options;

    let lastError;
    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;

            // Check if we should retry
            if (attempt === maxAttempts || !retryOn(error)) {
                throw error;
            }

            logger.warn(`[Retry] ${context} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`);

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));

            // Increase delay for next attempt
            delay = Math.min(delay * backoffMultiplier, maxDelay);
        }
    }

    throw lastError;
}

/**
 * Wrap an async operation with timeout
 * @param {Promise} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} context - Context for error message
 * @returns {Promise<*>} Operation result
 */
export async function withTimeout(promise, timeoutMs, context = 'operation') {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${context} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Safe wrapper for async operations that shouldn't throw
 * @param {Function} operation - Async function to execute
 * @param {*} fallbackValue - Value to return on error
 * @param {string} context - Context for logging
 * @returns {Promise<*>} Operation result or fallback
 */
export async function safeAsync(operation, fallbackValue = null, context = 'async operation') {
    try {
        return await operation();
    } catch (error) {
        return handleError(context, error, fallbackValue);
    }
}

/**
 * Create a circuit breaker for external services
 * @param {Object} options - Circuit breaker options
 * @returns {Object} Circuit breaker instance
 */
export function createCircuitBreaker(options = {}) {
    const {
        failureThreshold = 5,
        resetTimeout = 30000,
        name = 'circuit'
    } = options;

    let failures = 0;
    let lastFailure = 0;
    let state = 'closed'; // closed, open, half-open

    return {
        async execute(operation) {
            // Check if circuit should reset
            if (state === 'open' && Date.now() - lastFailure > resetTimeout) {
                state = 'half-open';
                logger.info(`[CircuitBreaker] ${name} entering half-open state`);
            }

            // Reject if circuit is open
            if (state === 'open') {
                throw new Error(`Circuit breaker ${name} is open`);
            }

            try {
                const result = await operation();

                // Success - reset on half-open
                if (state === 'half-open') {
                    state = 'closed';
                    failures = 0;
                    logger.info(`[CircuitBreaker] ${name} closed after successful operation`);
                }

                return result;
            } catch (error) {
                failures++;
                lastFailure = Date.now();

                if (failures >= failureThreshold) {
                    state = 'open';
                    logger.warn(`[CircuitBreaker] ${name} opened after ${failures} failures`);
                }

                throw error;
            }
        },

        getState: () => state,
        getFailures: () => failures,
        reset: () => {
            state = 'closed';
            failures = 0;
            logger.info(`[CircuitBreaker] ${name} manually reset`);
        }
    };
}

export default {
    ErrorCategory,
    classifyError,
    handleError,
    withRetry,
    withTimeout,
    safeAsync,
    createCircuitBreaker,
    ERROR_CODES
};
