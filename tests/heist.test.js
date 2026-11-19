import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TARGETS, MIN_CREW, getTarget, maxStake, successChance, payoutFor, stakeError, decideOutcome, cooldownMinutesLeft,
} from '../core/heist-odds.js';

/*
 * Heist odds decide who wins money, so the curve is pinned down here: a minimum crew should be a
 * losing bet on every target, a full well-funded crew a modest winning one, and nothing may ever
 * leave [0.05, 0.85].
 */

test('every target is known and ordered by risk', () => {
    const order = ['easy', 'medium', 'hard', 'extreme'];
    let lastBase = 1;
    let lastMult = 0;
    for (const key of order) {
        const t = getTarget(key);
        assert.ok(t, key);
        assert.ok(t.base < lastBase, `${key} base falls`);
        assert.ok(t.multiplier > lastMult, `${key} multiplier rises`);
        lastBase = t.base;
        lastMult = t.multiplier;
    }
    assert.equal(getTarget('nope'), null);
});

test('minimum crew is negative EV on every target; a full funded crew is positive but bounded', () => {
    for (const t of Object.values(TARGETS)) {
        const small = successChance(t, MIN_CREW, 0, t.recommendedTotal);
        assert.ok(small * t.multiplier < 1, `${t.key} min crew EV ${small * t.multiplier}`);
        const big = successChance(t, 10, 25, t.recommendedTotal);
        const ev = big * t.multiplier;
        assert.ok(ev > 1.15 && ev <= 1.21, `${t.key} full crew EV ${ev}`);
    }
});

test('crew bonus caps at 5 extra members', () => {
    const t = TARGETS.medium;
    assert.equal(successChance(t, 7, 0, 1e9), successChance(t, 10, 0, 1e9));
    assert.ok(successChance(t, 6, 0, 1e9) < successChance(t, 7, 0, 1e9));
});

test('level bonus caps at +0.05 (scaled) and underfunding costs up to 0.10 (scaled)', () => {
    for (const t of [TARGETS.easy, TARGETS.hard]) {
        const base = successChance(t, 2, 0, t.recommendedTotal);
        assert.equal(successChance(t, 2, 25, t.recommendedTotal), Math.round((base + 0.05 * t.bonusFactor) * 10000) / 10000);
        assert.equal(successChance(t, 2, 500, t.recommendedTotal), successChance(t, 2, 25, t.recommendedTotal));
        assert.equal(successChance(t, 2, 0, 0), Math.round((base - 0.10 * Math.max(t.bonusFactor, 0.5)) * 10000) / 10000);
    }
});

test('chance is clamped to [0.05, 0.85]', () => {
    const fake = { base: 2, bonusFactor: 1, recommendedTotal: 1 };
    assert.equal(successChance(fake, 10, 100, 1), 0.85);
    const bad = { base: -1, bonusFactor: 1, recommendedTotal: 1000 };
    assert.equal(successChance(bad, 2, 0, 0), 0.05);
});

test('payout floors stake x multiplier', () => {
    assert.equal(payoutFor(333, 1.6), 532);
    assert.equal(payoutFor(100, 5.5), 550);
});

test('stake limits per target', () => {
    const t = TARGETS.easy;
    assert.equal(maxStake(t), 1000);
    assert.match(stakeError(t, 49), /minimum/);
    assert.match(stakeError(t, 1001), /maximum/);
    assert.match(stakeError(t, 1.5), /whole number/);
    assert.equal(stakeError(t, 50), null);
    assert.equal(stakeError(t, 1000), null);
});

test('outcome: roll below chance succeeds', () => {
    assert.equal(decideOutcome(0.4, 0.39999), true);
    assert.equal(decideOutcome(0.4, 0.4), false);
});

test('cooldown minutes left', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    assert.equal(cooldownMinutesLeft(null, 60, now), 0);
    assert.equal(cooldownMinutesLeft(new Date(now - 30 * 60_000), 60, now), 30);
    assert.equal(cooldownMinutesLeft(new Date(now - 59.5 * 60_000), 60, now), 1);
    assert.equal(cooldownMinutesLeft(new Date(now - 61 * 60_000), 60, now), 0);
});
