// Pure rules behind the OwO social/economy ports (core/owo/social-math.js): give caps, lottery
// draw + chance, marriage bonus, pray deltas, battle settings/frames, shop ids, wallpaper colours.
// Run: node --test tests/owo-social.test.js  (no database or discord.js needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    prayDeltas, giveLimitsForLevel, usedToday, checkAllowance, isNewDay, lastMidnight, nextMidnight,
    lotteryAddable, winChance, pickWeightedWinner, LOTTERY_MAX_BET,
    marriageBonus, sortPair, ringSellPrice, RINGS,
    normalizeBattleSettings, parseBattleSetting, battleFrames,
    resolveShopId, parseColorList, rgbaFromNameColor, colorInt, seededRandom, untilMidnightText,
} from '../core/owo/social-math.js';

test('pray / curse deltas match upstream', () => {
    assert.deepEqual(prayDeltas('pray', false), { author: 1, target: 0 });
    assert.deepEqual(prayDeltas('pray', true), { author: -1, target: 1 });
    assert.deepEqual(prayDeltas('curse', false), { author: -1, target: 0 });
    assert.deepEqual(prayDeltas('curse', true), { author: 1, target: -1 });
    assert.throws(() => prayDeltas('hex', true));
});

test('give limits follow upstream getUserLimits', () => {
    assert.deepEqual(giveLimitsForLevel(0), { send: 50000, receive: 50000 });
    assert.deepEqual(giveLimitsForLevel(5), { send: 120000, receive: 120000 });
    // level 10: 50k + 140k + 5M = 5.19M; receive x1.5
    assert.deepEqual(giveLimitsForLevel(10), { send: 5190000, receive: 7785000 });
    assert.deepEqual(giveLimitsForLevel(-3), giveLimitsForLevel(0));
    assert.deepEqual(giveLimitsForLevel('abc'), giveLimitsForLevel(0));
});

test('usage resets at midnight', () => {
    const now = new Date(2026, 9, 5, 15, 0, 0);
    const earlierToday = new Date(2026, 9, 5, 1, 0, 0);
    const yesterday = new Date(2026, 9, 4, 23, 59, 0);
    assert.equal(usedToday({ send: 500, receive: 9, reset: earlierToday }, 'send', now), 500);
    assert.equal(usedToday({ send: 500, receive: 9, reset: yesterday }, 'send', now), 0);
    assert.equal(usedToday(null, 'receive', now), 0);
    assert.equal(isNewDay(null, now), true);
    assert.equal(isNewDay(earlierToday, now), false);
    assert.equal(isNewDay('not a date', now), true);
    assert.equal(nextMidnight(now) - lastMidnight(now), 86_400_000);
    assert.match(untilMidnightText(now), /^9H 0M 0S$/);
});

test('allowance check', () => {
    assert.deepEqual(checkAllowance({ used: 40000, amount: 10000, limit: 50000 }), { ok: true, remaining: 10000 });
    assert.deepEqual(checkAllowance({ used: 40000, amount: 10001, limit: 50000 }), { ok: false, remaining: 10000 });
    assert.deepEqual(checkAllowance({ used: 60000, amount: 1, limit: 50000 }), { ok: false, remaining: 0 });
});

test('lottery: how much can be added this round', () => {
    assert.equal(lotteryAddable({ requested: 1000, prevBet: 0, balance: 5000 }), 1000);
    assert.equal(lotteryAddable({ requested: 1000, prevBet: LOTTERY_MAX_BET - 300, balance: 5000 }), 300);
    assert.equal(lotteryAddable({ requested: null, prevBet: 0, balance: 7000 }), 7000);       // "all"
    assert.equal(lotteryAddable({ requested: null, prevBet: 0, balance: 900000 }), LOTTERY_MAX_BET);
    assert.equal(lotteryAddable({ requested: 10, prevBet: LOTTERY_MAX_BET, balance: 5000 }), 0);
    assert.equal(lotteryAddable({ requested: 5000, prevBet: 0, balance: 100 }), 100);
});

test('lottery chance is truncated like upstream', () => {
    assert.equal(winChance(1, 3), 33.33);
    assert.equal(winChance(500, 500), 100);
    assert.equal(winChance(0, 0), 0);
    assert.equal(winChance(10, 0), 100);
    assert.ok(winChance(1, 1_000_000) < 0.01);
});

test('weighted draw: each cowoncy is one ticket', () => {
    const entries = [{ id: 'a', amount: 1 }, { id: 'b', amount: 3 }, { id: 'c', amount: 0 }];
    // tickets: a = [0], b = [1,2,3]; rand() * 4 floors onto those
    assert.equal(pickWeightedWinner(entries, () => 0).id, 'a');
    assert.equal(pickWeightedWinner(entries, () => 0.24).id, 'a');
    assert.equal(pickWeightedWinner(entries, () => 0.25).id, 'b');
    assert.equal(pickWeightedWinner(entries, () => 0.9999).id, 'b');
    assert.equal(pickWeightedWinner([], () => 0.5), null);
    assert.equal(pickWeightedWinner([{ id: 'x', amount: 0 }], () => 0.5), null);
    // distribution sanity: b should win ~75%
    let bWins = 0;
    const rnd = seededRandom(42);
    for (let i = 0; i < 20000; i++) if (pickWeightedWinner(entries, rnd).id === 'b') bWins++;
    assert.ok(bWins > 14500 && bWins < 15500, `b won ${bWins}`);
});

test('marriage bonus: 100-199 + 12.5 per streak day, capped at 1000', () => {
    assert.equal(marriageBonus(0, () => 0), 100);
    assert.equal(marriageBonus(0, () => 0.999), 199);
    assert.equal(marriageBonus(10, () => 0), 225);
    assert.equal(marriageBonus(500, () => 0.5), 1000);
});

test('pairs sort numerically, not as strings', () => {
    assert.deepEqual(sortPair('99999999999999999', '100000000000000000'), ['99999999999999999', '100000000000000000']);
    assert.deepEqual(sortPair('200000000000000000', '100000000000000000'), ['100000000000000000', '200000000000000000']);
});

test('rings', () => {
    assert.equal(Object.keys(RINGS).length, 7);
    assert.equal(RINGS[1].price, 10);
    assert.equal(RINGS[7].price, 10_000_000);
    assert.equal(ringSellPrice(3), 750);
    assert.equal(ringSellPrice(99), 0);
});

test('battle settings parse + defaults', () => {
    assert.deepEqual(normalizeBattleSettings(null), { display: 'text', speed: 'instant', logs: false });
    assert.deepEqual(normalizeBattleSettings({ display: 'compact', speed: 2, logs: 1 }), { display: 'compact', speed: 'lengthy', logs: true });
    assert.deepEqual(normalizeBattleSettings({ display: 'image', speed: 9, logs: 0 }), { display: 'text', speed: 'instant', logs: false });
    assert.deepEqual(parseBattleSetting('display=compact'), { field: 'display', value: 'compact' });
    assert.deepEqual(parseBattleSetting('speed = short'), { field: 'speed', value: 1 });
    assert.deepEqual(parseBattleSetting('logs=true'), { field: 'logs', value: 1 });
    assert.deepEqual(parseBattleSetting('log:false'), { field: 'logs', value: 0 });
    assert.ok(parseBattleSetting('display=image').error);
    assert.ok(parseBattleSetting('volume=11').error);
    assert.ok(parseBattleSetting('').error);
});

test('battle frames replay turn by turn and end on the full log', () => {
    const log = ['header', '', '**Turn 1**', 'a', '', '**Turn 2**', 'b', '', '**Turn 3**', 'c', 'end'];
    assert.deepEqual(battleFrames(log, 'instant'), [log]);
    const short = battleFrames(log, 'short');
    assert.equal(short.length, 2);
    assert.deepEqual(short.at(-1), log);
    const lengthy = battleFrames(log, 'lengthy');
    assert.ok(lengthy.length >= 2 && lengthy.length <= 5);
    assert.deepEqual(lengthy.at(-1), log);
    for (let i = 1; i < lengthy.length; i++) assert.ok(lengthy[i].length >= lengthy[i - 1].length);
});

test('shop ids: 1-7 rings, 200+n wallpapers', () => {
    assert.deepEqual(resolveShopId(3), { kind: 'ring', rid: 3 });
    assert.deepEqual(resolveShopId('203'), { kind: 'wallpaper', bid: 3 });
    assert.equal(resolveShopId(8), null);
    assert.equal(resolveShopId(200), null);
    assert.equal(resolveShopId(0), null);
    assert.equal(resolveShopId('x'), null);
});

test('wallpaper colours', () => {
    assert.deepEqual(parseColorList('#112233, #AABBCC,bad'), ['#112233', '#AABBCC']);
    assert.deepEqual(parseColorList(''), ['#2c2f33']);
    assert.equal(rgbaFromNameColor('255,255,255,255'), 'rgba(255,255,255,1)');
    assert.equal(rgbaFromNameColor('40,40,40,128'), 'rgba(40,40,40,0.5)');
    assert.equal(rgbaFromNameColor(null), 'rgba(255,255,255,1)');
    assert.equal(colorInt('#ff0000'), 0xff0000);
    const a = seededRandom(7); const b = seededRandom(7);
    assert.equal(a(), b());
});
