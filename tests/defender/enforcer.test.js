import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnforcer } from '../../services/certifried-bot/defender/enforcer.js';

function build(overrides = {}) {
    const calls = { bans: [], deletes: [], logs: [], offenses: [], replies: [] };
    const deps = {
        isOnBanlist: async () => overrides.banlisted ?? false,
        isOnUnbanlist: async () => overrides.unbanlisted ?? false,
        resolveChannel: async () => ('channel' in overrides ? overrides.channel : {
            broadcasterId: '999', token: 'tok', scopes: overrides.scopes ?? ['moderation:ban']
        }),
        banUser: async (b, u, o, t) => {
            calls.bans.push({ b, u, o, t });
            if (overrides.banThrows) throw new Error('boom');
            return { ok: overrides.banOk ?? true };
        },
        deleteMessage: async (m, t) => { calls.deletes.push({ m, t }); return { ok: true }; },
        log: async (entry) => { calls.logs.push(entry); },
        getSettings: async () => overrides.settings ?? {
            banDurationMin: null, phishingThreshold: 2,
            warningTemplate: '@{{username}} posted a known scam link and it was removed. Repeat offenses = ban.',
            safeDomains: []
        }
    };
    // Phishing deps only when the test opts in, so existing banlist tests keep
    // exercising the no-link-scan path.
    if ('phishingDomain' in overrides || overrides.withPhishing) {
        deps.findPhishingDomain = (content) => overrides.phishingDomain ?? null;
        deps.recordOffense = async (p, u, n, d) => {
            calls.offenses.push({ p, u, n, d });
            return overrides.offenseCount ?? 1;
        };
    }
    return { enforcer: createEnforcer(deps), calls };
}

const baseEvent = {
    platform: 'kick', channelId: 'chan1', userId: '456', username: 'baddie',
    messageId: 'msg1', isMod: false, isBroadcaster: false
};

test('no-ops for non-kick platforms', async () => {
    const { enforcer, calls } = build({ banlisted: true });
    const r = await enforcer.check({ ...baseEvent, platform: 'twitch' });
    assert.equal(r.acted, false);
    assert.equal(calls.bans.length, 0);
});

test('exempts broadcaster and mods', async () => {
    const { enforcer, calls } = build({ banlisted: true });
    assert.equal((await enforcer.check({ ...baseEvent, isBroadcaster: true })).acted, false);
    assert.equal((await enforcer.check({ ...baseEvent, isMod: true })).acted, false);
    assert.equal(calls.bans.length, 0);
});

test('exempts users on the unbanlist even if banlisted', async () => {
    const { enforcer, calls } = build({ banlisted: true, unbanlisted: true });
    assert.equal((await enforcer.check(baseEvent)).acted, false);
    assert.equal(calls.bans.length, 0);
});

test('passes through non-banlisted users', async () => {
    const { enforcer, calls } = build({ banlisted: false });
    assert.equal((await enforcer.check(baseEvent)).acted, false);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.logs.length, 0);
});

test('bans banlisted user when channel has moderation:ban', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: ['moderation:ban'] });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 1);
    assert.equal(calls.bans[0].b, '999');
    assert.equal(calls.bans[0].u, '456');
    assert.equal(calls.logs[0].action, 'ban');
    assert.equal(calls.logs[0].success, true);
});

test('falls back to delete when only manage scope present', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: ['moderation:chat_message:manage'] });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.deletes.length, 1);
    assert.equal(calls.deletes[0].m, 'msg1');
    assert.equal(calls.logs[0].action, 'delete');
});

test('manage scope without messageId falls through to detected_no_scope', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: ['moderation:chat_message:manage'] });
    const r = await enforcer.check({ ...baseEvent, messageId: null });
    assert.equal(r.acted, false);
    assert.equal(calls.deletes.length, 0);
    assert.equal(calls.logs[0].action, 'detected_no_scope');
});

test('logs detected_no_scope when dormant (no usable scope)', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: [] });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.deletes.length, 0);
    assert.equal(calls.logs[0].action, 'detected_no_scope');
});

test('no-ops when channel not enrolled / token missing', async () => {
    const { enforcer, calls } = build({ banlisted: true, channel: null });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.logs.length, 0);
});

test('no-ops when channel has token but no broadcasterId', async () => {
    const { enforcer, calls } = build({ banlisted: true, channel: { token: 'tok', scopes: ['moderation:ban'] } });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.bans.length, 0);
});

test('a thrown ban still logs success:false and acted:false', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: ['moderation:ban'], banThrows: true });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.logs.length, 1);
    assert.equal(calls.logs[0].action, 'ban');
    assert.equal(calls.logs[0].success, false);
});

// ── Phishing-link enforcement ─────────────────────────────────────────────

const linkEvent = { ...baseEvent, content: 'check this https://scam.example/free' };

test('non-banlisted user with a clean message: no action', async () => {
    const { enforcer, calls } = build({ banlisted: false, withPhishing: true, phishingDomain: null });
    const r = await enforcer.check({ ...baseEvent, content: 'hello chat' });
    assert.equal(r.acted, false);
    assert.equal(calls.deletes.length, 0);
    assert.equal(calls.bans.length, 0);
});

test('first phishing offense: delete + warn, no ban', async () => {
    const { enforcer, calls } = build({
        banlisted: false, withPhishing: true, phishingDomain: 'scam.example',
        offenseCount: 1, scopes: ['moderation:ban', 'moderation:chat_message:manage']
    });
    const r = await enforcer.check({ ...linkEvent, reply: () => calls.replies.push(1) });
    assert.equal(r.acted, true);
    assert.equal(calls.deletes.length, 1);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.logs[0].action, 'delete');
    assert.equal(calls.logs[0].reason, 'phishing:scam.example');
    assert.equal(calls.replies.length, 1); // warned
});

test('repeat phishing offense: ban', async () => {
    const { enforcer, calls } = build({
        banlisted: false, withPhishing: true, phishingDomain: 'scam.example',
        offenseCount: 2, scopes: ['moderation:ban', 'moderation:chat_message:manage']
    });
    const r = await enforcer.check(linkEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 1);
    assert.equal(calls.logs.find(l => l.action === 'ban').reason, 'phishing:scam.example');
});

test('repeat offense without ban scope: still just deletes', async () => {
    const { enforcer, calls } = build({
        banlisted: false, withPhishing: true, phishingDomain: 'scam.example',
        offenseCount: 5, scopes: ['moderation:chat_message:manage']
    });
    const r = await enforcer.check(linkEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.deletes.length, 1);
});

test('phishing link but channel only dormant (no scopes): detected_no_scope', async () => {
    const { enforcer, calls } = build({
        banlisted: false, withPhishing: true, phishingDomain: 'scam.example',
        offenseCount: 1, scopes: []
    });
    const r = await enforcer.check(linkEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.logs[0].action, 'detected_no_scope');
});

test('unbanlisted user is exempt from link scanning too', async () => {
    const { enforcer, calls } = build({
        banlisted: false, unbanlisted: true, withPhishing: true, phishingDomain: 'scam.example'
    });
    const r = await enforcer.check(linkEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.offenses.length, 0); // never even recorded
});

test('mod posting a phishing link is exempt', async () => {
    const { enforcer, calls } = build({ banlisted: false, withPhishing: true, phishingDomain: 'scam.example' });
    const r = await enforcer.check({ ...linkEvent, isMod: true });
    assert.equal(r.acted, false);
    assert.equal(calls.deletes.length, 0);
});

test('banlisted takes precedence over link scan', async () => {
    const { enforcer, calls } = build({
        banlisted: true, withPhishing: true, phishingDomain: 'scam.example', scopes: ['moderation:ban']
    });
    const r = await enforcer.check(linkEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 1);
    assert.equal(calls.bans[0].o.reason, 'KBD banlist'); // banlist reason, not phishing
    assert.equal(calls.offenses.length, 0); // link path not reached
});

test('phishing threshold is configurable (threshold 1 bans on first offense)', async () => {
    const { enforcer, calls } = build({
        withPhishing: true, phishingDomain: 'evil.com', offenseCount: 1,
        scopes: ['moderation:ban', 'moderation:chat_message:manage'],
        settings: { banDurationMin: null, phishingThreshold: 1, warningTemplate: 'x', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent });
    assert.equal(calls.bans.length, 1, 'should ban on first offense when threshold=1');
});

test('ban duration from settings is passed to banUser', async () => {
    const { enforcer, calls } = build({
        banlisted: true, scopes: ['moderation:ban'],
        settings: { banDurationMin: 600, phishingThreshold: 2, warningTemplate: 'x', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent });
    assert.equal(calls.bans.length, 1);
    assert.equal(calls.bans[0].o.durationMin, 600, 'ban opts should carry durationMin');
});

test('custom warning template is used on first phishing offense', async () => {
    const replies = [];
    const { enforcer } = build({
        withPhishing: true, phishingDomain: 'evil.com', offenseCount: 1,
        scopes: ['moderation:chat_message:manage'],
        settings: { banDurationMin: null, phishingThreshold: 2, warningTemplate: 'begone {{username}}', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent, reply: (m) => replies.push(m) });
    assert.equal(replies[0], 'begone baddie', 'warning should render template with username');
});

test('warning template handles usernames with $ safely', async () => {
    const replies = [];
    const { enforcer } = build({
        withPhishing: true, phishingDomain: 'evil.com', offenseCount: 1,
        scopes: ['moderation:chat_message:manage'],
        settings: { banDurationMin: null, phishingThreshold: 2, warningTemplate: 'hey {{username}} stop', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent, username: 'ca$h$&money', reply: (m) => replies.push(m) });
    assert.equal(replies[0], 'hey ca$h$&money stop', 'username with $ must be inserted literally');
});
