import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyBanSource, contextFromLabel, contextFromReason, guildTrust, isBurst, signalStrength, computeConfidence,
    shouldCreateEntry, entryConfidence, severityForConfidence, decideEnforcement, decideMessageEnforcement,
    normaliseMode, normaliseThreshold, strongerSource, publicSummary, TRUSTED_BOT_IDS, DEFAULT_THRESHOLD,
} from '../core/global-ban-confidence.js';
import {
    scoreJoinRisk, badgesFromFlags, formatRiskField, normaliseNewAccountDays, DEFAULT_NEW_ACCOUNT_DAYS,
} from '../core/member-insight-logic.js';
import { classifyBanRow, matchEvidence, assembleBanLog, countByProtection, PROTECTIONS } from '../core/ban-log-logic.js';
import { protectionsGrid, securityScore, dailyBuckets, topRules, PROTECTION_GRID, eventGroup } from '../core/security-overview-logic.js';
import { up, down, COLUMNS } from '../migrations/329_insight_network.js';

const DAY = 86_400_000;
const sig = (guild, extra = {}) => ({ guild_id: guild, action_type: 'ban', source_kind: 'moderator', guild_trust: 1, burst: 0, ...extra });

// ── who banned ───────────────────────────────────────────────────────────────

test('protectionHold labels map to protection contexts', () => {
    assert.equal(contextFromLabel('Spammer check'), 'spammer');
    assert.equal(contextFromLabel('Spammer scan'), 'spammer');
    assert.equal(contextFromLabel('Name filter review'), 'name');
    assert.equal(contextFromLabel('Avatar protection'), 'avatar');
    assert.equal(contextFromLabel('Raid detection'), 'raid');
    assert.equal(contextFromLabel('Raid lockdown'), 'lockdown');
    assert.equal(contextFromLabel('Global ban'), 'global_ban');
    assert.equal(contextFromLabel('Join gate (rejoin limit)'), 'rejoin');
    assert.equal(contextFromLabel('Join gate (account age)'), 'join_gate');
    assert.equal(contextFromLabel('Obfuscated URL scam'), 'message_threat');
    assert.equal(contextFromLabel('Anti-everyone'), 'message_threat');
    assert.equal(contextFromLabel('Scam-image blocklist'), 'scam_image');
    assert.equal(contextFromLabel('Self-bot detection'), 'selfbot');
    assert.equal(contextFromLabel('Auto-prune'), 'prune');
    assert.equal(contextFromLabel('Something new'), 'other');
    assert.equal(contextFromLabel(null), null);
});

test('our protections\' audit reasons are recognised; staff reasons are not', () => {
    assert.equal(contextFromReason('Global Ban: spam (high)'), 'global_ban');
    assert.equal(contextFromReason('Join gate: account flagged as a spammer by Discord'), 'spammer');
    assert.equal(contextFromReason('Raid lockdown: not accepting new members until x'), 'lockdown');
    assert.equal(contextFromReason('Auto-ban: posted a known scam image across 3+ channels'), 'scam_image');
    assert.equal(contextFromReason('Phishing link detected: evil.example'), 'message_threat');
    assert.equal(contextFromReason('Automatic spam detection: ban'), 'spam');
    assert.equal(contextFromReason('Art Scammer!'), null);
    assert.equal(contextFromReason('No reason provided'), null);
    assert.equal(contextFromReason(null), null);
});

test('ban sources: our protection > staff > known bot > unknown bot', () => {
    assert.deepEqual(classifyBanSource({ executorId: 'b1', executorBot: true, ourBot: true, pendingLabel: 'Spammer check' }),
        { source: 'protection', context: 'spammer', excluded: false });
    assert.deepEqual(classifyBanSource({ executorId: 'b1', executorBot: true, ourBot: true, reason: 'Name filter: x' }),
        { source: 'protection', context: 'name', excluded: false });
    // our bot with no protection behind it = a moderator used our command
    assert.deepEqual(classifyBanSource({ executorId: 'b1', executorBot: true, ourBot: true, reason: 'spamming my DMs' }),
        { source: 'moderator', context: null, excluded: false });
    assert.equal(classifyBanSource({ executorId: 'u1', executorBot: false }).source, 'moderator');
    const carl = [...TRUSTED_BOT_IDS][0];
    assert.equal(classifyBanSource({ executorId: carl, executorBot: true, reason: 'Art Scammer!' }).source, 'trusted_bot');
    assert.equal(classifyBanSource({ executorId: carl, executorBot: true, reason: 'Banned by joehew' }).source, 'moderator', 'a bot acting for a person');
    assert.equal(classifyBanSource({ executorId: 'x', executorBot: true, executorName: 'Dyno' }).source, 'trusted_bot');
    assert.equal(classifyBanSource({ executorId: 'x', executorBot: true, executorName: 'RandomBot' }).source, 'bot');
    assert.equal(classifyBanSource({}).source, 'unknown');
});

test('bans made by global ban enforcement (or prune) are never fed back as signals', () => {
    assert.equal(classifyBanSource({ executorId: 'b', executorBot: true, ourBot: true, pendingLabel: 'Global ban' }).excluded, true);
    assert.equal(classifyBanSource({ executorId: 'b', executorBot: true, ourBot: true, reason: 'Global Ban: spam (high)' }).excluded, true);
    assert.equal(classifyBanSource({ executorId: 'b', executorBot: true, ourBot: true, pendingLabel: 'Auto-prune' }).excluded, true);
    assert.equal(classifyBanSource({ executorId: 'b', executorBot: true, ourBot: true, pendingLabel: 'Spammer check' }).excluded, false);
});

test('the stronger source wins when one ban is reported twice', () => {
    assert.equal(strongerSource('moderator', 'protection'), 'protection');
    assert.equal(strongerSource('protection', 'moderator'), 'protection');
    assert.equal(strongerSource('bot', 'trusted_bot'), 'trusted_bot');
    assert.equal(strongerSource(null, 'bot'), 'bot');
});

// ── anti-poisoning ───────────────────────────────────────────────────────────

test('young or tiny servers count less', () => {
    const now = Date.now();
    assert.equal(guildTrust({ createdAt: now - 400 * DAY, memberCount: 500, now }), 1);
    assert.equal(guildTrust({ createdAt: now - 20 * DAY, memberCount: 500, now }), 0.5);
    assert.equal(guildTrust({ createdAt: now - 2 * DAY, memberCount: 500, now }), 0.25);
    assert.equal(guildTrust({ createdAt: now - 400 * DAY, memberCount: 30, now }), 0.5);
    assert.equal(guildTrust({ createdAt: now - 400 * DAY, memberCount: 3, now }), 0.25);
    assert.equal(guildTrust({}), 1);
});

test('a mass-ban burst is detected inside the window only', () => {
    const now = 1_000_000_000;
    const recent = Array.from({ length: 11 }, (_, i) => now - i * 1000);
    assert.equal(isBurst(recent, now), true);
    assert.equal(isBurst(recent.slice(0, 10), now), false);
    assert.equal(isBurst(Array.from({ length: 30 }, (_, i) => now - 20 * 60_000 - i), now), false, 'old bans do not count');
});

test('signal strength: action points x source x context x trust x burst', () => {
    assert.equal(signalStrength(sig('g', { source_kind: 'protection', context: 'spammer' })), 1);
    assert.equal(signalStrength(sig('g')), 0.8);
    assert.ok(Math.abs(signalStrength(sig('g', { action_type: 'kick' })) - (2 / 3) * 0.8) < 1e-9);
    assert.equal(signalStrength(sig('g', { guild_trust: 0.5 })), 0.4);
    assert.equal(signalStrength(sig('g', { burst: 1 })), 0.2);
    assert.equal(signalStrength(sig('g', { source_kind: 'protection', context: 'global_ban' })), 0);
});

test('one server can never push anyone past 50, however hard it tries', () => {
    const r = computeConfidence([sig('g1', { source_kind: 'protection', context: 'spammer' }), sig('g1', { action_type: 'kick' })]);
    assert.equal(r.groups, 1);
    assert.ok(r.confidence <= 50);
    assert.equal(shouldCreateEntry(r), false);
});

test('servers with the same owner are one voice', () => {
    const sameOwner = computeConfidence([sig('g1', { guild_owner_id: 'o' }), sig('g2', { guild_owner_id: 'o' }), sig('g3', { guild_owner_id: 'o' })]);
    assert.equal(sameOwner.groups, 1);
    assert.equal(sameOwner.guilds, 3);
    assert.ok(sameOwner.confidence <= 50);
    const independent = computeConfidence([sig('g1', { guild_owner_id: 'a' }), sig('g2', { guild_owner_id: 'b' }), sig('g3', { guild_owner_id: 'c' })]);
    assert.equal(independent.groups, 3);
    assert.ok(independent.confidence > sameOwner.confidence);
});

test('independent agreement raises confidence; caps by how many agree', () => {
    const two = computeConfidence([sig('g1'), sig('g2')]);
    const three = computeConfidence([sig('g1'), sig('g2'), sig('g3')]);
    assert.ok(two.confidence <= 80);
    assert.ok(three.confidence > two.confidence);
    assert.equal(shouldCreateEntry(two), true);
    const perfect = computeConfidence([1, 2, 3, 4].map(i => sig(`g${i}`, { source_kind: 'protection', context: 'spammer' })));
    assert.ok(perfect.confidence >= 95 && perfect.confidence <= 100);
    assert.equal(perfect.severity, 'high');
    assert.equal(perfect.category, 'spam');
});

test('bursts and unknown bots cannot make an entry on their own', () => {
    const burst = computeConfidence(Array.from({ length: 6 }, (_, i) => sig(`g${i}`, { burst: 1 })));
    assert.ok(burst.computed < 65, `burst confidence ${burst.computed}`);
    const bots = computeConfidence([sig('g1', { source_kind: 'bot' }), sig('g2', { source_kind: 'bot' })]);
    assert.ok(bots.computed < 40);
    assert.equal(shouldCreateEntry(bots), false);
    const newServers = computeConfidence([sig('g1', { guild_trust: 0.25 }), sig('g2', { guild_trust: 0.25 })]);
    assert.equal(shouldCreateEntry(newServers), false);
});

test('curated entries keep the confidence their severity implies, signals can raise it', () => {
    assert.equal(entryConfidence({ severity: 'critical' }), 100);
    assert.equal(entryConfidence({ severity: 'high' }), 90);
    assert.equal(entryConfidence({ severity: 'medium' }), 75);
    assert.equal(entryConfidence({ severity: 'low' }), 60);
    assert.equal(entryConfidence({ severity: 'low', confidence: 83 }), 83);
    assert.equal(computeConfidence([], { curated: { severity: 'high' } }).confidence, 90);
    assert.equal(computeConfidence([sig('g1'), sig('g2'), sig('g3')], { curated: { severity: 'low' } }).confidence,
        computeConfidence([sig('g1'), sig('g2'), sig('g3')]).computed);
});

test('severity bands', () => {
    assert.equal(severityForConfidence(90), 'high');
    assert.equal(severityForConfidence(70), 'medium');
    assert.equal(severityForConfidence(45), 'low');
    assert.equal(severityForConfidence(20), null);
});

test('the public summary never carries server ids or moderators', () => {
    const r = computeConfidence([sig('111', { guild_owner_id: 'o1' }), sig('222', { source_kind: 'protection', context: 'spammer' })]);
    const pub = publicSummary(r, { entry: null, ownSignal: true, reports: 2 });
    const text = JSON.stringify(pub);
    assert.ok(!text.includes('111') && !text.includes('222') && !text.includes('o1'));
    assert.equal(pub.independentServers, 2);
    assert.equal(pub.ownSignal, true);
    assert.ok(pub.reasons.includes('Discord spammer flag'));
});

// ── modes ────────────────────────────────────────────────────────────────────

test('modes: protect acts at/above the threshold, alerts below; alert never acts; feed is silent', () => {
    assert.deepEqual(decideEnforcement({ mode: 'protect', threshold: 75, confidence: 90, severityAction: 'ban' }).action, 'ban');
    assert.equal(decideEnforcement({ mode: 'protect', threshold: 75, confidence: 75, severityAction: 'kick' }).action, 'kick');
    assert.equal(decideEnforcement({ mode: 'protect', threshold: 75, confidence: 74, severityAction: 'ban' }).action, 'alert');
    assert.equal(decideEnforcement({ mode: 'protect', threshold: 75, confidence: 99, severityAction: 'none' }).action, 'none');
    assert.equal(decideEnforcement({ mode: 'protect', threshold: 75, confidence: 99, severityAction: 'alert' }).action, 'alert');
    assert.equal(decideEnforcement({ mode: 'alert', threshold: 0, confidence: 100, severityAction: 'ban' }).action, 'alert');
    assert.equal(decideEnforcement({ mode: 'feed', threshold: 0, confidence: 100, severityAction: 'ban' }).action, 'none');
    assert.equal(decideEnforcement({ mode: 'junk', threshold: 'x', confidence: 80, severityAction: 'ban' }).action, 'ban', 'unknown = protect at 75');
});

test('existing curated entries keep acting exactly as before in the default mode', () => {
    for (const [sev, action] of [['critical', 'ban'], ['high', 'ban'], ['medium', 'kick']]) {
        assert.equal(decideEnforcement({ mode: 'protect', threshold: DEFAULT_THRESHOLD, confidence: entryConfidence({ severity: sev }), severityAction: action }).action, action);
    }
});

test('message-time checks only ever remove, never alert', () => {
    assert.equal(decideMessageEnforcement({ mode: 'protect', threshold: 75, confidence: 90, severityAction: 'ban' }).action, 'ban');
    assert.equal(decideMessageEnforcement({ mode: 'protect', threshold: 75, confidence: 50, severityAction: 'ban' }).action, 'none');
    assert.equal(decideMessageEnforcement({ mode: 'alert', threshold: 75, confidence: 90, severityAction: 'ban' }).action, 'none');
});

test('mode and threshold normalise', () => {
    assert.equal(normaliseMode('FEED'), 'feed');
    assert.equal(normaliseMode(null), 'protect');
    assert.equal(normaliseThreshold('150'), 100);
    assert.equal(normaliseThreshold(-3), 0);
    assert.equal(normaliseThreshold(undefined), 75);
});

// ── join risk ────────────────────────────────────────────────────────────────

test('a Discord-flagged spammer is high risk on its own', () => {
    const r = scoreJoinRisk({ spammer: true, accountAgeMs: 400 * DAY });
    assert.equal(r.level, 'high');
    assert.ok(r.reasons.some(x => x.key === 'spammer'));
});

test('a confident network listing is high; signals without a listing add a little', () => {
    assert.equal(scoreJoinRisk({ network: { listed: true, confidence: 90 }, accountAgeMs: 400 * DAY }).level, 'high');
    const low = scoreJoinRisk({ network: { listed: true, confidence: 40 }, accountAgeMs: 400 * DAY });
    assert.equal(low.level, 'medium');
    const sig1 = scoreJoinRisk({ network: { listed: false, independentServers: 1 }, accountAgeMs: 400 * DAY });
    assert.equal(sig1.score, 10);
});

test('new accounts are judged against the server threshold', () => {
    assert.ok(scoreJoinRisk({ accountAgeMs: 0.5 * DAY }).reasons.some(r => r.points === 30));
    assert.ok(scoreJoinRisk({ accountAgeMs: 3 * DAY, newAccountDays: 7 }).reasons.some(r => r.points === 20));
    assert.ok(!scoreJoinRisk({ accountAgeMs: 3 * DAY, newAccountDays: 2 }).reasons.some(r => r.points === 20));
    assert.equal(scoreJoinRisk({ accountAgeMs: 400 * DAY }).score, 0);
    assert.equal(scoreJoinRisk({ accountAgeMs: 400 * DAY }).level, 'low');
});

test('new + default avatar + rejoins adds up to medium/high; trusted badges lower it', () => {
    const r = scoreJoinRisk({ accountAgeMs: 2 * DAY, defaultAvatar: true, joins: 3 });
    assert.equal(r.score, 40);
    assert.equal(r.level, 'medium');
    const worse = scoreJoinRisk({ accountAgeMs: 0.1 * DAY, defaultAvatar: true, joins: 6, priorHits: 1 });
    assert.equal(worse.level, 'high');
    const badged = scoreJoinRisk({ accountAgeMs: 2 * DAY, defaultAvatar: true, joins: 3, badges: [{ trusted: true, label: 'Bug Hunter' }] });
    assert.equal(badged.score, 25);
    assert.equal(scoreJoinRisk({ bot: true, spammer: true }).level, 'low');
});

test('badges come from public flags; the spammer bit is not a badge', () => {
    const b = badgesFromFlags((1 << 3) | (1 << 7) | (1 << 20));
    assert.deepEqual(b.map(x => x.key), ['bughunter', 'brilliance']);
    assert.equal(b[0].trusted, true);
    assert.deepEqual(badgesFromFlags({ bitfield: 1 << 22 }).map(x => x.key), ['activedev']);
    assert.deepEqual(badgesFromFlags(null), []);
});

test('the join log field is short, says the level and highlights young accounts', () => {
    const input = { accountAgeMs: 2 * DAY, defaultAvatar: true, joins: 3, spammer: true, network: { listed: true, confidence: 88 } };
    const f = formatRiskField(scoreJoinRisk(input), input);
    assert.match(f.name, /Risk: High/);
    assert.match(f.value, /\*\*Account age: 2 days\*\*/);
    assert.match(f.value, /spammer flag/);
    assert.match(f.value, /confidence 88/);
    assert.match(f.value, /Joined 2 times before/);
    assert.ok(f.value.length <= 1024);
    assert.equal(formatRiskField(scoreJoinRisk({ accountAgeMs: 400 * DAY }), { accountAgeMs: 400 * DAY }).name.includes('Low'), true);
    assert.equal(normaliseNewAccountDays('abc'), DEFAULT_NEW_ACCOUNT_DAYS);
    assert.equal(normaliseNewAccountDays(500), 90);
});

// ── ban log ──────────────────────────────────────────────────────────────────

const FLEET = new Set(['bot1']);
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const ban = (user, at, extra = {}) => ({ user_id: user, moderator_id: 'bot1', reason: null, metadata: '{}', timestamp: new Date(at), ...extra });

test('ban rows: recorded classification wins, then our reasons, then a human infraction excludes', () => {
    assert.deepEqual(classifyBanRow(ban('u', T0, { metadata: JSON.stringify({ source: 'protection', protection: 'avatar' }) }), { fleetIds: FLEET }),
        { automated: true, protection: 'avatar' });
    assert.equal(classifyBanRow(ban('u', T0, { metadata: { source: 'moderator' } }), { fleetIds: FLEET }).automated, false);
    assert.deepEqual(classifyBanRow(ban('u', T0, { reason: 'Global Ban: spam (high)' }), { fleetIds: FLEET }), { automated: true, protection: 'global_ban' });
    assert.equal(classifyBanRow(ban('u', T0, { moderator_id: 'human' }), { fleetIds: FLEET }).automated, false, 'not our bot');
    assert.equal(classifyBanRow(ban('u', T0, { reason: 'data collection bot' }), {
        fleetIds: FLEET, humanBans: [{ user_id: 'u', moderator_id: 'mod1', created_at: new Date(T0 - 60_000) }],
    }).automated, false, '/ban by a person through our bot');
    assert.deepEqual(classifyBanRow(ban('u', T0, { reason: 'whatever' }), { fleetIds: FLEET }), { automated: false, protection: 'other', candidate: true });
});

test('evidence is matched by member, time window and protection', () => {
    const ev = [
        { userId: 'u', at: T0 - 30_000, protection: 'spammer', text: 'on join' },
        { userId: 'u', at: T0 - 20 * 60_000, protection: 'spammer', text: 'too old' },
        { userId: 'v', at: T0, protection: 'spammer', text: 'someone else' },
        { userId: 'u', at: T0 - 5000, protection: 'name', text: 'other protection' },
    ];
    assert.equal(matchEvidence({ userId: 'u', at: T0, protection: 'spammer' }, ev).text, 'on join');
    assert.equal(matchEvidence({ userId: 'u', at: T0, protection: 'other' }, ev).text, 'other protection', 'nearest when unknown');
    assert.equal(matchEvidence({ userId: 'w', at: T0, protection: 'spammer' }, ev), null);
});

test('the ban log: automated only, newest first, de-duplicated, with evidence and unbans', () => {
    const rows = assembleBanLog({
        fleetIds: FLEET,
        bans: [
            ban('a', T0, { reason: 'Join gate: account flagged as a spammer by Discord', metadata: JSON.stringify({ username: 'alice' }) }),
            ban('a', T0 + 20_000, { reason: 'Join gate: account flagged as a spammer by Discord' }),   // second bot logging the same ban
            ban('b', T0 + 60_000, { moderator_id: 'human', reason: 'manual' }),
            ban('c', T0 + 120_000, { metadata: JSON.stringify({ source: 'protection', protection: 'name' }) }),
            ban('d', T0 + 180_000, { reason: 'odd' }),
            ban('e', T0 + 240_000, { reason: 'your ability to annoy me' }),   // our bot, no evidence: a command, not shown
        ],
        unbans: [{ user_id: 'c', timestamp: new Date(T0 + 600_000) }, { user_id: 'a', timestamp: new Date(T0 - DAY) }],
        evidence: [
            { userId: 'a', at: T0 - 1000, protection: 'spammer', text: 'on join' },
            { userId: 'd', at: T0 + 170_000, protection: 'avatar', text: 'matched avatar', page: 'avatar-protection' },
        ],
    });
    assert.deepEqual(rows.map(r => r.userId), ['d', 'c', 'a']);
    const a = rows.find(r => r.userId === 'a');
    assert.equal(a.protection, 'spammer');
    assert.equal(a.evidence.text, 'on join');
    assert.equal(a.unbanned, false, 'an unban before the ban does not count');
    assert.equal(a.username, 'alice');
    assert.equal(rows.find(r => r.userId === 'c').unbanned, true);
    assert.equal(rows.find(r => r.userId === 'd').protection, 'avatar', 'evidence names an unclassified ban');
    for (const r of rows) assert.ok(PROTECTIONS[r.protection]);
    assert.deepEqual(countByProtection(rows).map(x => x.n), [1, 1, 1]);
});

// ── overview ─────────────────────────────────────────────────────────────────

test('protections grid: on, off (never set up) and unknown; every key has a page', () => {
    const grid = protectionsGrid({
        raid: { on: true, action: 'kick' }, joinGate: { spammer: true, ageGate: false, rejoinLimit: false },
        antiNuke: false, phishing: null, globalBan: { on: true, mode: 'protect', threshold: 80 }, joinInsight: { on: true },
    });
    assert.equal(grid.length, PROTECTION_GRID.length);
    const by = Object.fromEntries(grid.map(g => [g.key, g]));
    assert.equal(by.raid.on, true);
    assert.equal(by.raid.detail, 'kick');
    assert.equal(by.spammer.on, true);
    assert.equal(by.ageGate.on, false);
    assert.equal(by.antiNuke.on, false);
    assert.equal(by.phishing.on, null);
    assert.equal(by.globalBan.detail, 'protect at 80');
    for (const g of grid) assert.ok(g.page);
});

test('the score weights the important protections double', () => {
    const none = securityScore(protectionsGrid({}));
    assert.equal(none.percent, 0);
    assert.equal(none.level, 'Weak');
    const all = securityScore(PROTECTION_GRID.map(g => ({ key: g.key, on: true })));
    assert.equal(all.percent, 100);
    assert.equal(all.level, 'Strong');
    const heavy = securityScore([{ key: 'raid', on: true }, { key: 'autoPrune', on: false }]);
    assert.equal(heavy.percent, 67);
});

test('daily buckets cover exactly the window, oldest first, split by kind', () => {
    const now = Date.UTC(2026, 9, 12, 15);
    const days = dailyBuckets([
        { at: now, kind: 'automated' }, { at: now - 1000, kind: 'manual' }, { at: now - 2 * DAY, kind: 'automated' }, { at: now - 40 * DAY, kind: 'manual' },
    ], { days: 30, now, kinds: ['automated', 'manual'] });
    assert.equal(days.length, 30);
    assert.equal(days[29].date, '2026-10-12');
    assert.deepEqual([days[29].total, days[29].automated, days[29].manual], [2, 1, 1]);
    assert.equal(days[27].automated, 1);
    assert.equal(days.reduce((n, d) => n + d.total, 0), 3);
});

test('top rules merge across stores and sort', () => {
    assert.deepEqual(topRules([[{ label: 'A', n: 2 }, { label: 'B', n: 1 }], [{ label: 'A', n: 3 }, { label: 'C', n: 0 }]], 5),
        [{ label: 'A', n: 5 }, { label: 'B', n: 1 }]);
    assert.equal(eventGroup('spammer_banned'), 'Discord spammer check');
});

// ── migration (fake db: records the SQL, touches nothing) ───────────────────

function fakeDb(existing = new Set()) {
    const sql = [];
    return {
        sql,
        async execute(q, params = []) {
            sql.push(q);
            if (/information_schema\.COLUMNS/.test(q)) return [existing.has(`${params[0]}.${params[1]}`) ? [{ 1: 1 }] : []];
            if (/information_schema\.STATISTICS/.test(q)) return [existing.has(`${params[0]}#${params[1]}`) ? [{ 1: 1 }] : []];
            return [{ affectedRows: 0 }];
        },
    };
}

test('migration 329 adds only columns and an index, idempotently', async () => {
    const db = fakeDb();
    await up(db);
    const alters = db.sql.filter(q => /^ALTER TABLE/.test(q));
    assert.equal(alters.length, COLUMNS.length + 1);
    assert.ok(alters.every(q => / ADD (COLUMN|INDEX) /.test(q)));
    assert.ok(!db.sql.some(q => /DROP|CREATE TABLE|DELETE/.test(q)));
    assert.ok(db.sql.some(q => /ADD COLUMN mode ENUM\('protect','alert','feed'\) NOT NULL DEFAULT 'protect'/.test(q)));
    assert.ok(db.sql.some(q => /ADD COLUMN confidence_threshold TINYINT UNSIGNED NOT NULL DEFAULT 75/.test(q)));

    const all = new Set([...COLUMNS.map(([t, c]) => `${t}.${c}`), 'global_ban_auto_aggregate#idx_guild_occurred']);
    const again = fakeDb(all);
    await up(again);
    assert.equal(again.sql.filter(q => /^ALTER TABLE/.test(q)).length, 0, 'second run changes nothing');

    const back = fakeDb(all);
    await down(back);
    assert.equal(back.sql.filter(q => /DROP COLUMN/.test(q)).length, COLUMNS.length);
});
