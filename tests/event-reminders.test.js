import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRule, buildRule, occurrenceAt, nextOccurrenceAfter, describeRule, localToUtc, parseLocalDateTime, isValidTimeZone,
} from '../core/recurrence-rule.js';
import {
    normaliseEventConfig, reminderDue, startAnnouncementDue, occurrenceEnded, shouldRearm, allowUserDm,
    entityTypeToColumn, columnToEntityType, statusName,
} from '../core/event-reminder-helpers.js';

const iso = (ms) => new Date(ms).toISOString();

// ── Recurrence ──────────────────────────────────────────────────────────────────────────────

test('local wall time converts to UTC in a DST zone', () => {
    // New York is UTC-4 in summer, UTC-5 in winter.
    assert.equal(iso(localToUtc(2026, 7, 10, 20, 0, 'America/New_York')), '2026-07-11T00:00:00.000Z');
    assert.equal(iso(localToUtc(2026, 12, 10, 20, 0, 'America/New_York')), '2026-12-11T01:00:00.000Z');
    assert.equal(iso(localToUtc(2026, 3, 1, 9, 30, 'UTC')), '2026-03-01T09:30:00.000Z');
});

test('weekly rule keeps the local time across a DST change', () => {
    // 2026-10-30 is a Friday; US clocks fall back on 2026-11-01.
    const rule = buildRule({ freq: 'weekly', interval: 1, tz: 'America/New_York', start: '2026-10-30 20:00' });
    assert.equal(iso(occurrenceAt(rule, 0)), '2026-10-31T00:00:00.000Z'); // EDT
    assert.equal(iso(occurrenceAt(rule, 1)), '2026-11-07T01:00:00.000Z'); // EST — still 20:00 local
});

test('biweekly and daily intervals step correctly', () => {
    const biweekly = buildRule({ freq: 'weekly', interval: 2, tz: 'UTC', start: '2026-01-05 18:00' });
    assert.equal(iso(occurrenceAt(biweekly, 3)), '2026-02-16T18:00:00.000Z');
    const daily = buildRule({ freq: 'daily', interval: 1, tz: 'UTC', start: '2026-01-31 23:30' });
    assert.equal(iso(occurrenceAt(daily, 1)), '2026-02-01T23:30:00.000Z');
});

test('monthly rule on the 31st clamps to short months instead of skipping them', () => {
    const rule = buildRule({ freq: 'monthly', interval: 1, tz: 'UTC', start: '2026-01-31 12:00' });
    assert.equal(iso(occurrenceAt(rule, 1)), '2026-02-28T12:00:00.000Z');
    assert.equal(iso(occurrenceAt(rule, 2)), '2026-03-31T12:00:00.000Z');
    assert.equal(iso(occurrenceAt(rule, 13)), '2027-02-28T12:00:00.000Z');
});

test('nextOccurrenceAfter is strictly after the given instant and handles old anchors', () => {
    const rule = buildRule({ freq: 'weekly', interval: 1, tz: 'UTC', start: '2020-01-03 20:00' });
    const after = Date.parse('2026-10-09T20:00:00Z'); // exactly an occurrence
    const next = nextOccurrenceAfter(rule, after);
    assert.equal(iso(next.startMs), '2026-10-16T20:00:00.000Z');
    // Before the anchor -> the anchor itself.
    assert.equal(nextOccurrenceAfter(rule, Date.parse('2019-01-01T00:00:00Z')).index, 0);
});

test('nextOccurrenceAfter works for monthly rules many months out', () => {
    const rule = buildRule({ freq: 'monthly', interval: 3, tz: 'Europe/London', start: '2024-05-15 19:00' });
    const next = nextOccurrenceAfter(rule, Date.parse('2026-10-05T00:00:00Z'));
    assert.equal(iso(next.startMs), '2026-11-15T19:00:00.000Z'); // GMT in November
});

test('rule parsing rejects bad input and round-trips stored JSON', () => {
    assert.equal(parseRule('not json'), null);
    assert.equal(parseRule({ freq: 'hourly', tz: 'UTC', anchor: '2026-01-01T00:00' }), null);
    assert.equal(parseRule({ freq: 'daily', interval: 0, tz: 'UTC', anchor: '2026-01-01T00:00' }), null);
    assert.equal(parseRule({ freq: 'daily', tz: 'Mars/Olympus', anchor: '2026-01-01T00:00' }), null);
    assert.equal(parseRule({ freq: 'daily', tz: 'UTC', anchor: '2026-02-30T00:00' }), null);
    const rule = buildRule({ freq: 'monthly', tz: 'UTC', start: '2026-1-5 7:05' });
    assert.deepEqual(parseRule(JSON.stringify(rule)), rule);
    assert.equal(rule.anchor, '2026-01-05T07:05');
    assert.throws(() => buildRule({ freq: 'weekly', tz: 'UTC', start: 'next friday' }), /YYYY|2026-10-09/);
    assert.throws(() => buildRule({ freq: 'weekly', tz: 'Nowhere/Land', start: '2026-10-09 20:00' }), /time zone/);
});

test('parseLocalDateTime and zone validation', () => {
    assert.deepEqual(parseLocalDateTime('2026-10-09T20:00'), { year: 2026, month: 10, day: 9, hour: 20, minute: 0 });
    assert.equal(parseLocalDateTime('2026-13-01 10:00'), null);
    assert.equal(parseLocalDateTime('2026-10-09 24:00'), null);
    assert.ok(isValidTimeZone('Asia/Tokyo'));
    assert.ok(!isValidTimeZone(''));
});

test('describeRule names the weekday and zone', () => {
    const rule = buildRule({ freq: 'weekly', interval: 2, tz: 'America/New_York', start: '2026-10-09 20:00' });
    assert.equal(describeRule(rule), 'Every 2 weeks on Friday at 20:00 (America/New_York)');
});

// ── Reminder helpers ────────────────────────────────────────────────────────────────────────

test('config defaults are all off and values are clamped', () => {
    assert.deepEqual(normaliseEventConfig({}), {
        dmEnabled: false, leadMinutes: 30, announceEnabled: false, announceChannelId: null, announceRoleId: null,
    });
    const cfg = normaliseEventConfig({
        dm_reminders_enabled: 1, reminder_minutes: '2', announce_enabled: true,
        announce_channel_id: '123456789012345678', announce_role_id: 'not-a-role',
    });
    assert.equal(cfg.dmEnabled, true);
    assert.equal(cfg.leadMinutes, 5);
    assert.equal(cfg.announceEnabled, true);
    assert.equal(cfg.announceRoleId, null);
    // Announcements need a channel to be "on".
    assert.equal(normaliseEventConfig({ announce_enabled: true }).announceEnabled, false);
    assert.equal(normaliseEventConfig({ reminder_minutes: 99999 }).leadMinutes, 1440);
});

test('reminders are due only inside the lead window before start', () => {
    const start = Date.parse('2026-10-09T20:00:00Z');
    assert.equal(reminderDue({ startMs: start, nowMs: start - 31 * 60_000, leadMinutes: 30 }), false);
    assert.equal(reminderDue({ startMs: start, nowMs: start - 30 * 60_000, leadMinutes: 30 }), true);
    assert.equal(reminderDue({ startMs: start, nowMs: start - 1000, leadMinutes: 30 }), true);
    assert.equal(reminderDue({ startMs: start, nowMs: start, leadMinutes: 30 }), false);
});

test('start announcements stop after the grace window', () => {
    const start = Date.parse('2026-10-09T20:00:00Z');
    assert.equal(startAnnouncementDue({ startMs: start, nowMs: start - 1 }), false);
    assert.equal(startAnnouncementDue({ startMs: start, nowMs: start + 14 * 60_000 }), true);
    assert.equal(startAnnouncementDue({ startMs: start, nowMs: start + 16 * 60_000 }), false);
});

test('an occurrence ends on a final status or when its planned end passes', () => {
    const start = Date.parse('2026-10-09T20:00:00Z');
    assert.equal(occurrenceEnded({ status: 'completed', startMs: start, nowMs: start }), true);
    assert.equal(occurrenceEnded({ status: 'deleted', startMs: start, nowMs: start - 1 }), true);
    assert.equal(occurrenceEnded({ status: 'active', startMs: start, durationMinutes: 60, nowMs: start + 59 * 60_000 }), false);
    assert.equal(occurrenceEnded({ status: 'scheduled', startMs: start, durationMinutes: 60, nowMs: start + 60 * 60_000 }), true);
    assert.equal(occurrenceEnded({ status: 'scheduled', startMs: start, endMs: start + 2 * 3600_000, nowMs: start + 90 * 60_000 }), false);
});

test('moving an event into the future re-arms its reminder; small edits do not', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const old = Date.parse('2026-10-09T20:00:00Z');
    assert.equal(shouldRearm({ oldStartMs: old, newStartMs: old + 30_000, nowMs: now }), false);
    assert.equal(shouldRearm({ oldStartMs: old, newStartMs: old + 3600_000, nowMs: now }), true);
    assert.equal(shouldRearm({ oldStartMs: old, newStartMs: now - 3600_000, nowMs: now }), false);
});

test('per-member DM limiter allows a burst and then blocks within the window', () => {
    const log = new Map();
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) assert.equal(allowUserDm(log, 'u', t0 + i), true);
    assert.equal(allowUserDm(log, 'u', t0 + 10), false);
    assert.equal(allowUserDm(log, 'other', t0 + 10), true);
    assert.equal(allowUserDm(log, 'u', t0 + 3_600_001), true);
});

test('entity type and status mapping', () => {
    assert.equal(entityTypeToColumn(1), 'stage');
    assert.equal(entityTypeToColumn(2), 'voice');
    assert.equal(entityTypeToColumn(3), 'external');
    assert.equal(columnToEntityType('voice'), 2);
    assert.equal(statusName(2), 'active');
    assert.equal(statusName(4), 'canceled');
    assert.equal(statusName(undefined), 'scheduled');
});
