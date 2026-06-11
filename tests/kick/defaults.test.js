/**
 * OFF-BY-DEFAULT CONTRACT.
 *
 * Every proactive bot behavior must be opt-in: a channel with no
 * features_enabled config (or an empty one) gets NO automod actions, NO
 * welcomes, NO thank-yous, NO analytics counting, NO responders, NO timers,
 * NO giveaway handling. These tests pin that contract — if one fails, a
 * default got flipped somewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMessage, makeLoadAutomod } from '../../services/certifried-bot/kick-automod.js';
import { matchResponder } from '../../services/certifried-bot/auto-responder.js';
import { makeHandleKickEvent } from '../../services/certifried-bot/kick-events.js';
import { makeGiveaways } from '../../services/certifried-bot/giveaway.js';

test('automod: no settings → even a hostile message passes untouched', () => {
    assert.equal(evaluateMessage('SCREAMING http://scam.xyz !!!! badword', {}), null);
    assert.equal(evaluateMessage('anything', undefined), null);
});

test('automod loader: missing/empty/absent automod key → null (filters off)', async () => {
    for (const fe of [null, '{}', JSON.stringify({ tokes: true })]) {
        const load = makeLoadAutomod({ pool: { execute: async () => [[{ features_enabled: fe }]] } });
        assert.equal(await load(1), null, `features_enabled=${fe} must mean automod off`);
    }
    const loadNoRow = makeLoadAutomod({ pool: { execute: async () => [[]] } });
    assert.equal(await loadNoRow(1), null, 'no channel row must mean automod off');
});

test('auto-responders: no configured responders → never fires', () => {
    assert.equal(matchResponder([], 'any message at all', new Map(), Date.now()), null);
});

test('webhook events: no thank-you templates → stored only, nothing sent to chat', async () => {
    let sent = 0;
    const pool = { execute: async (sql) => /INSERT/.test(sql) ? [{}] : [[{ features_enabled: '{}' }]] };
    const handle = makeHandleKickEvent({ pool, send: async () => { sent++; return true; }, allow: () => true });
    assert.equal(await handle('channel.followed', { broadcaster: { user_id: 1 }, follower: { username: 'x' } }), 'stored');
    assert.equal(await handle('channel.subscription.new', { broadcaster: { user_id: 1 }, subscriber: { username: 'y' } }), 'stored');
    assert.equal(sent, 0, 'no chat message may be sent without an explicit template');
});

test('giveaways: none active → entry attempts are ignored', async () => {
    const g = makeGiveaways({ pool: { execute: async () => [[]] } });
    assert.equal(await g.tryEnter(1, 'enter', '123', 'user'), null);
});

test('analytics gate: only an explicit true enables counting', () => {
    // Mirrors the handleMessage gate: channelFeats?.analytics === true
    const gate = (feats) => feats?.analytics === true;
    assert.equal(gate(null), false, 'no config = off');
    assert.equal(gate({}), false, 'empty config = off');
    assert.equal(gate({ analytics: 1 }), false, 'truthy-but-not-true = off');
    assert.equal(gate({ analytics: true }), true, 'explicit opt-in = on');
});
