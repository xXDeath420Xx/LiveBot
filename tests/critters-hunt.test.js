import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TIER_KEYS, tierByKey } from '../core/critters/data/tiers.js';
import { SPECIES, speciesInTier, resolveSpecies } from '../core/critters/data/species.js';
import { GEMS, GEM_TYPES, gemById, gemFor } from '../core/critters/data/gems.js';
import { WEAPON_TYPES, PERKS, RANKS, WEAR } from '../core/critters/data/weapons.js';
import { RINGS, LUCK_PRIZES } from '../core/critters/data/economy.js';
import { WALLPAPERS, wallpaperByShopOrId } from '../core/critters/data/wallpapers.js';
import { QUEST_KINDS, rollQuest, PRIZE_KINDS } from '../core/critters/data/quests.js';
import {
    huntCount, luckTierOf, rollCatches, huntCurrency, huntXp, burnGems, parseGemIds, rollLootboxGem, tierWeights, groupCatches, rollLuckPrize,
} from '../core/critters/rules/game-rules.js';
import { generateWeapon, clampQuality, dismantleShards } from '../core/critters/rules/weapon-rules.js';
import { seededRng } from '../core/critters/rules/rng.js';

/*
 * Critters catalog integrity and the hunting / gem / lootbox / weapon generation rules.
 */

const gem = (type, tier, usesLeft = 10) => ({ gemId: gemFor(type, tier).id, usesLeft });

test('catalog: 7 tiers, weights sum to 100, rarer tiers are worth more, every tier has species', () => {
    assert.equal(TIERS.length, 7);
    assert.ok(Math.abs(TIERS.reduce((s, t) => s + t.weight, 0) - 100) < 1e-9);
    assert.ok(TIERS[0].weight > 50, 'the lowest tier dominates rolls');
    for (let i = 1; i < TIERS.length; i++) {
        for (const k of ['points', 'sell', 'essence', 'xp']) assert.ok(TIERS[i][k] > TIERS[i - 1][k], `${TIERS[i].key}.${k}`);
        assert.ok(TIERS[i].weight < TIERS[i - 1].weight);
    }
    for (const t of TIER_KEYS) assert.ok(speciesInTier(t).length >= 2, t);
    const keys = SPECIES.map(s => s.key);
    assert.equal(new Set(keys).size, keys.length, 'unique keys');
    for (const s of SPECIES) {
        assert.ok(tierByKey(s.tier), s.key);
        for (const v of Object.values(s.stats)) assert.ok(Number.isInteger(v) && v >= 1, `${s.key} stats`);
        assert.ok(s.emoji && s.description, s.key);
    }
});

test('species resolve from what members type', () => {
    assert.equal(resolveSpecies(':fox:').key, 'fox');
    assert.equal(resolveSpecies('Ember Fox').key, 'fox');
    assert.equal(resolveSpecies('t-rex').key, 'trex');
    assert.equal(resolveSpecies('red squirrel').key, 'squirrel');
    assert.equal(resolveSpecies('nothing'), null);
});

test('gems: 3 lootable types x 7 tiers, unique ids, stronger tiers last longer and are rarer', () => {
    assert.equal(GEMS.length, 21);
    assert.equal(new Set(GEMS.map(g => g.id)).size, 21);
    for (const t of GEM_TYPES) {
        const list = GEMS.filter(g => g.type === t.key);
        for (let i = 1; i < list.length; i++) {
            assert.ok(list[i].length > list[i - 1].length);
            assert.ok(list[i].weight < list[i - 1].weight);
            assert.ok(list[i].amount >= list[i - 1].amount);
        }
    }
});

test('a hunt with no gems catches exactly one critter from a real tier', () => {
    const rng = seededRng(7);
    assert.equal(huntCount([]), 1);
    for (let i = 0; i < 2000; i++) {
        const [c] = rollCatches(1, 0, rng);
        assert.ok(c && TIER_KEYS.includes(c.tier));
    }
});

test('hunting gem of amount a gives 1+a critters; adding empowering doubles it', () => {
    const trail = gem('trail', 5);
    const a = gemById(trail.gemId).amount;
    assert.equal(huntCount([trail]), 1 + a);
    assert.equal(huntCount([trail, gem('echo', 1)]), 2 * (1 + a));
    assert.equal(huntCount([gem('echo', 1)]), 2);
    assert.equal(huntCount([{ ...trail, usesLeft: 0 }]), 1, 'a gem at 0 uses is inactive');
});

test('a lucky gem raises the share of non-lowest tiers (seeded)', () => {
    const share = (luck) => {
        const rng = seededRng(99);
        let rare = 0;
        const n = 20000;
        for (const c of rollCatches(n, luck, rng)) if (c.tier !== 'common') rare++;
        return rare / n;
    };
    const base = share(0);
    const lucky = share(luckTierOf([gem('clover', 7)]));
    assert.ok(Math.abs(base - 0.38) < 0.02, `base ${base}`);
    assert.ok(lucky > base + 0.2, `lucky ${lucky} vs ${base}`);
    const w = tierWeights(3);
    assert.ok(Math.abs(w[0].weight - TIERS[0].weight / 2.5) < 1e-9);
    assert.ok(Math.abs(w[1].weight - TIERS[1].weight * 2.5) < 1e-9);
});

test('hunt currency is the sum of max(1, floor(points x multiplier)); xp uses reward_xp_multiplier', () => {
    const catches = [SPECIES.find(s => s.tier === 'common'), SPECIES.find(s => s.tier === 'rare')];
    assert.equal(huntCurrency(catches, 1), tierByKey('common').points + tierByKey('rare').points);
    assert.equal(huntCurrency(catches, 0.1), 1 + Math.floor(tierByKey('rare').points * 0.1));
    assert.equal(huntXp(catches, 1), tierByKey('common').xp + tierByKey('rare').xp);
    assert.equal(huntXp(catches, 2), 2 * (tierByKey('common').xp + tierByKey('rare').xp));
    const grouped = groupCatches([catches[1], catches[0], catches[0]]);
    assert.equal(grouped[0].species.tier, 'common');
    assert.equal(grouped[0].count, 2);
    assert.equal(grouped[grouped.length - 1].species.tier, 'rare', 'rarest last');
});

test('gem burn: hunting 1, empowering floor(n/2), lucky n (or floor(n/2) with both others); never below 0', () => {
    const b = (list, n) => Object.fromEntries(burnGems(list, n).map(x => [gemById(x.gemId).type, x.before - x.after]));
    assert.deepEqual(b([gem('trail', 1), gem('clover', 1)], 2), { trail: 1, clover: 2 });
    assert.deepEqual(b([gem('echo', 1), gem('clover', 1)], 4), { echo: 2, clover: 4 });
    assert.deepEqual(b([gem('trail', 1), gem('echo', 1), gem('clover', 1)], 6), { trail: 1, echo: 3, clover: 3 });
    const low = burnGems([gem('clover', 1, 2)], 9);
    assert.equal(low[0].after, 0);
});

test('use: rejects no ids, more than 4, unknown ids and two of one type', () => {
    assert.deepEqual(parseGemIds('11, 21 31'), [11, 21, 31]);
    assert.deepEqual(parseGemIds('11 11'), [11]);
    for (const [input, code] of [['', 'NO_IDS'], ['11 21 31 12 13', 'TOO_MANY'], ['99', 'UNKNOWN_GEM'], ['abc', 'UNKNOWN_GEM'], ['11 12', 'DUPLICATE_TYPE']]) {
        assert.throws(() => parseGemIds(input), (e) => e.code === code, input);
    }
});

test('every lootbox gem is of a lootable type', () => {
    const rng = seededRng(5);
    const types = new Set(GEM_TYPES.map(t => t.key));
    for (let i = 0; i < 3000; i++) assert.ok(types.has(rollLootboxGem(rng).type));
});

test('weapons: quality in the type range, distinct perks, forge pins the rank', () => {
    const rng = seededRng(11);
    for (let i = 0; i < 3000; i++) {
        const w = generateWeapon(rng);
        const type = WEAPON_TYPES.find(t => t.id === w.typeId);
        assert.ok(w.quality >= type.quality[0] && w.quality <= type.quality[1]);
        assert.equal(w.perks.length, type.perkSlots);
        assert.equal(new Set(w.perks.map(p => p.perkId)).size, w.perks.length);
        for (const p of w.perks) {
            const perk = PERKS.find(x => x.id === p.perkId);
            assert.ok(p.quality >= perk.quality[0] && p.quality <= perk.quality[1]);
        }
        assert.ok(WEAR.some(x => x.id === w.wear));
    }
    assert.equal(generateWeapon(rng, { rankId: 7 }).rankId, 7);
    assert.equal(clampQuality(3, 1), 20);
    for (let i = 1; i < RANKS.length; i++) assert.ok(dismantleShards(RANKS[i].id) > dismantleShards(RANKS[i - 1].id));
    assert.equal(RANKS.reduce((s, r) => s + r.weight, 0), 1000);
    assert.equal(WEAR.reduce((s, r) => s + r.weight, 0), 100);
});

test('rings ascend in price, wallpapers map from shop ids, luck prizes and quests are well formed', () => {
    assert.equal(RINGS.length, 7);
    for (let i = 1; i < RINGS.length; i++) assert.ok(RINGS[i].price > RINGS[i - 1].price);
    assert.equal(WALLPAPERS.length, 14);
    assert.equal(wallpaperByShopOrId(203).id, 3);
    assert.equal(wallpaperByShopOrId(3).id, 3);
    assert.equal(wallpaperByShopOrId(299), null);
    assert.equal(LUCK_PRIZES.reduce((s, p) => s + p.weight, 0), 100);
    const rng = seededRng(2);
    for (let i = 0; i < 200; i++) {
        const q = rollQuest(rng);
        assert.ok(QUEST_KINDS[q.kind] && PRIZE_KINDS.includes(q.prize) && q.target > 0 && q.prizeAmount > 0);
    }
    assert.ok(['currency', 'crate'].includes(rollLuckPrize(rng).kind));
});
