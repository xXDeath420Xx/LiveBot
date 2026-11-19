import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRetentionDays, planGuildSweeps, RETENTION_CATEGORIES } from '../core/guild-log-retention.js';

test('a guild can only shorten retention, never extend it past the bot-wide cap', () => {
    assert.equal(effectiveRetentionDays(7, 90), 7);
    assert.equal(effectiveRetentionDays(89, 90), 89);
    assert.equal(effectiveRetentionDays(90, 90), null);   // same as the cap: nothing to do
    assert.equal(effectiveRetentionDays(400, 90), null);  // longer: ignored, cap still applies
});

test('blank, zero and garbage mean "use the bot-wide window"', () => {
    for (const v of [null, undefined, '', 0, -5, 'abc', NaN]) {
        assert.equal(effectiveRetentionDays(v, 90), null, String(v));
    }
});

test('without a bot-wide policy the guild value applies, bounded to a year', () => {
    assert.equal(effectiveRetentionDays(30, null), 30);
    assert.equal(effectiveRetentionDays(5000, null), 365);
    assert.equal(effectiveRetentionDays(12.9, null), 12);
});

test('planGuildSweeps maps each category to its own table and cap', () => {
    const plan = planGuildSweeps(
        [
            { guild_id: '1', message_logs_days: 7, audit_logs_days: 30 },
            { guild_id: '2', message_logs_days: 120, audit_logs_days: null },
            { guild_id: '3', message_logs_days: null, audit_logs_days: 400 },
            { guild_id: null, message_logs_days: 1 },
        ],
        [{ table_name: 'message_logs', retain_days: 90 }, { table_name: 'audit_logs', retain_days: 365 }]
    );
    assert.deepEqual(plan, [
        { guildId: '1', category: 'messages', table: 'message_logs', column: 'timestamp', days: 7 },
        { guildId: '1', category: 'audit', table: 'audit_logs', column: 'timestamp', days: 30 },
    ]);
});

test('categories only name tables that carry guild_id and a timestamp', () => {
    assert.deepEqual(Object.values(RETENTION_CATEGORIES).map(c => c.table).sort(), ['audit_logs', 'message_logs']);
});
