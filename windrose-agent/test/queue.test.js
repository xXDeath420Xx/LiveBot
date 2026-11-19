import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.js';

// Virtual clock: sleep advances time instantly so a test asserting the 1 req/s
// spacing runs in microseconds instead of seconds.
function fakeClock(start = 0) {
    let t = start;
    return {
        now: () => t,
        sleep: async (ms) => { t += ms; },
        advance: (ms) => { t += ms; },
    };
}

test('spaces tasks by at least minIntervalMs', async () => {
    const clock = fakeClock();
    const q = createQueue({ minIntervalMs: 1100, now: clock.now, sleep: clock.sleep });
    const startTimes = [];

    await Promise.all([
        q.push(async () => startTimes.push(clock.now())),
        q.push(async () => startTimes.push(clock.now())),
        q.push(async () => startTimes.push(clock.now())),
    ]);

    assert.equal(startTimes.length, 3);
    for (let i = 1; i < startTimes.length; i++) {
        assert.ok(
            startTimes[i] - startTimes[i - 1] >= 1100,
            `gap ${startTimes[i] - startTimes[i - 1]}ms below the 1100ms minimum`,
        );
    }
});

test('runs tasks in FIFO order', async () => {
    const clock = fakeClock();
    const q = createQueue({ minIntervalMs: 10, now: clock.now, sleep: clock.sleep });
    const order = [];

    await Promise.all(['a', 'b', 'c', 'd'].map((id) => q.push(async () => { order.push(id); })));

    assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('a failing task does not poison the queue', async () => {
    const clock = fakeClock();
    const q = createQueue({ minIntervalMs: 10, now: clock.now, sleep: clock.sleep });

    const failed = q.push(async () => { throw new Error('boom'); });
    const after = q.push(async () => 'still works');

    await assert.rejects(failed, /boom/);
    assert.equal(await after, 'still works');
});

test('rejects a task that exceeds timeoutMs', async () => {
    // Real timers here: the timeout races the task, so a virtual clock that
    // never fires the setTimeout would defeat the thing under test.
    const q = createQueue({ minIntervalMs: 0, timeoutMs: 20 });
    await assert.rejects(
        q.push(() => new Promise((resolve) => setTimeout(resolve, 500))),
        /timed out/,
    );
});

test('sheds load past maxPending instead of queueing forever', async () => {
    const clock = fakeClock();
    const q = createQueue({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep, maxPending: 2 });

    const a = q.push(async () => 'a');
    const b = q.push(async () => 'b');
    await assert.rejects(q.push(async () => 'c'), /too many pending/);

    await Promise.all([a, b]);
});
