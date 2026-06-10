import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeListEvents } from '../../services/certifried-bot/defender/enforcement-log.js';

test('builds a filtered, paginated query', async () => {
    let captured = null;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[{ id: 1 }]]; } };
    const listEvents = makeListEvents({ pool });
    const rows = await listEvents({ channelId: 'c1', action: 'ban', limit: 25, offset: 50 });
    assert.equal(rows.length, 1);
    assert.match(captured.sql, /FROM kbd_enforcement_log/);
    assert.match(captured.sql, /channel_id = \?/);
    assert.match(captured.sql, /action = \?/);
    assert.deepEqual(captured.params, ['c1', 'ban', 25, 50]);
});

test('omits action filter when not given', async () => {
    let captured = null;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[]]; } };
    const listEvents = makeListEvents({ pool });
    await listEvents({ channelId: 'c1', limit: 10, offset: 0 });
    assert.doesNotMatch(captured.sql, /action = \?/);
    assert.deepEqual(captured.params, ['c1', 10, 0]);
});
