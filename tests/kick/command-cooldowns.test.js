// Kick/Twitch chat command cooldowns (services/certifried-bot/command-handler.js): the command's own
// per-user cooldown plus the channel page's Global and Per-user cooldowns (H-307).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isOnCooldown as isOnCooldown, _setCooldowns as setCooldowns } from '../../services/certifried-bot/command-handler.js';

const T0 = 1_000_000_000_000;

test('command cooldown blocks the same user and command only', () => {
    setCooldowns('cc-1', 'lit', 'u1', T0);
    assert.equal(isOnCooldown('cc-1', 'lit', 'u1', 10, {}, T0 + 5_000), true);
    assert.equal(isOnCooldown('cc-1', 'lit', 'u1', 10, {}, T0 + 10_000), false);
    assert.equal(isOnCooldown('cc-1', 'lit', 'u2', 10, {}, T0 + 5_000), false);
    assert.equal(isOnCooldown('cc-1', 'dab', 'u1', 10, {}, T0 + 5_000), false);
});

test('channel global cooldown blocks everyone, any command', () => {
    setCooldowns('cc-2', 'lit', 'u1', T0);
    const cd = { global: 3, user: 0 };
    assert.equal(isOnCooldown('cc-2', 'dab', 'u2', 0, cd, T0 + 2_000), true);
    assert.equal(isOnCooldown('cc-2', 'dab', 'u2', 0, cd, T0 + 3_000), false);
    assert.equal(isOnCooldown('cc-other', 'dab', 'u2', 0, cd, T0 + 1_000), false, 'other channels unaffected');
});

test('channel per-user cooldown blocks that user on every command', () => {
    setCooldowns('cc-3', 'lit', 'u1', T0);
    const cd = { global: 0, user: 5 };
    assert.equal(isOnCooldown('cc-3', 'dab', 'u1', 0, cd, T0 + 4_999), true);
    assert.equal(isOnCooldown('cc-3', 'dab', 'u2', 0, cd, T0 + 1_000), false);
    assert.equal(isOnCooldown('cc-3', 'dab', 'u1', 0, cd, T0 + 5_000), false);
});

test('zero, null and junk channel values mean off', () => {
    setCooldowns('cc-4', 'lit', 'u1', T0);
    for (const v of [0, null, undefined, 'x', -3]) {
        assert.equal(isOnCooldown('cc-4', 'dab', 'u1', 0, { global: v, user: v }, T0 + 1), false);
    }
});
