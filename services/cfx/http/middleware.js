// Greenhouse Tycoon (cfx v2): shared request middleware.
import { gameError, isGameError } from '../lib/errors.js';
import { IDEMPOTENCY_KEY_PATTERN, schema } from '../lib/validate.js';

/**
 * Every POST/PUT/PATCH/DELETE must carry an Idempotency-Key header (8-64 of A-Z a-z 0-9 . _ : -).
 * Routes that move money or items pass it to the ledger as the operation key, so a retried request is a
 * no-op; the other routes are idempotent by design. It is exposed as req.idempotencyKey.
 */
export function requireIdempotencyKey() {
    return (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
        const key = req.get('idempotency-key');
        if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) return next(gameError('IDEMPOTENCY_KEY_REQUIRED'));
        req.idempotencyKey = key;
        next();
    };
}

/** Validate req.body against a schema shape; the clean value replaces req.body. */
export function body(shape, opts) {
    const check = schema(shape, opts);
    return (req, res, next) => {
        try {
            req.body = check(req.body === undefined ? {} : req.body);
            next();
        } catch (err) {
            next(err);
        }
    };
}

/** Wrap an async handler so a rejection reaches the error handler. */
export function handler(fn) {
    return (req, res, next) => {
        Promise.resolve().then(() => fn(req, res, next)).catch(next);
    };
}

export function notFound() {
    return (req, res, next) => next(gameError('NOT_FOUND'));
}

/** The one error shape: { error: { code, message, details? } }. Unknown errors are a generic 500. */
export function errorHandler({ logger = console } = {}) {
    // eslint-disable-next-line no-unused-vars
    return (err, req, res, next) => {
        let out = err;
        if (!isGameError(err)) {
            if (err?.type === 'entity.parse.failed') out = gameError('BAD_JSON');
            else if (err?.type === 'entity.too.large') out = gameError('PAYLOAD_TOO_LARGE');
            else if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') out = gameError('VALIDATION', { field: 'body', reason: 'unsupported encoding' });
            else {
                logger.error?.('[cfx2] unhandled error', { method: req.method, path: req.path, error: err?.message, code: err?.code });
                out = gameError('INTERNAL');
            }
        }
        if (res.headersSent) return;
        res.status(out.status).json(out.toJSON());
    };
}
