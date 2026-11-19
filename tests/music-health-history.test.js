import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The "Music health" page must not lie: a one-minute blip is not an outage, a stretch with no
 * samples (monitor not running) is "no data" rather than "up", and counters that reset when a
 * resolver restarts must not turn into negative or huge traffic spikes.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhh-'));
process.env.MUSIC_HEALTH_DATA_DIR = tmp;
process.env.LOG_DIR = tmp;
const { componentOf, componentsFor, buildTimelines, uptimeByCheck, buildTrends } = await import('../dashboard/services/music-health-history.js');
const { sampleMetrics } = await import('../core/music-health-monitor.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000, from = 1_800_000_000_000, to = from + 4 * 15 * MIN; // four 15-minute buckets
const at = (bucket, minute) => from + bucket * 15 * MIN + minute * MIN;

test('checks are grouped into the panels the page draws, in a stable order', () => {
    assert.equal(componentOf('tunnel:server2:http://127.0.0.1:49998'), 'resolver:server2');
    assert.equal(componentOf('resolver:workstation:playback'), 'resolver:workstation');
    assert.equal(componentOf('sentinel:server2'), 'sentinels');
    assert.deepEqual(componentsFor(['spotify:owner', 'resolver:workstation:auth', 'youtube:residential', 'server1:cookies', 'resolver:server2:canary', 'sentinel:x']),
        ['youtube', 'resolver:server2', 'resolver:workstation', 'server1', 'spotify', 'sentinels']);
});

test('timelines: down beats a blip, a blip shows as degraded, no samples is "none", uptime counts down samples', () => {
    const samples = [
        { t: at(0, 1) }, { t: at(0, 2) },
        { t: at(1, 1), failing: 'resolver:server2:canary' },                                   // blip
        { t: at(1, 2) },
        { t: at(2, 1), failing: 'resolver:server2:canary', down: 'resolver:server2:canary' },  // outage
        { t: at(2, 2), failing: 'resolver:server2:canary', down: 'resolver:server2:canary' },
        // bucket 3: monitor not running
    ];
    const t = buildTimelines(samples, ['resolver:server2', 'spotify'], { from, to, buckets: 4 });
    assert.deepEqual(t['resolver:server2'].buckets.map(b => b.state), ['up', 'degraded', 'down', 'none']);
    assert.deepEqual(t['resolver:server2'].buckets[2].down, ['resolver:server2:canary']);
    assert.deepEqual(t['resolver:server2'].buckets[1].failing, ['resolver:server2:canary']);
    assert.ok(Math.abs(t['resolver:server2'].uptime - 4 / 6) < 1e-9, '2 of 6 samples down');
    assert.deepEqual(t.spotify.buckets.map(b => b.state), ['up', 'up', 'up', 'none']);
    assert.equal(t.spotify.uptime, 1);
    assert.equal(buildTimelines([], ['spotify'], { from, to, buckets: 4 }).spotify.uptime, null, 'no samples: unknown, not 100%');
});

test('per-check uptime', () => {
    const u = uptimeByCheck([{ down: 'a' }, { down: 'a,b' }, {}, {}], ['a', 'b', 'c']);
    assert.deepEqual(u, { a: 0.5, b: 0.75, c: 1 });
});

test('trends: deltas of cumulative counters per bucket, restarts handled, mean canary latency', () => {
    const m = (q, rb, cm, calls) => ({ r: { server2: { q, rb, cm } }, x: { c: calls, lo: 0, lf: 0 } });
    const rows = [
        { t: at(0, 1), m: m(100, 5e6, 4000, 10) },     // first sample: no baseline, so no traffic is claimed
        { t: at(0, 5), m: m(103, 8e6, null, 13) },     // +3 requests, +3 MB, +3 plays
        { t: at(1, 1), m: m(2, 1e6, 6000, 1) },        // resolver + bot restarted: counted from zero
        { t: at(1, 9), m: m(4, 2e6, 8000, 2) },
    ];
    const tr = buildTrends(rows, { from, to, buckets: 4 });
    assert.deepEqual(tr.resolvers, ['server2']);
    assert.deepEqual(tr.requests.server2, [3, 2 + 2, 0, 0]);
    assert.deepEqual(tr.relayMb.server2.map(v => Math.round(v)), [3, 1 + 1, 0, 0]);
    assert.deepEqual(tr.latency.server2, [4000, 7000, null, null]);
    assert.deepEqual(tr.plays, [3, 1 + 1, 0, 0]);
});

test('sampleMetrics: the compact per-tick numbers the trends are built from', () => {
    const snap = {
        resolvers: { server2: { canary: { ok: true, ms: 5359 }, cookieAgeSec: 357,
            stats: { requests: 150, fail: 2, relay: { streams: 150, bytes: 11206731 }, ytm: { served: 2 } } }, workstation: null },
        extractor: { calls: 7, hits: 6, localOk: 0, localFail: 1 }, prefetch: { started: 3, hits: 2 },
    };
    assert.deepEqual(sampleMetrics(snap), {
        r: { server2: { c: true, cm: 5359, ca: 357, q: 150, f: 2, rs: 150, rb: 11206731, ym: 2 }, workstation: null },
        x: { c: 7, h: 6, lo: 0, lf: 1 }, p: { s: 3, h: 2 },
    });
});
