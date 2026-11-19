import test from 'node:test';
import assert from 'node:assert/strict';
import marketplaceFilter from '../events/marketplaceFilter.js';
import { FEATURE_SPECS } from '../core/feature-config-spec.js';

// 2026-11-19 accuracy audit (Marketplace Guards): the filter built its warning with `member`, a name
// only declared inside the trader-role check, so after deleting a new account's post it threw
// ReferenceError and never told the member or the mod log why.

function fakeMessage({ ageDays }) {
    const sent = { dm: [], channel: [], deleted: false };
    const guild = {
        id: '000000000000000001', // no marketplace_settings row: the bot's defaults apply
        members: { fetch: async () => null },
        channels: { cache: { find: () => null } },
    };
    const message = {
        guild,
        member: { roles: { cache: { some: () => false } } },
        content: 'WTS stuff',
        author: {
            bot: false, id: '000000000000000002', tag: 'new#0001',
            createdAt: new Date(Date.now() - ageDays * 86400000),
            send: async (m) => { sent.dm.push(m); },
        },
        channel: { name: 'marketplace', id: '000000000000000003', send: async (m) => { sent.channel.push(m); return { delete: async () => {} }; } },
        delete: async () => { sent.deleted = true; },
    };
    return { message, sent };
}

test('a post from a new account is removed and the member is told why', async () => {
    const { message, sent } = fakeMessage({ ageDays: 1 });
    await marketplaceFilter.execute(message);
    assert.equal(sent.deleted, true);
    assert.equal(sent.dm.length, 1);
    assert.match(sent.dm[0].embeds[0].data.description, /at least \*\*7 days old\*\*/);
});

test('an account older than the default 7 days is left alone', async () => {
    const { message, sent } = fakeMessage({ ageDays: 8 });
    await marketplaceFilter.execute(message);
    assert.equal(sent.deleted, false);
});

test('the page shows the defaults the filter runs on for a server that never saved', () => {
    const f = Object.fromEntries(FEATURE_SPECS.marketplace.fields.map((x) => [x.key, x.default]));
    assert.equal(Number(f.account_age_filter), 1);
    assert.equal(f.min_account_age_days, 7);
    assert.equal(Number(f.trader_role_bypass), 1);
});
