import test from 'node:test';
import assert from 'node:assert/strict';
import { UserFlags, UserFlagsBitField } from 'discord.js';
import {
    SPAMMER_BIT, normaliseSpammerAction, isFlaggedSpammer, planSpammerScan, spammerReason, spammerEventAction,
} from '../core/spammer-flag.js';

test('the bit is the one discord.js calls Spammer', () => {
    assert.equal(SPAMMER_BIT, UserFlags.Spammer);
    assert.equal(SPAMMER_BIT, 1048576);
});

test('flag detection: raw numbers, API users, discord.js users, and unknown', () => {
    assert.equal(isFlaggedSpammer(1048576), true);
    assert.equal(isFlaggedSpammer(65536), false, 'verified bot is not spammer');
    assert.equal(isFlaggedSpammer(1048576 | 64), true, 'other flags alongside');
    assert.equal(isFlaggedSpammer({ public_flags: 1048576 }), true);
    assert.equal(isFlaggedSpammer({ flags: new UserFlagsBitField(UserFlags.Spammer) }), true);
    assert.equal(isFlaggedSpammer({ flags: new UserFlagsBitField(0) }), false);
    assert.equal(isFlaggedSpammer({ flags: null }), null, 'flags never received');
    assert.equal(isFlaggedSpammer({}), null);
    assert.equal(isFlaggedSpammer(null), null);
});

test('actions normalise to the four known, defaulting to kick', () => {
    for (const a of ['flag', 'kick', 'ban', 'none']) assert.equal(normaliseSpammerAction(a), a);
    assert.equal(normaliseSpammerAction('BAN'), 'ban');
    assert.equal(normaliseSpammerAction('apply'), 'kick');
    assert.equal(normaliseSpammerAction(null), 'kick');
});

test('scan plan: only flagged, non-exempt, actionable humans are targeted', () => {
    const members = [
        { id: 'clean', spammer: false, actionable: true },
        { id: 'bot', bot: true, spammer: true, actionable: true },
        { id: 'spam1', spammer: true, actionable: true },
        { id: 'allowed', spammer: true, allowlisted: true, actionable: true },
        { id: 'owner', spammer: true, owner: true, actionable: false },
        { id: 'mod', spammer: true, staff: true, actionable: true },
        { id: 'high', spammer: true, actionable: false },
        { id: 'unknown', spammer: null, actionable: true },
    ];
    const plan = planSpammerScan(members, 'kick');
    assert.deepEqual(plan.targets, ['spam1']);
    assert.deepEqual(plan.skipped, { allowlisted: ['allowed'], staff: ['owner', 'mod'], unremovable: ['high'], already: [] });
    assert.deepEqual(plan.unknown, ['unknown']);
});

test('scan plan: flag mode skips members who already carry the role', () => {
    const plan = planSpammerScan([
        { id: 'a', spammer: true, actionable: true, hasFlagRole: true },
        { id: 'b', spammer: true, actionable: true },
    ], 'flag');
    assert.deepEqual(plan.targets, ['b']);
    assert.deepEqual(plan.skipped.already, ['a']);
    assert.deepEqual(planSpammerScan([{ id: 'a', spammer: true, actionable: true, hasFlagRole: true }], 'kick').targets, ['a']);
});

test('audit reasons are ASCII and events map one-to-one', () => {
    for (const s of ['join', 'scan']) assert.match(spammerReason(s), /^[\x20-\x7E]+$/);
    assert.equal(spammerEventAction('ban'), 'spammer_banned');
    assert.equal(spammerEventAction('kick'), 'spammer_kicked');
    assert.equal(spammerEventAction('flag'), 'spammer_flagged');
    assert.equal(spammerEventAction('none'), 'spammer_observed');
});
