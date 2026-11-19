import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sessionKey, parseStartedAt, isNewBroadcast, shouldClose, viewerCount, clampText, formatSessionDuration,
    OFFLINE_CLOSE_MS,
} from '../core/stream-session-logic.js';

const NOW = Date.parse('2026-10-05T20:00:00Z');

test('session key is per channel, case-insensitive, and fits the column', () => {
    assert.equal(sessionKey('Twitch', 'SomeStreamer'), 'twitch:somestreamer');
    assert.equal(sessionKey('twitch', 'x'.repeat(400)).length, 191);
});

test('platform start times are used only when believable', () => {
    assert.equal(parseStartedAt('2026-10-05T18:00:00Z', NOW), Date.parse('2026-10-05T18:00:00Z'));
    // Kick sends "YYYY-MM-DD HH:MM:SS" in UTC.
    assert.equal(parseStartedAt('2026-10-05 18:00:00', NOW), Date.parse('2026-10-05T18:00:00Z'));
    // Unix seconds.
    assert.equal(parseStartedAt(Math.floor(NOW / 1000) - 60, NOW), NOW - 60_000);
    assert.equal(parseStartedAt('2026-10-05T21:00:00Z', NOW), null);       // future
    assert.equal(parseStartedAt('2026-10-01T18:00:00Z', NOW), null);       // days old
    assert.equal(parseStartedAt('N/A', NOW), null);
    assert.equal(parseStartedAt(null, NOW), null);
});

test('a much later reported start is a new broadcast; jitter is not', () => {
    const open = Date.parse('2026-10-05T18:00:00Z');
    assert.equal(isNewBroadcast({ openStartMs: open, reportedStartMs: open + 30_000 }), false);
    assert.equal(isNewBroadcast({ openStartMs: open, reportedStartMs: open + 45 * 60_000 }), true);
    assert.equal(isNewBroadcast({ openStartMs: open, reportedStartMs: null }), false);
});

test('sessions close only after the offline grace since the last live sighting', () => {
    assert.equal(shouldClose({ lastSeenMs: NOW - OFFLINE_CLOSE_MS + 1000, nowMs: NOW }), false);
    assert.equal(shouldClose({ lastSeenMs: NOW - OFFLINE_CLOSE_MS, nowMs: NOW }), true);
    assert.equal(shouldClose({ lastSeenMs: NaN, nowMs: NOW }), true);
});

test('viewer counts: numbers kept, "N/A" and junk dropped', () => {
    assert.equal(viewerCount({ viewer_count: 42 }), 42);
    assert.equal(viewerCount({ viewer_count: '17' }), 17);
    assert.equal(viewerCount({ viewer_count: 'N/A' }), null);
    assert.equal(viewerCount(null), null);
    assert.equal(viewerCount({ viewer_count: -3 }), null);
});

test('text clamping and duration formatting', () => {
    assert.equal(clampText('  '), null);
    assert.equal(clampText('a'.repeat(300)).length, 255);
    assert.equal(formatSessionDuration(42 * 60), '42m');
    assert.equal(formatSessionDuration(3 * 3600 + 5 * 60), '3h 05m');
});
