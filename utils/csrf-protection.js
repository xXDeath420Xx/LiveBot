import crypto from 'crypto';
import logger from './logger.js';

const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_NAME = '_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_BODY_FIELD = '_csrf';

/**
 * Generate a secure CSRF token
 * @returns {string} Random hex token
 */
function generateToken() {
    return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * CSRF protection middleware
 * Generates and validates CSRF tokens for state-changing requests
 */
export function csrfProtection(options = {}) {
    const {
        ignoreMethods = ['GET', 'HEAD', 'OPTIONS'],
        ignorePaths = [],
        cookieOptions = {}
    } = options;

    return (req, res, next) => {
        // Skip CSRF for safe methods
        if (ignoreMethods.includes(req.method)) {
            // Ensure token exists in session for forms
            if (!req.session.csrfToken) {
                req.session.csrfToken = generateToken();
            }
            // Make token available to templates
            res.locals.csrfToken = req.session.csrfToken;
            return next();
        }

        // Skip CSRF for ignored paths (like webhooks)
        if (ignorePaths.some(path => req.path.startsWith(path))) {
            return next();
        }

        // Get token from session
        const sessionToken = req.session?.csrfToken;
        if (!sessionToken) {
            logger.warn('[CSRF] No session token found', { path: req.path, ip: req.ip });
            return res.status(403).json({ error: 'CSRF token missing. Please refresh the page.' });
        }

        // Get token from request (header or body)
        const requestToken = req.headers[CSRF_HEADER_NAME] ||
                           req.body?.[CSRF_BODY_FIELD] ||
                           req.query?.[CSRF_BODY_FIELD];

        if (!requestToken) {
            logger.warn('[CSRF] No request token provided', { path: req.path, ip: req.ip });
            return res.status(403).json({ error: 'CSRF token not provided' });
        }

        // Timing-safe comparison
        try {
            const valid = requestToken.length === sessionToken.length &&
                         crypto.timingSafeEqual(
                             Buffer.from(requestToken),
                             Buffer.from(sessionToken)
                         );

            if (!valid) {
                logger.warn('[CSRF] Token mismatch', { path: req.path, ip: req.ip });
                return res.status(403).json({ error: 'Invalid CSRF token. Please refresh the page.' });
            }
        } catch (error) {
            logger.warn('[CSRF] Token comparison error', { path: req.path, error: error.message });
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }

        // Token valid - rotate for next request (optional, increases security)
        // req.session.csrfToken = generateToken();
        // res.locals.csrfToken = req.session.csrfToken;

        next();
    };
}

/**
 * Generate CSRF token for forms - add to res.locals
 * Use this for pages that need the token in their forms
 */
export function csrfToken(req, res, next) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = generateToken();
    }
    res.locals.csrfToken = req.session.csrfToken;
    next();
}

/**
 * Get current CSRF token from session (for API responses)
 */
export function getCsrfToken(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = generateToken();
    }
    return req.session.csrfToken;
}

export default {
    csrfProtection,
    csrfToken,
    getCsrfToken
};
