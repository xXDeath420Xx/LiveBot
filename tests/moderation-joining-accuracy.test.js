import test from 'node:test';
import assert from 'node:assert/strict';
import { enableAutomodSpamQuery, enableAutomodSpam } from '../core/automod-spam-config.js';
import { defaultsFor, FEATURE_SPECS } from '../core/feature-config-spec.js';
import { isJsonObjectText } from '../dashboard/routes/api/features/feature-config.js';
import { moveOrientationMessage, describeOrientationMove } from '../core/orientation-manager.js';
import { violationNotice } from '../core/channel-post-rules.js';
import { banAbsentIds } from '../core/mass-moderation.js';

/*
 * Accuracy pass over the Moderation & AutoMod and Verification & joining pages (2026-11-19):
 *   - the setup wizard and takeover switch the Spam limits on with the page's defaults, not the table's
 *   - JSON fields (AutoMod heat) refuse text the runtime would ignore
 *   - Orientation: saving a new guide channel moves the guide message
 *   - Channel post rules: the member's notice only says removed when the post was deleted
 *   - Mass actions: user IDs of people who left are banned by ID, as the page says
 */

test('Spam limits are switched on with the page defaults, and an existing row keeps its limits', async () => {
    const d = defaultsFor('automod-spam');
    const { sql, params } = enableAutomodSpamQuery('123456789012345678');
    assert.deepEqual(params, ['123456789012345678', d.max_messages, d.time_window, d.max_mentions, d.max_emojis, d.max_repeated_chars, d.action]);
    assert.match(sql, /ON DUPLICATE KEY UPDATE enabled = 1$/);
    assert.equal(params.length, (sql.match(/\?/g) || []).length);
    const calls = [];
    await enableAutomodSpam('1', { execute: async (s, p) => { calls.push([s, p]); return [[]]; } });
    assert.equal(calls.length, 1);
    assert.deepEqual(FEATURE_SPECS['automod-spam'].commands, []);
});

test('AutoMod heat JSON fields: defaults are valid JSON and plain text is refused', () => {
    const heat = FEATURE_SPECS['automod-heat'].fields;
    for (const key of ['heat_values', 'action_thresholds']) {
        const f = heat.find((x) => x.key === key);
        assert.equal(f.json, true, key);
        assert.ok(isJsonObjectText(f.default), key);
    }
    assert.equal(isJsonObjectText('warn 25'), false);
    assert.equal(isJsonObjectText('25'), false);
    assert.equal(isJsonObjectText('[{"type":"warn","threshold":25}]'), true);
});

function fakeClient(channels) {
    const deleted = [];
    const guild = {
        channels: {
            cache: new Map(Object.entries(channels).map(([id]) => [id, { id, messages: { delete: async (m) => { deleted.push([id, m]); } } }])),
            fetch: async () => null,
        },
    };
    return { client: { guilds: { cache: new Map([['g1', guild]]) } }, deleted };
}

test('Orientation: a new channel deletes the old guide and posts it there', async () => {
    const { client, deleted } = fakeClient({ old: 1, neu: 1 });
    const sql = [];
    const posted = [];
    const db = { execute: async (s, p) => { sql.push(s); return [[]]; } };
    const r = await moveOrientationMessage(client, 'g1', { fromChannelId: 'old', messageId: 'm1', toChannelId: 'neu' },
        { db, post: async (c, g, ch) => { posted.push(ch); return { action: 'posted' }; } });
    assert.deepEqual(r, { action: 'posted', channelId: 'neu' });
    assert.deepEqual(deleted, [['old', 'm1']]);
    assert.deepEqual(posted, ['neu']);
    assert.match(sql[0], /SET message_id = NULL/);
    assert.match(describeOrientationMove(r), /posted/);
});

test('Orientation: clearing the channel removes the guide; no bot means nothing moves', async () => {
    const { client, deleted } = fakeClient({ old: 1 });
    const sql = [];
    const db = { execute: async (s) => { sql.push(s); return [[]]; } };
    const r = await moveOrientationMessage(client, 'g1', { fromChannelId: 'old', messageId: 'm1', toChannelId: null }, { db, post: async () => assert.fail('no post') });
    assert.equal(r.action, 'removed');
    assert.deepEqual(deleted, [['old', 'm1']]);
    assert.match(sql[0], /^DELETE FROM orientation_config/);
    assert.equal((await moveOrientationMessage(null, 'g1', { toChannelId: 'x' }, { db, post: async () => assert.fail('no post') })).action, 'unavailable');
    const failed = await moveOrientationMessage(client, 'g1', { toChannelId: 'old' }, { db, post: async () => null });
    assert.equal(failed.action, 'failed');
});

test('Channel post rules: the notice says removed only when the post was deleted', () => {
    assert.match(violationNotice('1', ['a'], true), /was removed:\n• a$/);
    const kept = violationNotice('1', ['a', 'b'], false);
    assert.doesNotMatch(kept, /removed/);
    assert.match(kept, /breaks this channel's posting rules:\n• a\n• b$/);
});

test('Mass ban: IDs not in the server are banned by ID; bad and protected IDs are skipped', async () => {
    const made = [];
    const guild = { bans: { create: async (id, o) => { if (id === '333333333333333333') throw new Error('Unknown User'); made.push([id, o]); } } };
    const r = await banAbsentIds(guild, ['111111111111111111', 'nope', '222222222222222222', '333333333333333333'],
        { reason: 'raid', deleteMessageSeconds: 86400, isProtected: (id) => id === '222222222222222222' });
    assert.deepEqual(r, { banned: 1, failed: 1, skipped: 2 });
    assert.deepEqual(made, [['111111111111111111', { reason: 'raid', deleteMessageSeconds: 86400 }]]);
});
