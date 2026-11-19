import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * AutoMod "Message spam" (core/automod.js; register H-659). The rule's action is honoured: Delete deletes,
 * Warn warns, Mute times out for the rule's length, Kick and Ban remove. "Time out, longer each time"
 * (the ladder every spam rule used to get whatever was picked) is its own action, and migration 443 moved
 * the existing Delete / Warn / Mute spam rules to it so they behave as before.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amspam-'));
process.env.LOG_DIR ||= tmp;
const { spamRuleAction, spamLadderMinutes, SPAM_ACTIONS } = await import('../core/automod.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the chosen action is the one used', () => {
    for (const a of ['delete', 'warn', 'mute', 'kick', 'ban', 'ladder']) assert.equal(spamRuleAction({ action: a }), a);
    assert.deepEqual([...SPAM_ACTIONS].sort(), ['ban', 'delete', 'kick', 'ladder', 'mute', 'warn']);
    // Anything unknown keeps the old behaviour.
    assert.equal(spamRuleAction({ action: 'explode' }), 'ladder');
    assert.equal(spamRuleAction(null), 'ladder');
});

test('the ladder: 1, 5, 15, 30 minutes ... up to a day', () => {
    assert.equal(spamLadderMinutes(0), 1);
    assert.equal(spamLadderMinutes(1), 5);
    assert.equal(spamLadderMinutes(2), 15);
    assert.equal(spamLadderMinutes(3), 30);
    assert.equal(spamLadderMinutes(8), 1440);
    assert.equal(spamLadderMinutes(50), 1440);
    assert.equal(spamLadderMinutes(-1), 1);
});

test('only the ladder acts when the burst stops; the rest act when the spam is caught', () => {
    const src = read('core/automod.js');
    const enter = src.slice(src.indexOf('async function enterFilteredMode'), src.indexOf('async function releaseFilteredUser'));
    assert.match(enter, /spamRuleAction\(rule\)/);
    assert.match(enter, /action === 'warn' \|\| action === 'mute'/);
    assert.match(enter, /punishForRule\(message, action, 'Automod: Message spam rule\.', SPAM_SOURCE, minutes\)/);
    const release = src.slice(src.indexOf('async function releaseFilteredUser'), src.indexOf('export function isUserFiltered'));
    assert.match(release, /filterData\.action && filterData\.action !== 'ladder'\) \{[\s\S]*?return;/);
});

test('the AutoMod page offers the ladder for Message spam only, and says what the limit counts', () => {
    const page = read('dashboard/views/partials/manage/automod.ejs');
    assert.equal((page.match(/<option value="ladder" hidden disabled>/g) || []).length, 2, 'add form and edit dialog');
    assert.match(page, /function amSpamActionChoice\(/);
    assert.doesNotMatch(page, /How many messages trigger the rule\./);
    assert.doesNotMatch(page, /Message spam always deletes the burst and times the sender out for longer each time/);
    const server = read('dashboard/server.js');
    assert.match(server, /const automodRuleAction = \(action, isSpam\) =>/);
    assert.match(server, /automodRuleAction\(action, filter_type === 'antiSpam'\)/);
});

test('existing spam rules were moved to the ladder', () => {
    const mig = read('migrations/443_automod_spam_ladder_action.js');
    assert.match(mig, /SET action = 'ladder'/);
    assert.match(mig, /NOT IN \('kick', 'ban', 'ladder'\)/);
});
