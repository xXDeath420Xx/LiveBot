// Greenhouse Tycoon (cfx v2): the job scheduler - overlap guard, jitter, timeout and the kill switches.
// Pure (no database); the cross-process lock against MariaDB is covered in api.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, parseDisabledEnv } from '../../../services/cfx/jobs/scheduler.js';

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function recorder() {
    const calls = [];
    return { calls, record: async (name, r) => { calls.push({ name, status: r.status }); } };
}

describe('scheduler', () => {
    test('CFX2_JOBS_DISABLED parsing', () => {
        assert.equal(parseDisabledEnv(undefined).all, false);
        assert.equal(parseDisabledEnv('').all, false);
        assert.equal(parseDisabledEnv('0').all, false);
        for (const on of ['1', 'all', 'ALL', 'true', '*']) assert.equal(parseDisabledEnv(on).all, true, on);
        assert.deepEqual([...parseDisabledEnv('a-job, b-job ,').names], ['a-job', 'b-job']);
    });

    test('registration refuses bad names, intervals and duplicates', () => {
        const s = createScheduler({ logger: quiet, envDisabled: '' });
        const run = async () => {};
        assert.throws(() => s.register({ name: 'Bad Name', intervalMs: 1000, run }));
        assert.throws(() => s.register({ name: 'ok', intervalMs: 1.5, run }));
        assert.throws(() => s.register({ name: 'ok', intervalMs: 1000, jitterMs: -1, run }));
        assert.throws(() => s.register({ name: 'ok', intervalMs: 1000 }));
        s.register({ name: 'ok', intervalMs: 1000, run });
        assert.throws(() => s.register({ name: 'ok', intervalMs: 1000, run }));
    });

    test('overlap guard: a second run while the first is going is skipped', async () => {
        const rec = recorder();
        const s = createScheduler({ logger: quiet, envDisabled: '', recorder: rec });
        let runs = 0;
        s.register({ name: 'slow', intervalMs: 60_000, timeoutMs: 5000, run: async () => { runs++; await sleep(80); } });
        const [a, b] = await Promise.all([s.runNow('slow'), s.runNow('slow')]);
        assert.deepEqual([a, b].sort(), ['ok', 'skipped:overlap']);
        assert.equal(runs, 1);
        assert.equal(s.status()[0].skippedOverlap, 1);
        assert.deepEqual(rec.calls.map(c => c.status).sort(), ['ok', 'skipped']);
        assert.equal(await s.runNow('slow'), 'ok', 'runs again once the first finished');
    });

    test('cross-process lock held elsewhere: skipped, run not called, lock released after a run', async () => {
        let held = false;
        const released = [];
        const lock = {
            acquire: async (name) => {
                if (held) return null;
                held = true;
                return async () => { held = false; released.push(name); };
            }
        };
        const s = createScheduler({ logger: quiet, envDisabled: '', lock });
        let runs = 0;
        s.register({ name: 'locked', intervalMs: 60_000, run: async () => { runs++; } });
        held = true;
        assert.equal(await s.runNow('locked'), 'skipped:overlap');
        assert.equal(runs, 0);
        held = false;
        assert.equal(await s.runNow('locked'), 'ok');
        assert.equal(runs, 1);
        assert.deepEqual(released, ['locked']);
        assert.equal(held, false);
    });

    test('kill switch from the environment: all jobs, or named jobs', async () => {
        let runs = 0;
        const all = createScheduler({ logger: quiet, envDisabled: 'all' });
        all.register({ name: 'a', intervalMs: 60_000, run: async () => { runs++; } });
        assert.equal(await all.runNow('a'), 'skipped:disabled');
        const named = createScheduler({ logger: quiet, envDisabled: 'b' });
        named.register({ name: 'a', intervalMs: 60_000, run: async () => { runs++; } });
        named.register({ name: 'b', intervalMs: 60_000, run: async () => { runs += 100; } });
        assert.equal(await named.runNow('b'), 'skipped:disabled');
        assert.equal(await named.runNow('a'), 'ok');
        assert.equal(runs, 1);
    });

    test('kill switch from config (checked before every run); a failing check does not stop jobs', async () => {
        let disabled = true;
        let runs = 0;
        const s = createScheduler({ logger: quiet, envDisabled: '', isDisabled: async () => disabled });
        s.register({ name: 'cfg', intervalMs: 60_000, run: async () => { runs++; } });
        assert.equal(await s.runNow('cfg'), 'skipped:disabled');
        disabled = false;
        assert.equal(await s.runNow('cfg'), 'ok');
        const broken = createScheduler({ logger: quiet, envDisabled: '', isDisabled: async () => { throw new Error('db down'); } });
        broken.register({ name: 'cfg', intervalMs: 60_000, run: async () => { runs++; } });
        assert.equal(await broken.runNow('cfg'), 'ok');
        assert.equal(runs, 2);
    });

    test('in-process kill() stops scheduled runs at once; revive() resumes', async () => {
        const s = createScheduler({ logger: quiet, envDisabled: '' });
        let runs = 0;
        s.register({ name: 'tick', intervalMs: 15, run: async () => { runs++; } });
        s.start();
        await sleep(120);
        assert.ok(runs >= 2, `ran ${runs} times`);
        s.kill();
        const at = runs;
        await sleep(80);
        assert.equal(runs, at);
        assert.equal(await s.runNow('tick'), 'skipped:disabled');
        s.revive();
        await sleep(60);
        assert.ok(runs > at);
        await s.stop();
        const stoppedAt = runs;
        await sleep(60);
        assert.equal(runs, stoppedAt, 'stop() ends scheduling');
    });

    test('jitter: first run within [0, jitter], later runs interval + [0, jitter]', async () => {
        const delays = [];
        const fakeSetTimer = (fn, ms) => { delays.push(ms); return { unref() {} }; };
        const s = createScheduler({ logger: quiet, envDisabled: '', random: () => 0.5, setTimer: fakeSetTimer, clearTimer: () => {} });
        s.register({ name: 'j', intervalMs: 1000, jitterMs: 200, run: async () => {} });
        s.start();
        assert.deepEqual(delays, [100], 'first delay = floor(0.5 * (200 + 1))');
        const draws = [];
        const s3 = createScheduler({
            logger: quiet, envDisabled: '', random: Math.random,
            setTimer: (fn, ms) => { draws.push(ms); return { unref() {} }; }, clearTimer: () => {}
        });
        for (let i = 0; i < 50; i++) s3.register({ name: `j${i}`, intervalMs: 1000, jitterMs: 200, run: async () => {} });
        s3.start();
        assert.ok(draws.every(d => d >= 0 && d <= 200));
    });

    test('timeout: reported, signal aborted, overlap guard kept until the run really ends', async () => {
        const rec = recorder();
        const s = createScheduler({ logger: quiet, envDisabled: '', recorder: rec });
        let aborted = false;
        let finished = false;
        s.register({
            name: 'stuck', intervalMs: 60_000, timeoutMs: 30,
            run: async ({ signal }) => {
                signal.addEventListener('abort', () => { aborted = true; });
                await sleep(120);
                finished = true;
            }
        });
        const first = s.runNow('stuck');
        await sleep(60);
        assert.equal(aborted, true);
        assert.equal(await s.runNow('stuck'), 'skipped:overlap', 'still blocked after the timeout');
        assert.equal(await first, 'timeout');
        assert.equal(finished, true);
        assert.equal(s.status()[0].timeouts, 1);
        assert.ok(rec.calls.some(c => c.status === 'timeout'));
    });

    test('a failing job is counted and the scheduler keeps going', async () => {
        const rec = recorder();
        const s = createScheduler({ logger: quiet, envDisabled: '', recorder: rec });
        let n = 0;
        s.register({ name: 'flaky', intervalMs: 60_000, run: async () => { n++; if (n === 1) throw new Error('boom'); } });
        assert.equal(await s.runNow('flaky'), 'error');
        assert.equal(await s.runNow('flaky'), 'ok');
        const st = s.status()[0];
        assert.equal(st.failures, 1);
        assert.equal(st.runs, 1);
        assert.deepEqual(rec.calls.map(c => c.status), ['error', 'ok']);
    });
});
