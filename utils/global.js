/*
 * Compatibility shim for upstream OwO Bot's global.js utility.
 *
 * Upstream used `global` as a bag of helpers — UID lookup, fancy number
 * formatting, emoji resolution, etc. We expose the subset the battle
 * module actually calls. Anything not yet implemented logs a warning and
 * returns a safe default.
 */

import logger from './logger.js';

/**
 * Upstream used a synthetic `uid INT AUTO_INCREMENT` distinct from Discord
 * snowflakes. CertiFried uses Discord snowflakes directly so `getUid(id)`
 * is the identity function.
 */
export async function getUid(id) {
    return String(id);
}

/**
 * Format numbers in OwO-bot style. 1234 → "1,234", 1500000 → "1.5M", etc.
 */
export function toFancyNum(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    const abs = Math.abs(x);
    if (abs >= 1e12) return (x / 1e12).toFixed(2).replace(/\.?0+$/, '') + 'T';
    if (abs >= 1e9)  return (x / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (abs >= 1e6)  return (x / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    return x.toLocaleString();
}

/**
 * Format a number with thousands separators only, no abbreviation.
 */
export function toCommas(n) {
    return Number(n).toLocaleString();
}

/**
 * Stub: anything else that gets requested, warn once + return undefined so
 * we can find and implement it on demand.
 */
const seenMissing = new Set();
function missing(name) {
    return (...args) => {
        if (!seenMissing.has(name)) {
            seenMissing.add(name);
            logger.warn(`[owo-compat] global.${name}(...) called but not implemented — returning undefined`, { argc: args.length });
        }
        return undefined;
    };
}

const handler = {
    get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return missing(String(prop));
    },
};

const globalShim = new Proxy({ getUid, toFancyNum, toCommas }, handler);

export default globalShim;
