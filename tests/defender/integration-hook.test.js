import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../utils/db.js';
import { addBan, invalidateCache } from '../../services/certifried-bot/defender/banlist.js';
import { enforcer } from '../../services/certifried-bot/defender/index.js';

const UID = 'hook-test-uid';

after(async () => {
    await pool.execute('DELETE FROM kbd_banlist WHERE platform_user_id = ?', [UID]);
    await pool.end();
});

test('enforcer.check is safe (acted=false) for a banlisted user in a non-enrolled channel', async () => {
    await addBan({ platform: 'kick', userId: UID, username: 'hooktest' });
    invalidateCache();
    const r = await enforcer.check({
        platform: 'kick', channelId: 'definitely-not-enrolled-xyz',
        userId: UID, username: 'hooktest', messageId: 'm', isMod: false, isBroadcaster: false
    });
    assert.equal(r.acted, false); // no enrollment/token -> safe no-op, no real API call
});

test('enforcer.check returns acted=false for a clean user', async () => {
    invalidateCache();
    const r = await enforcer.check({
        platform: 'kick', channelId: 'whatever',
        userId: 'clean-user', username: 'cleanguy', messageId: 'm', isMod: false, isBroadcaster: false
    });
    assert.equal(r.acted, false);
});

test('enforcer.check no-ops for twitch even if banlisted', async () => {
    invalidateCache();
    const r = await enforcer.check({
        platform: 'twitch', channelId: 'whatever',
        userId: UID, username: 'hooktest', messageId: 'm', isMod: false, isBroadcaster: false
    });
    assert.equal(r.acted, false);
});
