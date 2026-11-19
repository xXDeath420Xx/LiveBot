import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeMessage, scoreLure, countEmoji, mightContainLink, LURE_MIN } from '../core/obfuscated-url.js';
import {
    settingsFrom, cleanSettingsPatch, scoreEscalation, breakerCheck, breakerRecord, underBreaker, qrUrls, qrDecision,
    explainUrl, validateOcrRule, matchOcrRules, cannotAct, threatReason, automodRuleSpec, isIgnored, everyoneAuthorised,
    AUTOMOD_REGEXES, BREAKER_LIMIT, BREAKER_WINDOW_MS, wantsImages,
} from '../core/message-threat-logic.js';
import { up, down, CONFIG_COLUMNS, DETECTION_COLUMNS, ENUM_CHANGES } from '../migrations/327_message_threats.js';

// Real-world shapes of the "fake support" copypasta (invite codes changed).
const SCAMS = [
    ['userinfo', 'Hello, your account has been flagged for review. Please open a ticket with our support team: https://@discord.gg/abc123'],
    ['slashes', 'Need help? Contact support https:////discord.gg/helpdesk'],
    ['line_split', 'Appeal here: https://disc\nord.gg/appeal123 our mods will help you'],
    ['odd_dot', 'Open a ticket with staff: discord。gg/support'],
    ['odd_dot', 'Open a ticket with staff: discord．gg/support'],
    ['spacing', 'Contact the moderators to resolve your issue: dis cord.gg/modteam'],
    ['spacing', 'Support: d i s c o r d . g g / a b c ticket'],
    ['percent', 'Support ticket: https://%64%69%73%63%6f%72%64.gg/abcd'],
    ['backslash', 'Our support team: https:\\\\discord.gg/xyz help'],
    ['lookalike', 'dіscord.gg/abc support ticket'],
    ['zero_width', 'Appeal your ban with the mod team: disc​ord.gg/appeals'],
    ['line_split', 'Our staff can help, open a ticket\nd\ni\ns\nc\no\nr\nd\n.\ng\ng\n/\nx\ny\nz'],
];

test('obfuscation detector: the fake-support copypasta is confirmed, with the technique named', () => {
    for (const [technique, text] of SCAMS) {
        const a = analyzeMessage(text);
        assert.equal(a.verdict, 'confirmed', `${JSON.stringify(text)} → ${a.verdict} ${a.techniques}`);
        assert.ok(a.discordTarget, text);
        assert.ok(a.techniques.includes(technique), `${JSON.stringify(text)} techniques ${a.techniques}`);
        assert.ok(a.lure.score >= LURE_MIN);
    }
});

test('obfuscation detector: a userinfo trick pointing at another host is confirmed with a lure', () => {
    const a = analyzeMessage('Support ticket here https://discord.com@evil.example.com/login');
    assert.equal(a.verdict, 'confirmed');
    assert.deepEqual(a.hiddenHosts, ['evil.example.com']);
    assert.ok(a.techniques.includes('userinfo'));
});

test('obfuscation detector: negatives — plain links, plain invites, defanged links, code blocks, ordinary chat', () => {
    const negatives = [
        'check out my server discord.gg/abc123',
        'Need help? Join our support server: https://discord.gg/abc123',
        'Our support ticket bot: https://discord.com/invite/tickets',
        'see https://example.com\nthanks for the help, mods',
        'I love discord. Gg everyone, support the mods',
        'visit https://google.com and https://youtube.com/watch?v=1',
        'support ticket: ```https:////discord.gg/abc```',
        'mods please help, `https://@discord.gg/x` is the scam going round',
        'Ticket #4521 resolved by staff, thanks for the help!',
        'https://www.reddit.com/r/discordapp/comments/abc/support_ticket_help/',
        '',
    ];
    for (const text of negatives) {
        const a = analyzeMessage(text);
        assert.equal(a.verdict, 'none', `${JSON.stringify(text)} → ${a.verdict} ${a.techniques}`);
        assert.equal(a.obfuscated, false, text);
    }
});

test('defanged links are recognised but never treated as obfuscation (no auto-ban on quoted links)', () => {
    for (const text of [
        'scam link: hxxps://discord[.]gg/fakesupport — report it to mods, do not open a ticket there',
        'WARNING support scam: discord(.)gg/helpdesk staff will never DM you',
        'appeal scam: hxxp://evil[.]example[.]com ticket support',
    ]) {
        const a = analyzeMessage(text);
        assert.equal(a.verdict, 'none', text);
        assert.equal(a.obfuscated, false, text);
        assert.equal(a.defanged, true, text);
        assert.ok(a.hosts.length || a.invites.length, 'the defanged host is still extracted for lookups');
    }
});

test('obfuscation without the lure is only suspicious; lure without obfuscation is nothing', () => {
    assert.equal(analyzeMessage('https:////discord.gg/abc123').verdict, 'suspicious');
    assert.equal(analyzeMessage('look at this https://@example.com/page').verdict, 'suspicious');
    assert.equal(analyzeMessage('Contact support, open a ticket, our staff will help').verdict, 'none');
});

test('lure scoring: distinct groups, folded through look-alikes, leet and letter spacing', () => {
    assert.deepEqual(scoreLure('open a ticket with support').groups, ['support', 'ticket']);
    assert.ok(scoreLure('ѕuррогt t1ck3t').score >= 2, 'cyrillic + leet');
    assert.ok(scoreLure('s u p p o r t  and  a p p e a l').groups.includes('appeal'));
    assert.equal(scoreLure('good game everyone').score, 0);
    assert.ok(scoreLure('Your account has been flagged by Trust & Safety').groups.includes('account'));
});

test('emoji count and the cheap pre-filter', () => {
    assert.equal(countEmoji('hi 🎫📩➡️ <:x:123456789012345678>'), 4);
    assert.equal(countEmoji('plain'), 0);
    assert.equal(mightContainLink('hello there, how are you'), false);
    assert.equal(mightContainLink('dis cord.gg/x'), true);
    assert.equal(mightContainLink('h t t p s : / / x'), true);
    assert.equal(mightContainLink('discord。gg'), true);
});

test('escalation scoring: only the confirmed pattern is enforced; account age, join recency, emoji add up', () => {
    const DAY = 86_400_000;
    const scam = scoreEscalation({ content: SCAMS[0][1], accountAgeMs: 2 * DAY, joinedAgoMs: 3600_000 });
    assert.equal(scam.tier, 'confirmed');
    const keys = scam.signals.map(s => s.key);
    for (const k of ['obfuscation', 'invite', 'account_age', 'join_recency', 'lure']) assert.ok(keys.includes(k), k);
    assert.ok(scam.score >= 9);

    const old = scoreEscalation({ content: SCAMS[0][1], accountAgeMs: 900 * DAY, joinedAgoMs: 400 * DAY });
    assert.equal(old.tier, 'confirmed', 'the pattern decides, not the account');
    assert.ok(old.score < scam.score);

    const weak = scoreEscalation({ content: 'https:////discord.gg/abc 🎉🎉🎉', accountAgeMs: 1 * DAY, joinedAgoMs: 1000 });
    assert.equal(weak.tier, 'review');
    assert.ok(weak.signals.some(s => s.key === 'emoji'));

    const clean = scoreEscalation({ content: 'bad word here', accountAgeMs: 1 * DAY, joinedAgoMs: 1000 });
    assert.equal(clean.tier, 'none', 'a new account tripping a word filter is not a scam');
});

test('circuit breaker: 25 bans in 10 minutes go ahead, the 26th trips it; old bans fall out of the window', () => {
    const now = 10_000_000;
    let times = [];
    for (let i = 0; i < BREAKER_LIMIT; i++) {
        const c = breakerCheck(times, now + i);
        assert.equal(c.trip, false, `ban ${i + 1}`);
        times = breakerRecord(c.times, now + i);
    }
    assert.equal(breakerCheck(times, now + 100).trip, true, '26th ban');
    assert.equal(breakerCheck(times, now + BREAKER_WINDOW_MS + 100).trip, false, 'window passed');
    assert.equal(breakerCheck(times, now + BREAKER_WINDOW_MS + 100).times.length, 0);
    assert.equal(underBreaker('ban', true), 'flag');
    assert.equal(underBreaker('timeout', true), 'timeout');
    assert.equal(underBreaker('ban', false), 'ban');
});

test('QR → URL: payloads become links and hosts; decisions for phishing, obfuscated, strict and clean codes', () => {
    const found = qrUrls(['https://login.evil-example.com/claim?x=1', 'WIFI:S:home;T:WPA;P:pw;;', 'discord.gg/free-nitro', 'example.org/path']);
    assert.ok(found.urls.includes('https://login.evil-example.com/claim?x=1'));
    assert.ok(found.hosts.includes('login.evil-example.com'));
    assert.ok(found.hosts.includes('example.org'));
    assert.ok(found.invites.includes('discord.gg/free-nitro'));
    assert.equal(qrUrls(['just some text']).hasLink, false);

    const qr = { strict: false, action: 'delete' };
    assert.deepEqual(qrDecision(qr, { codes: 0 }), { act: false, action: null, why: null });
    assert.equal(qrDecision(qr, { codes: 1, phishingHosts: ['evil.example'], verdict: 'none' }).act, true);
    assert.equal(qrDecision(qr, { codes: 1, phishingHosts: [], verdict: 'confirmed' }).act, true);
    assert.equal(qrDecision(qr, { codes: 1, phishingHosts: [], verdict: 'none' }).act, false, 'a clean QR code stays');
    const strict = qrDecision({ strict: true, action: 'timeout' }, { codes: 2, phishingHosts: [], verdict: 'none' });
    assert.deepEqual([strict.act, strict.action], [true, 'timeout']);
});

test('URL check: verdict and reasons from the list, safe list, policy and obfuscation', () => {
    const listed = explainUrl({ input: 'https://evil.example/x', host: 'evil.example', listed: true, listedAs: 'evil.example', policy: { verdict: 'review', category: 'unknown' } });
    assert.equal(listed.verdict, 'malicious');
    assert.ok(listed.reasons.some(r => r.includes('phishing')));

    const safe = explainUrl({ input: 'https://youtube.com', host: 'youtube.com', safe: false, policy: { verdict: 'allow', category: 'social' } });
    assert.equal(safe.verdict, 'safe');

    const allowedButListed = explainUrl({ input: 'x.example', host: 'x.example', listed: true, guildAllowed: true, policy: null });
    assert.notEqual(allowedButListed.verdict, 'malicious', 'the server allowlist wins');

    const obf = explainUrl({ input: 'https:////discord.gg/abc', host: 'discord.gg', policy: { verdict: 'allow', category: 'media' } });
    assert.equal(obf.verdict, 'suspicious');
    assert.ok(obf.reasons.some(r => r.includes('obfuscated')));

    const defanged = explainUrl({ input: 'hxxps://bad[.]example', host: 'bad.example', policy: { verdict: 'review', category: 'unknown' } });
    assert.equal(defanged.verdict, 'unknown');
    assert.ok(defanged.reasons.some(r => r.includes('defanged')));

    assert.equal(explainUrl({ input: 'nothing', host: '' }).verdict, 'unknown');
});

test('image-text rules: validated like message patterns; strictest matching action wins; folded text matches', () => {
    assert.equal(validateOcrRule({ type: 'contains', pattern: 'free nitro', action: 'delete' }).ok, true);
    assert.equal(validateOcrRule({ type: 'contains', pattern: 'ab', action: 'delete' }).ok, false);
    assert.equal(validateOcrRule({ type: 'regex', pattern: '(a+)+$', action: 'ban' }).ok, false, 'catastrophic backtracking refused');
    assert.equal(validateOcrRule({ type: 'regex', pattern: '.*', action: 'ban' }).ok, false, 'matches everything');
    assert.equal(validateOcrRule({ type: 'contains', pattern: 'free nitro', action: 'kick' }).ok, false, 'unknown action');

    const rules = [
        { id: 1, pattern_type: 'contains', pattern: 'mrbeast', action: 'log' },
        { id: 2, pattern_type: 'regex', pattern: 'claim\\s+your\\s+\\$\\d+', action: 'ban' },
        { id: 3, pattern_type: 'contains', pattern: 'casino', action: 'delete' },
    ];
    // A generous regex budget: which rule wins is the point here, not how loaded the machine is.
    const match = (text, fold = null) => matchOcrRules(rules, text, fold, { regexTimeoutMs: 2000 });
    assert.equal(match('MrBeast casino: claim your $500 now').rule.id, 2);
    assert.equal(match('MrBeast casino').rule.id, 3);
    assert.equal(match('nothing to see').rule, null);
    const fold = (t) => t.normalize('NFKC').toLowerCase();
    assert.equal(match('ＣＡＳＩＮＯ', fold).rule.id, 3, 'full-width text in an image');
});

test('manual action needed: names the missing permission or the hierarchy problem', () => {
    const perms = { ban: true, kick: true, timeout: true, delete: true };
    assert.equal(cannotAct({ action: 'ban', botPerms: perms, botTop: 10, targetTop: 2 }), null);
    assert.match(cannotAct({ action: 'ban', botPerms: { ...perms, ban: false }, botTop: 10, targetTop: 2 }), /Ban Members/);
    assert.match(cannotAct({ action: 'delete', botPerms: { ...perms, delete: false } }), /Manage Messages/);
    assert.match(cannotAct({ action: 'timeout', botPerms: perms, botTop: 5, botTopName: 'Bot', targetTop: 7, targetTopName: 'Mods' }), /Bot.*Mods/);
    assert.match(cannotAct({ action: 'timeout', botPerms: perms, botTop: 10, targetTop: 2, targetAdmin: true }), /Administrator/);
    assert.match(cannotAct({ action: 'ban', botPerms: perms, botTop: 10, targetTop: 2, targetOwner: true }), /own the server/);
    assert.equal(cannotAct({ action: 'ban', botPerms: perms, botTop: 10, targetTop: null }), null, 'a ban works on someone who left');
});

test('audit reasons are plain ASCII', () => {
    for (const k of ['obfuscated', 'escalation', 'everyone', 'qr', 'qr_phish', 'ocr', 'review', 'nope']) {
        assert.match(threatReason(k, 'odd_dot,lookalike — rule 5 ✓'), /^[\x20-\x7E]+$/);
    }
});

test('the AutoMod rule: within Discord limits, matches the tricks, never a plain link', () => {
    const spec = automodRuleSpec({ alertChannelId: '123456789012345678', exemptChannelIds: ['223456789012345678'] });
    assert.equal(spec.triggerType, 1);
    assert.ok(spec.triggerMetadata.regexPatterns.length <= 10);
    assert.equal(spec.actions.length, 2);
    for (const p of AUTOMOD_REGEXES) assert.ok(p.length <= 260, p);
    const res = AUTOMOD_REGEXES.map(p => new RegExp(p.replace(/^\(\?i\)/, ''), 'i'));
    const hits = (text) => res.some(re => re.test(text));
    for (const t of ['https:////discord.gg/x', 'https:\\\\discord.gg/x', 'https://@discord.gg/x', 'discord。gg/x', 'https://%64iscord.gg/x',
        'dis cord.gg/x', 'discord . gg/x', 'https://disc\nord.gg/x', 'discord\n.gg/x']) {
        assert.ok(hits(t), JSON.stringify(t));
    }
    for (const t of ['https://discord.gg/abc', 'discord.gg/abc', 'https://example.com/page', 'I love discord. GG everyone', 'my discord is cool', 'https://user.example.com']) {
        assert.ok(!hits(t), JSON.stringify(t));
    }
    assert.ok(automodRuleSpec().actions.length === 1, 'no alert action without a channel');
});

test('ignore list: a category covers its channels (including new ones) and their threads', () => {
    const lists = { channels: new Set(['c1']), categories: new Set(['cat']) };
    assert.equal(isIgnored({ id: 'c1' }, lists), true);
    assert.equal(isIgnored({ id: 'new-ticket', parentId: 'cat' }, lists), true);
    assert.equal(isIgnored({ id: 'thread', parentId: 'c2', parentParentId: 'cat' }, lists), true);
    assert.equal(isIgnored({ id: 'thread', parentId: 'c1' }, lists), true);
    assert.equal(isIgnored({ id: 'c2', parentId: 'other' }, lists), false);
    assert.equal(isIgnored({ id: 'c2' }, { channels: [], categories: [] }), false);
});

test('anti-everyone: the permission must come from somewhere other than @everyone', () => {
    const G = 'g';
    const ME = 1n << 17n;
    const base = { everyoneRoleId: G, memberId: 'u' };
    const everyoneRole = { id: G, permissions: ME };       // the misconfiguration: @everyone may ping everyone
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole] }), false, 'only @everyone has it');
    assert.equal(everyoneAuthorised({ ...base, roles: [{ id: G, permissions: 0n }], overwrites: [{ id: G, type: 0, allow: ME, deny: 0n }] }), false, 'channel overwrite on @everyone');
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole, { id: 'host', permissions: ME }] }), true, 'a role granted it');
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole, { id: 'host', permissions: 0n }], overwrites: [{ id: 'host', type: 0, allow: ME, deny: 0n }] }), true, 'role overwrite');
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole], overwrites: [{ id: 'u', type: 1, allow: ME, deny: 0n }] }), true, 'member overwrite');
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole, { id: 'host', permissions: ME }], overwrites: [{ id: 'host', type: 0, allow: 0n, deny: ME }] }), false, 'denied in this channel');
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole, { id: 'admin', permissions: 1n << 3n }] }), true, 'administrator');
    assert.equal(everyoneAuthorised({ ...base, owner: true, roles: [] }), true, 'owner');
    assert.equal(everyoneAuthorised({ ...base, roles: [everyoneRole, { id: 'vip', permissions: 0n }], allowedRoleIds: ['vip'] }), true, 'allowed role');
    // strict: a role that merely has the permission is not enough
    assert.equal(everyoneAuthorised({ ...base, strict: true, roles: [everyoneRole, { id: 'host', permissions: ME }] }), false);
    assert.equal(everyoneAuthorised({ ...base, strict: true, roles: [everyoneRole, { id: 'mgr', permissions: 1n << 5n }] }), true, 'Manage Server');
    assert.equal(everyoneAuthorised({ ...base, roles: [{ id: G, permissions: '131072' }, { id: 'h', permissions: '131072' }] }), true, 'string bitfields');
});

test('settings: everything off by default; patches are validated', () => {
    const s = settingsFrom(null);
    assert.deepEqual([s.obf.enabled, s.everyone.enabled, s.qr.enabled, s.ocrRules.enabled, s.escalation.enabled], [false, false, false, false, false]);
    assert.equal(s.obf.action, 'ban', 'Hashbot default once switched on');
    assert.equal(s.escalation.action, 'ban');
    assert.equal(s.everyone.webhooks, 'log');
    const parsed = settingsFrom({ obf_enabled: 1, obf_action: 'nonsense', esc_rule_ids: '["123456789012345678","x"]', everyone_timeout_minutes: 0 });
    assert.equal(parsed.obf.enabled, true);
    assert.equal(parsed.obf.action, 'ban');
    assert.deepEqual(parsed.escalation.ruleIds, ['123456789012345678']);
    assert.equal(parsed.everyone.timeoutMinutes, 0);
    assert.equal(wantsImages(settingsFrom({ qr_enabled: 1 })), true);
    assert.equal(wantsImages(settingsFrom({ ocr_rules_enabled: 1 })), false, 'no rules, no OCR');
    assert.equal(wantsImages(settingsFrom({ ocr_rules_enabled: 1 }), { hasOcrRules: true }), true);

    assert.deepEqual(cleanSettingsPatch({ obf_enabled: true, obf_action: 'flag', unknown: 1 }).values, { obf_enabled: 1, obf_action: 'flag' });
    assert.equal(cleanSettingsPatch({ obf_action: 'explode' }).ok, false);
    assert.equal(cleanSettingsPatch({ obf_timeout_minutes: 0 }).ok, false);
    assert.equal(cleanSettingsPatch({ everyone_timeout_minutes: 0 }).ok, true, '0 = delete only');
    assert.equal(cleanSettingsPatch({ threat_channel_id: 'abc' }).ok, false);
    assert.equal(cleanSettingsPatch({ esc_rule_ids: ['123456789012345678', 'bad', '123456789012345678'] }).values.esc_rule_ids, '["123456789012345678"]');
});

/** A fake db.execute that answers the information_schema probes and records every statement. */
function fakeDb({ columns = new Set(), indexes = new Set(), types = {} } = {}) {
    const sql = [];
    return {
        sql,
        async execute(q, args = []) {
            sql.push(q);
            if (q.includes('information_schema.TABLES')) return [[{ 1: 1 }]];
            if (q.includes('COLUMN_TYPE')) return [[{ t: types[`${args[0]}.${args[1]}`] }]];
            if (q.includes("information_schema.COLUMNS")) return [columns.has(`${args[0]}.${args[1]}`) ? [{ 1: 1 }] : []];
            if (q.includes('information_schema.STATISTICS')) return [indexes.has(`${args[0]}.${args[1]}`) ? [{ 1: 1 }] : []];
            return [{ affectedRows: 0 }];
        },
    };
}

test('migration 327: adds every column and enum value once, and is idempotent', async () => {
    const before = Object.fromEntries(ENUM_CHANGES.map(([t, c, b]) => [`${t}.${c}`, `enum(${b.map(v => `'${v}'`).join(',')})`]));
    const db = fakeDb({ types: before });
    await up(db);
    const alters = db.sql.filter(q => q.startsWith('ALTER'));
    assert.equal(alters.filter(q => q.startsWith('ALTER TABLE phishing_config ADD COLUMN')).length, CONFIG_COLUMNS.length);
    assert.equal(alters.filter(q => q.startsWith('ALTER TABLE phishing_detections ADD COLUMN')).length, DETECTION_COLUMNS.length);
    assert.ok(alters.some(q => q.includes('ADD INDEX idx_guild_source')));
    assert.ok(alters.some(q => q.includes("automod_patterns MODIFY target ENUM('message','name','image_text') NOT NULL DEFAULT 'message'")));
    assert.ok(alters.some(q => q.includes("protection_allowlist MODIFY kind ENUM('user','role','held','manager','channel','category') NOT NULL")));
    assert.ok(alters.some(q => q.includes("name_filter_reviews MODIFY kind ENUM('name','avatar','message') NOT NULL DEFAULT 'name'")));
    assert.ok(!db.sql.some(q => /^\s*(DELETE|UPDATE|INSERT)\b|\bDROP\b/.test(q)), 'up() never removes or rewrites data');
    for (const [, def] of CONFIG_COLUMNS) if (/enabled/.test(def)) assert.match(def, /DEFAULT 0/);
    for (const [name, def] of CONFIG_COLUMNS) if (name.endsWith('_enabled')) assert.match(def, /DEFAULT 0/, `${name} off by default`);

    const after = Object.fromEntries(ENUM_CHANGES.map(([t, c, , a]) => [`${t}.${c}`, `enum(${a.map(v => `'${v}'`).join(',')})`]));
    const columns = new Set([...CONFIG_COLUMNS.map(([n]) => `phishing_config.${n}`), ...DETECTION_COLUMNS.map(([n]) => `phishing_detections.${n}`)]);
    const again = fakeDb({ columns, indexes: new Set(['phishing_detections.idx_guild_source']), types: after });
    await up(again);
    assert.equal(again.sql.filter(q => q.startsWith('ALTER')).length, 0, 'second run changes nothing');

    const rollback = fakeDb({ columns, indexes: new Set(['phishing_detections.idx_guild_source']), types: after });
    await down(rollback);
    const r = rollback.sql;
    assert.ok(r.findIndex(q => q.includes("DELETE FROM automod_patterns WHERE target = 'image_text'")) < r.findIndex(q => q.includes('automod_patterns MODIFY')), 'rows removed before the enum shrinks');
    assert.ok(r.some(q => q.includes('DROP COLUMN obf_enabled')));
});

test('wiring: the pipeline reads images once, anti-everyone and escalation are hooked, buttons registered', () => {
    const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const pdm = read('core/phishing-detection-manager.js');
    assert.equal((pdm.match(/scanImages\(/g) || []).length, 1, 'one image read per message');
    assert.ok(!pdm.includes('extractImageText('), 'no second OCR path');
    assert.match(pdm, /obfuscationStage\(/);
    assert.match(pdm, /qrStage\(/);
    assert.match(pdm, /imageRulesStage\(/);
    assert.match(pdm, /isIgnoredChannel\(/);
    assert.match(read('events/messageCreate.js'), /message\.mentions\?\.everyone && await checkEveryone\(message\)/);
    assert.match(read('events/autoModerationActionExecution.js'), /handleAutoModExecution\(action\)/);
    assert.match(read('interactions/handlerRegistry.js'), /'mthreat_ban:': handleMessageThreatButton/);
    for (const f of ['core/link-filter.js', 'events/inviteLinkFilter.js', 'core/image-blocklist.js']) assert.match(read(f), /isIgnoredChannel\(/, f);
    const tw = read('dashboard/views/manage-tailwind.ejs');
    // Registered in the title map + page map; its overview row, sidebar link, search entry and
    // icon come from core/manage-nav.js (coverage of every page: tests/manage-nav.test.js).
    assert.equal((tw.match(/'message-threats'/g) || []).length, 3, 'title map, page map (key + partial)');
    assert.match(read('core/manage-nav.js'), /page: 'message-threats', section: 'protection'/);
    // every punitive call in the live module goes through enforce → protectionHold
    const live = read('core/message-threats.js');
    assert.match(live, /protectionHold\(member, holdAction/);
});
