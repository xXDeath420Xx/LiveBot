/*
 * Stream bot: the in-process live event feed behind the dashboard's SSE stream (GET /stream/bot/api/feed).
 * One process runs the dashboard and the ingestion hooks, so a plain listener map is enough.
 *
 *   const feed = createFeed();
 *   const off = feed.subscribe(profileId, (event) => …);   at most 10 listeners per profile (oldest dropped)
 *   feed.publish(profileId, event);
 */
export function createFeed({ maxPerProfile = 10 } = {}) {
    const listeners = new Map();   // profileId -> Set<fn>
    return {
        subscribe(profileId, fn) {
            const key = Number(profileId);
            if (!listeners.has(key)) listeners.set(key, new Set());
            const set = listeners.get(key);
            if (set.size >= maxPerProfile) {
                const oldest = set.values().next().value;
                set.delete(oldest);
                try { oldest({ type: '_closed' }); } catch { /* listener gone */ }
            }
            set.add(fn);
            return () => {
                set.delete(fn);
                if (!set.size) listeners.delete(key);
            };
        },
        publish(profileId, event) {
            for (const fn of listeners.get(Number(profileId)) || []) {
                try { fn(event); } catch { /* one bad listener must not stop the others */ }
            }
        },
        count(profileId) { return listeners.get(Number(profileId))?.size || 0; },
    };
}

export default { createFeed };
