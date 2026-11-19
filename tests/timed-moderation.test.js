import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseModerationDuration, TEMP_BAN_LIMITS, TEMP_ROLE_LIMITS, tempBanMarker, banReasonWithMarker,
    banCarriesMarker, backoffMinutes, errorText, MAX_ATTEMPTS,
} from '../core/timed-moderation-logic.js';

const MIN = 60_000, H = 3_600_000, D = 86_400_000;

test('durations moderators actually type', () => {
    assert.deepEqual(parseModerationDuration('30m', TEMP_BAN_LIMITS), { ok: true, ms: 30 * MIN, minutes: 30 });
    assert.equal(parseModerationDuration('12h', TEMP_BAN_LIMITS).ms, 12 * H);
    assert.equal(parseModerationDuration('7d', TEMP_BAN_LIMITS).ms, 7 * D);
    assert.equal(parseModerationDuration('1w 2d', TEMP_BAN_LIMITS).ms, 9 * D);
    assert.equal(parseModerationDuration(' 2D ', TEMP_BAN_LIMITS).ms, 2 * D, 'case and padding do not matter');
    assert.equal(parseModerationDuration('1mo', TEMP_BAN_LIMITS).ms, 30 * D, '"mo" is a month, not minutes');
});

test('garbage is refused rather than half-read', () => {
    for (const bad of ['', '   ', 'soon', '7 days please', '10x', 'd7', '-5m', '5', '1.5h']) {
        const r = parseModerationDuration(bad, TEMP_BAN_LIMITS);
        assert.equal(r.ok, false, `"${bad}" must be rejected`);
        assert.ok(r.error);
    }
    assert.equal(parseModerationDuration('1d'.repeat(30), TEMP_BAN_LIMITS).ok, false, 'absurdly long input');
});

test('limits: at least a minute, at most a year', () => {
    assert.equal(parseModerationDuration('30s', TEMP_BAN_LIMITS).ok, false);
    assert.equal(parseModerationDuration('60s', TEMP_BAN_LIMITS).ok, true);
    assert.equal(parseModerationDuration('365d', TEMP_ROLE_LIMITS).ok, true);
    assert.equal(parseModerationDuration('366d', TEMP_ROLE_LIMITS).ok, false);
    assert.equal(parseModerationDuration('13mo', TEMP_BAN_LIMITS).ok, false);
});

test('the ban marker survives any reason length and is recognised only for its own row', () => {
    const long = 'x'.repeat(2000);
    const reason = banReasonWithMarker(long, 42);
    assert.ok(reason.length <= 512, 'fits Discord\'s audit-log reason limit');
    assert.ok(reason.endsWith(tempBanMarker(42)));
    assert.equal(banCarriesMarker(reason, 42), true);
    assert.equal(banCarriesMarker(reason, 4), false, '#4 is not #42');
    assert.equal(banCarriesMarker(banReasonWithMarker('spam', 7), 77), false);
    assert.equal(banCarriesMarker('spam', 42), false, 'a ban re-applied by hand carries no marker');
    assert.equal(banCarriesMarker(null, 42), false);
    assert.equal(banReasonWithMarker('', 3), `No reason provided ${tempBanMarker(3)}`);
});

test('marker matching is exact on the closing bracket', () => {
    assert.equal(banCarriesMarker('x [tempban #12]', 1), false);
    assert.equal(banCarriesMarker('x [tempban #12]', 12), true);
});

test('retry backoff doubles and is capped at 12 hours', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(backoffMinutes), [1, 2, 4, 8, 16]);
    assert.equal(backoffMinutes(20), 720);
    assert.equal(backoffMinutes(-1), 1);
    // The whole retry budget spans more than a day, so an outage does not exhaust it.
    let total = 0;
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) total += backoffMinutes(i);
    assert.ok(total >= 24 * 60, `retry window ${total} min should cover a day`);
});

test('error text fits last_error VARCHAR(255) and keeps the Discord code', () => {
    const e = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    assert.equal(errorText(e), '[50013] Missing Permissions');
    assert.equal(errorText(new Error('y'.repeat(400))).length, 255);
});
