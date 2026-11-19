// Chat routing + battle kill tally for the OwO social/economy ports.
// Imports modules that load utils/db.js and discord.js, so run it on the server (node_modules present):
//   node --test tests/owo-social-routing.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseOwo, _internals } from '../core/owo-natural-prefix.js';
import { simulateBattle } from '../core/owo/battle-engine.js';

after(() => setTimeout(() => process.exit(0), 50).unref());

const route = (text) => parseOwo(text).subcommand;

test('upstream aliases reach the new commands', () => {
    assert.equal(route('owo pray'), 'pray');
    assert.equal(route('owo curse @x'), 'curse');
    assert.equal(route('owo rep'), 'cookie');
    assert.equal(route('owo cookie'), 'cookie');
    assert.equal(route('owo lotto 500'), 'lottery');
    assert.equal(route('owo bet all'), 'lottery');
    assert.equal(route('owo drop 100'), 'drop');
    assert.equal(route('owo pickup 100'), 'pickup');
    assert.equal(route('owo propose'), 'marry');
    assert.equal(route('owo wife'), 'marry');
    assert.equal(route('owo am'), 'acceptmarriage');
    assert.equal(route('owo dm'), 'declinemarriage');
    assert.equal(route('owo divorce'), 'divorce');
    assert.equal(route('owo wp 203'), 'wallpaper');
    assert.equal(route('owo shop'), 'shop');
    assert.equal(route('owo buy 3'), 'buy');
    assert.equal(route('owo bs display=compact'), 'battlesetting');
    assert.equal(route('owo ab'), 'ab');
    assert.equal(route('owo db'), 'db');
    assert.equal(route('owo profile'), 'profile');
    // unchanged
    assert.equal(route('owo me'), 'stats');
    assert.equal(route('owo top cookie'), 'leaderboard');
    assert.equal(route('owo lb'), 'lootbox');
});

test('natural args carry the whole argument string', () => {
    const { subcommand, rest } = parseOwo('owo b <@123456789012345678> 500');
    const args = _internals.buildArgs(subcommand, rest);
    assert.equal(args.natural, '1');
    assert.equal(args.text, '<@123456789012345678> 500');
    assert.equal(args.amount, '500');
    assert.equal(args.user, '<@123456789012345678>');
});

test('battle engine tallies kills per saved weapon only', () => {
    const team = (uwidBase) => ({
        pgid: 1, tname: 'T',
        animals: [1, 2, 3].map(i => ({
            pos: i, name: ':bee:', nickname: null, rank: 'common', xp: 0,
            stats: { hp: 1, att: 9, pr: 1, wp: 1, mag: 1, mr: 1 },
            weapon: uwidBase === null ? null
                : { uwid: uwidBase ? uwidBase + i : 0, name: 'Sword', emoji: '🗡️', rank: 'Epic', stat: 50, wearId: 2, passives: [] },
        })),
    });
    const r = simulateBattle(team(100), team(0)); // enemy weapons are CPU-style (uwid 0)
    const total = r.kills.reduce((s, k) => s + k.count, 0);
    const deadEnemies = r.finalState.team2.filter(a => !a.alive).length;
    assert.ok(r.kills.every(k => k.uwid > 100 && k.side === 'team1'));
    assert.equal(total, deadEnemies);
    const none = simulateBattle(team(null), team(null));
    assert.deepEqual(none.kills, []);
});
