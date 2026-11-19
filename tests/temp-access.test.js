/**
 * Temporary-access trials.
 *
 * These run against the real database because the module under test owns SQL
 * whose exact semantics are the point — `ON DUPLICATE KEY UPDATE` guarding a
 * live trial from being restarted, and status transitions that must only ever
 * fire on a 'pending' row. A fake db that returns whatever it is told would
 * assert nothing about either. Everything is scoped to synthetic guild ids and
 * torn down at the end; if MariaDB is not reachable the whole file skips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const GUILD = '999999999999999901';
const TEMP_ROLE = '888888888888888801';
const ACCESS_ROLE = '888888888888888802';
const OTHER_ROLE = '888888888888888803';

let pool, mgr, dbUp = true;

try {
    pool = (await import('../utils/db.js')).default;
    await pool.execute('SELECT 1');
    mgr = await import('../core/temp-access-manager.js');
} catch {
    dbUp = false;
}

const dbTest = (name, fn) => test(name, { skip: dbUp ? false : 'database not reachable' }, fn);

/** Minimal GuildMember stand-in: only the surface the manager actually touches. */
function fakeMember(id, roleIds = [], { voiceChannelId = null } = {}) {
    const added = [];
    const removed = [];
    const cache = new Collection();
    // Every member implicitly holds @everyone, whose id is the guild id — the
    // manager has to filter it out or nobody would ever look role-less.
    for (const rid of [GUILD, ...roleIds]) cache.set(rid, { id: rid, name: `role-${rid}` });

    const guildRoles = new Collection();
    for (const rid of [GUILD, TEMP_ROLE, ACCESS_ROLE, OTHER_ROLE]) guildRoles.set(rid, { id: rid, name: `role-${rid}` });

    return {
        id,
        added,
        removed,
        user: { id, bot: false, tag: `user-${id}` },
        voice: { channelId: voiceChannelId },
        guild: { id: GUILD, roles: { cache: guildRoles } },
        roles: {
            cache,
            add: async (ids) => { added.push(...[ids].flat()); for (const r of [ids].flat()) cache.set(r, { id: r, name: `role-${r}` }); },
            remove: async (id2) => { removed.push(id2); cache.delete(id2); },
        },
    };
}

async function writeConfig(overrides = {}) {
    const cfg = {
        enabled: 1, temp_role_id: TEMP_ROLE, access_role_ids: JSON.stringify([ACCESS_ROLE]),
        trial_hours: 24, dm_on_kick: 1, keep_role_on_pass: 0, log_channel_id: null, ...overrides,
    };
    await pool.execute(
        `INSERT INTO temp_access_config
             (guild_id, enabled, temp_role_id, access_role_ids, trial_hours, dm_on_kick, keep_role_on_pass, log_channel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), temp_role_id = VALUES(temp_role_id),
             access_role_ids = VALUES(access_role_ids), trial_hours = VALUES(trial_hours),
             dm_on_kick = VALUES(dm_on_kick), keep_role_on_pass = VALUES(keep_role_on_pass),
             log_channel_id = VALUES(log_channel_id)`,
        [GUILD, cfg.enabled, cfg.temp_role_id, cfg.access_role_ids, cfg.trial_hours,
            cfg.dm_on_kick, cfg.keep_role_on_pass, cfg.log_channel_id]
    );
    mgr.invalidateConfig(GUILD);
    return mgr.getConfig(GUILD);
}

async function rowFor(userId) {
    const [rows] = await pool.execute(
        'SELECT * FROM temp_access_members WHERE guild_id = ? AND user_id = ?', [GUILD, userId]
    );
    return rows[0] || null;
}

async function cleanup() {
    if (!dbUp) return;
    await pool.execute('DELETE FROM temp_access_members WHERE guild_id = ?', [GUILD]);
    await pool.execute('DELETE FROM temp_access_invites WHERE guild_id = ?', [GUILD]);
    await pool.execute('DELETE FROM temp_access_config WHERE guild_id = ?', [GUILD]);
}

test.before(cleanup);
test.after(cleanup);

dbTest('startTrial grants the guest role plus the access roles and records a deadline', async () => {
    const cfg = await writeConfig();
    const member = fakeMember('700000000000000001');

    assert.equal(await mgr.startTrial(member, { source: 'invite', inviteCode: 'abc123', cfg }), 'started');
    assert.deepEqual(member.added.sort(), [TEMP_ROLE, ACCESS_ROLE].sort());

    const row = await rowFor(member.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.invite_code, 'abc123');
    const window = new Date(row.expires_at) - new Date(row.started_at);
    assert.ok(Math.abs(window - 24 * 3600 * 1000) < 5000, `expected a ~24h window, got ${window}ms`);
    assert.equal(mgr.hasPendingTrial(GUILD, member.id), true);
});

dbTest('a second grant does not hand a live trial a fresh deadline', async () => {
    const cfg = await writeConfig();
    const member = fakeMember('700000000000000002');

    await mgr.startTrial(member, { cfg });
    const first = await rowFor(member.id);

    // The member now holds the roles from the first call — exactly the state a
    // re-fire of guildMemberUpdate would present.
    assert.equal(await mgr.startTrial(member, { cfg }), 'already-pending');
    const second = await rowFor(member.id);
    assert.equal(second.expires_at.getTime(), first.expires_at.getTime());
});

dbTest('someone who already holds an unrelated role is never put on trial', async () => {
    const cfg = await writeConfig();
    const member = fakeMember('700000000000000003', [OTHER_ROLE]);

    assert.equal(await mgr.startTrial(member, { cfg }), 'exempt');
    assert.equal(await rowFor(member.id), null);
    assert.deepEqual(member.added, []);
});

dbTest('hasForeignRole ignores @everyone and the roles this system grants', async () => {
    const cfg = await writeConfig();
    assert.equal(mgr.hasForeignRole(fakeMember('1', [TEMP_ROLE, ACCESS_ROLE]), cfg), false);
    assert.equal(mgr.hasForeignRole(fakeMember('1', []), cfg), false);
    assert.equal(mgr.hasForeignRole(fakeMember('1', [TEMP_ROLE, OTHER_ROLE]), cfg), true);
});

dbTest('the first message ends the trial in the guest\'s favour and drops the guest role', async () => {
    const cfg = await writeConfig({ keep_role_on_pass: 0 });
    const member = fakeMember('700000000000000004');
    await mgr.startTrial(member, { cfg });

    mgr.markActivity(GUILD, member.id, 'message', member);
    // markActivity is fire-and-forget by design; let its write land.
    await new Promise(r => setTimeout(r, 250));

    const row = await rowFor(member.id);
    assert.equal(row.status, 'passed');
    assert.equal(row.activity_kind, 'message');
    assert.ok(row.first_activity_at);
    assert.deepEqual(member.removed, [TEMP_ROLE]);
    assert.equal(mgr.hasPendingTrial(GUILD, member.id), false);
});

dbTest('keep_role_on_pass leaves the guest role in place', async () => {
    const cfg = await writeConfig({ keep_role_on_pass: 1 });
    const member = fakeMember('700000000000000005');
    await mgr.startTrial(member, { cfg });

    mgr.markActivity(GUILD, member.id, 'voice', member);
    await new Promise(r => setTimeout(r, 250));

    assert.equal((await rowFor(member.id)).status, 'passed');
    assert.deepEqual(member.removed, []);
});

dbTest('activity from someone with no trial is a no-op, not a write', async () => {
    await writeConfig();
    mgr.markActivity(GUILD, '700000000000000099', 'message', null);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await rowFor('700000000000000099'), null);
});

dbTest('being handed another role exempts a guest; leaving closes the trial', async () => {
    const cfg = await writeConfig();
    const a = fakeMember('700000000000000006');
    const b = fakeMember('700000000000000007');
    await mgr.startTrial(a, { cfg });
    await mgr.startTrial(b, { cfg });

    assert.equal(await mgr.markExempt(GUILD, a.id, 'received role: VIP'), true);
    assert.equal((await rowFor(a.id)).status, 'exempt');
    assert.equal(mgr.hasPendingTrial(GUILD, a.id), false);

    await mgr.markLeft(GUILD, b.id);
    assert.equal((await rowFor(b.id)).status, 'left');
});

dbTest('a resolved trial restarts cleanly when the member comes back', async () => {
    const cfg = await writeConfig();
    const member = fakeMember('700000000000000008');
    await mgr.startTrial(member, { cfg });
    await mgr.markLeft(GUILD, member.id);

    // Rejoining strips their roles, so they arrive role-less again.
    const returning = fakeMember(member.id);
    assert.equal(await mgr.startTrial(returning, { source: 'invite', inviteCode: 'xyz789', cfg }), 'started');

    const row = await rowFor(member.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.invite_code, 'xyz789');
    assert.equal(row.first_activity_at, null);
    assert.equal(row.resolved_at, null);
});

dbTest('a disabled guild starts no trials', async () => {
    const cfg = await writeConfig({ enabled: 0 });
    const member = fakeMember('700000000000000009');
    assert.equal(await mgr.startTrial(member, { cfg }), 'skipped');
    assert.equal(await rowFor(member.id), null);
});

/* ---------------- invite attribution ---------------- */

function fakeGuild(invites) {
    const coll = new Collection();
    for (const i of invites) coll.set(i.code, i);
    return { id: GUILD, invites: { fetch: async () => coll } };
}

async function seedInvite(code, usesSeen, { active = 1 } = {}) {
    await pool.execute(
        `INSERT INTO temp_access_invites (guild_id, invite_code, channel_id, created_by, max_uses, max_age, uses_seen, active)
         VALUES (?, ?, '1', '1', 0, 0, ?, ?)
         ON DUPLICATE KEY UPDATE uses_seen = VALUES(uses_seen), active = VALUES(active)`,
        [GUILD, code, usesSeen, active]
    );
}

dbTest('attribution: the tracked invite whose use count grew wins', async () => {
    await writeConfig();
    await pool.execute('DELETE FROM temp_access_invites WHERE guild_id = ?', [GUILD]);
    await seedInvite('guest01', 3);
    await seedInvite('guest02', 7);

    const code = await mgr.attributeJoin(fakeGuild([
        { code: 'guest01', uses: 4 },
        { code: 'guest02', uses: 7 },
        { code: 'untracked', uses: 99 },
    ]));
    assert.equal(code, 'guest01');

    // The new count is persisted, so the same increment cannot be claimed twice.
    const [[row]] = await pool.execute(
        'SELECT uses_seen FROM temp_access_invites WHERE guild_id = ? AND invite_code = ?', [GUILD, 'guest01']
    );
    assert.equal(row.uses_seen, 4);
    assert.equal(await mgr.attributeJoin(fakeGuild([{ code: 'guest01', uses: 4 }, { code: 'guest02', uses: 7 }])), null);
});

dbTest('attribution: a join through an untracked invite is not ours', async () => {
    await writeConfig();
    await pool.execute('DELETE FROM temp_access_invites WHERE guild_id = ?', [GUILD]);
    await seedInvite('guest03', 1);

    assert.equal(await mgr.attributeJoin(fakeGuild([
        { code: 'guest03', uses: 1 },
        { code: 'somebody-elses', uses: 50 },
    ])), null);
});

dbTest('attribution: a single-use guest invite that just vanished still counts', async () => {
    await writeConfig();
    await pool.execute('DELETE FROM temp_access_invites WHERE guild_id = ?', [GUILD]);
    await seedInvite('guest04', 0);

    // Discord deletes a maxUses:1 invite the instant it is used, so it is simply
    // absent from the fetch — there is no incremented count left to read.
    assert.equal(await mgr.attributeJoin(fakeGuild([])), 'guest04');

    // ...and it is retired, so the NEXT join can't be pinned on it too.
    assert.equal(await mgr.attributeJoin(fakeGuild([])), null);
});

dbTest('attribution: no tracked invites means no work and no attribution', async () => {
    await writeConfig();
    await pool.execute('DELETE FROM temp_access_invites WHERE guild_id = ?', [GUILD]);
    let fetched = false;
    const guild = { id: GUILD, invites: { fetch: async () => { fetched = true; return new Collection(); } } };
    assert.equal(await mgr.attributeJoin(guild), null);
    assert.equal(fetched, false, 'should not hit the Discord API when nothing is tracked');
});

dbTest('resyncInviteCounts adopts the live counts without attributing a join', async () => {
    await writeConfig();
    await pool.execute('DELETE FROM temp_access_invites WHERE guild_id = ?', [GUILD]);
    await seedInvite('guest05', 2);

    // Joins during an outage: the count moved but nobody should be put on trial.
    await mgr.resyncInviteCounts(fakeGuild([{ code: 'guest05', uses: 9 }]));
    assert.equal(await mgr.attributeJoin(fakeGuild([{ code: 'guest05', uses: 9 }])), null);
});

dbTest('primeTempAccess rebuilds the pending set from the database', async () => {
    const cfg = await writeConfig();
    const member = fakeMember('700000000000000010');
    await mgr.startTrial(member, { cfg });

    await mgr.primeTempAccess();
    assert.equal(mgr.hasPendingTrial(GUILD, member.id), true);

    await mgr.markLeft(GUILD, member.id);
    await mgr.primeTempAccess();
    assert.equal(mgr.hasPendingTrial(GUILD, member.id), false);
});
