import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGetChannelSettings, DEFAULTS } from '../../services/certifried-bot/defender/channel-settings.js';

test('returns defaults when no row exists', async () => {
    const get = makeGetChannelSettings({ pool: { execute: async () => [[]] } });
    const s = await get('chanX');
    assert.equal(s.phishingThreshold, DEFAULTS.phishingThreshold); // 2
    assert.equal(s.banDurationMin, DEFAULTS.banDurationMin);       // null = permanent
    assert.equal(s.warningTemplate, DEFAULTS.warningTemplate);
    assert.deepEqual(s.safeDomains, DEFAULTS.safeDomains);          // []
});

test('row overrides defaults; blanks fall back', async () => {
    const row = { ban_duration_min: 600, phishing_threshold: 3, warning_template: 'gtfo {{username}}', safe_domains: 'a.com,b.com' };
    const get = makeGetChannelSettings({ pool: { execute: async () => [[row]] } });
    const s = await get('chanY');
    assert.equal(s.banDurationMin, 600);
    assert.equal(s.phishingThreshold, 3);
    assert.equal(s.warningTemplate, 'gtfo {{username}}');
    assert.deepEqual(s.safeDomains, ['a.com', 'b.com']);
});

test('a DB error returns defaults, never throws', async () => {
    const get = makeGetChannelSettings({ pool: { execute: async () => { throw new Error('db down'); } } });
    const s = await get('chanZ');
    assert.equal(s.phishingThreshold, DEFAULTS.phishingThreshold);
    assert.equal(s.banDurationMin, DEFAULTS.banDurationMin);
    assert.equal(s.warningTemplate, DEFAULTS.warningTemplate);
    assert.deepEqual(s.safeDomains, []);
    s.safeDomains.push('x'); // must not throw — returned array must be mutable
    assert.deepEqual(s.safeDomains, ['x']);
});

test('returned safeDomains is mutable on the no-row path', async () => {
    const get = makeGetChannelSettings({ pool: { execute: async () => [[]] } });
    const s = await get('chanX');
    s.safeDomains.push('y'); // must not throw
    assert.deepEqual(s.safeDomains, ['y']);
});
