import test from 'node:test';
import assert from 'node:assert/strict';

const { summarise, managedFeatures, rank, FEATURES, RANGES } = await import('../dashboard/services/feature-adoption.js');
const { FEATURE_SPECS, defaultsFor } = await import('../core/feature-config-spec.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 11);
const cutoff = NOW - 30 * DAY;

test('a switchable feature counts the servers that have it on', () => {
    const f = summarise({ name: 'X', cat: 'C', on: new Set(['a', 'b']), setup: new Set(['a', 'b', 'c']) }, cutoff);
    assert.deepEqual(f.using.map(u => u.id), ['a', 'b']);
    assert.equal(f.on, 2);
    assert.equal(f.setup, 3);
    assert.equal(f.active, null);
});

test('always-on tracking counts only servers it recorded something for inside the window', () => {
    const last = new Map([['a', NOW - DAY], ['b', NOW - 40 * DAY]]);
    const f = summarise({ name: 'Backups', cat: 'C', note: 'always', on: new Set(['a', 'b', 'c']), lastByGuild: last }, cutoff);
    assert.deepEqual(f.using.map(u => u.id), ['a']);
    assert.equal(f.active, 1);
    assert.equal(f.lastAt, NOW - DAY);
});

test('a default-on feature with no activity record counts only servers that chose it', () => {
    const f = summarise({ name: 'Fishing', cat: 'C', note: 'default', on: new Set(['a', 'b', 'c']), chosen: new Set(['b']), setup: new Set(['b']) }, cutoff);
    assert.deepEqual(f.using.map(u => u.id), ['b']);
    assert.equal(f.on, 3);
    assert.equal(f.setup, 1, 'setup is the explicit rows, not every server the default covers');
});

test('managed families: default-on reaches every server unless that server switched it off', () => {
    // defaultsFor reads the real spec table, so use a real default-on family.
    assert.equal(defaultsFor('fishing').enabled, true);
    const rows = [
        { guild_id: 'b', feature_key: 'fishing', config: '{"enabled":0}' },
        { guild_id: 'c', feature_key: 'fishing', config: { enabled: 1 } },
        { guild_id: 'gone', feature_key: 'fishing', config: '{"enabled":1}' },
    ];
    const [m] = managedFeatures(rows, new Set(['a', 'b', 'c']), { fishing: FEATURE_SPECS.fishing }, new Set());
    assert.equal(m.note, 'default');
    assert.deepEqual([...m.on].sort(), ['a', 'c']);
    assert.deepEqual([...m.chosen], ['c']);
    assert.deepEqual([...m.setup].sort(), ['b', 'c']);
});

test('managed families: features already listed by table are not duplicated', () => {
    const taken = new Set(FEATURES.map(f => f[0].toLowerCase()));
    const names = managedFeatures([], new Set(['a'])).map(m => m.name.toLowerCase());
    for (const n of names) assert.ok(!taken.has(n), `${n} listed twice`);
    assert.equal(new Set(names).size, names.length);
});

test('ranking: most servers first, ties broken by setup then name', () => {
    const r = rank([
        { name: 'b', using: [1], setup: 1 }, { name: 'a', using: [1], setup: 1 }, { name: 'c', using: [1, 2], setup: 0 }, { name: 'd', using: [1], setup: 5 },
    ]);
    assert.deepEqual(r.map(f => f.name), ['c', 'd', 'a', 'b']);
});

test('feature names are unique and every range is a whole number of days', () => {
    const names = FEATURES.map(f => f[0]);
    assert.equal(new Set(names).size, names.length);
    for (const d of Object.values(RANGES)) assert.ok(Number.isInteger(d) && d > 0);
});
