import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStarts, dueAnnouncements, formatDuration, RECENT_WINDOW_MS } from '../core/schedule-announcement-logic.js';

const T0 = Date.parse('2026-10-05T18:00:00Z');
const min = 60_000;
const d = (ms) => new Date(ms);

const schedule = { id: 1, start_time: d(T0), setup_time_seconds: 300 };
const item = (over) => ({
    id: 1, schedule_id: 1, position: 1, status: 'pending', estimate_seconds: 1800, setup_seconds: 0,
    scheduled_start: null, actual_start: null, actual_end: null, game_name: 'Game', ...over,
});

test('projects pending runs from the schedule start, adding estimate + setup', () => {
    const items = [item({ id: 1, position: 1 }), item({ id: 2, position: 2 }), item({ id: 3, position: 3, setup_seconds: 600 })];
    const starts = projectStarts(schedule, items, T0 - 60 * min);
    assert.equal(starts.get(1), T0);
    assert.equal(starts.get(2), T0 + 35 * min);           // 30 min run + 5 min default setup
    assert.equal(starts.get(3), T0 + 70 * min);
});

test('a running run that overruns pushes the next one back to at least now', () => {
    const now = T0 + 50 * min;
    const items = [
        item({ id: 1, position: 1, status: 'running', actual_start: d(T0) }),  // estimate 30 min, now 50 min in
        item({ id: 2, position: 2 }),
    ];
    const starts = projectStarts(schedule, items, now);
    assert.equal(starts.get(2), now + 5 * min);
});

test('a completed run projects from its actual end; scheduled_start is a floor, not a ceiling', () => {
    const items = [
        item({ id: 1, position: 1, status: 'completed', actual_start: d(T0), actual_end: d(T0 + 20 * min) }),
        item({ id: 2, position: 2, scheduled_start: d(T0 + 60 * min) }),
        item({ id: 3, position: 3, status: 'skipped' }),
        item({ id: 4, position: 4 }),
    ];
    const starts = projectStarts(schedule, items, T0 + 21 * min);
    assert.equal(starts.get(2), T0 + 60 * min);             // planned later than the cursor
    assert.equal(starts.get(3), null);
    assert.equal(starts.get(4), T0 + 95 * min);             // 60 + 30 + 5
});

test('without a schedule start time nothing can be projected until something runs', () => {
    const starts = projectStarts({ id: 1, start_time: null, setup_time_seconds: 300 }, [item({ id: 1 }), item({ id: 2, position: 2 })], T0);
    assert.equal(starts.get(1), null);
    assert.equal(starts.get(2), null);
});

test('starting_soon fires inside the lead window only', () => {
    const items = [item({ id: 1 })];
    assert.deepEqual(dueAnnouncements({ schedules: [schedule], items, announceBeforeMinutes: 5, nowMs: T0 - 6 * min }), []);
    const due = dueAnnouncements({ schedules: [schedule], items, announceBeforeMinutes: 5, nowMs: T0 - 4 * min });
    assert.equal(due.length, 1);
    assert.equal(due[0].type, 'starting_soon');
    assert.equal(due[0].startMs, T0);
    assert.deepEqual(dueAnnouncements({ schedules: [schedule], items, announceBeforeMinutes: 5, nowMs: T0 + 1 }), []);
});

test('now_playing and completed only for recent transitions (no backlog dump)', () => {
    const now = T0 + 2 * 3600_000;
    const items = [
        item({ id: 1, position: 1, status: 'completed', actual_start: d(T0), actual_end: d(T0 + 30 * min) }),        // old
        item({ id: 2, position: 2, status: 'completed', actual_start: d(now - 40 * min), actual_end: d(now - 5 * min) }),
        item({ id: 3, position: 3, status: 'running', actual_start: d(now - 4 * min) }),
    ];
    const due = dueAnnouncements({ schedules: [schedule], items, announceBeforeMinutes: 5, nowMs: now });
    assert.deepEqual(due.map((x) => [x.item.id, x.type]), [[2, 'completed'], [3, 'now_playing']]);

    const later = dueAnnouncements({ schedules: [schedule], items, announceBeforeMinutes: 5, nowMs: now + RECENT_WINDOW_MS });
    assert.deepEqual(later.map((x) => x.type), []);
});

test('links covering several schedules evaluate each schedule on its own', () => {
    const s2 = { id: 2, start_time: d(T0 + 3 * min), setup_time_seconds: 0 };
    const items = [item({ id: 1, schedule_id: 1 }), item({ id: 2, schedule_id: 2 })];
    const due = dueAnnouncements({ schedules: [schedule, s2], items, announceBeforeMinutes: 5, nowMs: T0 - 1 * min });
    assert.deepEqual(due.map((x) => x.item.id).sort(), [1, 2]);
});

test('announce_before of 0 disables starting_soon', () => {
    const due = dueAnnouncements({ schedules: [schedule], items: [item({ id: 1 })], announceBeforeMinutes: 0, nowMs: T0 - min });
    assert.deepEqual(due, []);
});

test('formatDuration', () => {
    assert.equal(formatDuration(45), '0:45');
    assert.equal(formatDuration(3900), '1:05:00');
});
