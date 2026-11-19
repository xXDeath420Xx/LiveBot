// Greenhouse Tycoon (cfx v2): the shared input validator. HTTP bodies, query strings, the ledger and the
// account store all go through it, so no negative, fractional, NaN, Infinity, string or huge quantity
// can reach domain code. Every failure is a GameError('VALIDATION') with the field name.
//
// Two layers:
//   plain checks   int(), quantity(), str(), oneOf(), bool(), idempotencyKey() - return the clean value
//   schemas        v.object({ field: v.int({min: 1}), ... }) - returns a function(input) -> clean object;
//                  unknown keys are refused, so "__proto__" or "constructor" never get through
import { GameError } from './errors.js';
import { LIMITS } from '../config/game.js';

function fail(field, reason) {
    throw new GameError('VALIDATION', undefined, { field, reason });
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** A JSON number that is a safe integer inside [min, max]. Strings, floats, NaN and Infinity fail. */
export function int(value, { min = -SAFE, max = SAFE, field = 'value' } = {}) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(field, 'must be a whole number');
    if (value < min || value > max) fail(field, `must be between ${min} and ${max}`);
    return value === 0 ? 0 : value; // normalise -0
}

/** For query strings and route params: plain decimal digits only ("12", "-3"); no "1e3", "0x1", " 5". */
export function intFromString(value, opts = {}) {
    if (typeof value === 'string') {
        if (!/^-?\d{1,16}$/.test(value)) fail(opts.field || 'value', 'must be a whole number');
        value = Number(value);
    }
    return int(value, opts);
}

/** A count of something: integer >= 1. */
export function quantity(value, { max = LIMITS.MAX_ITEM_DELTA, field = 'quantity' } = {}) {
    return int(value, { min: 1, max, field });
}

/** A database id: integer >= 1. */
export function id(value, { field = 'id', max = SAFE } = {}) {
    return int(value, { min: 1, max, field });
}

export function str(value, { min = 0, max = 255, pattern = null, trim = true, field = 'value' } = {}) {
    if (typeof value !== 'string') fail(field, 'must be text');
    const out = trim ? value.trim() : value;
    if (out.length < min || out.length > max) fail(field, `must be ${min}-${max} characters`);
    if (pattern && !pattern.test(out)) fail(field, 'has an invalid format');
    return out;
}

export function oneOf(value, allowed, { field = 'value' } = {}) {
    if (!allowed.includes(value)) fail(field, 'is not an allowed value');
    return value;
}

export function bool(value, { field = 'value' } = {}) {
    if (typeof value !== 'boolean') fail(field, 'must be true or false');
    return value;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

/** Client-chosen request id: 8-64 of A-Z a-z 0-9 . _ : - */
export function idempotencyKey(value, { field = 'idempotencyKey' } = {}) {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) fail(field, 'must be 8-64 characters of A-Z a-z 0-9 . _ : -');
    return value;
}

/** Strip control and formatting characters from a display name, collapse spaces, cut to max. */
export function displayName(value, { max = 32, fallback = null } = {}) {
    if (typeof value !== 'string') return fallback;
    const clean = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
    if (!clean) return fallback;
    return Array.from(clean).slice(0, max).join('');
}

/**
 * A name a player chose (POST /account/name): cleaned like displayName() (control and formatting characters
 * removed, spaces collapsed, NFKC), then min-max characters of letters, digits, spaces and . _ ' - with at
 * least one letter. Which words are allowed is lib/name-filter.js's job.
 */
export function playerName(value, { min = 2, max = 24, field = 'name' } = {}) {
    if (typeof value !== 'string') fail(field, 'must be text');
    if (value.length > 200) fail(field, `must be ${min}-${max} characters`);
    const clean = displayName(value, { max: 200 }) || '';
    const length = Array.from(clean).length;
    if (length < min || length > max) fail(field, `must be ${min}-${max} characters`);
    if (!/^[\p{L}\p{M}\p{N} ._'-]+$/u.test(clean)) fail(field, "may only use letters, numbers, spaces and . _ ' -");
    if (!/\p{L}/u.test(clean)) fail(field, 'must contain a letter');
    return clean;
}

// ---------------------------------------------------------------- schemas

function check(fn, { optional = false, defaultValue } = {}) {
    fn.optional = optional;
    if (defaultValue !== undefined) fn.defaultValue = defaultValue;
    return fn;
}

export const v = {
    int: (opts = {}) => check((x, field) => int(x, { ...opts, field })),
    id: (opts = {}) => check((x, field) => id(x, { ...opts, field })),
    quantity: (opts = {}) => check((x, field) => quantity(x, { ...opts, field })),
    str: (opts = {}) => check((x, field) => str(x, { ...opts, field })),
    oneOf: (allowed) => check((x, field) => oneOf(x, allowed, { field })),
    bool: () => check((x, field) => bool(x, { field })),
    playerName: (opts = {}) => check((x, field) => playerName(x, { ...opts, field })),
    /** Make any check optional; `defaultValue` fills a missing field. */
    optional: (inner, defaultValue) => check((x, field) => inner(x, field), { optional: true, defaultValue }),
    array: (inner, { min = 0, max = 50 } = {}) => check((x, field) => {
        if (!Array.isArray(x)) fail(field, 'must be a list');
        if (x.length < min || x.length > max) fail(field, `must have ${min}-${max} entries`);
        return x.map((item, i) => inner(item, `${field}[${i}]`));
    }),
    object: (shape, opts) => check(objectSchema(shape, opts))
};

function isPlainObject(x) {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
    const proto = Object.getPrototypeOf(x);
    return proto === Object.prototype || proto === null;
}

function objectSchema(shape, { allowUnknown = false } = {}) {
    return (input, field = 'body') => {
        if (!isPlainObject(input)) fail(field, 'must be an object');
        if (!allowUnknown) {
            for (const key of Object.keys(input)) {
                if (!Object.hasOwn(shape, key)) fail(field === 'body' ? key : `${field}.${key}`, 'is not allowed');
            }
        }
        const out = {};
        for (const [key, checker] of Object.entries(shape)) {
            const path = field === 'body' ? key : `${field}.${key}`;
            if (!Object.hasOwn(input, key) || input[key] === undefined) {
                if (checker.optional) {
                    if (checker.defaultValue !== undefined) out[key] = checker.defaultValue;
                    continue;
                }
                fail(path, 'is required');
            }
            out[key] = checker(input[key], path);
        }
        return out;
    };
}

/** Build a body validator: schema(input) -> clean object, or throws GameError('VALIDATION'). */
export function schema(shape, opts) {
    return objectSchema(shape, opts);
}
