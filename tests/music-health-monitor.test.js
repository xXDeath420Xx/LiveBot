import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The music health monitor decides what reaches the owner's DMs. Two rules matter:
 *   - hysteresis: one bad probe is a blip, two in a row is an outage; recoveries are only announced
 *     for outages that were actually announced; a long outage is re-announced every 6h
 *   - folding: one outage is reported once, at its highest level (no residential resolver at all >
 *     one resolver unreachable > its tunnels / its sentinel), and a folded check never produces a
 *     stray "recovered" line later (the bug the live drill caught).
 */

process.env.MUSIC_HEALTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mhm-')); // never touch the live state file
process.env.LOG_DIR = process.env.MUSIC_HEALTH_DATA_DIR;                             // nor the bot's real logs
const { applyResultsTo, selectAnnouncements } = await import('../core/music-health-monitor.js');

const up = (sev = 'warning') => ({ ok: true, severity: sev, title: 't', detail: 'd' });
const down = (sev = 'warning') => ({ ok: false, severity: sev, title: 't', detail: 'd' });
const T0 = 1_800_000_000_000, MIN = 60_000, H = 3_600_000;
test.after(() => fs.rmSync(process.env.MUSIC_HEALTH_DATA_DIR, { recursive: true, force: true }));

test('first sighting healthy is silent; a single bad probe is a blip, not an outage', () => {
    const s = {};
    assert.deepEqual(applyResultsTo(s, { a: up() }, T0), []);
    assert.equal(s.a.status, 'up');
    assert.deepEqual(applyResultsTo(s, { a: down() }, T0 + MIN), []);
    assert.deepEqual(applyResultsTo(s, { a: up() }, T0 + 2 * MIN), []);
    assert.equal(s.a.status, 'up');
});

test('two bad probes in a row flip to down; recovery needs two good probes', () => {
    const s = {};
    applyResultsTo(s, { a: up() }, T0);
    applyResultsTo(s, { a: down() }, T0 + MIN);
    const t = applyResultsTo(s, { a: down() }, T0 + 2 * MIN);
    assert.deepEqual(t.map(x => [x.id, x.kind]), [['a', 'down']]);
    selectAnnouncements(t, s); // shown -> marked alerted
    assert.deepEqual(applyResultsTo(s, { a: up() }, T0 + 3 * MIN), []);
    assert.deepEqual(applyResultsTo(s, { a: up() }, T0 + 4 * MIN).map(x => x.kind), ['up']);
});

test('a down that was never shown produces no recovery', () => {
    const s = {};
    applyResultsTo(s, { a: up() }, T0);
    applyResultsTo(s, { a: down() }, T0 + MIN);
    applyResultsTo(s, { a: down() }, T0 + 2 * MIN);          // flipped down, but nobody called selectAnnouncements
    applyResultsTo(s, { a: up() }, T0 + 3 * MIN);
    assert.deepEqual(applyResultsTo(s, { a: up() }, T0 + 4 * MIN), []);
});

test('a shown outage is re-announced every 6 hours while it lasts', () => {
    const s = {};
    applyResultsTo(s, { a: up() }, T0);
    applyResultsTo(s, { a: down() }, T0 + MIN);
    selectAnnouncements(applyResultsTo(s, { a: down() }, T0 + 2 * MIN), s);
    assert.deepEqual(applyResultsTo(s, { a: down() }, T0 + 5 * H), []);
    const r = applyResultsTo(s, { a: down() }, T0 + 2 * MIN + 6 * H + 1);
    assert.deepEqual(r.map(x => x.kind), ['still_down']);
    assert.equal(r[0].downForH, 6);
});

test('a resolver outage hides its own tunnels and sentinel, but not other resolvers\' problems', () => {
    const s = { 'resolver:server2:reachable': { status: 'down' }, 'tunnel:server2:http://a': {}, 'tunnel:server2:http://b': {},
        'sentinel:server2': {}, 'tunnel:workstation:http://c': {} };
    const t = [
        { id: 'resolver:server2:reachable', kind: 'down' },
        { id: 'tunnel:server2:http://a', kind: 'down' },
        { id: 'tunnel:server2:http://b', kind: 'down' },
        { id: 'sentinel:server2', kind: 'down' },
        { id: 'tunnel:workstation:http://c', kind: 'down' },
    ];
    assert.deepEqual(selectAnnouncements(t, s).map(x => x.id), ['resolver:server2:reachable', 'tunnel:workstation:http://c']);
    assert.equal(s['tunnel:server2:http://a'].alerted, undefined, 'folded checks are not marked alerted');
    assert.equal(s['resolver:server2:reachable'].alerted, true);
});

test('no residential resolver at all hides every resolver/tunnel line beneath it', () => {
    const s = {};
    const t = [
        { id: 'youtube:residential', kind: 'down' },
        { id: 'resolver:server2:reachable', kind: 'down' },
        { id: 'resolver:workstation:reachable', kind: 'down' },
        { id: 'tunnel:server2:http://a', kind: 'down' },
        { id: 'spotify:owner', kind: 'down' },
    ];
    assert.deepEqual(selectAnnouncements(t, s).map(x => x.id), ['youtube:residential', 'spotify:owner']);
});

test('a sentinel going quiet is reported when its machine is otherwise up', () => {
    const s = { 'resolver:workstation:reachable': { status: 'up' } };
    assert.deepEqual(selectAnnouncements([{ id: 'sentinel:workstation', kind: 'down' }], s).map(x => x.id), ['sentinel:workstation']);
});

test('recoveries are always shown (they only exist for announced outages)', () => {
    const t = [{ id: 'tunnel:server2:http://a', kind: 'up' }, { id: 'resolver:server2:reachable', kind: 'down' }];
    assert.deepEqual(selectAnnouncements(t, {}).map(x => x.id), ['tunnel:server2:http://a', 'resolver:server2:reachable']);
});
