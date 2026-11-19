import test from 'node:test';
import assert from 'node:assert/strict';
import {
    generateCode, cleanAnswer, answerMatches, newChallenge, challengeExpired, pressKey, refreshChallenge, canRefresh,
    entryDisplay, judgeAttempt, windowDeadline, windowExpired, secondsUntil, buildCaptchaSvg, normaliseConfig,
    validateSettings, windowApplies, everyoneCanView, withView, buildLockPlan, undoEdit, snapshotRecord, mergeSnapshot,
    summariseStats, normaliseWizardOptions, channelSlug, CODE_LENGTH, CODE_TTL_MS, MAX_REFRESHES, VIEW_CHANNEL, DEFAULTS,
} from '../core/verification-logic.js';
import {
    parseRoleList, normalisePruneConfig, validatePruneSettings, bypassSet, hasRealRole, firstRealRole, shouldTrack,
    pruneVerdict, formatMinutes, PRUNE_DEFAULT_MINUTES,
} from '../core/auto-prune-logic.js';
import * as mig from '../migrations/328_verify_prune.js';

/*
 * CAPTCHA verification, the setup wizard's channel locking + undo, and auto-prune: the pure rules
 * (core/verification-logic.js, core/auto-prune-logic.js) and migration 328 run against a fake db
 * that only records SQL — never the real database.
 */

/** Deterministic [0,1) source. */
function seeded(seed = 42) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const G = '100000000000000001';     // guild = @everyone
const V = '200000000000000002';     // Verified
const U = '300000000000000003';     // Unverified
const GATE = '400000000000000004';
const ch = (id, name, overwrites = [], extra = {}) => ({ id, name, type: 0, parentId: null, manageable: true, overwrites, ...extra });
const ow = (id, allow = 0n, deny = 0n) => ({ id, type: 0, allow: allow.toString(), deny: deny.toString() });

// ── CAPTCHA ──────────────────────────────────────────────────────────────────

test('codes are 6 digits from the injected source, crypto by default', () => {
    const digits = [1, 2, 3, 4, 5, 6];
    let i = 0;
    assert.equal(generateCode(() => digits[i++]), '123456');
    for (let n = 0; n < 50; n++) assert.match(generateCode(), /^\d{6}$/);
    assert.equal(CODE_LENGTH, 6);
});

test('answers: digits only, exact length, wrong is wrong', () => {
    assert.equal(cleanAnswer(' 12 34-56 '), '123456');
    assert.ok(answerMatches('123456', '123456'));
    assert.ok(answerMatches('123456', '123 456'));
    assert.ok(!answerMatches('123456', '123457'));
    assert.ok(!answerMatches('123456', '12345'));
    assert.ok(!answerMatches('123456', ''));
    assert.ok(!answerMatches('', ''));
    assert.ok(!answerMatches('123456', null));
});

test('keypad: digits append up to the code length, back and clear edit, junk is ignored', () => {
    let c = newChallenge({ code: '000000', now: 0 });
    for (const k of ['1', '2', '3', '4', '5', '6', '7']) c = pressKey(c, k);
    assert.equal(c.entered, '123456');
    c = pressKey(c, 'back');
    assert.equal(c.entered, '12345');
    assert.equal(entryDisplay(c.entered), '1 2 3 4 5 _');
    c = pressKey(c, 'nonsense');
    assert.equal(c.entered, '12345');
    c = pressKey(c, 'clear');
    assert.equal(c.entered, '');
    assert.equal(pressKey(c, 'back').entered, '');
    assert.equal(entryDisplay(''), '_ _ _ _ _ _');
});

test('attempt state machine: a correct answer uses no try; the last wrong one fails', () => {
    assert.deepEqual(judgeAttempt({ correct: true, attemptsUsed: 2, maxAttempts: 3 }), { outcome: 'passed', attemptsUsed: 2, remaining: 1 });
    assert.deepEqual(judgeAttempt({ correct: false, attemptsUsed: 0, maxAttempts: 3 }), { outcome: 'retry', attemptsUsed: 1, remaining: 2 });
    assert.deepEqual(judgeAttempt({ correct: false, attemptsUsed: 1, maxAttempts: 3 }), { outcome: 'retry', attemptsUsed: 2, remaining: 1 });
    assert.deepEqual(judgeAttempt({ correct: false, attemptsUsed: 2, maxAttempts: 3 }), { outcome: 'failed', attemptsUsed: 3, remaining: 0 });
    assert.equal(judgeAttempt({ correct: false, attemptsUsed: 0, maxAttempts: 1 }).outcome, 'failed');
    // Already over (config lowered meanwhile): still a failure, never a negative "tries left".
    assert.equal(judgeAttempt({ correct: false, attemptsUsed: 5, maxAttempts: 3 }).outcome, 'failed');
    assert.equal(judgeAttempt({ correct: false }).outcome, 'retry');
});

test('a code expires after 5 minutes or at the window deadline, whichever is first', () => {
    const now = 1_000_000;
    assert.equal(newChallenge({ code: '1', now }).expiresAt, now + CODE_TTL_MS);
    assert.equal(newChallenge({ code: '1', now, deadline: now + 60_000 }).expiresAt, now + 60_000);
    assert.equal(newChallenge({ code: '1', now, deadline: now + 3_600_000 }).expiresAt, now + CODE_TTL_MS);
    const c = newChallenge({ code: '1', now });
    assert.ok(!challengeExpired(c, now + CODE_TTL_MS - 1));
    assert.ok(challengeExpired(c, now + CODE_TTL_MS));
    assert.ok(challengeExpired(undefined, now));
});

test('new pictures: limited per code; a wrong answer\'s fresh code does not count as one', () => {
    let c = newChallenge({ code: '111111', now: 0 });
    for (let i = 0; i < MAX_REFRESHES; i++) { assert.ok(canRefresh(c)); c = refreshChallenge(c, { code: '222222', now: i }); }
    assert.ok(!canRefresh(c));
    const after = refreshChallenge(c, { code: '333333', now: 10, countsAsRefresh: false });
    assert.equal(after.refreshes, MAX_REFRESHES);
    assert.equal(after.code, '333333');
    assert.equal(after.entered, '');
});

test('completion window: minutes from the start, 0 = no limit', () => {
    assert.equal(windowDeadline(1000, 5), 1000 + 300_000);
    assert.equal(windowDeadline(1000, 0), null);
    assert.ok(!windowExpired(null, 9e15));
    assert.ok(windowExpired(1000, 1000));
    assert.ok(!windowExpired(1000, 999));
    assert.equal(secondsUntil(null, 0), null);
    assert.equal(secondsUntil(10_500, 0), 11);
    assert.equal(secondsUntil(0, 10_000), 0);
});

test('the CAPTCHA SVG draws every digit separately, warped, with noise; same seed = same picture', () => {
    const svg = buildCaptchaSvg('482915', seeded(7));
    assert.equal(svg, buildCaptchaSvg('482915', seeded(7)));
    assert.notEqual(svg, buildCaptchaSvg('482915', seeded(8)));
    assert.match(svg, /^<svg [^>]*width="360" height="120"/);
    const texts = [...svg.matchAll(/<text [^>]*>(\d)<\/text>/g)].map(m => m[1]);
    assert.deepEqual(texts, ['4', '8', '2', '9', '1', '5']);
    assert.match(svg, /feTurbulence/);
    assert.match(svg, /feDisplacementMap/);
    assert.ok((svg.match(/<circle /g) || []).length >= 100, 'dot noise');
    assert.ok((svg.match(/<path /g) || []).length >= 10, 'curves');
    assert.ok(!/<script|javascript:/i.test(svg));
});

test('the CAPTCHA renders to a PNG with sharp', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp(Buffer.from(buildCaptchaSvg('123456', seeded(3)))).png().toBuffer();
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 360);
    assert.equal(meta.height, 120);
});

// ── config ───────────────────────────────────────────────────────────────────

test('a verify_config row normalises with defaults; old rows stay "I agree"', () => {
    assert.equal(normaliseConfig(null), null);
    const old = normaliseConfig({ guild_id: G, enabled: 1, verified_role_id: V, unverified_role_id: null, gate_channel_id: GATE, unverified_kick_days: 7 });
    assert.equal(old.mode, 'button');
    assert.equal(old.attempts, DEFAULTS.attempts);
    assert.equal(old.windowMinutes, DEFAULTS.windowMinutes);
    assert.equal(old.failAction, 'kick');
    assert.equal(old.unverifiedKickDays, 7);
    assert.equal(old.unverifiedRoleId, null);
    assert.ok(!windowApplies(old));
    const cap = normaliseConfig({ guild_id: G, enabled: 1, verified_role_id: V, mode: 'captcha', captcha_attempts: 99, captcha_window_minutes: 0, fail_action: 'weird', wizard_snapshot: '{"v":1}' });
    assert.equal(cap.attempts, 10);
    assert.equal(cap.failAction, 'kick');
    assert.deepEqual(cap.wizard, { v: 1 });
    assert.ok(!windowApplies(cap), 'window 0 = no deadline');
    assert.ok(windowApplies({ ...cap, windowMinutes: 5 }));
    assert.ok(!windowApplies({ ...cap, windowMinutes: 5, enabled: false }));
    assert.equal(normaliseConfig({ guild_id: G, wizard_snapshot: '{broken' }).wizard, null);
});

test('settings validation: columns out, every bad value an error, nothing half-saved', () => {
    const ok = validateSettings({ enabled: true, mode: 'captcha', attempts: 4, windowMinutes: 0, failAction: 'ban', timeoutMinutes: 30, failDm: false,
        verifiedRoleId: V, unverifiedRoleId: '', channelId: GATE, panelTitle: '  Hi ', panelText: '', unverifiedKickDays: 3 });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.patch, {
        enabled: 1, mode: 'captcha', fail_action: 'ban', captcha_attempts: 4, captcha_window_minutes: 0, fail_timeout_minutes: 30,
        unverified_kick_days: 3, fail_dm: 0, verified_role_id: V, unverified_role_id: null, gate_channel_id: GATE, panel_title: 'Hi', panel_text: null,
    });
    const bad = validateSettings({ mode: 'quiz', attempts: 0, windowMinutes: 30000, failAction: 'explode', verifiedRoleId: null, channelId: 'abc', panelText: 'x'.repeat(1001) });
    assert.equal(bad.errors.length, 7);
    assert.equal(validateSettings({ verifiedRoleId: V, unverifiedRoleId: V }).errors.length, 1);
    assert.deepEqual(validateSettings({}).patch, {});
});

// ── wizard: locking + undo ───────────────────────────────────────────────────

const snap = (channels, extra = {}) => ({
    everyoneId: G, everyoneBaseView: true, gateChannelId: GATE, rulesChannelId: null, updatesChannelId: null,
    verifiedRoleId: V, unverifiedRoleId: U, channels, ...extra,
});

test('who can see a channel: its own @everyone overwrite, else the base permission', () => {
    assert.ok(everyoneCanView(ch('1', 'a'), G, true));
    assert.ok(!everyoneCanView(ch('1', 'a'), G, false));
    assert.ok(!everyoneCanView(ch('1', 'a', [ow(G, 0n, VIEW_CHANNEL)]), G, true));
    assert.ok(everyoneCanView(ch('1', 'a', [ow(G, VIEW_CHANNEL)]), G, false));
    assert.deepEqual(withView({ allow: 1n | VIEW_CHANNEL, deny: 2n }, 'deny'), { allow: 1n, deny: 2n | VIEW_CHANNEL });
    assert.deepEqual(withView(null, 'allow'), { allow: VIEW_CHANNEL, deny: 0n });
});

test('"Unverified" strategy: hide public channels from the Unverified role, open the gate, skip the rest', () => {
    const plan = buildLockPlan(snap([
        ch('10', 'general'),
        ch('11', 'staff', [ow(G, 0n, VIEW_CHANNEL)]),                          // private already
        ch('12', 'rules'),                                                    // community rules channel
        ch('13', 'locked-out', [], { manageable: false }),                    // bot cannot manage
        ch('14', 'done', [ow(U, 0n, VIEW_CHANNEL)]),                          // already hidden
        ch('15', 'chat', [ow(U, 1n << 11n, 0n)]),                             // other bits on the overwrite stay
        ch(GATE, 'verify'),
    ], { rulesChannelId: '12' }), { strategy: 'unverified', hideGate: true });
    const byId = {};
    for (const e of plan.edits) (byId[e.channelId] ||= []).push(e);
    assert.deepEqual(Object.keys(byId).sort(), ['10', '15', GATE].sort());
    assert.deepEqual(byId['10'][0].after, { allow: 0n, deny: VIEW_CHANNEL });
    assert.equal(byId['10'][0].before, null);
    assert.deepEqual(byId['15'][0].after, { allow: 1n << 11n, deny: VIEW_CHANNEL });
    assert.deepEqual(byId[GATE].map(e => [e.targetId, e.after.allow & VIEW_CHANNEL ? 'show' : 'hide']), [[U, 'show'], [V, 'hide']]);
    assert.equal(plan.privateCount, 1);
    assert.equal(plan.lockedCount, 2);
    assert.deepEqual(plan.skipped.map(s => [s.channelId, s.why]).sort(), [['12', 'community'], ['13', 'no-permission'], ['14', 'already-locked']]);
});

test('"Verified" strategy: @everyone loses View, Verified gains it; the gate stays visible', () => {
    const plan = buildLockPlan(snap([ch('10', 'general'), ch(GATE, 'verify', [ow(G, 0n, VIEW_CHANNEL)])]), { strategy: 'verified', hideGate: false });
    const general = plan.edits.filter(e => e.channelId === '10');
    assert.deepEqual(general.map(e => [e.targetId, e.after]), [[G, { allow: 0n, deny: VIEW_CHANNEL }], [V, { allow: VIEW_CHANNEL, deny: 0n }]]);
    const gate = plan.edits.filter(e => e.channelId === GATE);
    assert.deepEqual(gate.map(e => [e.targetId, e.after]), [[G, { allow: VIEW_CHANNEL, deny: 0n }]]);
    assert.equal(plan.lockedCount, 1);
});

test('"none" hides nothing and leaves the gate alone', () => {
    const plan = buildLockPlan(snap([ch('10', 'general'), ch(GATE, 'verify')]), { strategy: 'none', hideGate: true });
    assert.deepEqual(plan.edits, []);
    assert.equal(plan.lockedCount, 0);
});

test('undo puts back only the View bit, deletes overwrites the wizard created, keeps later edits', () => {
    // Created by the wizard, untouched since → deleted.
    assert.deepEqual(undoEdit(null, { allow: 0n, deny: VIEW_CHANNEL }), { op: 'delete' });
    // Created by the wizard, staff added Send Messages deny since → kept, View cleared.
    assert.deepEqual(undoEdit(null, { allow: 0n, deny: VIEW_CHANNEL | (1n << 11n) }), { op: 'put', allow: 0n, deny: 1n << 11n });
    // Existed with View allowed → View allowed again, other bits as they are now.
    assert.deepEqual(undoEdit({ allow: VIEW_CHANNEL.toString(), deny: '0' }, { allow: 4n, deny: VIEW_CHANNEL }), { op: 'put', allow: 4n | VIEW_CHANNEL, deny: 0n });
    // Already back to how it was → nothing to do.
    assert.deepEqual(undoEdit({ allow: '0', deny: '0' }, { allow: 0n, deny: 0n }), { op: 'none' });
    // Overwrite gone and it did not exist before → nothing.
    assert.deepEqual(undoEdit(null, null), { op: 'none' });
    // Overwrite gone but it existed before → recreate its View state.
    assert.deepEqual(undoEdit({ allow: '0', deny: VIEW_CHANNEL.toString() }, null), { op: 'put', allow: 0n, deny: VIEW_CHANNEL });
});

/** Apply edits to a simple overwrite map, then undo them from the record, like the live code does. */
function simulate(channels, runs) {
    const state = new Map();
    for (const c of channels) for (const o of c.overwrites) state.set(`${c.id}:${o.id}`, { allow: BigInt(o.allow), deny: BigInt(o.deny) });
    const original = new Map(state);
    let record = null;
    for (const opts of runs) {
        const current = channels.map(c => ({ ...c, overwrites: [...state].filter(([k]) => k.startsWith(`${c.id}:`)).map(([k, v]) => ow(k.split(':')[1], v.allow, v.deny)) }));
        const plan = buildLockPlan(snap(current), opts);
        record = mergeSnapshot(record, snapshotRecord({ at: 't', by: 'x', strategy: opts.strategy, created: {}, edits: plan.edits, status: 'applied' }));
        for (const e of plan.edits) state.set(`${e.channelId}:${e.targetId}`, e.after);
    }
    for (const e of [...record.edits].reverse()) {
        const k = `${e.channelId}:${e.targetId}`;
        const op = undoEdit(e.before, state.get(k) || null, BigInt(e.mask));
        if (op.op === 'delete') state.delete(k);
        else if (op.op === 'put') state.set(k, { allow: op.allow, deny: op.deny });
    }
    return { original, state, record };
}

test('apply then undo returns every overwrite to where it started', () => {
    const channels = [ch('10', 'general'), ch('11', 'chat', [ow(U, 1n << 11n, 0n), ow(G, 4n, 0n)]), ch(GATE, 'verify')];
    for (const strategy of ['unverified', 'verified']) {
        const { original, state } = simulate(channels, [{ strategy, hideGate: true }]);
        assert.deepEqual(state, original, strategy);
    }
});

test('two runs (the second over the first) undo in one pass back to the original', () => {
    const channels = [ch('10', 'general'), ch('11', 'chat', [ow(V, 0n, 4n)]), ch(GATE, 'verify')];
    const { original, state, record } = simulate(channels, [{ strategy: 'unverified', hideGate: false }, { strategy: 'verified', hideGate: true }]);
    assert.equal(record.runs, 2);
    assert.deepEqual(state, original);
    assert.equal(mergeSnapshot({ status: 'undone', edits: [1] }, { edits: [2] }).edits.length, 1, 'an undone record is not carried');
});

test('wizard options: defaults, "create", the Unverified strategy creates its role', () => {
    const { options, errors } = normaliseWizardOptions({});
    assert.deepEqual(errors, []);
    assert.equal(options.strategy, 'unverified');
    assert.equal(options.mode, 'captcha');
    assert.equal(options.createUnverified, true);
    assert.equal(options.channelId, null);
    assert.equal(options.channelName, 'verify');
    assert.equal(options.hideGate, true);
    const picked = normaliseWizardOptions({ channelId: GATE, verifiedRoleId: V, unverifiedRoleId: 'none', strategy: 'verified', channelName: 'Get Verified!!' });
    assert.equal(picked.options.unverifiedRoleId, null);
    assert.equal(picked.options.createUnverified, false);
    assert.equal(picked.options.channelName, 'get-verified');
    assert.equal(normaliseWizardOptions({ strategy: 'sideways', mode: 'x', channelId: 'nope' }).errors.length, 3);
    assert.equal(normaliseWizardOptions({ verifiedRoleId: V, unverifiedRoleId: V }).errors.length, 1);
    assert.equal(channelSlug('***'), 'verify');
});

test('stats: counts and the verification rate', () => {
    const s = summariseStats([{ action: 'verify_passed', n: 8 }, { action: 'verify_failed', n: 1 }, { action: 'verify_expired', n: 1 },
        { action: 'verify_wrong', n: 5 }, { action: 'verify_kicked', n: 2 }, { action: 'prune_kicked', n: 3 }]);
    assert.equal(s.verified, 8);
    assert.equal(s.timedOut, 1);
    assert.equal(s.kicked, 2);
    assert.equal(s.pruned, 3);
    assert.equal(s.rate, 0.8);
    assert.equal(summariseStats([]).rate, null);
});

// ── auto-prune ───────────────────────────────────────────────────────────────

test('auto-prune settings: defaults, clamping, role lists', () => {
    const d = normalisePruneConfig(null);
    assert.deepEqual(d, { enabled: false, minutes: PRUNE_DEFAULT_MINUTES, action: 'kick', dm: true, bypassRoleIds: [], enabledAt: null });
    const c = normalisePruneConfig({ prune_enabled: 1, prune_minutes: 5, prune_action: 'log', prune_dm: 0, prune_bypass_roles: `["${V}","${V}","x"]`, prune_enabled_at: '2026-10-12T10:00:00Z' });
    assert.equal(c.minutes, 10);
    assert.equal(c.action, 'log');
    assert.deepEqual(c.bypassRoleIds, [V]);
    assert.equal(c.enabledAt, Date.parse('2026-10-12T10:00:00Z'));
    assert.equal(normalisePruneConfig({ prune_minutes: 99999 }).minutes, 20160);
    assert.deepEqual(parseRoleList(`${V}, ${U}`), [V, U]);
    assert.deepEqual(parseRoleList('{}'), []);
});

test('auto-prune validation: 10 min to 14 days, switching on and off is reported', () => {
    assert.equal(validatePruneSettings({ minutes: 9 }).errors.length, 1);
    assert.equal(validatePruneSettings({ minutes: 20161 }).errors.length, 1);
    assert.deepEqual(validatePruneSettings({ minutes: 10080 }).errors, [], 'a week is allowed');
    assert.equal(validatePruneSettings({ action: 'ban' }).errors.length, 1);
    const on = validatePruneSettings({ enabled: true, minutes: 240, bypassRoleIds: [V, 'junk'] }, { wasEnabled: false });
    assert.deepEqual(on.patch, { prune_minutes: 240, prune_bypass_roles: JSON.stringify([V]), prune_enabled: 1 });
    assert.ok(on.turnedOn && !on.turnedOff);
    const again = validatePruneSettings({ enabled: true }, { wasEnabled: true });
    assert.ok(!again.turnedOn, 're-saving does not restart the tracking period');
    assert.ok(validatePruneSettings({ enabled: false }, { wasEnabled: true }).turnedOff);
    assert.equal(validatePruneSettings({ bypassRoleIds: Array.from({ length: 26 }, (_, i) => String(100000000000000000n + BigInt(i))) }).errors.length, 1);
});

test('real roles: bypass roles, the bot\'s automatic roles and @everyone do not count', () => {
    const bypass = bypassSet({ bypassRoleIds: ['500000000000000005'], systemRoleIds: [U], everyoneId: G });
    assert.ok(!hasRealRole([G, U, '500000000000000005'], bypass));
    assert.ok(hasRealRole([G, U, V], bypass));
    assert.equal(firstRealRole([U, V], bypass), V);
    assert.equal(firstRealRole([U], bypass), null);
});

test('who goes on the queue: only real joins after switching on, without a real role', () => {
    const cfg = { enabled: true, enabledAt: 1000 };
    const bypass = bypassSet({ everyoneId: G, systemRoleIds: [U] });
    const base = { cfg, isBot: false, joinedAtMs: 2000, memberRoleIds: [G, U], bypass };
    assert.deepEqual(shouldTrack(base), { track: true, why: 'tracked' });
    assert.equal(shouldTrack({ ...base, cfg: { enabled: false } }).why, 'off');
    assert.equal(shouldTrack({ ...base, isBot: true }).why, 'bot');
    assert.equal(shouldTrack({ ...base, joinedAtMs: 999 }).why, 'before-enabled');
    assert.equal(shouldTrack({ ...base, memberRoleIds: [G, V] }).why, 'has-role');
    assert.equal(shouldTrack({ ...base, cfg: { enabled: true, enabledAt: null } }).track, true);
});

test('the verdict at the deadline', () => {
    const bypass = bypassSet({ everyoneId: G, systemRoleIds: [U] });
    const on = { enabled: true, action: 'kick' };
    const v = (o) => pruneVerdict({ cfg: on, inGuild: true, memberRoleIds: [G], bypass, elevated: false, ...o });
    assert.equal(v({ cfg: { enabled: false } }), 'cancelled');
    assert.equal(v({ inGuild: false }), 'left');
    assert.equal(v({ memberRoleIds: [G, V] }), 'passed');
    assert.equal(v({ memberRoleIds: [G, U] }), 'kick');
    assert.equal(v({ elevated: true }), 'exempt');
    assert.equal(v({ cfg: { enabled: true, action: 'log' } }), 'log');
    assert.equal(v({}), 'kick');
    assert.equal(formatMinutes(240), '4 h');
    assert.equal(formatMinutes(90), '1 h 30 min');
    assert.equal(formatMinutes(10), '10 min');
    assert.equal(formatMinutes(1440), '24 h');
    assert.equal(formatMinutes(10080), '7 d');
    assert.equal(formatMinutes(20160), '14 d');
    assert.equal(formatMinutes(3240), '2 d 6 h');
});

// ── migration 328 (fake db: records SQL, touches nothing) ────────────────────

function fakeDb({ columns = {}, enums = {}, indexes = {}, tables = [] } = {}) {
    const sql = [];
    return {
        sql,
        async execute(q, params = []) {
            sql.push(q.replace(/\s+/g, ' ').trim());
            if (/information_schema\.TABLES/.test(q)) return [tables.includes(params[0]) ? [{ 1: 1 }] : []];
            if (/COLUMN_TYPE AS t/.test(q)) return [enums[`${params[0]}.${params[1]}`] ? [{ t: enums[`${params[0]}.${params[1]}`] }] : []];
            if (/information_schema\.COLUMNS/.test(q)) return [(columns[params[0]] || []).includes(params[1]) ? [{ 1: 1 }] : []];
            if (/information_schema\.STATISTICS/.test(q)) return [(indexes[params[0]] || []).includes(params[1]) ? [{ 1: 1 }] : []];
            return [{ affectedRows: 0 }];
        },
    };
}

const BEFORE = {
    tables: ['temp_access_members'],
    columns: {
        verify_config: ['guild_id', 'verified_role_id', 'unverified_kick_days'],
        join_gate_config: ['guild_id', 'verification_role_id'],
        temp_access_members: ['id', 'guild_id', 'user_id'],
    },
    enums: {
        'join_gate_events.action': "enum('kicked_new','failed','avatar_queued','future_wave_x')",
        'temp_access_members.status': "enum('pending','passed','kicked','exempt','left','cancelled','error')",
        'temp_access_members.source': "enum('invite','role','manual')",
    },
    indexes: { temp_access_members: ['PRIMARY', 'uniq_guild_user', 'idx_due'] },
};

test('migration 328 adds what is missing, keeps every existing enum value, swaps the unique key', async () => {
    const db = fakeDb(BEFORE);
    await mig.up(db);
    const ddl = db.sql.filter(q => /^(ALTER|INSERT|UPDATE)/.test(q));
    for (const [name] of mig.VERIFY_COLUMNS) {
        const added = ddl.some(q => q.startsWith(`ALTER TABLE verify_config ADD COLUMN ${name} `));
        assert.equal(added, name !== 'unverified_kick_days', name);
    }
    for (const [name] of mig.PRUNE_COLUMNS) assert.ok(ddl.some(q => q.startsWith(`ALTER TABLE join_gate_config ADD COLUMN ${name} `)), name);
    const events = ddl.find(q => q.startsWith('ALTER TABLE join_gate_events MODIFY action'));
    assert.ok(events.includes("'future_wave_x'"), 'values added by other migrations survive');
    for (const v of mig.EVENT_ACTIONS_ADDED) assert.ok(events.includes(`'${v}'`), v);
    assert.ok(ddl.some(q => q.includes("ADD COLUMN kind ENUM('trial','prune','verify') NOT NULL DEFAULT 'trial'")));
    assert.ok(ddl.some(q => q === 'ALTER TABLE temp_access_members DROP INDEX uniq_guild_user, ADD UNIQUE KEY uniq_guild_user_kind (guild_id, user_id, kind)'));
    assert.ok(ddl.some(q => q === 'ALTER TABLE temp_access_members MODIFY expires_at TIMESTAMP NULL DEFAULT NULL'));
    assert.ok(ddl.some(q => q.includes("MODIFY status ENUM('pending','passed','kicked','exempt','left','cancelled','error','failed','expired')")));
    assert.ok(ddl.some(q => q.startsWith('INSERT IGNORE INTO verify_config')), 'the dead join_gate_config verification is folded in');
    assert.ok(!ddl.some(q => /DROP (TABLE|COLUMN)/.test(q)), 'nothing is dropped going up');
});

test('migration 328 run twice adds nothing the second time', async () => {
    const after = {
        tables: BEFORE.tables,
        columns: {
            verify_config: [...BEFORE.columns.verify_config, ...mig.VERIFY_COLUMNS.map(c => c[0])],
            join_gate_config: [...BEFORE.columns.join_gate_config, ...mig.PRUNE_COLUMNS.map(c => c[0])],
            temp_access_members: [...BEFORE.columns.temp_access_members, 'kind', 'attempts'],
        },
        enums: BEFORE.enums,
        indexes: { temp_access_members: ['PRIMARY', 'uniq_guild_user_kind', 'idx_guild_kind_status', 'idx_due'] },
    };
    const db = fakeDb(after);
    await mig.up(db);
    assert.ok(!db.sql.some(q => /ADD COLUMN|ADD UNIQUE|ADD INDEX/.test(q)));
    assert.deepEqual(mig.mergeEnum(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
});
