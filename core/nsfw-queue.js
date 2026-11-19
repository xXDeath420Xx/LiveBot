/*
 * The NSFW classifier's job queue — pure (no workers, no timers; unit-tested in tests/nsfw-protection.test.js).
 * core/nsfw-classifier.js owns the worker threads and feeds them from here.
 *
 * Backpressure, not buffering: inference is CPU-bound on a shared server, so the queue is small and
 * bounded, and a job that cannot be queued is DROPPED at once (the caller is told 'overloaded' and the
 * scan is counted as skipped in the stats) instead of piling up behind the event loop. Two lanes:
 *
 *   priority   live checks that act on a person (a join, an avatar change): served first
 *   normal     chat images and background member scans
 *
 * A job that waited longer than its lane's maxWaitMs is dropped when it reaches the front (a chat image
 * judged a minute late is no longer worth the CPU; the message has long been read).
 */

export function createJobQueue({ maxNormal = 24, maxPriority = 12, maxWaitMs = 45_000, maxPriorityWaitMs = 60_000 } = {}) {
    const lanes = { priority: [], normal: [] };
    const stats = { accepted: 0, dropped: 0, droppedPriority: 0, expired: 0, started: 0, maxDepth: 0 };

    const depth = () => lanes.priority.length + lanes.normal.length;

    /**
     * @returns {boolean} false = dropped (the lane is full)
     */
    function offer(job, { priority = false, now = Date.now() } = {}) {
        const lane = priority ? lanes.priority : lanes.normal;
        const cap = priority ? maxPriority : maxNormal;
        if (lane.length >= cap) {
            stats.dropped++;
            if (priority) stats.droppedPriority++;
            return false;
        }
        lane.push({ job, at: now, priority });
        stats.accepted++;
        stats.maxDepth = Math.max(stats.maxDepth, depth());
        return true;
    }

    /**
     * The next job to run, priority lane first. Jobs that waited too long are handed back in `expired`
     * so the caller can settle them.
     * @returns {{ job:any|null, expired:any[] }}
     */
    function take(now = Date.now()) {
        const expired = [];
        for (const [lane, limit] of [[lanes.priority, maxPriorityWaitMs], [lanes.normal, maxWaitMs]]) {
            while (lane.length) {
                const head = lane[0];
                if (now - head.at <= limit) {
                    lane.shift();
                    stats.started++;
                    return { job: head.job, expired };
                }
                lane.shift();
                stats.expired++;
                expired.push(head.job);
            }
        }
        return { job: null, expired };
    }

    /** Remove everything (shutdown, or the runtime turned out to be missing). */
    function drain() {
        const all = [...lanes.priority, ...lanes.normal].map(e => e.job);
        lanes.priority.length = 0;
        lanes.normal.length = 0;
        return all;
    }

    return {
        offer, take, drain,
        get depth() { return depth(); },
        get waiting() { return { priority: lanes.priority.length, normal: lanes.normal.length }; },
        stats,
        limits: { maxNormal, maxPriority, maxWaitMs, maxPriorityWaitMs },
    };
}

export default { createJobQueue };
