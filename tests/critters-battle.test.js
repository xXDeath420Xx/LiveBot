import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveCombatant, simulateBattle, applyRecord, generateCpuTeam, parseSettingsText, parseSettingValue, splitLogFrames,
} from '../core/critters/rules/battle-engine.js';
import {
    bossStats, bossPayouts, simulateBossStrike, pickBossSpecies, rollBossLevel, pickLotteryWinner, lotteryEntryAmount, winChancePct,
    orderPair, prayDeltas, hpBar,
} from '../core/critters/rules/misc-rules.js';
import { speciesByKey } from '../core/critters/data/species.js';
import { tierIndex, BOSS_TIERS } from '../core/critters/data/tiers.js';
import { seededRng } from '../core/critters/rules/rng.js';

/*
 * The live battle maths (spec 4.2 / 4.3), CPU teams, battle settings, guild boss and lottery rules.
 */

const sp = (k) => speciesByKey(k);
const team = (...keys) => keys.map(k => deriveCombatant({ species: sp(k) }));

test('combatant stats follow the live formulas', () => {
    const fox = sp('fox');
    const bare = deriveCombatant({ species: fox });
    assert.equal(bare.atk, 2 * fox.stats.atk + 1);
    assert.equal(bare.maxHp, 50 * fox.stats.hp + 100);
    assert.equal(bare.def, fox.stats.pr + fox.stats.mr);
    // Epic (bonus 20), quality 41 (+10), wear 3 (x1.15), perks 15 and 8 (+7, +4), physical type.
    const armed = deriveCombatant({ species: fox, weapon: { uwid: 5, typeId: 3, rankId: 4, quality: 41, wear: 3, perks: [{ quality: 15 }, { quality: 8 }] } });
    assert.equal(armed.atk, Math.floor((bare.atk + 20 + 10) * 1.15) + 7 + 4);
    assert.equal(armed.maxHp, bare.maxHp + 10);
    assert.equal(armed.def, bare.def);
    const magic = deriveCombatant({ species: fox, weapon: { uwid: 6, typeId: 2, rankId: 1, quality: 0, wear: 1, perks: [] } });
    assert.equal(magic.def, bare.def + fox.stats.wp, 'magic weapons add willpower to defence');
});

test('an empty side loses immediately with zero turns', () => {
    const r = simulateBattle([], team('fox'), { rng: seededRng(1) });
    assert.equal(r.winner, 'team2');
    assert.equal(r.turns, 0);
    assert.equal(simulateBattle(team('fox'), [], { rng: seededRng(1) }).winner, 'team1');
    assert.equal(simulateBattle([], [], { rng: seededRng(1) }).winner, 'draw');
});

test('damage is never below 1, HP stays in [0, max], at most 20 turns (many seeded battles, every weapon type)', () => {
    for (let seed = 1; seed <= 300; seed++) {
        const rng = seededRng(seed);
        const mk = (k, typeId) => deriveCombatant({ species: sp(k), weapon: typeId ? { uwid: seed * 10 + typeId, typeId, rankId: 1 + (seed % 7), quality: seed % 100, wear: 1 + (seed % 4), perks: [] } : null });
        const A = [mk('fox', 1 + (seed % 18)), mk('owl', 1 + ((seed + 5) % 18)), mk('otter', 0)];
        const B = [mk('sloth', 1 + ((seed + 9) % 18)), mk('wolf', 0), mk('beaver', 1 + ((seed + 13) % 18))];
        const r = simulateBattle(A, B, { rng });
        assert.ok(r.turns >= 1 && r.turns <= 20);
        for (const side of ['team1', 'team2']) for (const u of r.final[side]) assert.ok(u.hp >= 0 && u.hp <= u.maxHp, `seed ${seed}`);
        for (const line of r.log) {
            const m = line.match(/ for (-?\d+)/);
            if (m) assert.ok(Number(m[1]) >= 1, `seed ${seed}: ${line}`);
        }
    }
});

test('turn cap: two walls that cannot finish each other stop at 20 turns and are judged on margin', () => {
    const wall = (hp) => ({ pid: 0, speciesKey: 'x', tier: 'common', emoji: '', name: 'Wall', level: 1, atk: 1, def: 0, maxHp: hp, uwid: 0, effect: 'none' });
    const r = simulateBattle([wall(100000)], [wall(90000)], { rng: seededRng(4) });
    assert.equal(r.turns, 20);
    assert.equal(r.onMargin, true);
    assert.equal(r.winner, 'team1', 'equal survivors -> more remaining HP');
    const d = simulateBattle([wall(100000)], [wall(100000)], { rng: () => 0 });
    assert.equal(d.winner, 'draw');
    assert.equal(d.onMargin, false);
    const more = simulateBattle([wall(100000), wall(100000)], [wall(1e9)], { rng: () => 0 });
    assert.equal(more.winner, 'team1', 'more survivors wins before HP');
});

test('kill tallies only count weapons with uwid > 0', () => {
    const glass = (uwid) => ({ pid: 0, speciesKey: 'x', tier: 'common', emoji: '', name: 'G', level: 1, atk: 500, def: 0, maxHp: 10, uwid, effect: 'none' });
    const tank = { ...glass(42), maxHp: 1e6 };
    const r = simulateBattle([tank], [glass(0), glass(0)], { rng: seededRng(8) });
    assert.equal(r.winner, 'team1');
    assert.deepEqual(r.kills, [{ side: 'team1', uwid: 42, kills: 2 }]);
    const r2 = simulateBattle([glass(0)], [glass(7)], { rng: seededRng(8) });
    assert.ok(r2.kills.every(k => k.uwid > 0));
});

test('win / loss records: win+1 streak+1 best=max; loss resets the streak; draws change nothing', () => {
    const t = { wins: 2, losses: 1, streak: 2, bestStreak: 5 };
    assert.deepEqual(applyRecord(t, 'win'), { wins: 3, losses: 1, streak: 3, bestStreak: 5 });
    assert.deepEqual(applyRecord({ ...t, streak: 5 }, 'win'), { wins: 3, losses: 1, streak: 6, bestStreak: 6 });
    assert.deepEqual(applyRecord(t, 'loss'), { wins: 2, losses: 2, streak: 0, bestStreak: 5 });
    assert.deepEqual(applyRecord(t, 'draw'), t);
});

test('CPU team: same size as the player team, tiers at most one above the player average', () => {
    const rng = seededRng(21);
    for (let i = 0; i < 300; i++) {
        const player = i % 2 ? team('ant', 'worm') : team('fox', 'owl', 'otter');
        const cpu = generateCpuTeam(player, rng);
        assert.equal(cpu.members.length, player.length);
        const avg = Math.round(player.reduce((s, c) => s + tierIndex(c.tier), 0) / player.length);
        for (const m of cpu.members) assert.ok(tierIndex(m.tier) <= avg + 1);
        assert.ok(cpu.name.length > 0);
    }
});

test('battle settings parse names and numbers and reject bad values', () => {
    assert.deepEqual(parseSettingsText('display=compact speed=short logs=on'), { display: 'compact', speed: 1, logs: true });
    assert.deepEqual(parseSettingsText('speed:2 logs:off'), { speed: 2, logs: false });
    assert.deepEqual(parseSettingsText(''), {});
    assert.throws(() => parseSettingValue('display', 'image'), (e) => e.code === 'UNAVAILABLE');
    assert.throws(() => parseSettingsText('colour=red'), (e) => e.code === 'BAD_NAME');
    assert.throws(() => parseSettingsText('speed=9'), (e) => e.code === 'BAD_VALUE');
    assert.throws(() => parseSettingsText('compact'), (e) => e.code === 'BAD_SYNTAX');
});

test('frames: short shows one intermediate frame, lengthy up to four, all cut at turn boundaries', () => {
    const log = ['header'];
    for (let t = 1; t <= 12; t++) log.push(`Turn ${t}`, `hit ${t}`);
    assert.equal(splitLogFrames(log, 0).length, 0);
    assert.equal(splitLogFrames(log, 1).length, 1);
    const long = splitLogFrames(log, 2);
    assert.ok(long.length >= 2 && long.length <= 4);
    for (const f of [...splitLogFrames(log, 1), ...long]) assert.match(log[f.length], /^Turn \d+$/);
});

test('boss: stats, species tiers, level range, strike damage >= 1, payouts (min 50, +15% to the top dealer)', () => {
    assert.deepEqual(bossStats(10), { maxHp: 19000, attack: 220 });
    const rng = seededRng(13);
    for (let i = 0; i < 500; i++) {
        assert.ok(BOSS_TIERS.includes(pickBossSpecies(rng).tier));
        const l = rollBossLevel(rng);
        assert.ok(l >= 1 && l <= 100);
        const s = simulateBossStrike(team('ant'), bossStats(l).attack, rng);
        assert.ok(s.damage >= 1 && s.teamHpLeft >= 0);
    }
    const pay = bossPayouts(10, [{ userId: 'a', damage: 9000 }, { userId: 'b', damage: 1000 }, { userId: 'c', damage: 0 }]);
    const pool = 500 * 10 + 2000;
    assert.equal(pay[0].payout, Math.round(pool * 0.9) + Math.round(pool * 0.15));
    assert.equal(pay[0].top, true);
    assert.equal(pay[1].payout, Math.round(pool * 0.1));
    assert.equal(pay[2].payout, 50);
    assert.equal(hpBar(50, 100).length, 16);
});

test('lottery: entries trimmed by the cap; each acorn is one ticket; chance truncated to 2 decimals', () => {
    assert.deepEqual(lotteryEntryAmount({ requested: 500, balance: 1000, current: 900, cap: 1000 }), { add: 100, trimmed: true, room: 100 });
    assert.equal(lotteryEntryAmount({ all: true, balance: 300, current: 0, cap: 1000 }).add, 300);
    assert.equal(lotteryEntryAmount({ requested: 50, balance: 10, current: 0, cap: 1000 }).add, 10);
    const entries = [{ userId: 'a', amount: 1 }, { userId: 'b', amount: 3 }];
    assert.equal(pickLotteryWinner(entries, () => 0).userId, 'a');
    assert.equal(pickLotteryWinner(entries, () => 0.25).userId, 'b');
    assert.equal(pickLotteryWinner(entries, () => 0.999).userId, 'b');
    const rng = seededRng(17);
    let a = 0;
    for (let i = 0; i < 40000; i++) if (pickLotteryWinner(entries, rng).userId === 'a') a++;
    assert.ok(Math.abs(a / 40000 - 0.25) < 0.01);
    assert.equal(winChancePct(1, 3), 33.33);
});

test('pairs order numerically as big integers; pray / curse deltas', () => {
    assert.deepEqual(orderPair('99999999999999999', '100000000000000000'), ['99999999999999999', '100000000000000000']);
    assert.deepEqual(orderPair('200000000000000002', '200000000000000001'), ['200000000000000001', '200000000000000002']);
    assert.deepEqual(prayDeltas('pray', 'a', null), { self: 1, target: 0, targetId: null });
    assert.deepEqual(prayDeltas('pray', 'a', 'a'), { self: 1, target: 0, targetId: null });
    assert.deepEqual(prayDeltas('pray', 'a', 'b'), { self: -1, target: 1, targetId: 'b' });
    assert.deepEqual(prayDeltas('curse', 'a', null), { self: -1, target: 0, targetId: null });
    assert.deepEqual(prayDeltas('curse', 'a', 'b'), { self: 1, target: -1, targetId: 'b' });
});
