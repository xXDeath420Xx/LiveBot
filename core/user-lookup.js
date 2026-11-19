/**
 * Discord user lookup for ids nobody else can name: people who LEFT a server.
 *
 * core/user-display.js names an id from the guild's member cache, the client's user cache or a
 * name the caller stored with its row. Someone who left (an infraction subject, a banned spammer)
 * is in none of those once the bot restarts, so dashboard tables fell back to the raw id. This
 * module asks Discord itself (`client.users.fetch(id)`, the client's REST, which also handles
 * Discord's own rate-limit buckets) and remembers the answer:
 *
 *   - LRU cache (maxEntries): a found user for ~24 h, "unknown user" (10013 / 404) for ~1 h,
 *     any other failure for a minute so a flaky moment is not hammered.
 *   - One global queue, at most `ratePerSec` lookups started per second across every guild and
 *     bot; concurrent requests for the same id share one lookup (dedupe).
 *   - A 429 (or a discord.js RateLimitError) pauses the whole queue for the retry-after and puts
 *     the id back at the front; nothing is cached for it.
 *   - Callers never wait for the queue: `request()` hands back what is cached now, waits at most
 *     `waitMs` for the rest, and lists what is still queued as `pending` with a retry hint. The
 *     dashboard (GET /api/guilds/:guildId/users/resolve, dashboard/public/js/cf-user.js) shows
 *     the id first and asks again for pending ids.
 *
 * `createUserLookup()` takes its clock, timer and fetch function as options so the cache, dedupe,
 * rate cap and 429 handling unit-test without Discord (tests/user-lookup.test.js); the module's
 * default instance (`userLookup`) is what the dashboard uses.
 */

const HOUR = 60 * 60 * 1000;
export const LOOKUP_DEFAULTS = Object.freeze({
    ratePerSec: 5,             // lookups started per second, all guilds together
    perRequest: 50,            // new ids one request() may queue; the rest wait for the next poll
    maxQueue: 500,             // ids waiting at once; beyond that request() reports them pending
    maxEntries: 5000,          // LRU size
    positiveTtlMs: 24 * HOUR,
    negativeTtlMs: 1 * HOUR,
    errorTtlMs: 60 * 1000,
    rateLimitFallbackMs: 5000, // pause when a 429 carries no retry-after
});

/** The shape core/user-display.js uses, for a discord.js User (or a plain object like one). */
export function bitsFromUser(user) {
    if (!user?.id) return null;
    let avatar = null;
    try { avatar = user.displayAvatarURL?.({ size: 64 }) ?? null; } catch { avatar = null; }
    const username = user.username ?? null;
    return {
        id: String(user.id),
        username,
        displayName: user.globalName || username,
        avatar,
        inServer: false,
    };
}

/** True when bits carry a name to show. */
export function isNamed(b) {
    return !!(b && (b.displayName || b.username));
}

/**
 * Fold Discord lookups into resolveMany() output, keeping the lookup order: a member or cached
 * user (already named) always wins; a looked-up user only fills an id nothing else could name.
 * With `membersKnown` (the member fetch completed) every named non-member gets `left: true`.
 * Mutates and returns `users`.
 */
export function applyLookups(users, found = {}, { membersKnown = false } = {}) {
    for (const [id, bits] of Object.entries(found || {})) {
        if (bits && !isNamed(users[id])) users[id] = { ...bits, id, inServer: false };
    }
    if (membersKnown) for (const b of Object.values(users)) if (isNamed(b) && !b.inServer) b.left = true;
    return users;
}

/** 'unknown' (Discord says no such user), 'ratelimit' (429), or 'error' (anything else). */
export function classifyLookupError(err) {
    const status = Number(err?.status ?? err?.httpStatus ?? 0);
    if (status === 429 || err?.name === 'RateLimitError' || /ratelimit/i.test(String(err?.name || ''))) return 'ratelimit';
    if (Number(err?.code) === 10013 || status === 404) return 'unknown';
    return 'error';
}

/** Milliseconds to wait after a 429, from whatever the error carries (ms or seconds). */
export function retryAfterMs(err, fallback = LOOKUP_DEFAULTS.rateLimitFallbackMs) {
    const ms = Number(err?.retryAfter ?? err?.timeToReset ?? NaN);   // discord.js RateLimitError: ms
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
    const s = Number(err?.rawError?.retry_after ?? NaN);              // raw 429 body: seconds
    if (Number.isFinite(s) && s > 0) return Math.ceil(s * 1000);
    return fallback;
}

/**
 * @param {object} [o]  any LOOKUP_DEFAULTS key, plus:
 * @param {function} [o.now]       clock (ms)
 * @param {function} [o.schedule]  (fn, ms) => void; default setTimeout, unref'd
 * @param {function} [o.fetchUser] (client, id) => Promise<User>; default client.users.fetch(id, { cache: false })
 */
export function createUserLookup(o = {}) {
    const cfg = { ...LOOKUP_DEFAULTS, ...o };
    const now = o.now || Date.now;
    const schedule = o.schedule || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); });
    const fetchUser = o.fetchUser || ((client, id) => client.users.fetch(id, { cache: false }));
    const interval = 1000 / Math.max(0.01, cfg.ratePerSec);

    const cache = new Map();   // id -> { bits|null, expires }   (Map order = LRU order)
    const queued = new Map();  // id -> { client, waiters: [resolve] }   waiting or in flight
    const queue = [];          // ids not yet started, oldest first
    let nextSlot = 0;          // earliest time the next lookup may start
    let pausedUntil = 0;       // set by a 429
    let timerArmed = false;
    const stats = { fetched: 0, found: 0, unknown: 0, errors: 0, rateLimited: 0 };

    function remember(id, bits, ttl) {
        cache.delete(id);
        cache.set(id, { bits, expires: now() + ttl });
        while (cache.size > cfg.maxEntries) cache.delete(cache.keys().next().value);
    }

    /** { bits } (bits null = Discord has no such user) while a fresh answer is cached, else null. */
    function peek(id) {
        const key = String(id ?? '');
        const hit = cache.get(key);
        if (!hit) return null;
        if (hit.expires <= now()) { cache.delete(key); return null; }
        cache.delete(key); cache.set(key, hit);   // touch: most recently used
        return { bits: hit.bits };
    }

    function settle(id, bits) {
        const q = queued.get(id);
        queued.delete(id);
        for (const done of q?.waiters || []) { try { done(bits); } catch { /* one bad waiter */ } }
    }

    function arm() {
        if (timerArmed || !queue.length) return;
        timerArmed = true;
        schedule(run, Math.max(0, nextSlot - now(), pausedUntil - now()));
    }

    function run() {
        timerArmed = false;
        const t = now();
        if (t < pausedUntil || t < nextSlot) return arm();
        const id = queue.shift();
        if (id === undefined) return;
        const q = queued.get(id);
        if (!q) return arm();
        nextSlot = t + interval;
        stats.fetched++;
        Promise.resolve()
            .then(() => fetchUser(q.client, id))
            .then((user) => {
                const bits = bitsFromUser(user);
                if (bits) { stats.found++; remember(id, bits, cfg.positiveTtlMs); } else { stats.unknown++; remember(id, null, cfg.negativeTtlMs); }
                settle(id, bits);
            }, (err) => {
                const kind = classifyLookupError(err);
                if (kind === 'ratelimit') {
                    stats.rateLimited++;
                    pausedUntil = Math.max(pausedUntil, now() + retryAfterMs(err, cfg.rateLimitFallbackMs));
                    queue.unshift(id);   // try again first once the pause is over; waiters keep waiting
                    return arm();
                }
                if (kind === 'unknown') { stats.unknown++; remember(id, null, cfg.negativeTtlMs); } else { stats.errors++; remember(id, null, cfg.errorTtlMs); }
                settle(id, null);
            });
        arm();
    }

    /**
     * Queue one id (deduped) and get a promise of its bits (null when Discord has none). Resolves
     * at once from the cache; `undefined` when the queue is full (nothing was queued).
     */
    function lookup(client, id) {
        const key = String(id ?? '');
        const hit = peek(key);
        if (hit) return Promise.resolve(hit.bits);
        return new Promise((resolve) => {
            const q = queued.get(key);
            if (q) { q.waiters.push(resolve); return; }
            if (!client || queue.length >= cfg.maxQueue) { resolve(undefined); return; }
            queued.set(key, { client, waiters: [resolve] });
            queue.push(key);
            arm();
        });
    }

    /**
     * Names for many ids without holding the caller up for long.
     * @returns {Promise<{ found: Object<string,object>, unknown: string[], pending: string[], retryAfterMs: number }>}
     *   found: bits by id; unknown: Discord has no such user; pending: still queued (or not queued
     *   yet because of the per-request cap / a full queue) - ask again after retryAfterMs.
     */
    async function request(client, ids, { max = cfg.perRequest, waitMs = 0 } = {}) {
        const found = {};
        const unknown = [];
        const pending = [];
        const asked = [];          // ids whose lookup this call waits on
        const done = new Map();    // id -> bits (null: no such user, undefined: queue was full)
        const waits = [];
        let added = 0;
        for (const id of new Set([...(ids || [])].map(String))) {
            const hit = peek(id);
            if (hit) { if (hit.bits) found[id] = hit.bits; else unknown.push(id); continue; }
            if (!queued.has(id)) {
                if (added >= max || !client || queue.length >= cfg.maxQueue) { pending.push(id); continue; }
                added++;
            }
            asked.push(id);
            waits.push(lookup(client, id).then((bits) => { done.set(id, bits); }));
        }
        if (waits.length && waitMs > 0) {
            await Promise.race([Promise.all(waits), new Promise((r) => schedule(r, waitMs))]);
        }
        // Whatever has not settled by now stays queued and is answered on a later poll.
        for (const id of asked) {
            const bits = done.get(id);
            if (bits) found[id] = bits;
            else if (bits === null) unknown.push(id);
            else pending.push(id);
        }
        return { found, unknown, pending, retryAfterMs: pending.length ? hintMs() : 0 };
    }

    /** How long until a poll is likely to find the queue's current tail answered. */
    function hintMs() {
        const wait = Math.max(0, pausedUntil - now()) + Math.ceil(queue.length * interval);
        return Math.min(15000, Math.max(1500, wait + 500));
    }

    return {
        peek,
        lookup,
        request,
        stats: () => ({ ...stats, cached: cache.size, queued: queue.length, inFlight: queued.size - queue.length, pausedForMs: Math.max(0, pausedUntil - now()) }),
        clear: () => cache.clear(),
    };
}

/** The process-wide instance the dashboard uses. */
export const userLookup = createUserLookup();

export default userLookup;
