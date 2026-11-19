// TTL cache with single-flight.
//
// The panel polls status every 2s per open browser tab. Without this, ten
// friends with the page open would be ten times the upstream load on a server
// that rate limits at 1 req/s. The cache collapses all of that into one
// refresh per TTL regardless of how many people are watching.
//
// Single-flight matters as much as the TTL: on a cold or expired entry, N
// concurrent callers must produce ONE upstream request, not N. That is the
// stampede that actually trips the rate limiter, because it happens precisely
// when everyone loads the page at once.

export function createCache({ now = () => Date.now() } = {}) {
    const entries = new Map(); // key → { value, expiresAt }
    const inflight = new Map(); // key → Promise

    return {
        /**
         * Return the cached value for `key`, or call `producer()` to fill it.
         * Concurrent misses share a single producer call.
         */
        async get(key, ttlMs, producer) {
            const hit = entries.get(key);
            if (hit && hit.expiresAt > now()) return hit.value;

            const existing = inflight.get(key);
            if (existing) return existing;

            const promise = (async () => {
                const value = await producer();
                entries.set(key, { value, expiresAt: now() + ttlMs });
                return value;
            })();

            // Register before awaiting so a caller arriving in the same tick
            // joins this flight instead of starting its own.
            inflight.set(key, promise);
            try {
                return await promise;
            } finally {
                inflight.delete(key);
            }
        },

        /** Drop a key so the next read refetches — used after mutating actions. */
        invalidate(key) {
            entries.delete(key);
        },

        clear() {
            entries.clear();
        },
    };
}
