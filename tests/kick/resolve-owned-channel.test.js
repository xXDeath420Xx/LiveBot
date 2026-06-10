import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';

test('returns the PK row when the user owns the kick channel', async () => {
    let captured;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[{ id: 42 }]]; } };
    const resolve = makeResolveOwnedChannel({ pool });
    const row = await resolve(7, '62249842');
    assert.deepEqual(row, { id: 42 });
    assert.match(captured.sql, /FROM tokes_channels/);
    assert.match(captured.sql, /platform\s*=\s*'kick'/);
    assert.deepEqual(captured.params, ['62249842', 7]);
});

test('returns null when no owned channel matches', async () => {
    const pool = { execute: async () => [[]] };
    const resolve = makeResolveOwnedChannel({ pool });
    assert.equal(await resolve(7, 'nope'), null);
});

test('coerces a null channelId to empty string (no crash)', async () => {
    let captured;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[]]; } };
    const resolve = makeResolveOwnedChannel({ pool });
    await resolve(7, null);
    assert.equal(captured.params[0], '');
});
