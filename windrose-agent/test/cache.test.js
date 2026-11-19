import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.js';

function fakeClock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

test('serves a cached value until the TTL expires', async () => {
    const clock = fakeClock();
    const cache = createCache({ now: clock.now });
    let calls = 0;
    const produce = async () => { calls++; return calls; };

    assert.equal(await cache.get('status', 2000, produce), 1);
    clock.advance(1999);
    assert.equal(await cache.get('status', 2000, produce), 1, 'should still be cached');
    assert.equal(calls, 1);

    clock.advance(2);
    assert.equal(await cache.get('status', 2000, produce), 2, 'should refetch after TTL');
    assert.equal(calls, 2);
});

test('single-flights concurrent misses into one upstream call', async () => {
    // This is the property that actually protects the 1 req/s rate limit: ten
    // browser tabs loading at once must produce one upstream request, not ten.
    const cache = createCache();
    let calls = 0;
    const produce = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return 'value';
    };

    const results = await Promise.all(
        Array.from({ length: 10 }, () => cache.get('livemap', 2000, produce)),
    );

    assert.deepEqual(results, Array(10).fill('value'));
    assert.equal(calls, 1, `expected a single upstream call, got ${calls}`);
});

test('invalidate forces the next read to refetch', async () => {
    const clock = fakeClock();
    const cache = createCache({ now: clock.now });
    let calls = 0;
    const produce = async () => { calls++; return calls; };

    await cache.get('status', 60_000, produce);
    cache.invalidate('status');
    await cache.get('status', 60_000, produce);

    assert.equal(calls, 2);
});

test('a failed producer is not cached', async () => {
    const cache = createCache();
    let calls = 0;
    const produce = async () => {
        calls++;
        if (calls === 1) throw new Error('upstream down');
        return 'recovered';
    };

    await assert.rejects(cache.get('status', 60_000, produce), /upstream down/);
    assert.equal(await cache.get('status', 60_000, produce), 'recovered');
});
