import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    MINUTE, HOUR, DAY, INCIDENT_MAX_MS, INCIDENT_RENEW_BEFORE_MS, LOCKDOWN_ACTIONS,
    normaliseAction, lockdownSettings, checkDuration, parseLength, lockdownState, remainingMs, joinedDuring,
    joinsInWindow, autoTrigger, nameKey, memberNameKeys, sameNameGroups, raidTailMs, raidStillHot,
    planIncidentActions, summarise, counterFor, asciiReason, utcStamp,
} from '../core/raid-lockdown-logic.js';

/*
 * Raid lockdown rules (core/raid-lockdown-logic.js): the lockdown state machine across a restart,
 * the auto-trigger thresholds, same-name grouping, and Discord incident-action renewal + ownership.
 */

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const row = (over = {}) => ({
    id: 1, status: 'active', action: 'kick',
    started_at: new Date(T0), ends_at: new Date(T0 + HOUR), ...over,
});

// ── settings & durations ───────────────────────────────────────────────────

test('actions: unknown falls back, every listed action survives', () => {
    for (const a of LOCKDOWN_ACTIONS) assert.equal(normaliseAction(a), a);
    assert.equal(normaliseAction('BAN'), 'ban');
    assert.equal(normaliseAction('nuke'), 'kick');
    assert.equal(normaliseAction(undefined, 'ban'), 'ban');
});

test('settings: defaults are Hashbot\'s and everything that removes people is off', () => {
    const s = lockdownSettings(null);
    assert.equal(s.autoEnabled, false);
    assert.equal(s.sameNameEnabled, false);
    assert.equal(s.keepDmsDisabled, false);
    assert.equal(s.keepInvitesDisabled, false);
    assert.equal(s.autoJoins, 20);
    assert.equal(s.autoWindowSeconds, 10);
    assert.equal(s.autoDurationMinutes, 60);
    assert.equal(s.autoAction, 'kick');
    assert.equal(s.sameNameCount, 5);
    assert.equal(s.sameNameAction, 'ban');
    assert.equal(s.lockdownAction, 'kick');
    assert.equal(s.lockdownPauseInvites, true);
    assert.deepEqual(s.lockdownChannelIds, []);
});

test('settings: out-of-range numbers are clamped to Hashbot\'s ranges, junk channel ids dropped', () => {
    const s = lockdownSettings({
        auto_lockdown_enabled: 1, auto_lockdown_joins: 1000, auto_lockdown_window_seconds: 1,
        auto_lockdown_duration_minutes: 99999, same_name_count: 1, same_name_window_seconds: 99999,
        lockdown_channel_ids: JSON.stringify(['123456789012345678', 'nope', 42]), auto_lockdown_action: 'explode',
    });
    assert.equal(s.autoEnabled, true);
    assert.equal(s.autoJoins, 100);
    assert.equal(s.autoWindowSeconds, 5);
    assert.equal(s.autoDurationMinutes, 1440);
    assert.equal(s.sameNameCount, 3);
    assert.equal(s.sameNameWindowSeconds, 600);
    assert.equal(s.autoAction, 'kick');
    assert.deepEqual(s.lockdownChannelIds, ['123456789012345678']);
    assert.deepEqual(lockdownSettings({ lockdown_channel_ids: '{broken' }).lockdownChannelIds, []);
});

test('durations: auto 1 min - 24 h, manual 1 min - 7 days', () => {
    assert.equal(checkDuration(30_000).ok, false);
    assert.equal(checkDuration(MINUTE).ok, true);
    assert.equal(checkDuration(DAY + MINUTE, 'auto').ok, false);
    assert.equal(checkDuration(DAY, 'auto').ok, true);
    assert.equal(checkDuration(7 * DAY).ok, true);
    assert.equal(checkDuration(7 * DAY + 1).ok, false);
    assert.equal(checkDuration(NaN).ok, false);
});

test('parseLength: 30m, 2h, 1d, 1h30m, bare minutes; nonsense refused', () => {
    assert.equal(parseLength('30m').ms, 30 * MINUTE);
    assert.equal(parseLength('2h').ms, 2 * HOUR);
    assert.equal(parseLength(' 1d ').ms, DAY);
    assert.equal(parseLength('1h30m').ms, 90 * MINUTE);
    assert.equal(parseLength('45').ms, 45 * MINUTE);
    assert.equal(parseLength('1w').ms, 7 * DAY);
    assert.equal(parseLength('2w').ok, false);
    assert.equal(parseLength('soon').ok, false);
    assert.equal(parseLength('').ok, false);
    assert.equal(parseLength('30s').ok, false, 'under a minute');
    assert.equal(parseLength('25h', 'auto').ok, false);
});

// ── lockdown state machine ─────────────────────────────────────────────────

test('state: active until its end, then expired; ended / missing rows are none', () => {
    assert.equal(lockdownState(row(), T0 + 10 * MINUTE), 'active');
    assert.equal(remainingMs(row(), T0 + 10 * MINUTE), 50 * MINUTE);
    assert.equal(lockdownState(row(), T0 + HOUR), 'expired');
    assert.equal(remainingMs(row(), T0 + HOUR), 0);
    assert.equal(lockdownState(row({ status: 'ended' }), T0), 'none');
    assert.equal(lockdownState(null, T0), 'none');
    assert.equal(lockdownState(row({ ends_at: 'garbage' }), T0), 'expired', 'an unreadable end never blocks joins forever');
});

test('restart: the stored row alone resumes the lockdown (DB strings or Dates), and expires on time', () => {
    // After a restart the row comes back from MariaDB; nothing in memory is needed.
    const fromDb = row({ started_at: new Date(T0).toISOString(), ends_at: new Date(T0 + 2 * HOUR).toISOString() });
    assert.equal(lockdownState(fromDb, T0 + 90 * MINUTE), 'active');
    assert.equal(lockdownState(fromDb, T0 + 2 * HOUR + 1), 'expired');
});

test('restart: a replayed join is enforced only if the member joined after the lockdown began', () => {
    const r = row();
    assert.equal(joinedDuring(r, T0 + 5 * MINUTE, T0 + 20 * MINUTE), true, 'joined mid-lockdown while we were down');
    assert.equal(joinedDuring(r, T0 - HOUR, T0 + 20 * MINUTE), false, 'was already a member');
    assert.equal(joinedDuring(r, T0 - 2000, T0 + MINUTE), true, 'small clock skew tolerated');
    assert.equal(joinedDuring(r, null, T0 + MINUTE), true, 'unknown join time = a live join');
    assert.equal(joinedDuring(r, T0 + 5 * MINUTE, T0 + 2 * HOUR), false, 'expired lockdown enforces nothing');
    assert.equal(joinedDuring(null, T0, T0), false);
});

// ── auto-trigger ───────────────────────────────────────────────────────────

const joinsAt = (n, start, gap, prefix = 'u') => Array.from({ length: n }, (_, i) => ({ userId: `${prefix}${i}`, timestamp: start + i * gap }));

test('auto-trigger: fires at exactly the threshold inside the window, not below', () => {
    const settings = { autoJoins: 20, autoWindowSeconds: 10 };
    const nineteen = joinsAt(19, T0, 100);
    assert.equal(autoTrigger(nineteen, T0 + 5000, settings).fire, false);
    const twenty = joinsAt(20, T0, 100);
    const hit = autoTrigger(twenty, T0 + 5000, settings);
    assert.equal(hit.fire, true);
    assert.equal(hit.count, 20);
    assert.equal(hit.userIds.length, 20);
});

test('auto-trigger: joins outside the window or before the cutoff do not count; repeats count once', () => {
    const settings = { autoJoins: 5, autoWindowSeconds: 10 };
    const slow = joinsAt(10, T0, 3000);                       // 10 joins over 27 s: at most 4 in any 10 s
    assert.equal(autoTrigger(slow, T0 + 27_000, settings).fire, false);
    const burst = joinsAt(5, T0, 500);
    assert.equal(autoTrigger(burst, T0 + 3000, settings).fire, true);
    assert.equal(autoTrigger(burst, T0 + 3000, settings, T0 + 1000).fire, false, 'cutoff after the last lockdown');
    const sameUser = Array.from({ length: 6 }, (_, i) => ({ userId: 'same', timestamp: T0 + i }));
    assert.equal(autoTrigger(sameUser, T0 + 100, settings).fire, false);
    assert.equal(joinsInWindow(burst, T0 + 3000, 1).length, 1);
});

// ── same-name floods ───────────────────────────────────────────────────────

test('nameKey: lookalikes, separators, trailing numbers and leetspeak fold together', () => {
    assert.equal(nameKey('JohnSmith_4821'), 'johnsmith');
    assert.equal(nameKey('john smith 77'), 'johnsmith');
    assert.equal(nameKey('j0hn_sm1th_88'), 'johnsmith');
    assert.equal(nameKey('Jоhn Smith'), 'johnsmith', 'Cyrillic o');
    assert.equal(nameKey('𝐉𝐨𝐡𝐧𝐒𝐦𝐢𝐭𝐡'), 'johnsmith', 'math bold');
    assert.equal(nameKey('ab'), null, 'too short to group on');
    assert.equal(nameKey('12345'), null);
    assert.equal(nameKey(null), null);
    assert.deepEqual(memberNameKeys({ username: 'cryptodrop_1', globalName: 'Crypto Drop', displayName: 'Crypto Drop' }), ['cryptodrop']);
    assert.deepEqual(memberNameKeys({ username: 'alice99', globalName: 'Bob' }).sort(), ['alice', 'bob']);
});

test('same-name: 5 joins sharing a name inside the window are a group; 4 are not', () => {
    const settings = { sameNameCount: 5, sameNameWindowSeconds: 300 };
    const flood = Array.from({ length: 5 }, (_, i) => ({ userId: `f${i}`, timestamp: T0 + i * 1000, nameKeys: [nameKey(`free_nitro_${i}`)] }));
    const others = [{ userId: 'x', timestamp: T0, nameKeys: ['alice'] }, { userId: 'y', timestamp: T0, nameKeys: ['bob'] }];
    const groups = sameNameGroups([...flood, ...others], T0 + 10_000, settings);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'freenitro');
    assert.deepEqual(groups[0].userIds.sort(), ['f0', 'f1', 'f2', 'f3', 'f4']);
    assert.equal(sameNameGroups(flood.slice(0, 4), T0 + 10_000, settings).length, 0);
});

test('same-name: joins older than the window drop out; one person counts once', () => {
    const settings = { sameNameCount: 3, sameNameWindowSeconds: 60 };
    const joins = [
        { userId: 'a', timestamp: T0, nameKeys: ['spam'] },
        { userId: 'b', timestamp: T0 + 70_000, nameKeys: ['spam'] },
        { userId: 'c', timestamp: T0 + 80_000, nameKeys: ['spam'] },
        { userId: 'c', timestamp: T0 + 81_000, nameKeys: ['spam'] },
    ];
    assert.equal(sameNameGroups(joins, T0 + 90_000, settings).length, 0, 'a is outside the window, c twice is still one');
    joins.push({ userId: 'd', timestamp: T0 + 85_000, nameKeys: ['spam'] });
    assert.deepEqual(sameNameGroups(joins, T0 + 90_000, settings)[0].userIds.sort(), ['b', 'c', 'd']);
});

test('same-name: a group wholly inside a bigger one is dropped; biggest first', () => {
    const settings = { sameNameCount: 3, sameNameWindowSeconds: 300 };
    const joins = ['a', 'b', 'c', 'd'].map((id, i) => ({ userId: id, timestamp: T0 + i, nameKeys: i < 3 ? ['alpha', 'beta'] : ['alpha'] }));
    const groups = sameNameGroups(joins, T0 + 1000, settings);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'alpha');
    assert.equal(groups[0].userIds.length, 4);
});

// ── raid "hot" window (the joins-during-a-raid fix) ────────────────────────

test('raid: joins keep being part of a raid until it has been quiet for the tail', () => {
    assert.equal(raidTailMs(30), 10 * MINUTE);
    assert.equal(raidTailMs(600), 20 * MINUTE);
    const raid = { status: 'active', startTime: T0, lastJoinAt: T0 + MINUTE };
    assert.equal(raidStillHot(raid, T0 + 5 * MINUTE, 30), true);
    assert.equal(raidStillHot(raid, T0 + 12 * MINUTE, 30), false);
    assert.equal(raidStillHot({ ...raid, status: 'resolved' }, T0 + MINUTE, 30), false);
    assert.equal(raidStillHot(undefined, T0, 30), false);
    const busy = { status: 'active', startTime: T0, lastJoinAt: T0 + 65 * MINUTE };
    assert.equal(raidStillHot(busy, T0 + 66 * MINUTE, 30), false, 'an hour from detection at most');
});

// ── incident actions: renewal timing and ownership ─────────────────────────

const plan = (over) => planIncidentActions({ now: T0, current: {}, owned: {}, ...over });

test('incidents: keep switch on with nothing set -> pause for 24 h and own it', () => {
    const p = plan({ keepDms: true });
    assert.equal(p.changed, true);
    assert.equal(p.body.dms, T0 + INCIDENT_MAX_MS);
    assert.equal(p.owned.dms, T0 + INCIDENT_MAX_MS);
    assert.equal(p.body.invites, null);
});

test('incidents: renewed only once under 12 h is left, never sooner (hourly job has 11 h slack)', () => {
    const ours = T0 + 13 * HOUR;
    const quiet = plan({ keepDms: true, current: { dms: ours }, owned: { dms: ours } });
    assert.equal(quiet.changed, false, '13 h left: leave it');
    assert.equal(quiet.owned.dms, ours);
    const due = T0 + 11 * HOUR;
    const renew = plan({ keepDms: true, current: { dms: due }, owned: { dms: due } });
    assert.equal(renew.changed, true);
    assert.equal(renew.body.dms, T0 + DAY);
    assert.ok(INCIDENT_RENEW_BEFORE_MS - HOUR > 10 * HOUR, 'an hourly sweep renews long before Discord lifts it');
});

test('incidents: never more than 24 h ahead', () => {
    const p = plan({ lockdownInvitesUntil: T0 + 3 * DAY });
    assert.equal(p.body.invites, T0 + DAY);
    const later = plan({ now: T0 + 13 * HOUR, lockdownInvitesUntil: T0 + 3 * DAY, current: { invites: T0 + DAY }, owned: { invites: T0 + DAY } });
    assert.equal(later.changed, true, 'a lockdown over 24 h keeps invites paused by renewing');
    assert.equal(later.body.invites, T0 + 13 * HOUR + DAY);
});

test('incidents: lockdown pauses invites for its length and lifts them when it ends (only ours)', () => {
    const start = plan({ lockdownInvitesUntil: T0 + HOUR });
    assert.equal(start.body.invites, T0 + HOUR);
    assert.equal(start.owned.invites, T0 + HOUR);
    const end = plan({ now: T0 + 30 * MINUTE, current: { invites: T0 + HOUR }, owned: { invites: T0 + HOUR } });
    assert.equal(end.changed, true);
    assert.equal(end.body.invites, null, 'ended early: lift our pause');
    assert.equal(end.owned.invites, null);
});

test('incidents: a pause set by hand is never lifted, and not claimed', () => {
    const human = T0 + 5 * HOUR;
    const p = plan({ current: { invites: human }, owned: {} });
    assert.equal(p.changed, false);
    assert.equal(p.body.invites, human);
    assert.equal(p.owned.invites, null);
    assert.equal(p.humanSet.invites, true);
    // A lockdown that wants invites paused while a longer human pause runs: leave it as is.
    const covered = plan({ lockdownInvitesUntil: T0 + HOUR, current: { invites: human } });
    assert.equal(covered.changed, false);
    assert.equal(covered.owned.invites, null, 'still theirs: our lockdown ending must not lift it');
});

test('incidents: someone changed our pause by hand -> it is theirs now', () => {
    const p = plan({ current: { dms: T0 + 2 * HOUR }, owned: { dms: T0 + 20 * HOUR } });
    assert.equal(p.changed, false);
    assert.equal(p.owned.dms, null);
});

test('incidents: our pause lifted by hand before its end is reported and not put back', () => {
    const p = plan({ keepInvites: true, current: { invites: null }, owned: { invites: T0 + 10 * HOUR } });
    assert.equal(p.humanCleared.invites, true);
    assert.equal(p.changed, false, 'the keep switch must not fight a person');
    assert.equal(p.owned.invites, null);
    // Our pause ran out by itself (owned time is in the past): not "cleared by hand", just renew.
    const lapsed = plan({ keepInvites: true, current: { invites: null }, owned: { invites: T0 - MINUTE } });
    assert.equal(lapsed.humanCleared.invites, false);
    assert.equal(lapsed.body.invites, T0 + DAY);
});

test('incidents: Discord rounding the stored time still counts as ours; expired times read as none', () => {
    const p = plan({ current: { dms: T0 + 5 * HOUR + 30_000 }, owned: { dms: T0 + 5 * HOUR } });
    assert.equal(p.body.dms, null, 'switch off and it is ours (within tolerance): lifted');
    const stale = plan({ current: { dms: T0 - MINUTE }, owned: {} });
    assert.equal(stale.changed, false);
    assert.equal(stale.body.dms, null);
});

test('incidents: switching the keep switch off lifts a running pause now, whoever set it (H-660)', () => {
    const human = T0 + 5 * HOUR;
    // Not ours, nothing wants it, and staff just switched DMs off: lifted.
    const off = plan({ current: { dms: human }, owned: {}, lift: { dms: true } });
    assert.equal(off.changed, true);
    assert.equal(off.body.dms, null);
    assert.equal(off.owned.dms, null);
    // Without the switch-off a hand-set pause is still left alone (the hourly renewal never lifts it).
    assert.equal(plan({ current: { dms: human } }).body.dms, human);
    // A lift for one kind leaves the other alone.
    const one = plan({ current: { dms: human, invites: human }, lift: { dms: true } });
    assert.equal(one.body.invites, human);
    // A running lockdown still holding invites keeps them paused even when the switch goes off.
    const held = plan({ lockdownInvitesUntil: T0 + HOUR, current: { invites: T0 + HOUR }, owned: { invites: T0 + HOUR }, lift: { invites: true } });
    assert.equal(held.body.invites, T0 + HOUR);
    // Nothing running: nothing to send.
    assert.equal(plan({ lift: { dms: true, invites: true } }).changed, false);
});

test('incidents: both fields always come back, so the PUT never clears the other one by omission', () => {
    const p = plan({ keepDms: true, current: { invites: T0 + 3 * HOUR } });
    assert.ok('dms' in p.body && 'invites' in p.body);
    assert.equal(p.body.invites, T0 + 3 * HOUR, 'a human invite pause rides along unchanged');
});

// ── summaries & reasons ────────────────────────────────────────────────────

test('summary counts and outcome buckets', () => {
    const s = summarise({
        joins_blocked: 3, joins_held: 1, joins_failed: 1, joins_logged: 0,
        blocked_users: JSON.stringify([{ id: '1', r: 'kicked' }, { id: '2', r: 'kicked' }, { id: '3', r: 'banned' }, { id: '4', r: 'held' }, { id: '5', r: 'failed' }]),
    });
    assert.equal(s.total, 5);
    assert.equal(s.byOutcome.kicked.length, 2);
    assert.equal(summarise({ blocked_users: 'nope' }).users.length, 0);
    assert.equal(counterFor('banned'), 'joins_blocked');
    assert.equal(counterFor('quarantined'), 'joins_blocked');
    assert.equal(counterFor('paused'), 'joins_held');
    assert.equal(counterFor('logged'), 'joins_logged');
    assert.equal(counterFor('failed'), 'joins_failed');
});

test('audit-log reasons are plain ASCII', () => {
    const r = asciiReason('Same-name join flood: 5 accounts named like “crуpto” — 🚨');
    assert.match(r, /^[\x20-\x7E]*$/);
    assert.equal(utcStamp(T0), '2026-10-12 12:00 UTC');
});

// ── wiring (source checks) ─────────────────────────────────────────────────

const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('join pipeline: the lockdown is checked before the stale-event guard and stops the pipeline', () => {
    const s = src('events/guildMemberAdd.js');
    const lock = s.indexOf('enforceRaidLockdown(member)');
    const stale = s.indexOf('Stale event guard');
    assert.ok(lock > 0 && stale > 0 && lock < stale);
    assert.match(s, /verdict === 'stop'\) return;/);
});

test('raid detection: joins during an active raid are actioned, not just listed', () => {
    const s = src('core/raid-detection-manager.js');
    assert.match(s, /raidStillHot\(activeRaid/);
    assert.match(s, /executeRaidActions\(guild, config, \[joinedUserId\]\)/);
    assert.doesNotMatch(s, /this\.joinTracker\.set\(guild\.id, \[\]\)/, 'the tracker is no longer wiped (same-name needs it)');
});

test('lockdown expiry and incident renewal are scheduled', () => {
    const s = src('jobs/timed-moderation-job.js');
    assert.match(s, /sweepExpiredLockdowns\(\)/);
    assert.match(s, /renewIncidentActions\(\)/);
});
