import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    normaliseInactivityConfig, validateInactivitySettings, baselineMs, lastActiveMs, exemptionFor, evaluateMember, planSweep,
    summarise, previewRows, kickReason, warningText, kickDmText, warningPayload, kickPayload, describeInactivity, parseIdList, DAY_MS, INACTIVE_DEFAULTS,
    INACTIVE_LIMITS, MAX_WARNINGS_PER_SWEEP,
} from '../core/inactivity-prune-logic.js';
import { PRUNE_LIMITS, validatePruneSettings, formatMinutes } from '../core/auto-prune-logic.js';
import { LIMITS as VERIFY_LIMITS, validateSettings as validateVerify, VERIFY_EVENT_LABEL, summariseStats } from '../core/verification-logic.js';
import * as mig from '../migrations/332_prune_activity.js';

/*
 * Wave 11 "prune-activity": auto-prune up to 14 days, and the inactivity prune — never active / gone
 * quiet, with the fairness rule (nobody judged on time before activity tracking began), exemptions,
 * the warning DM, caps — plus per-member activity tracking (core/member-activity.js) and migration 332
 * against a fake db that only records SQL (never the real database).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
process.env.LOG_DIR ||= tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-10-13T12:00:00Z');
const D = DAY_MS;
const R1 = '500000000000000005';
const R2 = '600000000000000006';
const cfgWith = (o = {}) => {
    const base = normaliseInactivityConfig({
        inactive_never_enabled: 1, inactive_never_days: 30, inactive_never_action: 'log',
        inactive_quiet_enabled: 1, inactive_quiet_days: 90, inactive_quiet_action: 'log',
        inactive_min_member_days: 7, inactive_warn_days: 3,
    });
    const out = { ...base, ...o, never: { ...base.never, ...(o.never || {}) }, quiet: { ...base.quiet, ...(o.quiet || {}) } };
    out.enabled = o.enabled ?? (out.never.enabled || out.quiet.enabled);
    out.kicks = (out.never.enabled && out.never.action === 'kick') || (out.quiet.enabled && out.quiet.action === 'kick');
    return out;
};
const ctx = (o = {}) => ({ now: NOW, trackingSinceMs: NOW - 400 * D, botJoinedAtMs: NOW - 1000 * D, exemptRoleSet: new Set(), ...o });
const member = (o = {}) => ({ isBot: false, isOwner: false, isElevated: false, isStaff: false, isBooster: false, roleIds: [], inVoice: false,
    gatePending: false, joinedAtMs: NOW - 200 * D, ...o });

// ── auto-prune: the 1-day cap is gone ────────────────────────────────────────

test('auto-prune and the CAPTCHA window allow up to 14 days (a week is fine)', () => {
    assert.deepEqual(PRUNE_LIMITS.minutes, [10, 20160]);
    assert.deepEqual(validatePruneSettings({ minutes: 7 * 1440 }).patch, { prune_minutes: 10080 });
    assert.equal(validatePruneSettings({ minutes: 20161 }).errors.length, 1);
    assert.match(validatePruneSettings({ minutes: 5 }).errors[0], /14 days/);
    assert.deepEqual(VERIFY_LIMITS.windowMinutes, [0, 20160]);
    assert.deepEqual(validateVerify({ windowMinutes: 10080 }).errors, []);
    assert.equal(validateVerify({ windowMinutes: 20161 }).errors.length, 1);
    assert.equal(formatMinutes(10080), '7 d');
});

test('the command, the dashboard and the column all agree on 14 days', () => {
    const cmd = read('commands/admin/systems.js');
    assert.match(cmd, /setName\('minutes'\)\.setDescription\('Minutes after joining \(10-20160[^)]*\)'\)\.setMinValue\(10\)\.setMaxValue\(20160\)/);
    assert.match(cmd, /setName\('days'\)[^\n]*setMaxValue\(14\)/);
    assert.doesNotMatch(cmd, /CAPTCHA[^\n]*setMaxValue\(1440\)|'minutes'\)\.setDescription\('Minutes from joining[^\n]*setMaxValue\(1440\)/);
    const page = read('dashboard/views/partials/manage/verification.ejs');
    assert.match(page, /id="prMinutes" type="number" min="10" max="20160"/);
    assert.match(page, /id="vfWindow" type="number" min="0" max="20160"/);
    assert.doesNotMatch(page, /max="1440"/);
    // prune_minutes / captcha_window_minutes are INT columns (migration 328): no range of their own.
    assert.match(read('migrations/328_verify_prune.js'), /\['prune_minutes', 'INT NOT NULL DEFAULT 240'\]/);
});

// ── settings ─────────────────────────────────────────────────────────────────

test('inactivity settings: both rules off and log-only by default, values clamped', () => {
    const d = normaliseInactivityConfig(null);
    assert.equal(d.enabled, false);
    assert.equal(d.kicks, false);
    assert.deepEqual(d.never, { enabled: false, days: 30, action: 'log' });
    assert.deepEqual(d.quiet, { enabled: false, days: 90, action: 'log' });
    assert.equal(d.exemptBoosters, true);
    assert.equal(d.exemptStaff, true);
    assert.equal(d.minMemberDays, INACTIVE_DEFAULTS.minMemberDays);
    assert.equal(d.warnDays, 3);
    assert.equal(d.maxPerSweep, 25);
    assert.equal(d.dailyCap, 100);
    const c = normaliseInactivityConfig({ inactive_never_enabled: 1, inactive_never_days: 2, inactive_never_action: 'ban',
        inactive_quiet_enabled: 1, inactive_quiet_days: 9999, inactive_quiet_action: 'kick', inactive_exempt_roles: `["${R1}","${R1}","x"]`,
        inactive_last_result: '{"kicked":2}', inactive_last_sweep_at: '2026-10-13T06:00:00Z' });
    assert.equal(c.never.days, 7);
    assert.equal(c.never.action, 'log');
    assert.equal(c.quiet.days, 365);
    assert.ok(c.kicks);
    assert.deepEqual(c.exemptRoleIds, [R1]);
    assert.deepEqual(c.lastResult, { kicked: 2 });
    assert.equal(c.lastSweepAt, Date.parse('2026-10-13T06:00:00Z'));
    assert.deepEqual(parseIdList(`${R1}, ${R2}`), [R1, R2]);
});

test('inactivity validation: every range, both actions, the exempt list', () => {
    const ok = validateInactivitySettings({ neverEnabled: true, neverDays: 30, neverAction: 'kick', quietEnabled: false, quietDays: 120,
        quietAction: 'log', exemptBoosters: false, exemptStaff: true, minMemberDays: 0, warnDays: 0, maxPerSweep: 10, dailyCap: 50,
        exemptRoleIds: [R1, 'junk'] });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.patch, {
        inactive_never_enabled: 1, inactive_never_days: 30, inactive_never_action: 'kick', inactive_quiet_enabled: 0,
        inactive_quiet_days: 120, inactive_quiet_action: 'log', inactive_exempt_boosters: 0, inactive_exempt_staff: 1,
        inactive_min_member_days: 0, inactive_warn_days: 0, inactive_max_per_sweep: 10, inactive_daily_cap: 50,
        inactive_exempt_roles: JSON.stringify([R1]),
    });
    const bad = validateInactivitySettings({ neverDays: 6, quietDays: 29, neverAction: 'ban', quietAction: 'nuke', minMemberDays: -1,
        warnDays: 31, maxPerSweep: 0, dailyCap: 1001 });
    assert.equal(bad.errors.length, 8);
    assert.equal(validateInactivitySettings({ neverDays: 181 }).errors.length, 1);
    assert.equal(validateInactivitySettings({ quietDays: 366 }).errors.length, 1);
    assert.equal(validateInactivitySettings({ neverDays: 7.5 }).errors.length, 1);
    assert.equal(validateInactivitySettings({ exemptRoleIds: Array.from({ length: 26 }, (_, i) => String(100000000000000000n + BigInt(i))) }).errors.length, 1);
    assert.deepEqual(validateInactivitySettings({}).patch, {});
    assert.deepEqual(INACTIVE_LIMITS.neverDays, [7, 180]);
    assert.deepEqual(INACTIVE_LIMITS.quietDays, [30, 365]);
});

// ── the fairness rule ────────────────────────────────────────────────────────

test('baseline: the latest of joining, tracking starting and the bot joining; unknown join = nobody judged', () => {
    assert.equal(baselineMs({ joinedAtMs: 100, trackingSinceMs: 500, botJoinedAtMs: 50 }), 500);
    assert.equal(baselineMs({ joinedAtMs: 900, trackingSinceMs: 500, botJoinedAtMs: 50 }), 900);
    assert.equal(baselineMs({ joinedAtMs: 100, trackingSinceMs: 50, botJoinedAtMs: 700 }), 700);
    assert.equal(baselineMs({ joinedAtMs: 100 }), 100);
    assert.equal(baselineMs({ joinedAtMs: null, trackingSinceMs: 5 }), null);
    assert.equal(lastActiveMs({ lastMessageMs: 5, lastVoiceMs: 9 }), 9);
    assert.equal(lastActiveMs({}), null);
});

test('nobody is pruned for "no data" before N days of real tracking have passed', () => {
    const cfg = cfgWith({ never: { action: 'kick' }, quiet: { action: 'kick' }, warnDays: 0 });
    // A member here for two years with no recorded activity; tracking began 10 days ago.
    const e = evaluateMember(member({ joinedAtMs: NOW - 730 * D }), {}, cfg, ctx({ trackingSinceMs: NOW - 10 * D }));
    assert.equal(e.status, 'ok');
    assert.equal(e.baselineMs, NOW - 10 * D);
    assert.equal(e.dueAtMs, NOW + 20 * D, 'never-active: 30 days of tracking, 20 to go');
    assert.equal(e.inactiveDays, 10, 'counted from the baseline, not from the join');
    // 31 days after tracking began, the never-active rule is due.
    const later = evaluateMember(member({ joinedAtMs: NOW - 730 * D }), {}, cfg, ctx({ trackingSinceMs: NOW - 31 * D }));
    assert.equal(later.status, 'due');
    assert.equal(later.rule, 'never');
    // The bot joining the server later than tracking began also moves the baseline.
    const botLate = evaluateMember(member({ joinedAtMs: NOW - 730 * D }), {}, cfg, ctx({ trackingSinceMs: NOW - 400 * D, botJoinedAtMs: NOW - 5 * D }));
    assert.equal(botLate.status, 'ok');
    // Unknown join time: never judged.
    assert.equal(evaluateMember(member({ joinedAtMs: null }), {}, cfg, ctx()).status, 'unknown');
});

test('never active vs gone quiet', () => {
    const cfg = cfgWith();
    // Joined 40 days ago, nothing since: never active (log only).
    const n = evaluateMember(member({ joinedAtMs: NOW - 40 * D }), {}, cfg, ctx());
    assert.deepEqual([n.status, n.rule, n.action], ['due', 'never', 'log']);
    // Posted once after joining 100 days ago: not "never"; gone quiet once 90 days pass from that post.
    const q = evaluateMember(member({ joinedAtMs: NOW - 200 * D }), { lastMessageMs: NOW - 100 * D }, cfg, ctx());
    assert.deepEqual([q.status, q.rule], ['due', 'quiet']);
    const fine = evaluateMember(member({ joinedAtMs: NOW - 200 * D }), { lastVoiceMs: NOW - 10 * D }, cfg, ctx());
    assert.equal(fine.status, 'ok');
    assert.equal(fine.dueAtMs, NOW + 80 * D);
    // Activity before the current join (left and came back) does not count as "active since joining".
    const back = evaluateMember(member({ joinedAtMs: NOW - 40 * D }), { lastMessageMs: NOW - 300 * D }, cfgWith({ quiet: { enabled: false } }), ctx());
    assert.deepEqual([back.status, back.rule], ['due', 'never']);
    // Only the quiet rule on: a never-active member is judged by it, from the baseline.
    const quietOnly = evaluateMember(member({ joinedAtMs: NOW - 40 * D }), {}, cfgWith({ never: { enabled: false } }), ctx());
    assert.equal(quietOnly.rule, 'quiet');
    assert.equal(quietOnly.status, 'ok');
    assert.equal(quietOnly.dueAtMs, NOW + 50 * D);
});

test('minimum days in the server', () => {
    const cfg = cfgWith({ minMemberDays: 60, never: { days: 7 } });
    const e = evaluateMember(member({ joinedAtMs: NOW - 20 * D }), {}, cfg, ctx());
    assert.equal(e.status, 'ok');
    assert.equal(e.dueAtMs, NOW + 40 * D);
});

test('exemptions: bots, owner, admins, staff and boosters (toggles), exempt roles, voice now, the gate', () => {
    const cfg = cfgWith();
    const set = new Set([R1]);
    assert.equal(exemptionFor(member({ isBot: true }), cfg, set), 'bot');
    assert.equal(exemptionFor(member({ isOwner: true }), cfg, set), 'owner');
    assert.equal(exemptionFor(member({ isElevated: true }), cfg, set), 'admin');
    assert.equal(exemptionFor(member({ isStaff: true }), cfg, set), 'staff');
    assert.equal(exemptionFor(member({ isStaff: true }), { ...cfg, exemptStaff: false }, set), null);
    assert.equal(exemptionFor(member({ isBooster: true }), cfg, set), 'booster');
    assert.equal(exemptionFor(member({ isBooster: true }), { ...cfg, exemptBoosters: false }, set), null);
    assert.equal(exemptionFor(member({ roleIds: [R2, R1] }), cfg, set), 'exempt role');
    assert.equal(exemptionFor(member({ roleIds: [R2] }), cfg, set), null);
    const old = { joinedAtMs: NOW - 300 * D };
    assert.equal(evaluateMember(member({ ...old, isBooster: true }), {}, cfg, ctx()).status, 'exempt');
    assert.equal(evaluateMember(member({ ...old, roleIds: [R1] }), {}, cfg, ctx({ exemptRoleSet: set })).status, 'exempt');
    assert.equal(evaluateMember(member({ ...old, inVoice: true }), {}, cfg, ctx()).status, 'active');
    assert.equal(evaluateMember(member({ ...old, gatePending: true }), {}, cfg, ctx()).status, 'gate');
    assert.equal(evaluateMember(member(old), {}, { ...cfg, enabled: false }, ctx()).status, 'off');
});

// ── the warning ──────────────────────────────────────────────────────────────

test('kick mode with a warning: warn first, kick only after the warning period, activity cancels it', () => {
    const cfg = cfgWith({ never: { enabled: false }, quiet: { action: 'kick' }, warnDays: 3 });
    const m = member({ joinedAtMs: NOW - 300 * D });
    const last = { lastMessageMs: NOW - 120 * D };
    const w = evaluateMember(m, last, cfg, ctx());
    assert.equal(w.status, 'warn');
    assert.equal(w.kickAtMs, NOW + 3 * D, 'never kicked sooner than the warning says');
    // Within the warning window, before the due date, they are warned too (due in 2 days, warn 3 days ahead).
    const ahead = evaluateMember(m, { lastMessageMs: NOW - 88 * D }, cfg, ctx());
    assert.equal(ahead.status, 'warn');
    assert.equal(ahead.kickAtMs, NOW + 3 * D);
    assert.equal(evaluateMember(m, { lastMessageMs: NOW - 80 * D }, cfg, ctx()).status, 'ok', 'not yet in the warning window');
    // Warned a day ago: waiting. Warned four days ago: due.
    const waiting = evaluateMember(m, { ...last, warnedAtMs: NOW - 1 * D }, cfg, ctx());
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.kickAtMs, NOW + 2 * D);
    const due = evaluateMember(m, { ...last, warnedAtMs: NOW - 4 * D }, cfg, ctx());
    assert.deepEqual([due.status, due.action], ['due', 'kick']);
    // They posted after the warning: the clock restarts (not due, not warned).
    const posted = evaluateMember(m, { lastMessageMs: NOW - 1 * D, warnedAtMs: NOW - 2 * D }, cfg, ctx());
    assert.equal(posted.status, 'ok');
    // A stale warning from long ago (settings moved the deadline) does not count: warn again.
    const stale = evaluateMember(m, { lastMessageMs: NOW - 120 * D, warnedAtMs: NOW - 119 * D }, cfg, ctx());
    assert.equal(stale.status, 'warn');
});

test('kick mode without a warning; log only is recorded once per episode', () => {
    const noWarn = cfgWith({ never: { enabled: false }, quiet: { action: 'kick' }, warnDays: 0 });
    const m = member({ joinedAtMs: NOW - 300 * D });
    assert.equal(evaluateMember(m, { lastMessageMs: NOW - 120 * D }, noWarn, ctx()).status, 'due');
    const log = cfgWith({ never: { enabled: false } });
    const first = evaluateMember(m, { lastMessageMs: NOW - 120 * D }, log, ctx());
    assert.deepEqual([first.status, first.action, first.alreadyLogged], ['due', 'log', false]);
    const again = evaluateMember(m, { lastMessageMs: NOW - 120 * D, loggedAtMs: NOW - 6 * 3_600_000 }, log, ctx());
    assert.equal(again.alreadyLogged, true);
    const newEpisode = evaluateMember(m, { lastMessageMs: NOW - 95 * D, loggedAtMs: NOW - 100 * D }, log, ctx());
    assert.equal(newEpisode.alreadyLogged, false, 'activity since the last log starts a new episode');
});

test('one rule logs, the other kicks: the kick rule decides when it applies', () => {
    const cfg = cfgWith({ never: { action: 'log' }, quiet: { action: 'kick', days: 30 }, warnDays: 0 });
    const e = evaluateMember(member({ joinedAtMs: NOW - 60 * D }), {}, cfg, ctx());
    assert.deepEqual([e.status, e.action, e.rule], ['due', 'kick', 'quiet']);
    const logOnly = evaluateMember(member({ joinedAtMs: NOW - 31 * D }), {}, cfgWith({ never: { action: 'log' }, quiet: { action: 'kick', days: 90 }, warnDays: 0 }), ctx());
    assert.deepEqual([logOnly.status, logOnly.action, logOnly.rule], ['due', 'log', 'never']);
});

// ── sweeping ─────────────────────────────────────────────────────────────────

test('the sweep plan: kicks oldest-due first, capped per sweep and by what is left of the day', () => {
    const ev = (i, extra) => ({ userId: String(i), dueAtMs: NOW - i * D, ...extra });
    const kicks = Array.from({ length: 40 }, (_, i) => ev(i, { status: 'due', action: 'kick' }));
    const p = planSweep(kicks, { maxPerSweep: 25, kickedToday: 0, dailyCap: 100 });
    assert.equal(p.kick.length, 25);
    assert.equal(p.kick[0].userId, '39', 'the longest overdue first');
    assert.equal(p.deferredKicks, 15);
    assert.equal(p.capReached, 'sweep');
    assert.equal(p.kickQueue.length, 40, 'held members do not use up the budget: the sweep may try further down');
    assert.equal(p.budget, 25);
    assert.equal(p.maxAttempts, 110);
    const daily = planSweep(kicks, { maxPerSweep: 25, kickedToday: 90, dailyCap: 100 });
    assert.equal(daily.kick.length, 10);
    assert.equal(daily.capReached, 'daily');
    assert.equal(planSweep(kicks, { maxPerSweep: 25, kickedToday: 120, dailyCap: 100 }).kick.length, 0);
    const warns = Array.from({ length: 70 }, (_, i) => ev(i, { status: 'warn', action: 'kick' }));
    const pw = planSweep(warns, {});
    assert.equal(pw.warn.length, MAX_WARNINGS_PER_SWEEP);
    assert.equal(pw.deferredWarnings, 70 - MAX_WARNINGS_PER_SWEEP);
    const logs = planSweep([ev(1, { status: 'due', action: 'log' }), ev(2, { status: 'due', action: 'log', alreadyLogged: true }), ev(3, { status: 'ok' })], {});
    assert.deepEqual(logs.log.map(e => e.userId), ['1']);
    assert.equal(logs.kick.length, 0);
    assert.equal(logs.capReached, null);
});

test('preview: counts and the list (due first, then warned, then coming up)', () => {
    const evs = [
        { userId: 'a', status: 'ok', rule: 'quiet', dueAtMs: NOW + 3 * D },
        { userId: 'b', status: 'due', rule: 'never', action: 'kick', dueAtMs: NOW - D },
        { userId: 'c', status: 'warn', rule: 'quiet', action: 'kick', dueAtMs: NOW },
        { userId: 'd', status: 'exempt' },
        { userId: 'e', status: 'ok', rule: 'quiet', dueAtMs: NOW + 30 * D },
        { userId: 'f', status: 'waiting', rule: 'quiet', action: 'kick', dueAtMs: NOW - 2 * D },
        { userId: 'g', status: 'due', rule: 'quiet', action: 'log', dueAtMs: NOW - 5 * D },
        { userId: 'h', status: 'gate' },
    ];
    const s = summarise(evs, { now: NOW });
    assert.deepEqual([s.due, s.dueKick, s.dueLog, s.warn, s.waiting, s.soon, s.exempt, s.gate, s.never, s.quiet], [2, 1, 1, 1, 1, 1, 1, 1, 1, 3]);
    assert.deepEqual(previewRows(evs, { now: NOW }).map(e => e.userId), ['g', 'b', 'f', 'c', 'a']);
});

test('texts: ASCII audit reason, the warning names the server and how to stay', () => {
    const r = kickReason('never', 30);
    assert.match(r, /^[\x20-\x7E]+$/);
    assert.match(r, /within 30 days of joining/);
    assert.match(kickReason('quiet', 90), /90\+ days/);
    const w = warningText('Cool Server', { rule: 'quiet', days: 90, kickAtMs: NOW + 3 * D, now: NOW });
    assert.match(w, /\*\*Cool Server\*\*/);
    assert.match(w, /3 days/);
    assert.match(w, /send a message/);
    assert.match(w, /join a voice channel/);
    assert.match(kickDmText('Cool Server', { rule: 'never', days: 30 }), /welcome to join again/);
    assert.equal(describeInactivity(normaliseInactivityConfig(null)), 'Inactivity prune is off.');
    assert.match(describeInactivity(cfgWith({ quiet: { action: 'kick' } })), /warned 3 d before/);
});

test('warning and kick DMs: embed with exact time, go-to-server and rejoin buttons', () => {
    const g = { id: '123', name: 'Cool Server', iconUrl: 'https://cdn.example/icon.png' };
    const kickAt = NOW + 3 * D;
    const w = warningPayload(g, { rule: 'quiet', days: 90, kickAtMs: kickAt });
    const e = w.embeds[0];
    assert.match(e.title, /Cool Server/);
    assert.match(e.description, /90 days/);
    assert.ok(e.fields[0].value.includes(`<t:${Math.floor(kickAt / 1000)}:F>`));
    assert.match(e.fields[1].value, /voice channel/);
    assert.equal(w.components[0].components[0].url, 'https://discord.com/channels/123');
    assert.equal(w.components[0].components[0].style, 5);
    const k = kickPayload(g, { rule: 'never', days: 30, inviteUrl: 'https://discord.gg/abc' });
    assert.match(k.embeds[0].description, /join again/);
    assert.equal(k.components[0].components[0].url, 'https://discord.gg/abc');
    assert.deepEqual(kickPayload({ id: '1', name: 'X' }, { rule: 'quiet', days: 90 }).components, []);
    assert.equal(warningPayload({ id: '1', name: 'X' }, { rule: 'quiet', days: 90, kickAtMs: kickAt }).embeds[0].thumbnail, undefined);
});

// ── live side wiring (source checks: these modules talk to Discord) ──────────

test('every inactivity kick goes through protectionHold and actOrReport, with a registered log key', () => {
    const src = read('core/inactivity-prune.js');
    assert.match(src, /await protectionHold\(member, 'kick', SOURCE\)/);
    assert.match(src, /from '\.\/manual-action\.js'/);
    const kickLines = src.split('\n').filter(l => /\.kick\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.equal(kickLines.length, 1);
    assert.match(src, /actOrReport\(guild, 'kick', \{ member, source: SOURCE \}, async \(\) => \{\n[^\n]*\n\s*await member\.kick\(kickReason/);
    const la = read('core/log-actions.js');
    for (const key of ['join-gate.inactivityPrune', 'join-gate.inactivitySettings']) {
        assert.ok(la.includes(`key: '${key}'`), key);
        assert.ok(src.includes(`'${key}'`), key);
    }
    // One reaper, no parallel scheduler; the activity flush is batched.
    const reaper = read('jobs/temp-access-reaper.js');
    assert.match(reaper, /sweepInactivityDue\(resolveGuild\)/);
    assert.match(reaper, /startActivityFlush\(\)/);
    assert.doesNotMatch(src, /cron\.schedule|setInterval/);
    assert.match(read('events/messageCreate.js'), /noteActivityMessage\(message\.guild\.id, message\.author\.id, message\.channel\.id, message\.id\)/);
    assert.match(read('events/voiceStateUpdate.js'), /noteActivityVoice\(newState\.guild\.id, newState\.id, newState\.channelId\)/);
});

test('activity writes are batched upserts that keep the later time and the first activity', async () => {
    const ma = await import('../core/member-activity.js');
    assert.match(ma.UPSERT_SQL, /VALUES \?/);
    assert.match(ma.UPSERT_SQL, /first_active_at = COALESCE\(first_active_at, VALUES\(first_active_at\)\)/);
    assert.match(ma.UPSERT_SQL, /GREATEST\(COALESCE\(last_message_at, VALUES\(last_message_at\)\), VALUES\(last_message_at\)\)/);
    const rows = ma.toRows([{ g: '1', u: '2', msg: 5000, voice: null }, { g: '1', u: '3', msg: 9000, voice: 7000 }]);
    assert.deepEqual(rows[0].map(v => (v instanceof Date ? v.getTime() : v)), ['1', '2', 5000, 5000, null, null, null, null]);
    assert.deepEqual(rows[1].map(v => (v instanceof Date ? v.getTime() : v)), ['1', '3', 7000, 9000, 7000, null, null, null]);
    // noteMessage / noteVoiceJoin only touch memory: many messages, one pending entry.
    ma._pending.clear();
    for (let i = 0; i < 50; i++) ma.noteMessage('111111111111111111', '222222222222222222');
    ma.noteVoiceJoin('111111111111111111', '222222222222222222');
    assert.equal(ma._pending.size, 1);
    const e = [...ma._pending.values()][0];
    assert.ok(e.msg && e.voice);
    ma._pending.clear();
});

test('the security grid, the privacy plan, the event labels and the stats know the new pieces', async () => {
    const { PROTECTION_GRID, protectionsGrid, eventGroup, BLOCKING_EVENT_ACTIONS } = await import('../core/security-overview-logic.js');
    assert.ok(PROTECTION_GRID.some(g => g.key === 'inactivityPrune' && g.page === 'verification'));
    const grid = protectionsGrid({ inactivityPrune: { on: true, action: 'gone quiet: kick' } });
    assert.deepEqual(grid.find(g => g.key === 'inactivityPrune'), { key: 'inactivityPrune', label: 'Inactivity prune', page: 'verification', on: true, detail: 'gone quiet: kick' });
    assert.equal(eventGroup('prune_inactive_kicked'), 'Inactivity prune');
    assert.ok(BLOCKING_EVENT_ACTIONS.includes('prune_inactive_kicked'));
    const { DELETE_PLAN } = await import('../core/privacy-tables.js');
    assert.ok(DELETE_PLAN.some(p => p.table === 'member_activity' && p.column === 'user_id'));
    for (const a of mig.EVENT_ACTIONS_ADDED) assert.ok(VERIFY_EVENT_LABEL[a], a);
    const s = summariseStats([{ action: 'prune_inactive_kicked', n: 4 }, { action: 'prune_inactive_warned', n: 2 }]);
    assert.equal(s.inactiveKicked, 4);
    assert.equal(s.inactiveWarned, 2);
    // The settings columns are writable through join-gate setConfig; the sweep's own columns are not.
    const jg = read('core/join-gate.js');
    for (const [col] of mig.INACTIVE_COLUMNS.filter(([c]) => !c.startsWith('inactive_last_'))) assert.ok(jg.includes(`'${col}'`), col);
    assert.ok(!jg.includes("'inactive_last_sweep_at'"));
});

// ── migration 332 (fake db: records SQL, touches nothing) ────────────────────

function fakeDb({ columns = {}, enums = {}, tables = [] } = {}) {
    const sql = [];
    return {
        sql,
        async execute(q, params = []) {
            sql.push(q.replace(/\s+/g, ' ').trim());
            if (/information_schema\.TABLES/.test(q)) return [tables.includes(params[0]) ? [{ 1: 1 }] : []];
            if (/COLUMN_TYPE AS t/.test(q)) return [enums[`${params[0]}.${params[1]}`] ? [{ t: enums[`${params[0]}.${params[1]}`] }] : []];
            if (/information_schema\.COLUMNS/.test(q)) return [(columns[params[0]] || []).includes(params[1]) ? [{ 1: 1 }] : []];
            return [{ affectedRows: 0 }];
        },
    };
}

test('migration 332: table, columns, enum, backfill, tracking start — and nothing else', async () => {
    const db = fakeDb({
        tables: ['message_stats', 'voice_activity', 'activity_logs'],
        columns: { join_gate_config: ['guild_id'], guilds: ['guild_id'] },
        enums: { 'join_gate_events.action': "enum('kicked_new','prune_kicked','failed')" },
    });
    await mig.up(db);
    const ddl = db.sql.filter(q => !/information_schema/.test(q));
    assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS member_activity .*PRIMARY KEY \(guild_id, user_id\)/);
    const adds = ddl.filter(q => q.startsWith('ALTER TABLE join_gate_config ADD COLUMN'));
    assert.equal(adds.length, mig.INACTIVE_COLUMNS.length);
    assert.ok(adds.some(q => /inactive_never_enabled TINYINT\(1\) NOT NULL DEFAULT 0/.test(q)));
    assert.ok(adds.some(q => /inactive_quiet_enabled TINYINT\(1\) NOT NULL DEFAULT 0/.test(q)));
    assert.ok(adds.some(q => /inactive_never_action VARCHAR\(10\) NOT NULL DEFAULT 'log'/.test(q)));
    assert.ok(ddl.includes('ALTER TABLE guilds ADD COLUMN activity_tracked_since DATETIME NULL'));
    assert.ok(ddl.includes(`ALTER TABLE join_gate_events MODIFY action ENUM('kicked_new','prune_kicked','failed','prune_inactive_kicked','prune_inactive_warned','prune_inactive_logged','prune_inactive_held') NOT NULL`));
    const fills = ddl.filter(q => q.startsWith('INSERT INTO member_activity'));
    assert.equal(fills.length, 3);
    for (const f of fills) {
        assert.match(f, /SELECT x\.guild_id, x\.user_id, x\.f, x\.lm, x\.lv FROM \(SELECT /, 'grouped select in a derived table');
        assert.match(f, /ON DUPLICATE KEY UPDATE first_active_at = IF\(.*LEAST/);
        assert.match(f, /last_message_at = IF\(.*GREATEST/);
    }
    assert.match(fills[0], /FROM message_stats/);
    assert.match(fills[1], /FROM voice_activity/);
    assert.match(fills[2], /FROM activity_logs/);
    assert.match(fills[0], /DATE_ADD\(MAX\(stat_date\), INTERVAL 86399 SECOND\)/, 'a day counts to its end');
    const since = ddl.find(q => q.startsWith('UPDATE guilds g'));
    assert.match(since, /WHERE g\.activity_tracked_since IS NULL$/, 'never moves a start already set');
    assert.match(since, /GREATEST\(CAST\(ms\.m AS DATETIME\), COALESCE\(va\.v, vall\.v/);
    assert.match(since, /WHEN ms\.m IS NULL THEN NOW\(\)/);
    assert.ok(!ddl.some(q => /^(DELETE|DROP|TRUNCATE)/.test(q)), 'up() deletes nothing');
    assert.ok(!ddl.some(q => /^UPDATE (?!guilds g)/.test(q)), 'the only UPDATE is the tracking start');
});

test('migration 332 is idempotent and copes with missing history tables', async () => {
    const db = fakeDb({
        tables: [],
        columns: { join_gate_config: mig.INACTIVE_COLUMNS.map(([c]) => c), guilds: ['activity_tracked_since'] },
        enums: { 'join_gate_events.action': `enum('failed',${mig.EVENT_ACTIONS_ADDED.map(a => `'${a}'`).join(',')})` },
    });
    await mig.up(db);
    const ddl = db.sql.filter(q => !/information_schema/.test(q));
    assert.deepEqual(ddl.map(q => q.split(' ').slice(0, 3).join(' ')), ['CREATE TABLE IF', 'UPDATE guilds SET']);
    assert.match(ddl[1], /WHERE activity_tracked_since IS NULL/);
    const down = fakeDb({ columns: { join_gate_config: ['inactive_never_enabled'], guilds: ['activity_tracked_since'] },
        enums: { 'join_gate_events.action': "enum('failed','prune_inactive_kicked')" } });
    await mig.down(down);
    const d = down.sql.filter(q => !/information_schema/.test(q));
    assert.ok(d.some(q => q === "ALTER TABLE join_gate_events MODIFY action ENUM('failed') NOT NULL"));
    assert.ok(d.includes('DROP TABLE IF EXISTS member_activity'));
});

test('the backfill SELECTs only read the history tables', () => {
    for (const q of mig.BACKFILL_SELECTS) {
        assert.match(q.trim(), /^SELECT /);
        assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
        assert.match(q, /CHAR_LENGTH\(guild_id\) BETWEEN 15 AND 20/);
    }
    assert.deepEqual(mig.BACKFILL_SOURCES, ['message_stats', 'voice_activity', 'activity_logs']);
});

// ── slash command ────────────────────────────────────────────────────────────

test('/systems auto-prune: inactivity subcommands within Discord limits', async () => {
    const { default: cmd } = await import('../commands/admin/systems.js');
    const json = cmd.data.toJSON();
    const group = json.options.find(o => o.name === 'auto-prune');
    const names = group.options.map(o => o.name);
    for (const n of ['set', 'bypass', 'status', 'unqueue', 'inactive', 'inactive-exempt', 'inactive-preview']) assert.ok(names.includes(n), n);
    assert.ok(group.options.length <= 25);
    const walk = (o) => { assert.ok(!o.description || o.description.length <= 100, o.name); (o.options || []).forEach(walk); };
    json.options.forEach(walk);
    assert.ok(group.options.find(o => o.name === 'inactive').options.length <= 25);
    // Discord's 8000-character limit counts names, descriptions and choices (as tests/tidy.test.js measures it).
    const size = (o) => (o.name?.length ?? 0) + (o.description?.length ?? 0)
        + (o.choices || []).reduce((n, c) => n + c.name.length + String(c.value).length, 0) + (o.options || []).reduce((n, c) => n + size(c), 0);
    assert.ok(size(json) <= 8000, `command is ${size(json)} characters (limit 8000)`);
});
