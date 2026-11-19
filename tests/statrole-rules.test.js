import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normaliseRuleRows, evaluateMember, memberTimeStats, minimumByType, describeRule, STAT_TYPE_KEYS,
} from '../core/statrole-rules.js';

const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';

test('dashboard rows: arrays, qs objects, legacy field names and blank cards', () => {
    const { rules, errors } = normaliseRuleRows({
        0: { role_id: ROLE_A, stat_type: 'messages', required_amount: '1000' },
        1: { roleId: ROLE_B, stat: 'voice_minutes', requiredValue: '600', remove_below: '1' },
        2: { role_id: '', stat_type: '', required_amount: '' },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(rules, [
        { role_id: ROLE_A, stat_type: 'messages', required_amount: 1000, remove_below: 0 },
        { role_id: ROLE_B, stat_type: 'voice_minutes', required_amount: 600, remove_below: 1 },
    ]);
});

test('invalid rows are reported, not saved', () => {
    const { errors } = normaliseRuleRows([
        { role_id: 'abc', stat_type: 'messages', required_amount: 5 },
        { role_id: ROLE_A, stat_type: 'reactions', required_amount: 5 },
        { role_id: ROLE_A, stat_type: 'messages', required_amount: 0 },
        { role_id: ROLE_A, stat_type: 'level', required_amount: 1.5 },
    ]);
    assert.equal(errors.length, 4);
    assert.match(errors[1], /unknown statistic/);
});

test('roles that no longer exist are rejected when the guild role list is known', () => {
    const { errors } = normaliseRuleRows([{ role_id: ROLE_A, stat_type: 'messages', required_amount: 5 }], { validRoleIds: new Set([ROLE_B]) });
    assert.match(errors[0], /no longer exists/);
});

test('duplicate role+stat keeps the last row, like the UNIQUE key', () => {
    const { rules } = normaliseRuleRows([
        { role_id: ROLE_A, stat_type: 'messages', required_amount: 10 },
        { role_id: ROLE_A, stat_type: 'messages', required_amount: 20 },
    ]);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].required_amount, 20);
});

test('a role is earned when any of its rules is met', () => {
    const rules = [
        { role_id: ROLE_A, stat_type: 'messages', required_amount: 1000, remove_below: 0 },
        { role_id: ROLE_A, stat_type: 'voice_minutes', required_amount: 600, remove_below: 0 },
    ];
    const out = evaluateMember({ rules, stats: { messages: 10, voice_minutes: 700 }, heldRoles: new Set() });
    assert.deepEqual(out.add.map((a) => [a.roleId, a.rule.stat_type, a.value]), [[ROLE_A, 'voice_minutes', 700]]);
    assert.deepEqual(out.remove, []);
    // Already held -> nothing to do.
    assert.deepEqual(evaluateMember({ rules, stats: { messages: 5000 }, heldRoles: new Set([ROLE_A]) }).add, []);
});

test('removal needs: opt-in, a bot grant, every stat known, and no rule met', () => {
    const rules = [{ role_id: ROLE_A, stat_type: 'level', required_amount: 10, remove_below: 1 }];
    const base = { rules, heldRoles: new Set([ROLE_A]) };
    assert.deepEqual(evaluateMember({ ...base, stats: { level: 3 }, grantedRoles: new Set([ROLE_A]) }).remove, [ROLE_A]);
    // Granted by hand, not by the bot -> keep.
    assert.deepEqual(evaluateMember({ ...base, stats: { level: 3 }, grantedRoles: new Set() }).remove, []);
    // Stat unknown on this check -> keep.
    assert.deepEqual(evaluateMember({ ...base, stats: {}, grantedRoles: new Set([ROLE_A]) }).remove, []);
    // No opt-in -> keep.
    const noOptIn = [{ ...rules[0], remove_below: 0 }];
    assert.deepEqual(evaluateMember({ rules: noOptIn, heldRoles: new Set([ROLE_A]), stats: { level: 1 }, grantedRoles: new Set([ROLE_A]) }).remove, []);
});

test('partial checks never remove a role another (unloaded) rule could justify', () => {
    const rules = [
        { role_id: ROLE_A, stat_type: 'messages', required_amount: 1000, remove_below: 1 },
        { role_id: ROLE_A, stat_type: 'voice_minutes', required_amount: 600, remove_below: 1 },
    ];
    const out = evaluateMember({ rules, stats: { messages: 1 }, heldRoles: new Set([ROLE_A]), grantedRoles: new Set([ROLE_A]) });
    assert.deepEqual(out.remove, []);
});

test('time stats and minimum thresholds', () => {
    const now = Date.parse('2026-10-05T00:00:00Z');
    const stats = memberTimeStats({ createdTimestamp: now - 400 * 86_400_000, joinedTimestamp: now - 3.5 * 86_400_000 }, now);
    assert.deepEqual(stats, { account_age_days: 400, server_days: 3 });
    assert.deepEqual(memberTimeStats({}, now), {});
    assert.deepEqual(minimumByType([
        { stat_type: 'messages', required_amount: 500 }, { stat_type: 'messages', required_amount: 100 },
        { stat_type: 'level', required_amount: 5 },
    ]), { messages: 100, level: 5 });
});

test('every stat type has a readable description', () => {
    for (const t of STAT_TYPE_KEYS) assert.ok(describeRule({ stat_type: t, required_amount: 10 }).length > 3);
    assert.equal(describeRule({ stat_type: 'level', required_amount: 10 }), 'level 10');
});
