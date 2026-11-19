// Greenhouse Tycoon (cfx v2): the one scheduler for periodic jobs. Jobs are global and minutes-scale;
// there is no per-player tick.
//
//   Overlap guard  a job never runs twice at once: in-process (a running flag) and, when a `lock`
//                  provider is given, across processes (store/job-runs.js acquire: MariaDB GET_LOCK).
//                  A tick that finds the job still running is skipped and counted.
//   Jitter         each run is scheduled interval + random(0..jitterMs) after the previous one finished,
//                  and the first run waits random(0..jitterMs), so jobs do not fire in step.
//   Timeout        a run longer than timeoutMs is reported (status 'timeout') and its AbortSignal fires.
//                  The job stays marked running until its promise settles, so a stuck run still blocks
//                  overlap.
//   Kill switch    a run is skipped when any of these is on:
//                    - env CFX2_JOBS_DISABLED: "1"/"all"/"true" for all jobs, or a comma list of job names
//                    - isDisabled(name) (store/flags.js: gh_config 'jobs.disabled'), read before every run
//                    - scheduler.kill() in-process (stops future runs immediately)

export function parseDisabledEnv(value) {
    if (value == null) return { all: false, names: new Set() };
    const s = String(value).trim();
    if (!s || s === '0' || s.toLowerCase() === 'false') return { all: false, names: new Set() };
    if (['1', 'all', 'true', '*'].includes(s.toLowerCase())) return { all: true, names: new Set() };
    return { all: false, names: new Set(s.split(',').map(x => x.trim()).filter(Boolean)) };
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function createScheduler({
    logger = console,
    isDisabled = async () => false,
    lock = null,
    recorder = null,
    envDisabled = process.env.CFX2_JOBS_DISABLED,
    random = Math.random,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    const env = parseDisabledEnv(envDisabled);
    const jobs = new Map();
    let started = false;
    let killed = false;

    function register({ name, intervalMs, jitterMs = 0, timeoutMs, run }) {
        if (!NAME_PATTERN.test(name || '')) throw new Error(`invalid job name "${name}"`);
        if (jobs.has(name)) throw new Error(`job "${name}" already registered`);
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new Error('intervalMs must be an integer >= 10');
        if (!Number.isSafeInteger(jitterMs) || jitterMs < 0) throw new Error('jitterMs must be a non-negative integer');
        if (typeof run !== 'function') throw new Error('run must be a function');
        const job = {
            name, intervalMs, jitterMs, timeoutMs: timeoutMs ?? Math.max(intervalMs, 1000), run,
            running: false, timer: null, inFlight: null,
            stats: { runs: 0, failures: 0, timeouts: 0, skippedOverlap: 0, skippedDisabled: 0, lastStatus: null, lastStartedAt: null, lastDurationMs: null, lastError: null }
        };
        jobs.set(name, job);
        if (started && !killed) schedule(job, true);
        return job.name;
    }

    function delayFor(job, first) {
        const jitter = job.jitterMs ? Math.floor(random() * (job.jitterMs + 1)) : 0;
        return first ? jitter : job.intervalMs + jitter;
    }

    function schedule(job, first = false) {
        if (killed || !started || job.timer) return; // one timer chain per job
        job.timer = setTimer(() => {
            job.timer = null;
            tick(job).finally(() => schedule(job));
        }, delayFor(job, first));
        job.timer?.unref?.();
    }

    async function record(job, status, startedAt, error) {
        job.stats.lastStatus = status;
        if (!recorder) return;
        try {
            await recorder.record(job.name, { status, startedAt, finishedAt: now(), durationMs: startedAt ? now() - startedAt : null, error });
        } catch (err) {
            logger.warn?.('[cfx2] could not record job run', { job: job.name, error: err.message });
        }
    }

    async function disabledReason(job) {
        if (killed) return 'killed';
        if (env.all || env.names.has(job.name)) return 'env';
        try {
            if (await isDisabled(job.name)) return 'config';
        } catch (err) {
            logger.warn?.('[cfx2] kill-switch check failed; running anyway', { job: job.name, error: err.message });
        }
        return null;
    }

    /** Run one job now, respecting the guards. Returns 'ok' | 'error' | 'timeout' | 'skipped:overlap' | 'skipped:disabled'. */
    async function tick(job) {
        if (job.running) {
            job.stats.skippedOverlap++;
            logger.warn?.('[cfx2] job skipped: previous run still going', { job: job.name });
            await record(job, 'skipped', null, 'overlap');
            return 'skipped:overlap';
        }
        // Claim the job before the first await, so a concurrent tick cannot slip past the check above.
        job.running = true;
        const reason = await disabledReason(job);
        if (reason) {
            job.running = false;
            job.stats.skippedDisabled++;
            return 'skipped:disabled';
        }
        let release = null;
        const startedAt = now();
        job.stats.lastStartedAt = startedAt;
        try {
            if (lock) {
                release = await lock.acquire(job.name);
                if (!release) {
                    job.stats.skippedOverlap++;
                    await record(job, 'skipped', null, 'locked by another process');
                    return 'skipped:overlap';
                }
            }
            const controller = new AbortController();
            const runPromise = Promise.resolve().then(() => job.run({ signal: controller.signal, name: job.name }));
            job.inFlight = runPromise;
            let timeoutHandle;
            const timedOut = new Promise(resolve => {
                timeoutHandle = setTimer(() => resolve('timeout'), job.timeoutMs);
                timeoutHandle?.unref?.();
            });
            const outcome = await Promise.race([runPromise.then(() => 'ok', err => ({ err })), timedOut]);
            clearTimer(timeoutHandle);
            if (outcome === 'timeout') {
                job.stats.timeouts++;
                controller.abort();
                logger.warn?.('[cfx2] job timed out', { job: job.name, timeoutMs: job.timeoutMs });
                await record(job, 'timeout', startedAt, `timed out after ${job.timeoutMs} ms`);
                await runPromise.catch(() => {}); // keep the overlap guard until it really ends
                return 'timeout';
            }
            if (outcome !== 'ok') throw outcome.err;
            job.stats.runs++;
            job.stats.lastDurationMs = now() - startedAt;
            await record(job, 'ok', startedAt, null);
            return 'ok';
        } catch (err) {
            job.stats.failures++;
            job.stats.lastError = err?.message || String(err);
            logger.error?.('[cfx2] job failed', { job: job.name, error: job.stats.lastError });
            await record(job, 'error', startedAt, job.stats.lastError);
            return 'error';
        } finally {
            job.inFlight = null;
            if (release) {
                try { await release(); } catch (err) { logger.warn?.('[cfx2] job lock release failed', { job: job.name, error: err.message }); }
            }
            job.running = false;
        }
    }

    return {
        register,
        start() {
            if (started) return;
            started = true;
            if (env.all) logger.warn?.('[cfx2] all jobs disabled by CFX2_JOBS_DISABLED');
            for (const job of jobs.values()) schedule(job, true);
        },
        /** Stop scheduling and wait (up to waitMs) for runs in progress. */
        async stop({ waitMs = 10_000 } = {}) {
            started = false;
            for (const job of jobs.values()) {
                if (job.timer) clearTimer(job.timer);
                job.timer = null;
            }
            const inFlight = [...jobs.values()].map(j => j.inFlight).filter(Boolean);
            if (inFlight.length) {
                let h;
                await Promise.race([Promise.allSettled(inFlight), new Promise(r => { h = setTimer(r, waitMs); h?.unref?.(); })]);
                clearTimer(h);
            }
        },
        /** In-process kill switch: no further runs until revive(). */
        kill() { killed = true; for (const job of jobs.values()) { if (job.timer) clearTimer(job.timer); job.timer = null; } },
        revive() { killed = false; if (started) for (const job of jobs.values()) if (!job.timer) schedule(job, true); },
        runNow(name) {
            const job = jobs.get(name);
            if (!job) throw new Error(`no job "${name}"`);
            return tick(job);
        },
        status() {
            return [...jobs.values()].map(j => ({ name: j.name, running: j.running, intervalMs: j.intervalMs, jitterMs: j.jitterMs, ...j.stats }));
        },
        get killed() { return killed; }
    };
}
