import test from 'node:test';
import assert from 'node:assert/strict';
import { guildsToMarkLeft, servedByAnotherClient } from '../core/guild-presence-logic.js';

const MAIN = 'main';

test('a server no bot is in, whose bot is up, is marked left', () => {
    assert.deepEqual(guildsToMarkLeft({
        openGuildIds: ['a', 'b'],
        presentGuildIds: new Set(['a']),
        readyBotIds: new Set([MAIN]),
        mapping: new Map(),
        mainBotId: MAIN,
    }), ['b']);
});

test('a server whose custom bot did not log in this boot is left alone', () => {
    assert.deepEqual(guildsToMarkLeft({
        openGuildIds: ['g'],
        presentGuildIds: new Set(),
        readyBotIds: new Set([MAIN]),
        mapping: new Map([['g', 'custom']]),
        mainBotId: MAIN,
    }), []);
});

test('a server another bot is serving is not left (main bot handed it over)', () => {
    assert.deepEqual(guildsToMarkLeft({
        openGuildIds: ['g'],
        presentGuildIds: new Set(['g']),
        readyBotIds: new Set([MAIN, 'custom']),
        mapping: new Map([['g', 'custom']]),
        mainBotId: MAIN,
    }), []);
});

const client = (ready, ids) => ({ isReady: () => ready, guilds: { cache: new Set(ids) } });

test('guildDelete check: only other READY clients count', () => {
    const leaving = client(true, []);
    const bm = { clients: new Map([['main', leaving], ['bubba', client(true, ['g'])], ['down', client(false, ['h'])]]) };
    assert.equal(servedByAnotherClient(bm, 'g', leaving), true);
    assert.equal(servedByAnotherClient(bm, 'h', leaving), false);
    assert.equal(servedByAnotherClient(bm, 'x', leaving), false);
    assert.equal(servedByAnotherClient(undefined, 'g'), false);
});
