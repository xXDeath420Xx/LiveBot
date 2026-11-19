// Scheduled restarts, with warnings players actually get.
//
// A nightly restart that drops people mid-voyage with no notice is worse than
// no restart at all, so a scheduled restart is a SEQUENCE, not an event: warn
// at T-5m, warn at T-1m, snapshot, then restart. The warnings go out over RCON
// (~4s each — see spec §2a on spool latency), which is why they are scheduled
// well ahead rather than fired in a tight loop at the last second.
//
// Deliberately not a cron library. One job, one interval, and node's own timers
// are enough — a dependency here would be more code than it saves.

const MINUTE = 60_000;

export function createScheduler({
    docker,
    backups,
    broadcast,          // async (message) => void — usually an RCON say/broadcast
    logger = console,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = () => Date.now(),
} = {}) {
    let timer = null;
    let nextRunAt = null;
    let running = false;

    async function warn(message) {
        if (!broadcast) return;
        try {
            await broadcast(message);
        } catch (err) {
            // A failed warning must never cancel the restart — but it must be
            // visible, because "players got no notice" is the failure people
            // will actually complain about.
            logger.warn?.(`scheduler: broadcast failed: ${err.message}`);
        }
    }

    async function performRestart({ skipSnapshot = false } = {}) {
        if (running) return { skipped: 'already running' };
        running = true;
        try {
            await warn('Server restarting in 5 minutes.');
            await sleep(4 * MINUTE);
            await warn('Server restarting in 1 minute. Find safe harbour.');
            await sleep(MINUTE);

            // Snapshot before bouncing. Safe while running because it copies
            // the engine's sealed zips rather than the live RocksDB.
            let snapshot = null;
            if (!skipSnapshot && backups) {
                try {
                    snapshot = await backups.snapshot({ kind: 'scheduled' });
                } catch (err) {
                    logger.warn?.(`scheduler: pre-restart snapshot failed: ${err.message}`);
                }
            }

            await warn('Restarting now.');
            const result = await docker.restart();
            logger.info?.('scheduler: restart complete');
            return { restarted: true, snapshot, state: result };
        } finally {
            running = false;
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeoutImpl(resolve, ms));
    }

    return {
        /**
         * Schedule a daily restart at local `hour`:`minute`.
         * Re-arms itself after each run.
         */
        scheduleDaily({ hour = 5, minute = 0 } = {}) {
            this.cancel();

            const at = new Date(now());
            at.setHours(hour, minute, 0, 0);
            if (at.getTime() <= now()) at.setDate(at.getDate() + 1);

            // Fire the sequence 5 minutes early so the first warning lands at
            // T-5m and the actual bounce happens at the requested time.
            const fireAt = at.getTime() - 5 * MINUTE;
            const delay = Math.max(0, fireAt - now());

            nextRunAt = at.toISOString();
            timer = setTimeoutImpl(async () => {
                try {
                    await performRestart();
                } catch (err) {
                    logger.error?.(`scheduler: restart failed: ${err.message}`);
                } finally {
                    this.scheduleDaily({ hour, minute });
                }
            }, delay);

            return { nextRunAt };
        },

        /** Fire the full warn → snapshot → restart sequence immediately. */
        restartNow(opts) { return performRestart(opts); },

        cancel() {
            if (timer) clearTimeoutImpl(timer);
            timer = null;
            nextRunAt = null;
        },

        status() {
            return { scheduled: Boolean(timer), nextRunAt, inProgress: running };
        },
    };
}
