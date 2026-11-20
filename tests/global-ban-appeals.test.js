import './fixtures/test-log-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import GlobalBanManager from '../core/global-ban-manager.js';
import { appealDecisionScope, scopeText, isGlobalBanBanReason } from '../core/global-ban-appeal-scope.js';
import { requireSuperAdmin } from '../utils/auth-middleware.js';
import { isSuperAdmin } from '../utils/constants.js';

/*
 * H-802: any moderator in any server could approve a global ban appeal, which lifted the ban for every
 * server. Now only a CertiFried super-admin decides for every server; a server's moderators can only
 * approve for their own server (past the global ban only, allowlist kind 'globalban', + lifting that server's
 * "Global Ban:" ban; tests/global-ban-appeal-allow-kind.test.js covers the kind).
 * The database is stubbed: no query reaches MariaDB.
 */

const TEAM = '685127470625980501';   // utils/constants.js: always a super-admin
const MOD = '700000000000000001';
const USER = '800000000000000001';

const realExecute = pool.execute;
let sql = [];
let appealRow = null;
pool.execute = async (q, params = []) => {
    sql.push([q.replace(/\s+/g, ' ').trim(), params]);
    if (/FROM global_ban_appeals WHERE id = \?/.test(q)) return [appealRow ? [appealRow] : []];
    if (/SELECT COUNT\(\*\) AS n FROM protection_allowlist/.test(q)) return [[{ n: 0 }]];
    if (/information_schema\.COLUMNS/.test(q)) return [[{ t: "enum('user','role','held','manager','channel','category','bot','globalban')" }]];
    return [{ affectedRows: 1 }];
};
after(async () => { pool.execute = realExecute; await pool.end().catch(() => {}); });

const dms = [];
const manager = new GlobalBanManager({ users: { fetch: async (id) => ({ id, send: async (m) => dms.push([id, m.content]) }) } });
function guild({ banReason = 'Global Ban: spam (high)' } = {}) {
    const g = { id: '900000000000000001', name: 'Plant Club', removed: [],
        bans: { fetch: async () => (banReason === null ? null : { reason: banReason }), remove: async (id) => g.removed.push(id) } };
    return g;
}
function fresh() { sql = []; dms.length = 0; appealRow = { id: 7, global_ban_entry_id: 42, user_id: USER, status: 'pending' }; manager.banCache.set(USER, { severity: 'high' }); }
const ran = (re) => sql.some(([q]) => re.test(q));

test('decision scope: team decides for every server; a server moderator only approves for their server', () => {
    assert.equal(isSuperAdmin(TEAM), true);
    assert.equal(isSuperAdmin(MOD), false);
    assert.deepEqual(appealDecisionScope({ reviewerIsSuperAdmin: true, approved: false }), { scope: 'global' });
    assert.deepEqual(appealDecisionScope({ reviewerIsSuperAdmin: false, approved: true, inGuild: true }), { scope: 'server' });
    assert.equal(appealDecisionScope({ reviewerIsSuperAdmin: false, approved: false, inGuild: true }).scope, 'refuse');
    assert.equal(appealDecisionScope({ reviewerIsSuperAdmin: false, approved: true, inGuild: false }).scope, 'refuse');
    assert.match(scopeText('server', 'Plant Club'), /For Plant Club only/);
    assert.match(scopeText('global'), /every server/);
    assert.equal(isGlobalBanBanReason('Global Ban: spam (high)'), true);
    assert.equal(isGlobalBanBanReason('Raiding'), false);
});

test('a server moderator\'s approval stays in their server: allowlist + local unban, shared ban untouched', async () => {
    fresh();
    const g = guild();
    const r = await manager.reviewAppeal(MOD, 7, true, 'Fine here', { guild: g });
    assert.equal(r.success, true);
    assert.equal(r.scope, 'server');
    assert.equal(r.unbanned, true);
    assert.deepEqual(g.removed, [USER]);
    assert.ok(ran(/INSERT INTO protection_allowlist .*'globalban'/), 'let past the global ban in this server');
    assert.ok(!sql.some(([q, p]) => /INSERT INTO protection_allowlist/.test(q) && p.includes('user')), 'not put on the full allowlist');
    assert.ok(!ran(/UPDATE global_ban_entries/), 'the shared ban is not lifted');
    assert.ok(!ran(/UPDATE global_ban_appeals/), 'the appeal stays open for the team');
    assert.ok(ran(/INSERT INTO global_ban_action_log/));
    assert.ok(manager.banCache.has(USER), 'still enforced in every other server');
    assert.match(dms[0][1], /Plant Club accepted your appeal for their server/);
});

test('a server approval does not lift a ban that server made for its own reasons', async () => {
    fresh();
    const g = guild({ banReason: 'Harassment' });
    const r = await manager.reviewAppeal(MOD, 7, true, null, { guild: g });
    assert.equal(r.success, true);
    assert.equal(r.unbanned, false);
    assert.deepEqual(g.removed, []);
});

test('a server moderator cannot deny for the network, or decide outside a server', async () => {
    fresh();
    const deny = await manager.reviewAppeal(MOD, 7, false, 'no', { guild: guild() });
    assert.equal(deny.success, false);
    assert.equal(deny.scope, 'refuse');
    const dm = await manager.reviewAppeal(MOD, 7, true, 'yes');
    assert.equal(dm.success, false);
    assert.equal(sql.length, 0, 'nothing was read or written');
});

test('a super-admin approval lifts the shared ban for every server, even when made inside a server', async () => {
    fresh();
    const r = await manager.reviewAppeal(TEAM, 7, true, 'Lifted', { guild: guild() });
    assert.equal(r.success, true);
    assert.equal(r.scope, 'global');
    assert.ok(ran(/UPDATE global_ban_entries SET active = 0/));
    assert.ok(ran(/UPDATE global_ban_appeals SET status/));
    assert.ok(!ran(/INSERT INTO protection_allowlist/));
    assert.equal(manager.banCache.has(USER), false);
    assert.match(dms[0][1], /approved/);
});

test('requireSuperAdmin works on a route without :guildId (req.isSuperAdmin is never set there)', () => {
    const run = (id) => {
        let status = 200; let nexted = false;
        const res = { status(s) { status = s; return this; }, json() { return this; } };
        requireSuperAdmin({ user: { id, username: 'x' } }, res, () => { nexted = true; });
        return { status, nexted };
    };
    assert.deepEqual(run(TEAM), { status: 200, nexted: true });
    assert.deepEqual(run(MOD), { status: 403, nexted: false });
});
