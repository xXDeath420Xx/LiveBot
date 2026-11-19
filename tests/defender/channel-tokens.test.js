import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResolveChannel } from '../../services/certifried-bot/defender/channel-tokens.js';

function fakePool(row) {
    return { execute: async () => [row ? [row] : []] };
}

test('returns null when channel not enrolled', async () => {
    const resolve = makeResolveChannel({
        pool: fakePool(null), decryptToken: () => 'x', refresh: async () => null
    });
    assert.equal(await resolve('chanX'), null);
});

test('returns broadcasterId, token, parsed scopes for enrolled channel', async () => {
    const row = {
        broadcaster_id: '999', connection_id: 1,
        access_token: 'enc', refresh_token: 'encr',
        expires_at: new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace('T', ' '),
        scopes: 'user:read chat:write moderation:ban'
    };
    const resolve = makeResolveChannel({
        pool: fakePool(row), decryptToken: () => 'plain-token', refresh: async () => null
    });
    const r = await resolve('chan1');
    assert.equal(r.broadcasterId, '999');
    assert.equal(r.token, 'plain-token');
    assert.deepEqual(r.scopes, ['user:read', 'chat:write', 'moderation:ban']);
});

test('refreshes when expired', async () => {
    const row = {
        broadcaster_id: '999', connection_id: 1,
        access_token: 'enc', refresh_token: 'encr',
        expires_at: '2000-01-01 00:00:00', scopes: 'moderation:ban'
    };
    let refreshed = false;
    const resolve = makeResolveChannel({
        pool: fakePool(row), decryptToken: () => 'old',
        refresh: async () => { refreshed = true; return 'new-token'; }
    });
    const r = await resolve('chan1');
    assert.equal(refreshed, true);
    assert.equal(r.token, 'new-token');
});

test('falls back to stale token when refresh fails', async () => {
    const row = {
        broadcaster_id: '1', connection_id: 1,
        access_token: 'enc', refresh_token: 'encr',
        expires_at: '2000-01-01 00:00:00', scopes: 'moderation:ban'
    };
    const resolve = makeResolveChannel({
        pool: fakePool(row), decryptToken: () => 'stale-token', refresh: async () => null
    });
    const r = await resolve('chan1');
    assert.equal(r.token, 'stale-token');
});

test('returns null when decryptToken yields null', async () => {
    const row = {
        broadcaster_id: '1', connection_id: 1,
        access_token: 'enc', refresh_token: null,
        expires_at: new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace('T', ' '),
        scopes: 'moderation:ban'
    };
    const resolve = makeResolveChannel({
        pool: fakePool(row), decryptToken: () => null, refresh: async () => null
    });
    assert.equal(await resolve('chan1'), null);
});
