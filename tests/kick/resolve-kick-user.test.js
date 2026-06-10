import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResolveKickUser } from '../../services/certifried-bot/defender/resolve-kick-user.js';

test('resolves a username to broadcaster_user_id + canonical slug', async () => {
    let asked;
    const apiRequest = async (ep) => { asked = ep; return { data: [{ broadcaster_user_id: 31564961, slug: 'iamthedabsrandy' }] }; };
    const resolve = makeResolveKickUser({ apiRequest });
    const r = await resolve('IamTheDabsRandy');
    assert.deepEqual(r, { userId: '31564961', slug: 'iamthedabsrandy' });
    assert.match(asked, /\/channels\?slug=iamthedabsrandy/);
});

test('strips a leading @ and lowercases', async () => {
    let asked;
    const resolve = makeResolveKickUser({ apiRequest: async (ep) => { asked = ep; return { data: [{ broadcaster_user_id: 1, slug: 'death420' }] }; } });
    await resolve('@Death420');
    assert.match(asked, /slug=death420/);
});

test('returns null for an empty/blank username (no API call)', async () => {
    let called = false;
    const resolve = makeResolveKickUser({ apiRequest: async () => { called = true; return {}; } });
    assert.equal(await resolve('   '), null);
    assert.equal(called, false);
});

test('returns null when the user is not found', async () => {
    const resolve = makeResolveKickUser({ apiRequest: async () => ({ data: [] }) });
    assert.equal(await resolve('ghost'), null);
});
