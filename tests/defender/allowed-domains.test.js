// Per-channel allowed domains (kbd_channel_settings.safe_domains, dashboard 'Allowed domains').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnforcer, isAllowedDomain } from '../../services/certifried-bot/defender/enforcer.js';

test('isAllowedDomain matches the domain and its subdomains only', () => {
    assert.equal(isAllowedDomain('example.com', ['example.com']), true);
    assert.equal(isAllowedDomain('cdn.example.com', ['*.example.com']), true);
    assert.equal(isAllowedDomain('example.com.evil.io', ['example.com']), false);
    assert.equal(isAllowedDomain('badexample.com', ['example.com']), false);
    assert.equal(isAllowedDomain('example.com', []), false);
    assert.equal(isAllowedDomain('example.com', undefined), false);
});

function deps(safeDomains, calls) {
    return {
        isOnBanlist: async () => false,
        isOnUnbanlist: async () => false,
        resolveChannel: async () => ({ broadcasterId: '1', token: 't', scopes: ['moderation:ban', 'moderation:chat_message:manage'] }),
        banUser: async () => { calls.push('ban'); return { ok: true }; },
        deleteMessage: async () => { calls.push('delete'); return { ok: true }; },
        log: async () => {},
        findPhishingDomain: () => 'listed.example',
        recordOffense: async () => { calls.push('offense'); return 1; },
        getSettings: async () => ({ phishingThreshold: 2, safeDomains }),
    };
}
const event = { platform: 'kick', channelId: '1', userId: '9', username: 'u', messageId: 'm', content: 'https://listed.example/x' };

test('a link on the channel allowed list is left alone and not counted', async () => {
    const calls = [];
    const r = await createEnforcer(deps(['listed.example'], calls)).check(event);
    assert.deepEqual(r, { acted: false });
    assert.deepEqual(calls, []);
});

test('without an allowed entry the link is still removed', async () => {
    const calls = [];
    const r = await createEnforcer(deps(['other.example'], calls)).check(event);
    assert.equal(r.acted, true);
    assert.deepEqual(calls, ['offense', 'delete']);
});
