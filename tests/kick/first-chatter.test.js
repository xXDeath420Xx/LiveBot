import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCheckFirstChatter } from '../../services/certifried-bot/first-chatter.js';

function fakePool(hasRow) {
    const calls = { selects: 0, inserts: 0 };
    return {
        calls,
        execute: async (sql) => {
            if (/^SELECT/i.test(sql.trim())) { calls.selects++; return [hasRow ? [{ id: 1 }] : []]; }
            calls.inserts++; return [{ affectedRows: 1 }];
        }
    };
}

test('first-ever message returns true and creates the stats row', async () => {
    const pool = fakePool(false);
    const check = makeCheckFirstChatter({ pool });
    assert.equal(await check(7, '123', 'newbie'), true);
    assert.equal(pool.calls.inserts, 1);
});

test('a user with an existing stats row is not first', async () => {
    const pool = fakePool(true);
    const check = makeCheckFirstChatter({ pool });
    assert.equal(await check(7, '123', 'regular'), false);
    assert.equal(pool.calls.inserts, 0);
});

test('in-memory dedupe: second message hits no DB at all', async () => {
    const pool = fakePool(false);
    const check = makeCheckFirstChatter({ pool });
    await check(7, '123', 'newbie');           // first → select + insert
    assert.equal(await check(7, '123', 'newbie'), false);
    assert.equal(pool.calls.selects, 1, 'no second SELECT for a seen user');
});

test('per-channel isolation: same user is "first" in a different channel', async () => {
    const pool = fakePool(false);
    const check = makeCheckFirstChatter({ pool });
    assert.equal(await check(7, '123', 'x'), true);
    assert.equal(await check(8, '123', 'x'), true);
});

test('null inputs never fire', async () => {
    const check = makeCheckFirstChatter({ pool: fakePool(false) });
    assert.equal(await check(null, '1', 'x'), false);
    assert.equal(await check(1, null, 'x'), false);
});
