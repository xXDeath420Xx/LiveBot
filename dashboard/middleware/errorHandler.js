import logger from '../../utils/logger.js';

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req, res, next) {
    res.status(404).render('error', {
        user: req.user || null,
        error: 'Page not found',
        statusCode: 404
    });
}

/**
 * Global error handler
 */
export function errorHandler(err, req, res, next) {
    // Log the error
    logger.error('[Dashboard Error]', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        user: req.user?.username || 'anonymous'
    });

    // Determine status code
    const statusCode = err.status || err.statusCode || 500;

    // Handle API requests differently
    if (req.path.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(statusCode).json({
            error: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message,
            ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
        });
    }

    // Render error page for regular requests
    res.status(statusCode).render('error', {
        user: req.user || null,
        error: process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred. Please try again later.'
            : err.message,
        statusCode
    });
}

/**
 * Async handler wrapper to catch errors in async route handlers
 * @param {Function} fn - Async function to wrap
 * @returns {Function} Wrapped function
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Validation error handler for form submissions
 */
export function validationErrorHandler(errors, req, res) {
    if (req.path.startsWith('/api/') || req.xhr) {
        return res.status(400).json({
            error: 'Validation failed',
            errors: errors
        });
    }

    // For regular form submissions, flash errors and redirect back
    req.session.errors = errors;
    res.redirect('back');
}

/**
 * Rate limit exceeded handler
 */
export function rateLimitHandler(req, res) {
    const message = 'Too many requests. Please try again later.';

    if (req.path.startsWith('/api/') || req.xhr) {
        return res.status(429).json({ error: message });
    }

    res.status(429).render('error', {
        user: req.user || null,
        error: message,
        statusCode: 429
    });
}

/**
 * Create standardized error response
 * @param {string} message - Error message
 * @param {number} statusCode - HTTP status code
 * @returns {Error} Error object with statusCode
 */
export function createError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

export default {
    notFoundHandler,
    errorHandler,
    asyncHandler,
    validationErrorHandler,
    rateLimitHandler,
    createError
};
