/*
 * Watch Together: video pieces shared by everyone watching the same title.
 *
 * Everyone in a session asks for the same HLS segments within a few seconds of each other. The first request fetches
 * the segment from Jellyfin (through the owner's home connection); everyone else gets the copy kept here. Requests
 * that arrive while the first is still downloading wait for it instead of starting their own (in-flight sharing).
 * So the home upload carries each segment about once per session, however many people watch.
 *
 * Least recently used pieces are dropped once the total passes the budget (WATCH_SEGMENT_CACHE_MB). Only complete
 * 200 answers are kept, each at most `maxItemBytes`.
 */
export function createSegmentCache({ maxBytes = 512 * 1024 * 1024, maxItemBytes = 24 * 1024 * 1024, now = () => Date.now() } = {}) {
    const items = new Map(); // key -> { body, type, at }; Map order = recency (oldest first)
    const inflight = new Map(); // key -> Promise<entry>
    let bytes = 0;
    let hits = 0;
    let misses = 0;

    function drop(key) {
        const e = items.get(key);
        if (!e) return;
        bytes -= e.body.length;
        items.delete(key);
    }

    function put(key, entry) {
        if (entry.body.length > maxItemBytes) return;
        drop(key);
        items.set(key, entry);
        bytes += entry.body.length;
        while (bytes > maxBytes && items.size) drop(items.keys().next().value);
    }

    /**
     * The cached answer for key, or loader()'s. loader resolves { status, type, body: Buffer }.
     * Concurrent calls for one key share one loader call.
     */
    async function get(key, loader) {
        const hit = items.get(key);
        if (hit) {
            items.delete(key);
            items.set(key, hit); // most recent
            hits++;
            return { ...hit, cached: true };
        }
        if (inflight.has(key)) {
            hits++;
            return { ...(await inflight.get(key)), cached: true };
        }
        misses++;
        const p = (async () => {
            const entry = await loader();
            if (entry && entry.status === 200 && Buffer.isBuffer(entry.body)) put(key, { status: 200, type: entry.type, body: entry.body, at: now() });
            return entry;
        })();
        inflight.set(key, p);
        try {
            return await p;
        } finally {
            inflight.delete(key);
        }
    }

    /** Forget every piece whose key starts with prefix (a session's title changed or ended). */
    function dropPrefix(prefix) {
        for (const k of [...items.keys()]) if (k.startsWith(prefix)) drop(k);
    }

    return { get, dropPrefix, stats: () => ({ items: items.size, bytes, maxBytes, hits, misses }) };
}
