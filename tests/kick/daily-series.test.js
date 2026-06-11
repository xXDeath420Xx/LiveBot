import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillDailySeries, makeDailyActivity } from '../../services/certifried-bot/defender/enforcement-log.js';

test('fills a continuous zero-filled series ending today', () => {
    const out = fillDailySeries([{ date: '2026-06-09', banned: 3, deleted: 1, dormant: 0 }], 3, '2026-06-11');
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(r => r.date), ['2026-06-09', '2026-06-10', '2026-06-11']);
    assert.equal(out[0].banned, 3);   // the populated day
    assert.equal(out[1].banned, 0);   // gap → zero
    assert.equal(out[2].banned, 0);   // today, no data → zero
});

test('coerces count strings/nulls to numbers', () => {
    const out = fillDailySeries([{ date: '2026-06-11', banned: '5', deleted: null, dormant: '2' }], 1, '2026-06-11');
    assert.equal(out[0].banned, 5);
    assert.equal(out[0].deleted, 0);
    assert.equal(out[0].dormant, 2);
});

test('empty input yields an all-zero series of the right length', () => {
    const out = fillDailySeries([], 7, '2026-06-11');
    assert.equal(out.length, 7);
    assert.ok(out.every(r => r.banned === 0 && r.deleted === 0 && r.dormant === 0));
    assert.equal(out[6].date, '2026-06-11');
});

test('dailyActivity clamps days to [1,90] and scopes by channel', async () => {
    let captured;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[]]; } };
    const daily = makeDailyActivity({ pool });
    await daily({ channelId: '999', days: 1000, todayIso: '2026-06-11' });
    assert.match(captured.sql, /channel_id = \?/);
    assert.equal(captured.params[0], 89);     // 90 days clamp → INTERVAL 89 DAY
    assert.equal(captured.params[1], '999');
});

test('dailyActivity returns a continuous 14-day default series', async () => {
    const pool = { execute: async () => [[{ date: '2026-06-11', banned: 2, deleted: 0, dormant: 0 }]] };
    const daily = makeDailyActivity({ pool });
    const series = await daily({ todayIso: '2026-06-11' });
    assert.equal(series.length, 14);
    assert.equal(series[13].banned, 2);
});
