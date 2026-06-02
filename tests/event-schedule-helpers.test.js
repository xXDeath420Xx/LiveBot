import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStartFor, materializeWeek, groupByCategory, scheduleHash, parseCustomEmoji, formatTimeLabel } from '../core/event-schedule-helpers.js';

test('formatTimeLabel: same-day shows 24h range + duration; multi-day shows start + length', () => {
    const h = (iso) => new Date(iso).getTime();
    // 2h same-day window
    assert.equal(formatTimeLabel(h('2026-06-02T19:00:00Z'), h('2026-06-02T21:00:00Z')), '19:00–21:00 · 2h');
    // sub-hour
    assert.equal(formatTimeLabel(h('2026-06-02T19:00:00Z'), h('2026-06-02T19:45:00Z')), '19:00–19:45 · 45m');
    // hours + minutes
    assert.equal(formatTimeLabel(h('2026-06-02T19:00:00Z'), h('2026-06-02T21:30:00Z')), '19:00–21:30 · 2h 30m');
    // multi-day: start time only + day-rolled duration
    assert.equal(formatTimeLabel(h('2026-06-02T19:00:00Z'), h('2026-06-04T23:00:00Z')), '19:00 · 2d 4h');
});

test('parseCustomEmoji: custom mention parsed, unicode/empty -> null', () => {
    assert.deepEqual(parseCustomEmoji('<:weed:1322212094963351562>'), { animated: false, name: 'weed', id: '1322212094963351562' });
    assert.deepEqual(parseCustomEmoji('<a:spin:123456789012345678>'), { animated: true, name: 'spin', id: '123456789012345678' });
    assert.equal(parseCustomEmoji('🔥'), null);
    assert.equal(parseCustomEmoji(':weed:'), null);
    assert.equal(parseCustomEmoji(''), null);
    assert.equal(parseCustomEmoji(null), null);
});

test('weekStartFor: returns the Sunday 00:00 UTC of the week', () => {
    const ws = weekStartFor(new Date('2026-06-02T13:00:00Z'));
    assert.equal(ws.toISOString(), '2026-05-31T00:00:00.000Z');
});

test('materializeWeek: one-off in window included, out-of-window excluded', () => {
    const ws = weekStartFor(new Date('2026-06-02T13:00:00Z')); // 05-31..06-07
    const events = [
        { id: 1, recurrence: 'none', start_time: '2026-06-02T18:00:00Z', end_time: '2026-06-02T20:00:00Z', title: 'A', category_id: 1, user_id: 'u1' },
        { id: 2, recurrence: 'none', start_time: '2026-06-20T18:00:00Z', end_time: null, title: 'B', category_id: 1, user_id: 'u1' },
    ];
    const segs = materializeWeek(events, ws);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].title, 'A');
});

test('materializeWeek: weekly event lands on its day-of-week within the window', () => {
    const ws = weekStartFor(new Date('2026-06-02T13:00:00Z')); // Sunday 05-31
    const events = [
        { id: 3, recurrence: 'weekly', recur_dow: 2, recur_start_min: 19 * 60, recur_end_min: 21 * 60, title: 'Tue Stream', category_id: 2, user_id: 'u2' },
    ];
    const segs = materializeWeek(events, ws);
    assert.equal(segs.length, 1);
    assert.equal(new Date(segs[0].start).toISOString(), '2026-06-02T19:00:00.000Z');
    assert.equal(new Date(segs[0].end).toISOString(), '2026-06-02T21:00:00.000Z');
});

test('groupByCategory: orders by category sort_order, unknown category -> Other bucket', () => {
    const cats = [{ id: 1, name: 'Streams', sort_order: 0 }, { id: 2, name: 'Tournaments', sort_order: 1 }];
    const segs = [{ categoryId: 2, title: 'T' }, { categoryId: 1, title: 'S' }, { categoryId: 999, title: 'U' }];
    const sections = groupByCategory(segs, cats);
    assert.deepEqual(sections.map(s => s.name), ['Streams', 'Tournaments', 'Uncategorized']);
});

test('scheduleHash: stable for equal content, differs on change', () => {
    const a = [{ start: 1, end: 2, title: 'X', categoryId: 1 }];
    const b = [{ start: 1, end: 2, title: 'X', categoryId: 1 }];
    const c = [{ start: 1, end: 2, title: 'Y', categoryId: 1 }];
    assert.equal(scheduleHash(a), scheduleHash(b));
    assert.notEqual(scheduleHash(a), scheduleHash(c));
});
