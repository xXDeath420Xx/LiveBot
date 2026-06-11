import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchResponder, makeLoadResponders } from '../../services/certifried-bot/auto-responder.js';

const R = (id, trigger_text, match_type, cooldown = 10) => ({ id, trigger_text, match_type, response: 'hi', cooldown });

test('contains match fires', () => {
    const hit = matchResponder([R(1, 'discord', 'contains')], 'whats your discord?', new Map(), 1000);
    assert.equal(hit?.id, 1);
});

test('exact match only fires on exact message', () => {
    const rs = [R(1, '!social', 'exact')];
    assert.equal(matchResponder(rs, '!social', new Map(), 1000)?.id, 1);
    assert.equal(matchResponder(rs, 'check !social pls', new Map(), 1000), null);
});

test('word match fires on a whole word, not a substring', () => {
    const rs = [R(1, 'gg', 'word')];
    assert.equal(matchResponder(rs, 'that was gg', new Map(), 1000)?.id, 1);
    assert.equal(matchResponder(rs, 'ggéant', new Map(), 1000), null);
});

test('starts match', () => {
    assert.equal(matchResponder([R(1, 'hello', 'starts')], 'hello there', new Map(), 1000)?.id, 1);
    assert.equal(matchResponder([R(1, 'hello', 'starts')], 'oh hello', new Map(), 1000), null);
});

test('is case-insensitive', () => {
    assert.equal(matchResponder([R(1, 'Discord', 'contains')], 'JOIN THE DISCORD', new Map(), 1000)?.id, 1);
});

test('respects cooldown — does not fire again within the window', () => {
    const rs = [R(1, 'discord', 'contains', 10)]; // 10s cooldown
    const lastFired = new Map([[1, 5000]]);       // fired at t=5000ms
    assert.equal(matchResponder(rs, 'discord', lastFired, 9000), null,  'within 10s window → no fire');
    assert.equal(matchResponder(rs, 'discord', lastFired, 16000)?.id, 1, 'after 10s window → fires');
});

test('first matching responder wins; no match → null', () => {
    const rs = [R(1, 'discord', 'contains'), R(2, 'youtube', 'contains')];
    // only the 2nd trigger is present → responder 2 fires
    assert.equal(matchResponder(rs, 'check my youtube', new Map(), 1000)?.id, 2);
    // both present → first in the list wins
    assert.equal(matchResponder(rs, 'discord and youtube', new Map(), 1000)?.id, 1);
    // neither → null
    assert.equal(matchResponder(rs, 'nothing relevant', new Map(), 1000), null);
});

test('blank message or blank trigger never fires', () => {
    assert.equal(matchResponder([R(1, 'x', 'contains')], '', new Map(), 1000), null);
    assert.equal(matchResponder([R(1, '', 'contains')], 'anything', new Map(), 1000), null);
});

test('loadResponders queries enabled responders for the channel PK', async () => {
    let captured;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[{ id: 1 }]]; } };
    const load = makeLoadResponders({ pool });
    const rows = await load(42);
    assert.equal(rows.length, 1);
    assert.match(captured.sql, /FROM tokes_auto_responders/);
    assert.match(captured.sql, /is_enabled = 1/);
    assert.deepEqual(captured.params, [42]);
});
