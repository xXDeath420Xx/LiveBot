// H-315: a feed is polled by the one bot that serves its server, and by nobody when no bot is in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pollsGuild } from '../core/guild-presence-logic.js';

const client = (...guilds) => ({ guilds: { cache: new Map(guilds.map(g => [g, {}])) } });

test('a server the bot is not in is never polled by it', () => {
    assert.equal(pollsGuild(client('a'), 'gone', null), false);
    assert.equal(pollsGuild(client(), 'gone', { getClientForGuild: () => client() }), false);
});

test('without a bot manager, being in the server is enough', () => {
    assert.equal(pollsGuild(client('a'), 'a', null), true);
});

test('when two bots share a server, only the one the bot manager picks polls it', () => {
    const main = client('a');
    const custom = client('a');
    const bm = { getClientForGuild: () => custom };
    assert.equal(pollsGuild(custom, 'a', bm), true);
    assert.equal(pollsGuild(main, 'a', bm), false);
});

test('a bot manager that answers with the fallback main bot does not make it poll a server it is not in', () => {
    const main = client('x');
    assert.equal(pollsGuild(main, 'gone', { getClientForGuild: () => main }), false);
});
