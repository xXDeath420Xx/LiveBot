import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONFIG_DEFAULTS, FEATURE_KEYS, normalizeConfig, applyConfigPatch, checkGates, featureKeyForPath, mapLegacyFeatureKeys, configToRow,
} from '../core/critters/rules/config-rules.js';
import { dailyState, decideDailyDrop, autohuntQueue, ranchHours, ranchRate } from '../core/critters/rules/game-rules.js';
import { lastLocalMidnight, nextLocalMidnight, isBeforeToday } from '../core/critters/rules/time.js';
import { dailyPayout, DAILY, sendCap, receiveCap, petLevel, xpForLevel, coupleBonusAmount, COUPLE_BONUS } from '../core/critters/data/economy.js';
import { seededRng } from '../core/critters/rules/rng.js';
import { CURRENCY, formatAcorns, STARTING_BALANCE } from '../core/critters/constants.js';

/*
 * Critters config, gates and the time-based economy rules (daily, drops, autohunt, ranch, give caps).
 * Pure functions only: no database.
 */

const H = 3600 * 1000;

test('currency is defined once with a non-legacy name and a formatMoney-shaped meta', () => {
    assert.equal(CURRENCY.name, 'acorns');
    assert.notEqual(CURRENCY.name.toLowerCase(), 'cowoncy');
    assert.deepEqual(Object.keys(CURRENCY.meta).sort(), ['currency_emoji', 'currency_name']);
    assert.equal(formatAcorns(1), `${CURRENCY.emoji} 1 acorn`);
    assert.equal(formatAcorns(1500), `${CURRENCY.emoji} 1,500 acorns`);
    assert.equal(STARTING_BALANCE, 15000);
});

test('no config row reads as the defaults: module off', () => {
    const c = normalizeConfig(null);
    assert.equal(c.enabled, false);
    assert.equal(c.hunt_cooldown_seconds, 15);
    assert.equal(c.sell_multiplier, 0.5);
    assert.deepEqual(c.disabled_subcommands, []);
    assert.deepEqual(checkGates(c), { ok: false, code: 'DISABLED' });
});

test('config patch clamps numbers, sanitises arrays, ignores unknown keys and keeps unspecified ones', () => {
    const base = normalizeConfig({ ...CONFIG_DEFAULTS, enabled: 1, reward_xp_multiplier: 2 });
    const next = applyConfigPatch(base, {
        hunt_cooldown_seconds: 0, reward_currency_multiplier: 50, sell_multiplier: 0.01,
        disabled_subcommands: ['hunt', 'nonsense', 'hunt', 'boss'], allowed_channel_ids: ['123456789012345678', 'abc', '12'],
        blocked_role_ids: '["123456789012345679"]', unknown_key: 5,
    });
    assert.equal(next.hunt_cooldown_seconds, 1);
    assert.equal(next.reward_currency_multiplier, 10);
    assert.equal(next.sell_multiplier, 0.1);
    assert.equal(next.reward_xp_multiplier, 2, 'unspecified key unchanged');
    assert.deepEqual(next.disabled_subcommands, ['hunt', 'boss']);
    assert.deepEqual(next.allowed_channel_ids, ['123456789012345678']);
    assert.deepEqual(next.blocked_role_ids, ['123456789012345679']);
    assert.equal(applyConfigPatch(base, { hunt_cooldown_seconds: 99999 }).hunt_cooldown_seconds, 3600);
    assert.throws(() => applyConfigPatch(base, { sell_multiplier: 'cheap' }), /must be a number/);
    assert.throws(() => applyConfigPatch(base, { hunt_cooldown_seconds: null }), /must be a number/);
    const row = configToRow(next);
    assert.equal(row.disabled_subcommands, '["hunt","boss"]');
});

test('NULL JSON arrays (legacy rows) read as empty arrays', () => {
    const c = normalizeConfig({ enabled: 1, disabled_subcommands: null, allowed_channel_ids: null, blocked_role_ids: 'not json' });
    assert.deepEqual(c.disabled_subcommands, []);
    assert.deepEqual(c.allowed_channel_ids, []);
    assert.deepEqual(c.blocked_role_ids, []);
});

test('gates run in order: enabled, feature key, channel allow-list (max 3 named), role block-list', () => {
    const c = normalizeConfig({
        enabled: 1, disabled_subcommands: '["sell"]',
        allowed_channel_ids: JSON.stringify(['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444']),
        blocked_role_ids: '["555555555555555555"]',
    });
    assert.equal(checkGates(c, { featureKey: 'sell', channelId: '111111111111111111' }).code, 'FEATURE_OFF');
    const ch = checkGates(c, { featureKey: 'hunt', channelId: '999999999999999999' });
    assert.equal(ch.code, 'CHANNEL');
    assert.equal(ch.allowedChannelIds.length, 3);
    assert.equal(ch.moreChannels, true);
    assert.equal(checkGates(c, { featureKey: 'battle', channelId: '111111111111111111', roleIds: ['555555555555555555'] }).code, 'ROLE');
    assert.deepEqual(checkGates(c, { featureKey: 'battle', channelId: '222222222222222222', roleIds: ['1'] }), { ok: true });
    assert.deepEqual(checkGates(c, { featureKey: null, channelId: '9', skipPlaceGates: true }), { ok: true });
});

test('every command path has a feature key in the vocabulary (team, lootbox, gems, use, boss included)', () => {
    const set = new Set(FEATURE_KEYS);
    for (const p of ['owo team view', 'owo team add', 'owo lootbox', 'owo gems', 'owo use', 'owo boss', 'owo2 marry accept', 'owo2 wallpaper shop',
        'owo-profile view', 'autohunt claim', 'luck', 'owo ranch-claim', 'owo marry accept', 'owo wallpaper buy', 'owo autohunt enable']) {
        const k = featureKeyForPath(p);
        assert.ok(k && set.has(k), `${p} -> ${k}`);
    }
    assert.equal(featureKeyForPath('owo team view'), 'team');
    assert.equal(featureKeyForPath('owo team create'), 'team-create');
    assert.equal(featureKeyForPath('owo-profile accent'), 'profile');
    assert.equal(featureKeyForPath('owo toggle'), null);
    assert.equal(featureKeyForPath('owo grant-crate'), null);
    assert.equal(featureKeyForPath('nothing here'), undefined);
});

test('legacy disabled keys keep their meaning; unknown ones are dropped', () => {
    assert.deepEqual(mapLegacyFeatureKeys(['hunt', 'marry', 'Ring', 'old-thing', 'hunt']), ['hunt', 'marry', 'ring']);
    for (const k of ['hunt', 'zoo', 'leaderboard', 'catalog', 'sell', 'sacrifice', 'daily', 'balance', 'give', 'stats', 'team', 'team-create',
        'team-add', 'team-remove', 'team-switch', 'team-rename', 'equip', 'unequip', 'pet-name', 'battle', 'weapon', 'crate', 'quest', 'shards',
        'dismantle', 'forge', 'favorite', 'forge-prices', 'ranch', 'ranch-claim', 'pray', 'curse', 'cookie', 'top', 'lottery', 'drop', 'pickup',
        'duel', 'battle-settings', 'give-limits', 'transactions', 'wallpaper', 'ring', 'marry', 'shop', 'profile', 'autohunt', 'luck']) {
        assert.ok(FEATURE_KEYS.includes(k), k);
    }
});

test('daily: 24 h rolling cooldown; streak continues at 30 h and resets at 49 h', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const cd = dailyState(new Date(now.getTime() - 23 * H), 4, now);
    assert.equal(cd.onCooldown, true);
    assert.equal(cd.msLeft, H);
    assert.deepEqual(dailyState(new Date(now.getTime() - 30 * H), 4, now), { onCooldown: false, streak: 5 });
    assert.deepEqual(dailyState(new Date(now.getTime() - 49 * H), 4, now), { onCooldown: false, streak: 1 });
    assert.deepEqual(dailyState(null, 0, now), { onCooldown: false, streak: 1 });
});

test('daily payout grows with the streak and stops at its cap', () => {
    assert.equal(dailyPayout(1).total, DAILY.base);
    let last = 0;
    for (let s = 1; s <= DAILY.maxSteps + 1; s++) {
        const t = dailyPayout(s).total;
        assert.ok(t > last, `streak ${s}`);
        last = t;
    }
    assert.equal(dailyPayout(DAILY.maxSteps + 1).total, dailyPayout(500).total);
});

test('give caps: level 0 still allows modest gifts; caps rise with level and jump every 10 levels', () => {
    assert.ok(sendCap(0) >= 1000);
    assert.ok(receiveCap(0) >= sendCap(0));
    assert.ok(sendCap(9) < sendCap(10) - (sendCap(9) - sendCap(8)), '10-level step bonus');
    assert.ok(receiveCap(20) / sendCap(20) > receiveCap(5) / sendCap(5), 'receive multiplier grows');
    assert.equal(sendCap(-3), sendCap(0));
});

test('daily drops: first after local midnight always drops; the daily max is never exceeded', () => {
    const now = new Date();
    const yesterday = new Date(lastLocalMidnight(now).getTime() - 1000);
    const never = () => 0.999999;
    const first = decideDailyDrop({ claims: 3, windowAt: yesterday, now, chance: 0.01, max: 3, rng: never });
    assert.equal(first.drop, true);
    assert.equal(first.claimsAfter, 1);
    assert.equal(decideDailyDrop({ claims: 1, windowAt: now, now, chance: 0.01, max: 3, rng: never }).drop, false);
    assert.equal(decideDailyDrop({ claims: 1, windowAt: now, now, chance: 0.01, max: 3, rng: () => 0 }).drop, true);
    assert.equal(decideDailyDrop({ claims: 3, windowAt: now, now, chance: 1, max: 3, rng: () => 0 }).drop, false);
    assert.equal(decideDailyDrop({ claims: 0, windowAt: new Date(1000), now, chance: 0, max: 3, rng: never }).drop, true, 'epoch window = new day');
});

test('autohunt: 95 minutes queues 3 and leaves the anchor 5 minutes behind; never more than 24', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const q = autohuntQueue(new Date(now.getTime() - 95 * 60000), now);
    assert.equal(q.queued, 3);
    assert.equal(now.getTime() - q.newAnchor.getTime(), 5 * 60000);
    assert.equal(Math.round(q.nextInMs / 60000), 25);
    assert.equal(autohuntQueue(new Date(now.getTime() - 40 * H), now).queued, 24);
    assert.equal(autohuntQueue(now, now).queued, 0);
});

test('ranch: whole hours capped at 24; rate is the sum of tier rates', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    assert.equal(ranchHours(new Date(now.getTime() - 3.5 * H), now).hours, 3);
    assert.equal(ranchHours(new Date(now.getTime() - 100 * H), now).hours, 24);
    assert.equal(ranchRate(['common', 'uncommon', 'rare']), 1 + 3 + 10);
    assert.equal(ranchRate(['legendary', 'fabled']), 1000 + 2500);
    assert.equal(ranchRate([]), 0);
});

test('local midnight helpers', () => {
    const now = new Date();
    const m = lastLocalMidnight(now);
    assert.equal(m.getHours(), 0);
    assert.ok(m.getTime() <= now.getTime());
    assert.equal(nextLocalMidnight(now).getTime() - m.getTime() >= 23 * H, true);
    assert.equal(isBeforeToday(new Date(m.getTime() - 1), now), true);
    assert.equal(isBeforeToday(m, now), false);
    assert.equal(isBeforeToday(null, now), true);
});

test('pet levels follow the curve and cap at 100', () => {
    assert.equal(petLevel(0), 1);
    for (let l = 1; l <= 100; l++) assert.equal(petLevel(xpForLevel(l)), l, `level ${l}`);
    assert.equal(petLevel(1e12), 100);
});

test('couple bonus stays inside its bounds', () => {
    const rng = seededRng(3);
    for (let i = 0; i < 200; i++) {
        const v = coupleBonusAmount(i, i * 2, rng);
        assert.ok(v >= COUPLE_BONUS.min && v <= COUPLE_BONUS.max + COUPLE_BONUS.streakBonusCap);
    }
});
