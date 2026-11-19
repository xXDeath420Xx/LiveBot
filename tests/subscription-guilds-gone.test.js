import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionGuildsGone } from '../core/guild-presence-logic.js';

const MAIN = 'main';
const base = (o) => ({
    subGuildIds: ['g'], guildRows: new Map(), presentGuildIds: new Set(), readyBotIds: new Set([MAIN]),
    mapping: new Map(), knownBotIds: new Set(['custom']), mainBotId: MAIN, ...o,
});

test('a server some ready bot has is never gone, even with a stale left_at', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ presentGuildIds: new Set(['g']), guildRows: new Map([['g', { left_at: new Date() }]]) })), []);
});

test('guild presence already recorded the server left', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ guildRows: new Map([['g', { left_at: new Date() }]]) })), ['g']);
});

test('no guilds row at all and the main bot is up without it (deleted server)', () => {
    assert.deepEqual(subscriptionGuildsGone(base()), ['g']);
});

test('mapped custom bot did not log in this boot: left alone', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ mapping: new Map([['g', 'custom']]), guildRows: new Map([['g', { left_at: null }]]) })), []);
});

test('mapped custom bot is up and does not have it: gone', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ mapping: new Map([['g', 'custom']]), readyBotIds: new Set([MAIN, 'custom']), guildRows: new Map([['g', { left_at: null }]]) })), ['g']);
});

test('mapped bot was deleted from our system: main bot stands in (DabFam case)', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ mapping: new Map([['g', 'deleted-bot']]), guildRows: new Map([['g', { left_at: null }]]) })), ['g']);
});

test('main bot not ready: says nothing about unmapped servers', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ readyBotIds: new Set(['custom']) })), []);
});

test('duplicate guild ids are reported once', () => {
    assert.deepEqual(subscriptionGuildsGone(base({ subGuildIds: ['g', 'g'] })), ['g']);
});
