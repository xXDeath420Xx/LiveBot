import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPost } from '../core/qotd-poster.js';

const qotw = { enabled: 1, schedule_type: 'weekly', schedule_days: '["monday"]', schedule_time: '09:30:00',
    timezone: 'America/Los_Angeles', last_posted_at: null };
const at = (s) => new Date(s);

test('weekly posts at local time on the chosen day only', () => {
    assert.equal(shouldPost(qotw, at('2026-11-09T17:25:00Z')), false);
    assert.equal(shouldPost(qotw, at('2026-11-09T17:30:00Z')), true);
    assert.equal(shouldPost(qotw, at('2026-11-08T17:30:00Z')), false);           // Sunday
    assert.equal(shouldPost(qotw, at('2027-06-07T16:30:00Z')), true);            // PDT
});

test('weekly posts once per day, even after UTC midnight', () => {
    const posted = { ...qotw, last_posted_at: '2026-11-09T17:30:02Z' };
    assert.equal(shouldPost(posted, at('2026-11-09T17:35:00Z')), false);
    assert.equal(shouldPost(posted, at('2026-11-10T07:55:00Z')), false);
    assert.equal(shouldPost(posted, at('2026-11-16T17:30:00Z')), true);
});

test('daily uses the channel timezone and calendar days (no 5-minute drift)', () => {
    const ny = { enabled: 1, schedule_type: 'daily', schedule_time: '12:00:00', timezone: 'America/New_York',
        last_posted_at: '2026-11-07T23:25:03Z' };
    assert.equal(shouldPost(ny, at('2026-11-08T16:55:00Z')), false);
    assert.equal(shouldPost(ny, at('2026-11-08T17:00:00Z')), true);
    const utc = { enabled: 1, schedule_type: 'daily', schedule_time: '09:00:00', timezone: 'UTC',
        last_posted_at: '2026-11-07T09:05:00Z' };
    assert.equal(shouldPost(utc, at('2026-11-08T09:00:00Z')), true);
});

test('unknown timezone falls back to UTC; numeric and CSV days parse', () => {
    assert.equal(shouldPost({ enabled: 1, schedule_type: 'daily', schedule_time: '09:00', timezone: 'Mars/Base' },
        at('2026-11-08T09:00:00Z')), true);
    assert.equal(shouldPost({ ...qotw, schedule_days: '1' }, at('2026-11-09T17:30:00Z')), true);
    assert.equal(shouldPost({ ...qotw, schedule_days: 'monday,thursday' }, at('2026-11-12T17:30:00Z')), true);
});

test("days parse from names, short names, plurals, numbers and JSON", async () => {
    const { parseDays, describeDays, normaliseTime } = await import("../core/qotd-poster.js");
    assert.deepEqual(parseDays("mon,thurs"), ["monday", "thursday"]);
    assert.deepEqual(parseDays("Mondays tues"), ["monday", "tuesday"]);
    assert.deepEqual(parseDays(["friday", "sun"]), ["sunday", "friday"]);
    assert.deepEqual(parseDays("3"), ["wednesday"]);
    assert.deepEqual(parseDays("someday"), []);
    assert.equal(describeDays(["monday", "thursday"]), "Monday and Thursday");
    assert.equal(normaliseTime("9:30"), "09:30:00");
    assert.equal(normaliseTime("25:00"), null);
});
