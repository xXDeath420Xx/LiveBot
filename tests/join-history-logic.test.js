import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    newJoins, countFrom, overLimit, normaliseAction, ordinal, TOLERANCE_MS, REJOIN_ACTIONS,
} from '../utils/join-history-logic.js';

const T = Date.UTC(2026, 3, 17, 3, 52, 26); // inkmaster1984's first join, 2026-04-17 03:52:26Z
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

test('the same join seen by several sources a few seconds apart counts once', () => {
    const system = T;
    const audit = T + 4000;      // audit_logs is written moments after the join
    const invite = T + 1500;
    assert.deepEqual(newJoins([], [audit, system, invite]), [system]);
});

test('separate joins are all kept, oldest first', () => {
    const joins = [T + 200 * DAY, T, T + 13 * DAY];
    assert.deepEqual(newJoins([], joins), [T, T + 13 * DAY, T + 200 * DAY]);
});

test('joins already recorded are not added again; ones outside the tolerance are', () => {
    const existing = [new Date(T)];
    assert.deepEqual(newJoins(existing, [T + 30 * 1000]), []);
    assert.deepEqual(newJoins(existing, [T + TOLERANCE_MS + 1]), [T + TOLERANCE_MS + 1]);
});

test('unparseable stamps are ignored rather than counted', () => {
    assert.deepEqual(newJoins([], [null, 'not a date', NaN, T]), [T]);
});

test('counting starts at the latest of a reset, an approval and the window', () => {
    const now = T + 400 * DAY;
    assert.equal(countFrom({ now }), null, 'nothing set: all time');
    assert.equal(countFrom({ resetAt: new Date(T), now }).getTime(), T);
    assert.equal(countFrom({ resetAt: new Date(T), approvedAt: new Date(T + DAY), now }).getTime(), T + DAY);
    assert.equal(countFrom({ windowDays: 30, now }).getTime(), now - 30 * DAY);
    assert.equal(countFrom({ resetAt: new Date(now - DAY), windowDays: 30, now }).getTime(), now - DAY,
        'a reset inside the window wins');
    assert.equal(countFrom({ windowDays: 0, now }), null, '0 days means all time');
});

test('the limit allows exactly maxJoins joins', () => {
    assert.equal(overLimit(3, 3), false, 'the 3rd join of 3 is allowed');
    assert.equal(overLimit(4, 3), true, 'the 4th is over');
    assert.equal(overLimit(1, 1), false);
    assert.equal(overLimit(2, 1), true);
});

test('a missing or nonsense limit never blocks anyone', () => {
    for (const max of [0, -1, null, undefined, 'abc', 2.5]) assert.equal(overLimit(99, max), false, String(max));
});

test('unknown actions fall back to ban, the default', () => {
    assert.equal(normaliseAction('KICK'), 'kick');
    assert.equal(normaliseAction('none'), 'none');
    assert.equal(normaliseAction('explode'), 'ban');
    assert.equal(normaliseAction(undefined), 'ban');
    assert.deepEqual([...REJOIN_ACTIONS], ['ban', 'kick', 'apply', 'none']);
});

test('ordinals', () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal),
        ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
});
