import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The "gaps" wave: the "manual action needed" cause classifier (core/manual-action-logic.js), the AI second
 * opinion's pure parts (core/ai-judge-logic.js: settings, prompts, reply parsing, decisions, rate and cap),
 * domain reports / disputes (core/domain-report-logic.js), name-filter and avatar-list export / import
 * (core/name-filter-logic.js, core/avatar-match-logic.js), the global allow-list overrides in
 * core/safe-domains.js, and migration 331 (against a fake db that records SQL).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-'));
process.env.LOG_DIR ||= tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MA = await import('../core/manual-action-logic.js');
const AI = await import('../core/ai-judge-logic.js');
const DR = await import('../core/domain-report-logic.js');
const NF = await import('../core/name-filter-logic.js');
const AV = await import('../core/avatar-match-logic.js');
const SD = await import('../core/safe-domains.js');

// ── manual action needed: the cause classifier ──────────────────────────────

const ALL = { ban: true, kick: true, timeout: true, delete: true, roles: true };

test('manual action: each missing permission is named exactly', () => {
    const c = (action, perms) => MA.classifyCannotAct({ action, botPerms: { ...ALL, ...perms }, botTop: 10, targetTop: 2 });
    assert.equal(c('ban', { ban: false }).cause, 'missing_permission');
    assert.match(c('ban', { ban: false }).text, /\*\*Ban Members\*\*/);
    assert.match(c('kick', { kick: false }).text, /\*\*Kick Members\*\*/);
    assert.match(c('timeout', { timeout: false }).text, /\*\*Moderate Members\*\*/);
    assert.match(c('delete', { delete: false }).text, /\*\*Manage Messages\*\* permission in that channel/);
    assert.match(c('flag', { roles: false }).text, /\*\*Manage Roles\*\*/);
    assert.equal(c('ban', { ban: false }).permission, 'Ban Members');
    assert.equal(c('ban', {}), null, 'everything in place: nothing to report');
});

test('manual action: role hierarchy, owner, admin timeout and members who left', () => {
    const base = { botPerms: ALL, botTop: 5, botTopName: 'CertiFried' };
    const h = MA.classifyCannotAct({ ...base, action: 'kick', targetTop: 9, targetTopName: 'Moderators', targetTopId: '42' });
    assert.equal(h.cause, 'hierarchy');
    assert.equal(h.roleId, '42');
    assert.match(h.text, /CertiFried.*Moderators/);
    assert.equal(MA.classifyCannotAct({ ...base, action: 'ban', targetTop: 5 }).cause, 'hierarchy', 'equal position is not below');
    assert.equal(MA.classifyCannotAct({ ...base, action: 'ban', targetTop: 1, targetOwner: true }).cause, 'owner');
    assert.equal(MA.classifyCannotAct({ ...base, action: 'timeout', targetTop: 1, targetAdmin: true }).cause, 'admin_timeout');
    assert.equal(MA.classifyCannotAct({ ...base, action: 'kick', targetTop: null }).cause, 'not_member');
    assert.equal(MA.classifyCannotAct({ ...base, action: 'ban', targetTop: null }), null, 'a ban works on someone who left');
    assert.equal(MA.classifyCannotAct({ ...base, action: 'delete', targetTop: 99 }), null, 'deleting a message ignores roles');
});

test('manual action: giving a role only needs the role below the bot', () => {
    const base = { botPerms: ALL, botTop: 5, botTopName: 'Bot' };
    const r = MA.classifyCannotAct({ ...base, action: 'flag', targetTop: 9, rolePosition: 7, roleName: 'Flagged', roleId: 'r1' });
    assert.equal(r.cause, 'role_hierarchy');
    assert.equal(r.roleId, 'r1');
    assert.match(r.text, /Flagged/);
    assert.equal(MA.classifyCannotAct({ ...base, action: 'flag', targetTop: 9, rolePosition: 2 }), null, 'a member above the bot can still be given a lower role');
    assert.equal(MA.classifyCannotAct({ ...base, action: 'quarantine', targetTop: 1, rolePosition: 1 }), null);
});

test('manual action: Discord errors become causes; others are not for staff', () => {
    assert.equal(MA.classifyError({ code: 50013 }, 'ban').cause, 'refused');
    assert.match(MA.classifyError({ code: 50013 }, 'kick').text, /Kick Members.*above/);
    assert.equal(MA.classifyError({ code: '50001' }, 'delete').cause, 'refused');
    assert.equal(MA.classifyError({ code: 10007 }, 'kick').cause, 'not_member');
    assert.equal(MA.classifyError({ code: 429 }, 'ban'), null);
    assert.equal(MA.classifyError(new Error('socket hang up'), 'ban'), null);
    assert.equal(MA.needsStaff({ cause: 'not_member' }), false);
    assert.equal(MA.needsStaff({ cause: 'hierarchy' }), true);
});

test('manual action: one alert per server per cause (and per permission / role)', () => {
    const k = (c) => MA.throttleKey('g1', c);
    assert.equal(k({ cause: 'missing_permission', permission: 'Ban Members' }), k({ cause: 'missing_permission', permission: 'Ban Members', text: 'other words' }));
    assert.notEqual(k({ cause: 'missing_permission', permission: 'Ban Members' }), k({ cause: 'missing_permission', permission: 'Kick Members' }));
    assert.notEqual(k({ cause: 'hierarchy', roleId: '1' }), k({ cause: 'hierarchy', roleId: '2' }));
    assert.notEqual(MA.throttleKey('g1', { cause: 'owner' }), MA.throttleKey('g2', { cause: 'owner' }));
});

test('manual action: message threats keeps its cannotAct API (re-exported)', async () => {
    const MT = await import('../core/message-threat-logic.js');
    assert.equal(MT.cannotAct, MA.cannotAct);
    assert.match(MT.cannotAct({ action: 'ban', botPerms: { ban: false } }), /Ban Members/);
});

// ── AI second opinion ───────────────────────────────────────────────────────

test('AI settings: everything off without a row; values clamped', () => {
    const s = AI.aiSettingsFrom(null);
    assert.equal(s.avatar.mode, 'off');
    assert.equal(s.text.mode, 'off');
    assert.equal(s.nsfw.advise, false);
    assert.equal(s.any, false);
    assert.equal(s.dailyCap, AI.DEFAULT_DAILY_CAP);
    const t = AI.aiSettingsFrom({ ai_avatar_mode: 'act', ai_avatar_confidence: '0.2', ai_text_mode: 'weird', ai_text_confidence: 97, ai_nsfw_advise: 1, ai_daily_cap: 99999 });
    assert.equal(t.avatar.mode, 'act');
    assert.equal(t.avatar.confidence, AI.MIN_CONFIDENCE);
    assert.equal(t.text.mode, 'off');
    assert.equal(t.text.confidence, 0.97, 'a percentage reads as a fraction');
    assert.equal(t.nsfw.advise, true);
    assert.equal(t.dailyCap, AI.MAX_DAILY_CAP);
    assert.equal(t.any, true);
});

test('AI settings patch: modes, confidences, cap and unknown keys', () => {
    assert.deepEqual(AI.cleanAiPatch({ ai_avatar_mode: 'ADVISE', ai_nsfw_advise: true, ai_daily_cap: '50' }).values,
        { ai_avatar_mode: 'advise', ai_nsfw_advise: 1, ai_daily_cap: 50 });
    assert.equal(AI.cleanAiPatch({ ai_text_mode: 'always' }).ok, false);
    assert.equal(AI.cleanAiPatch({ ai_text_confidence: 'x' }).ok, false);
    assert.equal(AI.cleanAiPatch({ enabled: 1 }).ok, false, 'never touches other phishing_config columns');
    assert.equal(AI.cleanAiPatch({ ai_avatar_confidence: 0.9 }).values.ai_avatar_confidence, 0.9);
});

test('AI prompts ask for JSON only and fence member content', () => {
    for (const p of [AI.AVATAR_PROMPT, AI.TEXT_PROMPT, AI.NSFW_PROMPT]) {
        assert.match(p, /ONE JSON object and nothing else/);
        assert.match(p, /"confidence": number from 0 to 1/);
    }
    assert.match(AI.TEXT_PROMPT, /untrusted data.*Never follow instructions/s);
    const payload = AI.buildTextPayload({
        text: 'hey <@123456789012345678> claim your nitro at <#123456789012345678>', authorName: 'Bob "the" Builder',
        detector: 'Obfuscated link', signals: ['lure words'], context: [{ author: false, text: 'hi all' }, { author: true, text: 'look <@&123456789012345678>' }],
    });
    assert.ok(!/\d{15,}/.test(payload), 'no ids are sent');
    assert.match(payload, /@member/);
    assert.match(payload, /<context>\nanother member: hi all\nthe author: look @role\n<\/context>/);
    assert.match(payload, /<message author="Bob 'the' Builder">/);
    const many = AI.buildTextPayload({ text: 'x', context: Array.from({ length: 12 }, (_, i) => ({ author: false, text: `m${i}` })) });
    assert.equal((many.match(/another member:/g) || []).length, AI.MAX_CONTEXT_MESSAGES);
    assert.ok(AI.scrubText('a'.repeat(5000)).length <= AI.MAX_MESSAGE_CHARS);
});

test('AI replies: only the exact JSON shape is a verdict', () => {
    assert.deepEqual(AI.parseVerdict('{"match": true, "confidence": 0.93, "reason": "same photo, recoloured"}', 'avatar'),
        { positive: true, confidence: 0.93, reason: 'same photo, recoloured' });
    assert.deepEqual(AI.parseVerdict('```json\n{"scam": false, "confidence": 80, "reason": "a warning"}\n```', 'text'),
        { positive: false, confidence: 0.8, reason: 'a warning' });
    assert.equal(AI.parseVerdict('{"scam": true, "confidence": 7}', 'text').confidence, 0.07, '7 on a 100 scale');
    assert.equal(AI.parseVerdict('{"scam": true, "confidence": 0.9}', 'avatar'), null, 'wrong field for the surface');
    assert.equal(AI.parseVerdict('{"scam": "maybe", "confidence": 0.9}', 'text'), null);
    assert.equal(AI.parseVerdict('{"scam": true}', 'text'), null, 'no confidence, no verdict');
    assert.equal(AI.parseVerdict('{"scam": true, "confidence": null}', 'text'), null);
    assert.equal(AI.parseVerdict('Sure! It is a scam.', 'text'), null);
    assert.equal(AI.parseVerdict('[{"scam": true, "confidence": 1}]', 'text'), null);
    assert.equal(AI.parseVerdict(null, 'text'), null);
    assert.equal(AI.parseVerdict('{"nsfw": true, "confidence": 5000, "reason": "x"}', 'nsfw').confidence, 1, 'clamped');
    const long = AI.parseVerdict(`{"nsfw": false, "confidence": 0.5, "reason": "${'y'.repeat(900)}"}`, 'nsfw');
    assert.ok(long.reason.length <= AI.MAX_REASON);
});

test('AI replies: blocked or empty Gemini responses are no verdict', () => {
    assert.equal(AI.replyText({ promptFeedback: { blockReason: 'SAFETY' } }), null);
    assert.equal(AI.replyText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '{}' }] } }] }), null);
    assert.equal(AI.replyText({ candidates: [] }), null);
    assert.equal(AI.replyText({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking', thought: true }, { text: '{"a":1}' }] } }] }), '{"a":1}');
});

test('AI decisions: off, fail open, advise, and act only when everything agrees', () => {
    const yes = { positive: true, confidence: 0.95 };
    assert.equal(AI.decide({ mode: 'off', verdict: yes }), 'off');
    assert.equal(AI.decide({ mode: 'act', verdict: null }), 'none', 'no verdict changes nothing');
    assert.equal(AI.decide({ mode: 'advise', verdict: yes }), 'advise');
    assert.equal(AI.decide({ mode: 'act', verdict: yes, confidence: 0.9 }), 'act');
    assert.equal(AI.decide({ mode: 'act', verdict: { positive: true, confidence: 0.89 }, confidence: 0.9 }), 'advise');
    assert.equal(AI.decide({ mode: 'act', verdict: { positive: false, confidence: 0.99 }, confidence: 0.9 }), 'advise');
    assert.equal(AI.decide({ mode: 'act', verdict: yes, confidence: 0.9, eligible: false }), 'advise', 'the hash score must be past review');
    assert.equal(AI.verdictWord('avatar', yes), 'match');
    assert.equal(AI.verdictWord('text', { positive: false }), 'not_scam');
    assert.match(AI.verdictLine('nsfw', { positive: true, confidence: 0.5, reason: 'r' }), /^Explicit, 50%: r$/);
});

test('AI rate window, daily cap and keys', () => {
    let times = [];
    for (let i = 0; i < 3; i++) { const r = AI.takeSlot(times, 1000 + i, 3); assert.ok(r.ok); times = r.times; }
    assert.equal(AI.takeSlot(times, 2000, 3).ok, false);
    assert.equal(AI.takeSlot(times, 61_500, 3).ok, true, 'a minute later the window is clear');
    assert.equal(AI.capAllows(99, 100), true);
    assert.equal(AI.capAllows(100, 100), false);
    assert.equal(AI.textKey('Free  NITRO here'), AI.textKey(' free nitro HERE '));
    assert.notEqual(AI.textKey('a'), AI.textKey('b'));
    assert.deepEqual(AI.dataUriPart('data:image/webp;base64,QUJD'), { mime_type: 'image/webp', data: 'QUJD' });
    assert.equal(AI.dataUriPart('data:text/html;base64,QUJD'), null);
    assert.equal(AI.sniffImage(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
    assert.equal(AI.sniffImage(Buffer.from('RIFF0000WEBPVP8 ', 'latin1')), 'image/webp');
    assert.equal(AI.sniffImage(Buffer.from('<html>hello world</html>')), null);
});

test('AI judge: no key means no request and no verdict (fail open)', async () => {
    // Imported first: the db module loads .env, which would put the key straight back.
    const judge = await import('../core/ai-judge.js');
    const saved = [process.env.GOOGLE_API_KEY, process.env.GOOGLE_AI_KEY];
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_AI_KEY;
    try {
        assert.equal(judge.isConfigured(), false);
        const r = await judge.judgeScamText('1', { text: 'free nitro' });
        assert.deepEqual(r, { verdict: null, status: 'not_configured' });
        const n = await judge.judgeNsfw('1', { buffer: Buffer.alloc(20), minorSuspected: true });
        assert.equal(n.verdict, null, 'never for a suspected minor');
        assert.equal(judge.isAgeRestricted({ nsfw: true }), true);
        assert.equal(judge.isAgeRestricted({ nsfw: false, parent: { nsfw: true } }), true);
        assert.equal(judge.isAgeRestricted({ nsfw: false }), false);
    } finally {
        if (saved[0] !== undefined) process.env.GOOGLE_API_KEY = saved[0];
        if (saved[1] !== undefined) process.env.GOOGLE_AI_KEY = saved[1];
    }
});

// ── domain reports / disputes ───────────────────────────────────────────────

test('domain reports: hosts are real domains', () => {
    assert.equal(DR.hostOf('https://www.Evil-Site.com/login?x=1'), 'evil-site.com');
    assert.equal(DR.hostOf('sub.example.co.uk'), 'sub.example.co.uk');
    assert.equal(DR.hostOf('not a domain'), '');
    assert.equal(DR.hostOf('localhost'), '');
    assert.equal(DR.hostOf(''), '');
});

test('domain reports: reports and disputes are validated against the lists', () => {
    const why = 'it asks for my Discord login';
    const ok = DR.validateSubmission({ kind: 'report', url: 'https://free-nitro.gift/claim', reason: why });
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'phishing_url');
    assert.equal(ok.host, 'free-nitro.gift');
    assert.equal(DR.validateSubmission({ kind: 'report', url: 'x.com', reason: why, safe: 'builtin' }).ok, false, 'platforms cannot be reported');
    assert.match(DR.validateSubmission({ kind: 'report', url: 'evil.com', reason: why, listedAs: 'evil.com' }).error, /already blocked/);
    assert.match(DR.validateSubmission({ kind: 'dispute', url: 'fine.com', reason: why }).error, /not on the phishing list/);
    const d = DR.validateSubmission({ kind: 'dispute', url: 'https://cdn.listed.net/x', reason: 'it is our own CDN, really', listedAs: 'listed.net' });
    assert.equal(d.kind, 'domain_dispute');
    assert.equal(d.host, 'listed.net', 'the dispute is about the listed entry');
    assert.match(DR.validateSubmission({ kind: 'report', url: 'evil.com', reason: 'bad' }).error, /at least/);
    assert.equal(DR.validateSubmission({ kind: 'nonsense', url: 'evil.com', reason: why }).ok, false);
});

test('domain reports: approval plans, history and the reporter\'s message', () => {
    assert.deepEqual(DR.approvalPlan('phishing_url'), { override: 'block', status: 'blocked' });
    assert.deepEqual(DR.approvalPlan('domain_dispute'), { override: 'allow', status: 'resolved' });
    let h = null;
    for (let i = 0; i < DR.MAX_HISTORY + 5; i++) h = DR.historyAppend(h, { by: 'u', action: `a${i}`, at: 't' });
    const list = DR.parseHistory(h);
    assert.equal(list.length, DR.MAX_HISTORY);
    assert.equal(list.at(-1).action, `a${DR.MAX_HISTORY + 4}`);
    assert.deepEqual(DR.parseHistory('not json'), []);
    assert.match(DR.outcomeMessage({ id: 7, kind: 'domain_dispute', domain: 'ok.com', status: 'resolved', note: 'thanks' }), /dispute.*ok\.com.*#7.*block is lifted.*thanks/s);
    assert.match(DR.outcomeMessage({ id: 8, kind: 'phishing_url', domain: 'bad.com', status: 'rejected' }), /report of \*\*bad\.com\*\*.*not approved/);
    let times = [];
    for (let i = 0; i < DR.PER_USER_PER_HOUR; i++) { const r = DR.rateAllows(times, 1000); assert.ok(r.ok); times = [...r.times, 1000]; }
    assert.equal(DR.rateAllows(times, 2000).ok, false);
    assert.equal(DR.rateAllows(times, 1000 + 3_600_001).ok, true);
});

test('safe domains: dispute overrides join the never-flag check and can be removed', () => {
    SD.setOverrideSafeDomains([]);
    assert.equal(SD.isSafeDomain('our-cdn.example'), false);
    SD.setOverrideSafeDomains(['https://www.Our-CDN.example/']);
    assert.equal(SD.safeSource('our-cdn.example'), 'override');
    assert.equal(SD.safeSource('img.our-cdn.example'), 'override', 'subdomains too');
    assert.equal(SD.safeSource('discord.com'), 'builtin');
    assert.equal(SD.isSafeDomain('our-cdn.example.evil.com'), false, 'a suffix trick is not a subdomain');
    assert.deepEqual(SD.overrideSafeDomains(), ['our-cdn.example']);
    SD.setOverrideSafeDomains([]);
    assert.equal(SD.isSafeDomain('our-cdn.example'), false);
});

// ── name filter export / import ─────────────────────────────────────────────

test('name filters: export keeps only the server\'s own filters, versioned', () => {
    const out = NF.buildNameExport([
        { type: 'phrase', pattern: 'support team', action: 'ban', caseSensitive: false, note: 'n', enabled: true, origin: 'manual', removed: false },
        { type: 'exact', pattern: 'Mod', action: 'log', origin: 'template', removed: false },
        { type: 'exact', pattern: 'Alice', action: 'log', origin: 'auto', removed: false },
        { type: 'regex', pattern: '^old$', action: 'log', origin: 'manual', removed: true },
    ], { guildId: '1', now: 0 });
    assert.equal(out.format, NF.NAME_EXPORT_FORMAT);
    assert.equal(out.version, NF.NAME_EXPORT_VERSION);
    assert.equal(out.exportedAt, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(out.filters, [{ type: 'phrase', pattern: 'support team', action: 'ban', caseSensitive: false, note: 'n', enabled: true }]);
});

test('name filters: import previews adds, duplicates, safety rejections and the limit', () => {
    const file = {
        format: NF.NAME_EXPORT_FORMAT, version: 1, filters: [
            { type: 'phrase', pattern: 'support   team', action: 'ban' },
            { type: 'phrase', pattern: 'support team', action: 'kick' },
            { type: 'phrase', pattern: 'already here' },
            { type: 'regex', pattern: '(a+)+$' },
            { type: 'regex', pattern: 'x*' },
            { type: 'phrase', pattern: 'ab' },
            { type: 'magic', pattern: 'whatever' },
            { type: 'exact', pattern: 'Fake Admin', action: 'nonsense', caseSensitive: true },
            { type: 'phrase', pattern: 'one too many' },
        ],
    };
    const plan = NF.planNameImport(JSON.stringify(file), [{ type: 'phrase', pattern: 'already here' }], { room: 2 });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.add.map(a => a.pattern), ['support team', 'Fake Admin']);
    assert.equal(plan.add[0].action, 'ban');
    assert.equal(plan.add[1].action, 'log', 'unknown actions fall back to log');
    assert.equal(plan.add[1].caseSensitive, true);
    assert.deepEqual(plan.duplicates.map(d => d.pattern), ['support team', 'already here'], 'in the file twice, and already on the server');
    assert.equal(plan.rejected.length, 4);
    assert.ok(plan.rejected.some(r => /Refused/.test(r.why)), 'the regex safety rules apply');
    assert.ok(plan.rejected.some(r => /unknown type/.test(r.why)));
    assert.deepEqual(plan.overCap.map(o => o.pattern), ['one too many']);
});

test('name filters: import refuses other files and versions', () => {
    assert.match(NF.planNameImport('{not json').error, /not valid JSON/);
    assert.match(NF.planNameImport({ format: 'something', version: 1, filters: [] }).error, /not a name-filter export/);
    assert.match(NF.planNameImport({ format: NF.NAME_EXPORT_FORMAT, version: 2, filters: [] }).error, /Unsupported export version 2/);
    assert.match(NF.planNameImport({ format: NF.NAME_EXPORT_FORMAT, version: 1 }).error, /no filter list/);
    const big = { format: NF.NAME_EXPORT_FORMAT, version: 1, filters: Array.from({ length: NF.MAX_IMPORT_ENTRIES + 1 }, () => ({})) };
    assert.match(NF.planNameImport(big).error, /at most/);
});

// ── avatar list export / import (fingerprints only) ─────────────────────────

const V = 'a'.repeat(160);
const row = (o) => ({ kind: 'avatar', label: 'Staff', dhash: '0123456789abcdef', bits_set: 31, colour_sig: 'b'.repeat(96), exact_sha: 'c'.repeat(64), avatar_fp: `${V},${'d'.repeat(160)}`, removed_at: null, ...o });

test('avatar list: export carries fingerprints and labels, never pictures', () => {
    const out = AV.buildAvatarExport([row({ thumb: 'data:image/webp;base64,AAA' }), row({ kind: 'scam_avatar', avatar_fp: null, label: 'Scam' }), row({ removed_at: new Date() })]);
    assert.equal(out.format, AV.AVATAR_EXPORT_FORMAT);
    assert.equal(out.images.length, 2);
    assert.ok(!JSON.stringify(out).includes('data:image'), 'no thumbnails');
    assert.equal(out.images[0].kind, 'protected');
    assert.equal(out.images[0].fingerprint, `${V},${'d'.repeat(160)}`);
    assert.equal(out.images[1].kind, 'scam');
    assert.equal(out.images[1].fingerprint, null);
});

test('avatar list: import round-trips and rejects damaged entries', () => {
    const file = AV.buildAvatarExport([row(), row({ kind: 'scam_avatar', avatar_fp: null, exact_sha: 'e'.repeat(64) }), row({ dhash: 'ffffffffffffffff', label: 'Second' })]);
    file.images.push({ kind: 'protected', dhash: 'zz', bits: 3, colour: 'b'.repeat(96), fingerprint: V });
    file.images.push({ kind: 'protected', dhash: '1111111111111111', bits: 3, colour: 'b'.repeat(96), fingerprint: 'nope' });
    file.images.push({ kind: 'scam', dhash: '1111111111111111', bits: 3, colour: 'b'.repeat(96), sha: 'short' });
    file.images.push({ kind: 'scam', dhash: '1111111111111111', bits: 3, colour: 'b'.repeat(96), sha: AV.BUILTIN_SCAM_AVATARS[0].sha });
    file.images.push({ kind: 'gif', dhash: '1111111111111111' });
    const existing = [{ kind: 'avatar', dhash: '0123456789abcdef', exact_sha: 'c'.repeat(64) }];
    const plan = AV.planAvatarImport(JSON.stringify(file), existing, { room: 5 });
    assert.equal(plan.ok, true);
    assert.equal(plan.add.length, 2);
    assert.deepEqual(plan.add.map(a => a.kind).sort(), ['avatar', 'scam_avatar']);
    assert.equal(plan.add.find(a => a.kind === 'avatar').label, 'Second');
    assert.equal(plan.duplicates.length, 2, 'already on the server, and a built-in scam avatar');
    assert.equal(plan.rejected.length, 4);
    const tight = AV.planAvatarImport(file, [], { room: 1 });
    assert.equal(tight.add.filter(a => a.kind === 'avatar').length, 1);
    assert.equal(tight.overCap.length, 1);
    assert.match(AV.planAvatarImport({ format: 'x' }).error, /not an avatar-protection export/);
});

// ── migration 331 ───────────────────────────────────────────────────────────

function fakeDb({ columns = new Set(), enums = {}, indexes = new Set() } = {}) {
    const sql = [];
    return {
        sql,
        async execute(q, params = []) {
            sql.push(q);
            if (q.includes('information_schema.TABLES')) return [[{ 1: 1 }]];
            if (q.includes('information_schema.STATISTICS')) return [indexes.has(`${params[0]}.${params[1]}`) ? [{ 1: 1 }] : []];
            if (q.includes('COLUMN_TYPE')) return [[enums[`${params[0]}.${params[1]}`] ? { t: enums[`${params[0]}.${params[1]}`] } : null].filter(Boolean)];
            if (q.includes('information_schema.COLUMNS')) return [columns.has(`${params[0]}.${params[1]}`) ? [{ 1: 1 }] : []];
            return [{ affectedRows: 0 }];
        },
    };
}

test('migration 331: adds every column and the index, widens the enums, and only widens', async () => {
    const m = await import('../migrations/331_gaps.js');
    const enums = Object.fromEntries(m.ENUM_CHANGES.map(([t, c, before]) => [`${t}.${c}`, `enum(${before.map(v => `'${v}'`).join(',')})`]));
    const db = fakeDb({ enums });
    await m.up(db);
    const alters = db.sql.filter(q => q.startsWith('ALTER'));
    const adds = alters.filter(q => q.includes('ADD COLUMN'));
    assert.equal(adds.length, m.AI_COLUMNS.length + m.REVIEW_COLUMNS.length + m.STATS_COLUMNS.length + m.REPORT_COLUMNS.length);
    assert.ok(adds.includes("ALTER TABLE phishing_config ADD COLUMN ai_avatar_mode ENUM('off','advise','act') NOT NULL DEFAULT 'off'"));
    assert.ok(adds.includes('ALTER TABLE phishing_config ADD COLUMN ai_daily_cap INT NOT NULL DEFAULT 100'));
    assert.ok(adds.includes('ALTER TABLE name_filter_reviews ADD COLUMN ai_verdict VARCHAR(12) DEFAULT NULL'));
    assert.ok(adds.includes('ALTER TABLE server_stats ADD COLUMN ai_text_calls INT NOT NULL DEFAULT 0'));
    assert.ok(adds.some(q => q.startsWith('ALTER TABLE scam_reports ADD COLUMN domain VARCHAR(255)')));
    const mods = alters.filter(q => q.includes(' MODIFY '));
    assert.equal(mods.length, m.ENUM_CHANGES.length);
    for (const [t, c, before, after] of m.ENUM_CHANGES) {
        const q = mods.find(x => x.startsWith(`ALTER TABLE ${t} MODIFY ${c} `));
        assert.ok(q, `${t}.${c}`);
        for (const v of [...before, ...after]) assert.ok(q.includes(`'${v}'`), `${t}.${c} keeps ${v}`);
    }
    assert.ok(mods.find(q => q.includes('MODIFY report_type')).endsWith('NOT NULL'));
    assert.ok(mods.find(q => q.includes('MODIFY status')).endsWith("DEFAULT 'pending'"));
    assert.ok(alters.includes(m.REPORT_INDEX[1]));
    assert.ok(!db.sql.some(q => /^\s*(DROP|DELETE|UPDATE)\s|DROP COLUMN|DROP INDEX/i.test(q)), 'up() never removes anything');
});

test('migration 331: a re-run changes nothing, and an unknown live enum value stops it', async () => {
    const m = await import('../migrations/331_gaps.js');
    const all = new Set();
    for (const [t, cols] of [['phishing_config', m.AI_COLUMNS], ['name_filter_reviews', m.REVIEW_COLUMNS], ['server_stats', m.STATS_COLUMNS], ['scam_reports', m.REPORT_COLUMNS]]) {
        for (const [c] of cols) all.add(`${t}.${c}`);
    }
    const done = Object.fromEntries(m.ENUM_CHANGES.map(([t, c, , after]) => [`${t}.${c}`, `enum(${after.map(v => `'${v}'`).join(',')})`]));
    const db = fakeDb({ columns: all, enums: done, indexes: new Set(['scam_reports.idx_type_domain']) });
    await m.up(db);
    assert.equal(db.sql.filter(q => q.startsWith('ALTER')).length, 0);

    const odd = Object.fromEntries(m.ENUM_CHANGES.map(([t, c, before]) => [`${t}.${c}`, `enum(${before.map(v => `'${v}'`).join(',')})`]));
    odd['scam_reports.status'] = odd['scam_reports.status'].replace(')', ",'escalated')");
    await assert.rejects(() => m.up(fakeDb({ columns: all, enums: odd })), /does not know: escalated/);
});

// ── the protections grid ────────────────────────────────────────────────────

test('security overview: the AI second opinion is in the protections grid', async () => {
    const { protectionsGrid, PROTECTION_GRID } = await import('../core/security-overview-logic.js');
    assert.ok(PROTECTION_GRID.some(g => g.key === 'aiJudge' && g.page === 'protection-settings'));
    const by = Object.fromEntries(protectionsGrid({ aiJudge: { on: true, action: 'avatars act' } }).map(g => [g.key, g]));
    assert.equal(by.aiJudge.on, true);
    assert.equal(by.aiJudge.detail, 'avatars act');
    assert.equal(Object.fromEntries(protectionsGrid({}).map(g => [g.key, g])).aiJudge.on, null);
});
