import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../utils/db.js';
import {
    addBan, removeBan, isOnBanlist, addUnban, removeUnban, isOnUnbanlist,
    getCounts, invalidateCache, addSite, removeSite, listSites
} from '../../services/certifried-bot/defender/banlist.js';

const TEST_UID = 'test-uid-0001';
const TEST_SITE = 'http://evil.test/x';

after(async () => {
    await pool.execute('DELETE FROM kbd_banlist WHERE platform_user_id = ?', [TEST_UID]);
    await pool.execute("DELETE FROM kbd_banlist WHERE username = ?", ['evilname']);
    await pool.execute('DELETE FROM kbd_unbanlist WHERE platform_user_id = ?', [TEST_UID]);
    await pool.execute('DELETE FROM kbd_malicious_sites WHERE uri = ?', [TEST_SITE]);
    await pool.end();
});

test('addBan then isOnBanlist by id', async () => {
    await addBan({ platform: 'kick', userId: TEST_UID, username: 'evil', reason: 'spam', listType: 'ban', addedBy: null });
    invalidateCache();
    assert.equal(await isOnBanlist('kick', TEST_UID, 'evil'), true);
});

test('isOnBanlist matches by username when id unknown', async () => {
    invalidateCache();
    assert.equal(await isOnBanlist('kick', null, 'evil'), true);
});

test('removeBan clears membership', async () => {
    await removeBan('kick', TEST_UID);
    invalidateCache();
    assert.equal(await isOnBanlist('kick', TEST_UID, 'evil'), false);
});

test('removeBan by username works', async () => {
    await addBan({ platform: 'kick', userId: null, username: 'evilname', reason: 'bot' });
    invalidateCache();
    assert.equal(await isOnBanlist('kick', null, 'evilname'), true);
    await removeBan('kick', null, 'evilname');
    invalidateCache();
    assert.equal(await isOnBanlist('kick', null, 'evilname'), false);
});

test('unbanlist add + check + remove', async () => {
    await addUnban({ platform: 'kick', userId: TEST_UID, username: 'evil', addedBy: null });
    invalidateCache();
    assert.equal(await isOnUnbanlist('kick', TEST_UID, 'evil'), true);
    await removeUnban('kick', TEST_UID);
    invalidateCache();
    assert.equal(await isOnUnbanlist('kick', TEST_UID, 'evil'), false);
});

test('getCounts returns numeric fields', async () => {
    const counts = await getCounts();
    assert.equal(typeof counts.banlist, 'number');
    assert.equal(typeof counts.sublist, 'number');
    assert.equal(typeof counts.unbanlist, 'number');
    assert.equal(typeof counts.sites, 'number');
});

test('site add + list + remove', async () => {
    await addSite(TEST_SITE, null);
    let sites = await listSites();
    assert.ok(sites.some(s => s.uri === TEST_SITE));
    await removeSite(TEST_SITE);
    sites = await listSites();
    assert.ok(!sites.some(s => s.uri === TEST_SITE));
});
