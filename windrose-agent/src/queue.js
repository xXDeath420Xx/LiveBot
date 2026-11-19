// Serialising rate-limit queue for Windrose+ RCON.
//
// Windrose+ limits POST /api/rcon to 1 request/second PER CLIENT IP. The panel
// is a single server-side client, so that budget is shared by every friend with
// the page open. Without a queue, two people clicking at once means one of them
// silently gets a 429 — so all RCON traffic funnels through here.
//
// FIFO and strictly serial: fairness matters more than throughput at 1 req/s,
// and out-of-order admin commands ("ban then kick" arriving reversed) would be
// worse than slow ones.
//
// `now` and `sleep` are injectable so tests can drive the clock instead of
// actually waiting seconds per assertion.

export function createQueue({
    minIntervalMs = 1100,
    timeoutMs = 25_000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxPending = 50,
} = {}) {
    let lastStartedAt = -Infinity;
    let chain = Promise.resolve();
    let pending = 0;

    async function run(task) {
        const wait = minIntervalMs - (now() - lastStartedAt);
        if (wait > 0) await sleep(wait);
        lastStartedAt = now();

        // Timeout races the task rather than cancelling it — we cannot abort
        // work already accepted by Windrose+, but we can stop one wedged
        // command from blocking everyone queued behind it.
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`queue: task timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        try {
            return await Promise.race([task(), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        /**
         * Enqueue a task. Resolves/rejects with the task's own result.
         * Rejects immediately if the backlog is already too deep — shedding
         * load beats accumulating a queue nobody is still waiting on.
         */
        push(task) {
            if (pending >= maxPending) {
                return Promise.reject(new Error('queue: too many pending commands'));
            }
            pending++;

            // Each caller gets a promise for its own task, but the chain itself
            // must never reject — a failed task would otherwise poison every
            // subsequent one.
            const result = chain.then(() => run(task));
            chain = result.catch(() => {});
            return result.finally(() => { pending--; });
        },

        get pending() { return pending; },
    };
}
