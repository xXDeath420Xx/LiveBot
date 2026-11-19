import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { normaliseFilter, applyFilter, describeFilter } from '../core/activity-audit-filter.js';

/*
 * The protection rules decide who gets kicked, so they are tested against constructed
 * members rather than whatever the live server happens to contain — a real guild cannot be
 * made to contain a member the bot is unable to kick on demand, and those are exactly the
 * cases that must not regress.
 */

const CTX = { nowMs: Date.parse('2026-08-22T00:00:00Z'), windowStartMs: Date.parse('2026-05-24T00:00:00Z') };

const member = (over = {}) => ({
    userId: '100', displayName: 'Someone', username: 'someone', isBot: false, inGuild: true,
    joinedGuildAt: '2026-01-01T00:00:00Z', messages: 0, channelsPosted: 0,
    firstPost: null, lastPost: null, voiceSeconds: 0, voiceSessions: 0, voiceLast: null,
    lastActive: null, daysSinceActive: null, voiceHours: 0, ...over,
});

test('filter: never-active selects only zero-message zero-voice members', () => {
    const rows = [
        member({ userId: '1' }),
        member({ userId: '2', messages: 5, daysSinceActive: 3 }),
        member({ userId: '3', voiceSeconds: 60, voiceSessions: 1, daysSinceActive: 10 }),
    ];
    const got = applyFilter(rows, normaliseFilter({ segments: ['never_active'] }), CTX);
    assert.deepEqual(got.map(m => m.userId), ['1']);
});

test('filter: bots and departed members are excluded unless asked for', () => {
    const rows = [
        member({ userId: '1' }),
        member({ userId: '2', isBot: true }),
        member({ userId: '3', inGuild: false }),
    ];
    assert.deepEqual(applyFilter(rows, normaliseFilter({}), CTX).map(m => m.userId), ['1']);
    assert.equal(applyFilter(rows, normaliseFilter({ includeBots: true }), CTX).length, 2);
    assert.equal(applyFilter(rows, normaliseFilter({ includeLeft: true }), CTX).length, 2);
});

test('filter: never-active counts as maximally quiet for a minimum, never for a maximum', () => {
    // A member who never did anything has no "last active" date. Treating that as 0 days
    // would hide them from a dormancy sweep, which is the one query they must appear in.
    const rows = [member({ userId: '1' }), member({ userId: '2', messages: 1, daysSinceActive: 5 })];
    assert.deepEqual(
        applyFilter(rows, normaliseFilter({ daysSinceActiveMin: 60 }), CTX).map(m => m.userId), ['1']);
    assert.deepEqual(
        applyFilter(rows, normaliseFilter({ daysSinceActiveMax: 90 }), CTX).map(m => m.userId), ['2']);
});

test('filter: role conditions fail closed when role data is missing', () => {
    // An un-evaluated "must not have Staff" must not let staff through into a kick set.
    const rows = [member({ userId: '1' })];
    assert.equal(applyFilter(rows, normaliseFilter({ lacksRoles: ['999999999999999999'] }), CTX, null).length, 0);
    const roleMap = new Map([['1', ['888888888888888888']]]);
    assert.equal(applyFilter(rows, normaliseFilter({ lacksRoles: ['999999999999999999'] }), CTX, roleMap).length, 1);
    assert.equal(applyFilter(rows, normaliseFilter({ lacksRoles: ['888888888888888888'] }), CTX, roleMap).length, 0);
});

test('filter: unknown join date cannot satisfy a membership-length condition', () => {
    const rows = [member({ userId: '1', joinedGuildAt: null })];
    assert.equal(applyFilter(rows, normaliseFilter({ membershipDaysMin: 7 }), CTX).length, 0);
});

test('describeFilter states voice conditions, not just message ones', () => {
    // An understated summary on an irreversible action is worse than no summary.
    const label = describeFilter(normaliseFilter({ messagesMax: 2, voiceSecondsMax: 0 }));
    assert.match(label, /messages/);
    assert.match(label, /voice/i);
});

test('normaliseFilter rejects junk and unknown segments', () => {
    const f = normaliseFilter({
        segments: ['never_active', 'not_a_segment', 'all'],
        messagesMin: 'abc', voiceSecondsMax: '120',
        hasRoles: ['123', '999999999999999999'], search: '  hi  ',
    });
    assert.deepEqual(f.segments, ['never_active']);   // 'all' and junk dropped
    assert.equal(f.messagesMin, null);
    assert.equal(f.voiceSecondsMax, 120);
    assert.deepEqual(f.hasRoles, ['999999999999999999']);  // short id dropped
    assert.equal(f.search, 'hi');
});

/* ── protection rules ──────────────────────────────────────────────────────
 * planAction is exercised through a mock guild. Constructing a real member the bot cannot
 * kick, or a role positioned above the bot, is not something a live server can be asked to
 * provide on demand — and those are precisely the paths that must never regress.
 */
import { planAction } from '../core/activity-audit-actions.js';
import pool from '../utils/db.js';

const OWNER = '900000000000000001';
const BOT_OWNER = '365905620060340224';
const ACTOR = '900000000000000009';

function mockMember(id, over = {}) {
    const perms = over.permissions ?? [];
    return {
        id,
        displayName: over.displayName ?? `M${id}`,
        user: { id, bot: over.bot ?? false, username: `u${id}` },
        permissions: { has: (p) => perms.includes(p) },
        kickable: over.kickable ?? true,
        joinedTimestamp: over.joinedTimestamp ?? Date.parse('2026-01-01T00:00:00Z'),
        joinedAt: new Date(over.joinedTimestamp ?? Date.parse('2026-01-01T00:00:00Z')),
        roles: { cache: new Map((over.roles ?? []).map(r => [r, { id: r }])), highest: { position: over.highest ?? 1 } },
    };
}

function mockGuild(members, { roles = [] } = {}) {
    const cache = new Map(members.map(m => [m.id, m]));
    cache.map = (fn) => [...cache.values()].map(fn);
    const me = mockMember('999', { permissions: [PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageRoles] });
    me.roles.highest = { position: 50 };
    return {
        id: 'G1', ownerId: OWNER, memberCount: members.length,
        members: { cache, me, fetch: async () => cache, fetchMe: async () => me },
        roles: { cache: new Map(roles.map(r => [r.id, r])) },
    };
}

/** Stub loadAudit's data by inserting a throwaway audit, then clean it up. */
async function withAudit(members, fn) {
    const [ins] = await pool.execute(
        `INSERT INTO activity_audits (guild_id, window_days, status, voice_tracked, completed_at, totals, scanned)
         VALUES ('G1', 90, 'complete', 1, NOW(), '{}', '{"containers":1,"readable":1,"denied":0}')`);
    const auditId = ins.insertId;
    try {
        await pool.query(
            `INSERT INTO activity_audit_members
               (audit_id, user_id, username, display_name, is_bot, in_guild, joined_guild_at, messages, voice_seconds, voice_sessions)
             VALUES ?`,
            [members.map(m => [auditId, m.id, `u${m.id}`, m.displayName ?? `M${m.id}`, 0, 1,
                new Date(m.joinedTimestamp), 0, 0, 0])]);
        await fn(auditId);
    } finally {
        await pool.execute('DELETE FROM activity_audit_members WHERE audit_id = ?', [auditId]);
        await pool.execute('DELETE FROM activity_audits WHERE audit_id = ?', [auditId]);
    }
}

const reasons = (plan) => Object.fromEntries(plan.blocked.map(b => [b.userId, b.reason]));

test('kick plan protects owner, bot owner, actor, bots, staff and unkickable members', async () => {
    const members = [
        mockMember(OWNER),
        mockMember(BOT_OWNER),
        mockMember(ACTOR),
        mockMember('1000', { bot: true }),
        mockMember('1001', { permissions: [PermissionFlagsBits.ManageGuild] }),
        mockMember('1002', { kickable: false }),
        mockMember('1003'),                       // the only legitimate target
    ];
    const guild = mockGuild(members);
    const client = { guilds: { cache: new Map([['G1', guild]]) } };

    await withAudit(members, async (auditId) => {
        const plan = await planAction(client, 'G1', {
            auditId, actionType: 'kick', filter: { segments: ['never_active'] },
            actorId: ACTOR, minMembershipDays: 0,
        });
        const why = reasons(plan);
        assert.equal(why[OWNER], 'is the server owner');
        assert.equal(why[BOT_OWNER], 'is the bot owner');
        assert.equal(why[ACTOR], 'is you');
        assert.equal(why['1000'], 'is a bot');
        assert.equal(why['1001'], 'holds staff permissions');
        assert.equal(why['1002'], 'bot cannot kick them (role hierarchy)');
        assert.deepEqual(plan.eligible.map(e => e.userId), ['1003']);
    });
});

test('kick plan honours the newcomer grace period', async () => {
    const fresh = Date.now() - 2 * 86400000;
    const members = [mockMember('2001', { joinedTimestamp: fresh }), mockMember('2002')];
    const guild = mockGuild(members);
    const client = { guilds: { cache: new Map([['G1', guild]]) } };

    await withAudit(members, async (auditId) => {
        const plan = await planAction(client, 'G1', {
            auditId, actionType: 'kick', filter: { segments: ['never_active'] },
            actorId: ACTOR, minMembershipDays: 7,
        });
        assert.match(reasons(plan)['2001'], /grace period/);
        assert.deepEqual(plan.eligible.map(e => e.userId), ['2002']);
    });
});

test('the plan token changes when the eligible set changes', async () => {
    const members = [mockMember('3001'), mockMember('3002')];
    const guild = mockGuild(members);
    const client = { guilds: { cache: new Map([['G1', guild]]) } };

    await withAudit(members, async (auditId) => {
        const spec = { auditId, actionType: 'kick', filter: { segments: ['never_active'] }, actorId: ACTOR, minMembershipDays: 0 };
        const a = await planAction(client, 'G1', spec);
        assert.equal(a.eligible.length, 2);

        // One becomes staff — the approved set is no longer the current set.
        guild.members.cache.get('3002').permissions = { has: (p) => p === PermissionFlagsBits.ManageGuild };
        const b = await planAction(client, 'G1', spec);
        assert.equal(b.eligible.length, 1);
        assert.notEqual(a.token, b.token, 'token must change so a stale approval cannot execute');
    });
});

test('role actions refuse a role positioned above the bot', async () => {
    const members = [mockMember('4001')];
    const guild = mockGuild(members, { roles: [{ id: '4000000000000000001', position: 99, managed: false }] });
    const client = { guilds: { cache: new Map([['G1', guild]]) } };

    await withAudit(members, async (auditId) => {
        const plan = await planAction(client, 'G1', {
            auditId, actionType: 'add_role', roleId: '4000000000000000001',
            filter: { segments: ['never_active'] }, actorId: ACTOR,
        });
        assert.equal(reasons(plan)['4001'], 'target role is above the bot');
        assert.equal(plan.eligible.length, 0);
    });
});

test('a destructive action refuses a stale snapshot', async () => {
    const members = [mockMember('5001')];
    const guild = mockGuild(members);
    const client = { guilds: { cache: new Map([['G1', guild]]) } };

    await withAudit(members, async (auditId) => {
        // Age the snapshot past the limit.
        await pool.execute(
            'UPDATE activity_audits SET completed_at = DATE_SUB(NOW(), INTERVAL 5 DAY) WHERE audit_id = ?', [auditId]);
        await assert.rejects(
            () => planAction(client, 'G1', {
                auditId, actionType: 'kick', filter: { segments: ['never_active'] }, actorId: ACTOR,
            }),
            /Re-run it before kicking/);

        // A non-destructive action is still allowed on the same snapshot.
        const plan = await planAction(client, 'G1', {
            auditId, actionType: 'add_role', roleId: '5000000000000000001',
            filter: { segments: ['never_active'] }, actorId: ACTOR,
        });
        assert.ok(plan.warnings.some(w => /old/.test(w)));
    });
});
