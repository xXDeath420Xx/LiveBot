import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * NSFW protection (wave 8): the two-stage decision, thresholds and settings, the daily cap and metering,
 * the overturn rules, the worker queue's backpressure, the classifier degrading when the model is not
 * installed, migration 330 (against a fake db that records SQL), and the wave's cleanup (raid protection
 * and NSFW in the shared protection lists).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsfw-'));
process.env.LOG_DIR ||= tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const L = await import('../core/nsfw-logic.js');
const { createJobQueue } = await import('../core/nsfw-queue.js');

// ── maths ───────────────────────────────────────────────────────────────────

test('softmax is stable and sums to one; bad input gives nothing', () => {
    const p = L.softmax([1000, 1000]);
    assert.ok(Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[0] + p[1] - 1) < 1e-9);
    assert.ok(L.softmax(new Float32Array([-2, 3]))[1] > 0.99);
    assert.deepEqual(L.softmax([]), []);
    assert.deepEqual(L.softmax([1, NaN]), []);
});

test('the NSFW probability reads each model\'s own label order', () => {
    // Marqo: index 0 is nsfw; Falconsai: index 1 is nsfw.
    assert.equal(L.nsfwProbability([0.9, 0.1], L.MODELS.screen), 0.9);
    assert.equal(L.nsfwProbability([0.9, 0.1], L.MODELS.judge), 0.1);
});

test('the minors check: never on the shipped models, fires on a labelled one', () => {
    assert.equal(L.modelHasMinorLabels(L.MODELS.screen), false);
    assert.equal(L.modelHasMinorLabels(L.MODELS.judge), false);
    assert.equal(L.minorSuspected([0.99, 0.01], L.MODELS.screen), false);
    const future = { labels: ['safe', 'adult', 'underage'], nsfwLabels: ['adult', 'underage'] };
    assert.equal(L.modelHasMinorLabels(future), true);
    assert.equal(L.minorSuspected([0.1, 0.2, 0.7], future), true);
    assert.equal(L.minorSuspected([0.6, 0.3, 0.1], future), false);
    assert.equal(L.modelHasMinorLabels({ labels: ['skidding', 'teenage_mutant'] }), false, 'whole words only');
});

test('pixels become normalised planar tensors', () => {
    const rgb = new Uint8Array([255, 0, 127, 0, 255, 255, 10, 20, 30, 0, 0, 0]);
    const t = L.toTensorData(rgb, 2);
    assert.equal(t.length, 12);
    assert.equal(t[0], 1);        // R of pixel 0
    assert.equal(t[1], -1);       // R of pixel 1
    assert.equal(t[4], -1);       // G of pixel 0 (plane 2 starts at 4)
    assert.ok(Math.abs(t[8] - (127 / 255 - 0.5) / 0.5) < 1e-6);
    assert.throws(() => L.toTensorData(new Uint8Array(5), 2));
});

test('animated images: the first and the middle frame', () => {
    assert.deepEqual(L.framesToCheck(1), [0]);
    assert.deepEqual(L.framesToCheck(undefined), [0]);
    assert.deepEqual(L.framesToCheck(2), [0, 1]);
    assert.deepEqual(L.framesToCheck(30), [0, 15]);
});

// ── thresholds + the two-stage decision ─────────────────────────────────────

test('thresholds clamp, and review never exceeds act', () => {
    assert.deepEqual(L.normaliseThresholds(0.9, 0.6), { act: 0.9, review: 0.6 });
    assert.deepEqual(L.normaliseThresholds(0.5, 0.2), { act: L.MIN_ACT, review: L.MIN_REVIEW });
    assert.deepEqual(L.normaliseThresholds(1.5, 0.95), { act: L.MAX_THRESHOLD, review: 0.95 });
    assert.deepEqual(L.normaliseThresholds(0.85, 0.95), { act: 0.85, review: 0.85 });
    assert.deepEqual(L.normaliseThresholds('x', null), { act: L.DEFAULT_ACT, review: L.MIN_REVIEW });
});

const T = { act: 0.9, review: 0.6 };

test('two-stage: action only when both models agree on the image AND its mirror', () => {
    const agree = { screen: 0.97, screenFlip: 0.95, judge: 0.96, judgeFlip: 0.93 };
    assert.equal(L.decide(agree, T).verdict, 'nsfw');
    assert.equal(L.decide(agree, T).confidence, 0.93);
    assert.equal(L.decide({ ...agree, judgeFlip: 0.85 }, T).verdict, 'review', 'judge mirror below act');
    assert.equal(L.decide({ ...agree, screenFlip: 0.7 }, T).verdict, 'review', 'screen mirror below act');
    assert.equal(L.decide({ ...agree, judge: 0.7, judgeFlip: 0.65 }, T).verdict, 'review', 'second model only borderline');
    assert.equal(L.decide({ ...agree, judge: 0.2, judgeFlip: 0.1 }, T).verdict, 'clean', 'second model clears it');
    assert.equal(L.decide({ ...agree, judge: 0.2, judgeFlip: 0.7 }, T).verdict, 'review', 'either reading of the second model keeps it borderline');
});

test('two-stage: below review is clean; a screen hit without the second model is review-only', () => {
    assert.equal(L.decide({ screen: 0.59 }, T).verdict, 'clean');
    assert.equal(L.decide({ screen: 0.2, judge: 0.99, judgeFlip: 0.99 }, T).verdict, 'clean', 'the screen gates everything');
    const noJudge = L.decide({ screen: 0.99, screenFlip: 0.99, judge: null, judgeFlip: null }, T);
    assert.equal(noJudge.verdict, 'review');
    assert.match(noJudge.why, /never acted on/);
    assert.equal(L.decide({ screen: 0.8, judge: null }, T).verdict, 'clean', 'no second model: only an act-level screen is queued');
    assert.equal(L.decide(null, T).verdict, 'clean');
    assert.equal(L.decide({ screen: 'x' }, T).verdict, 'clean');
});

test('two-stage: shapes measured on 1,200 real avatars', () => {
    // The screen alone at 0.94-0.96 on ordinary avatars with the second model near 0: cleared.
    assert.equal(L.decide({ screen: 0.951, screenFlip: 0.95, judge: 0.001, judgeFlip: 0.001 }, T).verdict, 'clean');
    assert.equal(L.decide({ screen: 0.944, screenFlip: 0.936, judge: 0.084, judgeFlip: 0.497 }, T).verdict, 'clean');
    // The models half agree: a human looks.
    assert.equal(L.decide({ screen: 0.941, screenFlip: 0.945, judge: 0.668, judgeFlip: 0.96 }, T).verdict, 'review');
    assert.equal(L.decide({ screen: 0.942, screenFlip: 0.94, judge: 0.99, judgeFlip: 0.847 }, T).verdict, 'review', 'mirror reading under act');
    // All four readings at 0.9+: acted on.
    assert.equal(L.decide({ screen: 0.934, screenFlip: 0.929, judge: 0.986, judgeFlip: 0.989 }, T).verdict, 'nsfw');
});

test('two-stage: a minors label wins over everything', () => {
    assert.equal(L.decide({ screen: 0.1, minor: true }, T).verdict, 'minor');
});

test('score lines are plain ASCII and say which model', () => {
    const line = L.scoreLine({ screen: 0.974, screenFlip: 0.95, judge: 0.9, judgeFlip: null });
    assert.equal(line, 'screen 97% (mirror 95%), second model 90%');
    assert.equal(L.scoreLine(null), 'not scored');
    assert.match(L.evidenceDetail({ scores: { screen: 0.9 }, decision: { verdict: 'nsfw' }, action: 'ban', outcome: 'banned' }), /^[\x20-\x7E]+$/);
});

// ── settings ────────────────────────────────────────────────────────────────

test('avatar settings: off and log-only by default; columns read when present', () => {
    const d = L.avatarSettingsFrom(null);
    assert.deepEqual(d, { enabled: false, action: 'log', act: 0.9, review: 0.6, dailyCap: L.DEFAULT_AVATAR_CAP, dm: true });
    const s = L.avatarSettingsFrom({ nsfw_avatar_enabled: 1, nsfw_avatar_action: 'BAN', nsfw_avatar_act_threshold: '0.950', nsfw_avatar_review_threshold: 0.5, nsfw_avatar_daily_cap: 5, nsfw_avatar_dm: 0 });
    assert.deepEqual(s, { enabled: true, action: 'ban', act: 0.95, review: 0.5, dailyCap: L.MIN_CAP, dm: false });
    assert.equal(L.avatarSettingsFrom({ nsfw_avatar_action: 'timeout' }).action, 'log', 'avatars have no timeout');
});

test('image settings: off and alert-only by default', () => {
    const d = L.imageSettingsFrom({});
    assert.deepEqual(d, { enabled: false, action: 'alert', timeoutMinutes: 60, act: 0.9, review: 0.6, reviewAlerts: false, dailyCap: L.DEFAULT_IMAGE_CAP });
    assert.equal(L.imageSettingsFrom({ nsfw_img_action: 'timeout', nsfw_img_timeout_minutes: 99999 }).timeoutMinutes, 40320);
});

test('settings patches are validated per surface', () => {
    assert.deepEqual(L.cleanNsfwPatch('avatar', { enabled: true, action: 'kick', dm: false }).values,
        { nsfw_avatar_enabled: 1, nsfw_avatar_action: 'kick', nsfw_avatar_dm: 0 });
    assert.equal(L.cleanNsfwPatch('avatar', { action: 'delete' }).ok, false);
    assert.equal(L.cleanNsfwPatch('image', { action: 'ban' }).ok, false, 'chat images never ban');
    assert.equal(L.cleanNsfwPatch('image', { act: 0.5 }).ok, false, 'act below 0.80 is not high confidence');
    assert.equal(L.cleanNsfwPatch('image', { review: 0.95 }, { act: 0.9, review: 0.6 }).ok, false, 'review above act');
    assert.deepEqual(L.cleanNsfwPatch('image', { act: 0.95 }, { act: 0.9, review: 0.6 }).values,
        { nsfw_img_act_threshold: 0.95, nsfw_img_review_threshold: 0.6 });
    assert.equal(L.cleanNsfwPatch('image', { dailyCap: 5 }).ok, false);
    assert.deepEqual(L.cleanNsfwPatch('image', { dailyCap: 300, timeoutMinutes: 15, reviewAlerts: true }).values,
        { nsfw_img_daily_cap: 300, nsfw_img_timeout_minutes: 15, nsfw_img_review_alerts: 1 });
    assert.equal(L.cleanNsfwPatch('image', { timeoutMinutes: 0 }).ok, false);
    assert.deepEqual(L.cleanNsfwPatch('avatar', { timeoutMinutes: 5, reviewAlerts: true }).values, {}, 'image-only keys ignored for avatars');
});

// ── cap + metering ──────────────────────────────────────────────────────────

test('the daily cap allows scans up to the limit, never below the minimum', () => {
    assert.deepEqual(L.capCheck(0, 100), { allowed: true, remaining: 100 });
    assert.deepEqual(L.capCheck(99, 100), { allowed: true, remaining: 1 });
    assert.deepEqual(L.capCheck(100, 100), { allowed: false, remaining: 0 });
    assert.deepEqual(L.capCheck(150, 100), { allowed: false, remaining: 0 });
    assert.equal(L.capCheck(5, 0).allowed, true, 'a zero / missing cap reads as the minimum, not unlimited');
    assert.equal(L.capCheck(L.MIN_CAP, 0).allowed, false);
});

test('meter increments map onto the server_stats columns; capped and dropped both count as skipped', () => {
    const pending = { avatar: { ...L.emptyMeter(), scanned: 3, nsfw: 1, capped: 2, dropped: 1, cached: 9 }, image: { ...L.emptyMeter(), scanned: 5, review: 2 } };
    assert.deepEqual(L.statsIncrements(pending), {
        nsfw_avatar_scans: 3, nsfw_avatar_hits: 1, nsfw_avatar_skipped: 3, nsfw_image_scans: 5, nsfw_image_reviews: 2,
    });
    assert.deepEqual(L.statsIncrements({}), {});
    assert.equal(L.ALL_STATS_COLUMNS.length, 8);
    assert.equal(L.dayKey(Date.UTC(2026, 9, 12, 23, 59)), '2026-10-12');
});

// ── overturn + decisions ────────────────────────────────────────────────────

test('overturn: unban a ban, lift a timeout, remove a flag; kicks and deletes cannot be undone', () => {
    assert.deepEqual(L.overturnPlan({ status: 'actioned', action_taken: 'ban' }), { ok: true, undo: 'unban', note: null });
    assert.equal(L.overturnPlan({ status: 'banned', action_taken: 'ban' }).undo, 'unban', 'a ban staff confirmed from review');
    assert.equal(L.overturnPlan({ status: 'actioned', action_taken: 'timeout' }).undo, 'untimeout');
    assert.equal(L.overturnPlan({ status: 'actioned', action_taken: 'flag' }).undo, 'unflag');
    const kick = L.overturnPlan({ status: 'actioned', action_taken: 'kick' });
    assert.equal(kick.undo, null);
    assert.match(kick.note, /cannot be undone/);
    assert.match(L.overturnPlan({ status: 'actioned', action_taken: 'delete' }).note, /cannot be restored/);
    assert.equal(L.overturnPlan({ status: 'overturned', action_taken: 'ban' }).ok, false);
    assert.equal(L.overturnPlan({ status: 'safe' }).ok, false);
    assert.equal(L.overturnPlan(null).ok, false);
});

test('decisions offered follow the entry\'s status', () => {
    assert.deepEqual(L.decisionsFor({ status: 'pending' }), ['ban', 'kick', 'safe', 'skip']);
    assert.deepEqual(L.decisionsFor({ status: 'actioned' }), ['overturn']);
    assert.deepEqual(L.decisionsFor({ status: 'overturned' }), []);
    assert.equal(L.avatarEventAction('ban'), 'nsfw_banned');
    assert.equal(L.avatarEventAction('overturn'), 'nsfw_overturned');
    assert.equal(L.avatarEventAction('anything'), 'nsfw_logged');
});

test('audit reasons are ASCII and age-restricted channels include threads in them', () => {
    assert.match(L.nsfwReason('avatar', '97% on two models'), /^[\x20-\x7E]+$/);
    assert.match(L.nsfwReason('minor'), /Trust and Safety/);
    assert.equal(L.isAgeRestricted({ nsfw: true }), true);
    assert.equal(L.isAgeRestricted({ nsfw: false, parent: { nsfw: true } }), true);
    assert.equal(L.isAgeRestricted({ nsfw: false, parent: null }), false);
    assert.equal(L.isAgeRestricted(null), false);
});

// ── the worker queue ────────────────────────────────────────────────────────

test('queue: bounded lanes drop at once instead of piling up', () => {
    const q = createJobQueue({ maxNormal: 2, maxPriority: 1 });
    assert.equal(q.offer('a', { now: 0 }), true);
    assert.equal(q.offer('b', { now: 0 }), true);
    assert.equal(q.offer('c', { now: 0 }), false, 'normal lane full');
    assert.equal(q.offer('p1', { priority: true, now: 0 }), true);
    assert.equal(q.offer('p2', { priority: true, now: 0 }), false, 'priority lane full');
    assert.equal(q.stats.dropped, 2);
    assert.equal(q.stats.droppedPriority, 1);
    assert.equal(q.depth, 3);
    assert.equal(q.stats.maxDepth, 3);
});

test('queue: priority first, then FIFO; stale jobs come back as expired', () => {
    const q = createJobQueue({ maxNormal: 5, maxPriority: 5, maxWaitMs: 100, maxPriorityWaitMs: 1000 });
    q.offer('old', { now: 0 });
    q.offer('n1', { now: 500 });
    q.offer('p1', { priority: true, now: 450 });
    let r = q.take(550);
    assert.equal(r.job, 'p1');
    assert.deepEqual(r.expired, []);
    r = q.take(550);
    assert.deepEqual(r.expired, ['old'], 'waited 550 ms > 100 ms');
    assert.equal(r.job, 'n1');
    r = q.take(560);
    assert.equal(r.job, null);
    assert.equal(q.stats.expired, 1);
    assert.equal(q.stats.started, 2);
});

test('queue: drain empties both lanes', () => {
    const q = createJobQueue();
    q.offer(1); q.offer(2, { priority: true });
    assert.deepEqual(q.drain().sort(), [1, 2]);
    assert.equal(q.depth, 0);
});

// ── the classifier without a model ──────────────────────────────────────────

test('classifier: degrades to "not installed" without the model, never throws', async () => {
    const c = await import('../core/nsfw-classifier.js');
    const st = await c.installState({ fresh: true });
    if (st.ready || st.partial) return; // installed on this machine: nothing to check here
    assert.ok(st.missing.length > 0);
    const r = await c.classify(Buffer.from('not an image'), { review: 0.6 });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'not_installed');
    const s = await c.status();
    assert.equal(s.installed, false);
    assert.equal(s.workers.running, 0, 'no worker is started without a model');
});

test('classifier: the picture key survives re-encoding and differs between pictures', async () => {
    const sharp = (await import('sharp')).default;
    const { imageKey } = await import('../core/nsfw-classifier.js');
    const raw = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256;
    const img = sharp(raw, { raw: { width: 64, height: 64, channels: 3 } });
    const png = await img.clone().png().toBuffer();
    const webp = await img.clone().webp({ lossless: true }).toBuffer();
    const other = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#335577' } }).png().toBuffer();
    const k = await imageKey(png);
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.equal(await imageKey(webp), k);
    assert.notEqual(await imageKey(other), k);
    await assert.rejects(() => imageKey(Buffer.from('nope')));
});

// ── migration 330 ───────────────────────────────────────────────────────────

function fakeDb({ columns = new Set(), enums = {} } = {}) {
    const sql = [];
    return {
        sql,
        async execute(q, params = []) {
            sql.push(q);
            if (q.includes('information_schema.TABLES')) return [[{ 1: 1 }]];
            if (q.includes('COLUMN_TYPE')) return [[enums[`${params[0]}.${params[1]}`] ? { t: enums[`${params[0]}.${params[1]}`] } : null].filter(Boolean)];
            if (q.includes('information_schema.COLUMNS')) return [columns.has(`${params[0]}.${params[1]}`) ? [{ 1: 1 }] : []];
            return [{ affectedRows: 0 }];
        },
    };
}

test('migration 330: adds every column, widens the enums, and only widens', async () => {
    const m = await import('../migrations/330_nsfw_cleanup.js');
    const enums = Object.fromEntries(m.ENUM_CHANGES.map(([t, c, before]) => [`${t}.${c}`, `enum(${before.map(v => `'${v}'`).join(',')})`]));
    const db = fakeDb({ enums });
    await m.up(db);
    const alters = db.sql.filter(q => q.startsWith('ALTER'));
    const adds = alters.filter(q => q.includes('ADD COLUMN'));
    assert.equal(adds.length, m.AVATAR_COLUMNS.length + m.IMAGE_COLUMNS.length + m.REVIEW_COLUMNS.length + m.STATS_COLUMNS.length);
    assert.ok(adds.some(q => q.startsWith('ALTER TABLE join_gate_config ADD COLUMN nsfw_avatar_enabled TINYINT(1) NOT NULL DEFAULT 0')));
    assert.ok(adds.some(q => q.startsWith('ALTER TABLE phishing_config ADD COLUMN nsfw_img_action')));
    assert.ok(adds.some(q => q.startsWith('ALTER TABLE server_stats ADD COLUMN nsfw_image_scans INT NOT NULL DEFAULT 0')));
    const mods = alters.filter(q => q.includes(' MODIFY '));
    assert.equal(mods.length, m.ENUM_CHANGES.length);
    for (const [t, c, before, after] of m.ENUM_CHANGES) {
        const q = mods.find(x => x.startsWith(`ALTER TABLE ${t} MODIFY ${c} `));
        assert.ok(q, `${t}.${c}`);
        for (const v of [...before, ...after]) assert.ok(q.includes(`'${v}'`), `${t}.${c} keeps ${v}`);
    }
    assert.ok(!db.sql.some(q => /^\s*(DROP|DELETE|UPDATE)\s|DROP COLUMN/i.test(q)), 'up() never removes anything');
});

test('migration 330: a re-run changes nothing, and an unknown live enum value stops it', async () => {
    const m = await import('../migrations/330_nsfw_cleanup.js');
    const all = new Set();
    for (const [t, cols] of [['join_gate_config', m.AVATAR_COLUMNS], ['phishing_config', m.IMAGE_COLUMNS], ['name_filter_reviews', m.REVIEW_COLUMNS], ['server_stats', m.STATS_COLUMNS]]) {
        for (const [c] of cols) all.add(`${t}.${c}`);
    }
    const done = Object.fromEntries(m.ENUM_CHANGES.map(([t, c, , after]) => [`${t}.${c}`, `enum(${after.map(v => `'${v}'`).join(',')})`]));
    const db = fakeDb({ columns: all, enums: done });
    await m.up(db);
    assert.equal(db.sql.filter(q => q.startsWith('ALTER')).length, 0);

    const odd = { ...Object.fromEntries(m.ENUM_CHANGES.map(([t, c, before]) => [`${t}.${c}`, `enum(${before.map(v => `'${v}'`).join(',')})`])) };
    odd['join_gate_events.action'] = odd['join_gate_events.action'].replace(')', ",'something_new')");
    await assert.rejects(() => m.up(fakeDb({ columns: all, enums: odd })), /does not know: something_new/);
});

// ── shared lists this wave extends ──────────────────────────────────────────

test('NSFW protection is on the security grid, the ban log and the global ban contexts', async () => {
    const { protectionsGrid, PROTECTION_GRID, eventGroup } = await import('../core/security-overview-logic.js');
    const keys = PROTECTION_GRID.map(g => g.key);
    assert.ok(keys.includes('nsfwAvatars') && keys.includes('nsfwImages'));
    const by = Object.fromEntries(protectionsGrid({ nsfwAvatars: { on: true, action: 'ban' }, nsfwImages: false }).map(g => [g.key, g]));
    assert.equal(by.nsfwAvatars.on, true);
    assert.equal(by.nsfwAvatars.detail, 'ban');
    assert.equal(by.nsfwAvatars.page, 'nsfw-protection');
    assert.equal(by.nsfwImages.on, false);
    assert.equal(eventGroup('nsfw_banned'), 'NSFW avatars');

    const { PROTECTIONS, EVENT_PROTECTION } = await import('../core/ban-log-logic.js');
    assert.equal(PROTECTIONS.nsfw.page, 'nsfw-protection');
    assert.equal(EVENT_PROTECTION.nsfw_banned, 'nsfw');

    const g = await import('../core/global-ban-confidence.js');
    assert.equal(g.contextFromLabel('NSFW avatar protection'), 'nsfw', 'not "avatar": an NSFW ban is not impersonation');
    assert.equal(g.contextFromLabel('Avatar protection'), 'avatar');
    assert.equal(g.contextFromReason(L.nsfwReason('avatar', '97% on two models')), 'nsfw');
    assert.ok(g.CONTEXT_WEIGHT.nsfw > 0 && g.CONTEXT_WEIGHT.nsfw < g.CONTEXT_WEIGHT.avatar);
});

test('message-threat settings carry the chat-image stage, validated', async () => {
    const mtl = await import('../core/message-threat-logic.js');
    assert.equal(mtl.settingsFrom(null).nsfw.enabled, false);
    assert.equal(mtl.settingsFrom({ nsfw_img_enabled: 1, nsfw_img_action: 'delete' }).nsfw.action, 'delete');
    const ok = mtl.cleanSettingsPatch({ nsfw_img_enabled: true, nsfw_img_act_threshold: 0.92, nsfw_img_daily_cap: 500, nsfw_img_action: 'timeout' });
    assert.deepEqual(ok, { ok: true, values: { nsfw_img_enabled: 1, nsfw_img_action: 'timeout', nsfw_img_act_threshold: 0.92, nsfw_img_daily_cap: 500 } });
    assert.equal(mtl.cleanSettingsPatch({ nsfw_img_action: 'ban' }).ok, false);
    assert.equal(mtl.cleanSettingsPatch({ nsfw_img_daily_cap: 1 }).ok, false);
    assert.match(mtl.threatReason('nsfw', '97%'), /^NSFW image in chat \(97%\)$/);
});

test('cleanup: nothing at runtime writes or reads anti_raid_config or raid_protection_config any more', () => {
    const ROOT = path.join(import.meta.dirname, '..');
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(js|ejs)$/.test(e.name)) files.push(p);
        }
    };
    for (const d of ['core', 'events', 'jobs', 'utils', 'dashboard', 'commands', 'interactions', 'handlers']) {
        if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    }
    const offenders = [];
    for (const f of files) {
        const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        // Both legacy raid tables were never enforced (raid_detection_config is the raid system) and may be dropped.
        if (/anti_raid_config|raid_protection_config/.test(code)) offenders.push(path.relative(ROOT, f));
    }
    assert.deepEqual(offenders, []);
});
