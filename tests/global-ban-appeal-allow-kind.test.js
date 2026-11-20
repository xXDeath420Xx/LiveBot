import './fixtures/test-log-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import GlobalBanManager from '../core/global-ban-manager.js';
import {
    isExempt, isGlobalBanAllowed, allowGlobalBan, removeAllow, listAllowlist, addAllow, invalidate, protectionsOverview,
} from '../core/protection-exempt.js';
import { up } from '../migrations/471_globalban_appeal_allow_kind.js';

/*
 * H-802 follow-up (fix wave 6, 2026-11-20): a server moderator accepting a global ban appeal used to put the
 * person on the server's protection allowlist, which exempts them from EVERY protection there. Now it is
 * protection_allowlist kind 'globalban': past the global ban only. Raid, phishing, name filters and the rest
 * still see them as not exempt. Also: the trusted-bot kind the Protection Settings page sends is accepted and
 * listed (it was refused as "Unknown kind."), and migration 471 moves rows the old path created.
 * The database is stubbed: no query reaches MariaDB.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = '900000000000000071';
const USER = '800000000000000071';
const MOD = '700000000000000071';

let migrated = false;
let rows = [];          // protection_allowlist rows for G
let sql = [];
const realExecute = pool.execute;
pool.execute = async (q, params = []) => {
    const flat = q.replace(/\s+/g, ' ').trim();
    sql.push([flat, params]);
    if (/information_schema\.COLUMNS/.test(flat)) {
        return [[{ t: `enum('user','role','held','manager','channel','category','bot'${migrated ? ",'globalban'" : ''})`, COLUMN_TYPE: `enum('user','role','held','manager','channel','category','bot'${migrated ? ",'globalban'" : ''})` }]];
    }
    if (/SELECT kind, target_id, via_role_id FROM protection_allowlist/.test(flat)) return [(params[0] === G ? rows : []).map(r => ({ kind: r.kind, target_id: r.target_id, via_role_id: null }))];
    if (/FROM guilds WHERE guild_id/.test(flat)) return [[]];
    if (/SELECT COUNT\(\*\) AS n FROM protection_allowlist/.test(flat)) return [[{ n: 0 }]];
    if (/^INSERT INTO protection_allowlist .*'globalban'/.test(flat)) { rows.push({ kind: 'globalban', target_id: params[1] }); return [{ affectedRows: 1 }]; }
    if (/^INSERT INTO protection_allowlist/.test(flat)) { rows.push({ kind: params[1], target_id: params[2] }); return [{ affectedRows: 1 }]; }
    if (/^DELETE FROM protection_allowlist WHERE guild_id = \? AND kind = \? AND target_id = \?/.test(flat)) {
        const before = rows.length;
        rows = rows.filter(r => !(r.kind === params[1] && r.target_id === params[2]));
        return [{ affectedRows: before - rows.length }];
    }
    if (/SELECT kind, target_id, added_by, note, added_at FROM protection_allowlist/.test(flat)) {
        const kinds = (flat.match(/kind IN \(([^)]+)\)/)?.[1] || '').replace(/'/g, '').split(',');
        return [rows.filter(r => kinds.includes(r.kind)).map(r => ({ ...r, added_by: null, note: null, added_at: null }))];
    }
    return [[]];
};
after(async () => { pool.execute = realExecute; await pool.end().catch(() => {}); });

const fakeGuild = () => {
    const g = { id: G, name: 'Plant Club', ownerId: '1', removed: [], members: { cache: new Map(), fetch: async () => null },
        roles: { cache: new Map() }, bans: { fetch: async () => ({ reason: 'Global Ban: spam (high)' }), remove: async (id) => g.removed.push(id) } };
    return g;
};
const memberOf = (guild) => ({ id: USER, user: { id: USER, bot: false }, guild, roles: { cache: new Map() } });
const appeal = { id: 9, global_ban_entry_id: 42, user_id: USER, status: 'pending' };
const reset = () => { rows = []; sql = []; invalidate(G); };

test('before migration 471 the approval changes nothing (never falls back to the full allowlist)', async () => {
    reset();
    const manager = new GlobalBanManager({ users: { fetch: async (id) => ({ id, send: async () => {} }) } });
    const g = fakeGuild();
    const r = await manager.approveAppealForServer(appeal, g, MOD, 'ok');
    assert.equal(r.success, false);
    assert.match(r.message, /migration 471/);
    assert.equal(rows.length, 0);
    assert.deepEqual(g.removed, [], 'no unban either');
});

test('a server approval lets them past the global ban only: every other protection still applies', async () => {
    reset();
    migrated = true;
    const manager = new GlobalBanManager({ users: { fetch: async (id) => ({ id, send: async () => {} }) } });
    const g = fakeGuild();
    const r = await manager.approveAppealForServer(appeal, g, MOD, 'ok');
    assert.equal(r.success, true);
    assert.deepEqual(rows, [{ kind: 'globalban', target_id: USER }]);
    assert.deepEqual(g.removed, [USER], 'their global-ban ban here was lifted');
    invalidate(G);
    assert.equal(await isGlobalBanAllowed(G, USER), true, 'the global ban skips them here');
    assert.equal(await isGlobalBanAllowed('900000000000000072', USER), false, 'and only here');
    const ex = await isExempt(memberOf(g));
    assert.equal(ex.exempt, false, 'raid, phishing, name filters and the rest still act on them');
    assert.deepEqual(await listAllowlist(G), [], 'not on the allowlist');
    const overview = await protectionsOverview(G);
    assert.ok('globalBanAppealsAllowed' in overview.otherLists);
    // A moderator can undo it
    const off = await removeAllow(g, 'globalban', USER, MOD);
    assert.equal(off.removed, true);
    invalidate(G);
    assert.equal(await isGlobalBanAllowed(G, USER), false);
});

test('the global ban checks skip a person this server accepted, before any action', () => {
    const src = fs.readFileSync(path.join(root, 'core/global-ban-manager.js'), 'utf8');
    const join = src.slice(src.indexOf('async checkMember(member)'), src.indexOf('async checkMessage(message)'));
    assert.ok(join.indexOf('isGlobalBanAllowed(member.guild.id, member.id)') > 0 && join.indexOf('isGlobalBanAllowed') < join.indexOf('executeAction'));
    const msg = src.slice(src.indexOf('async checkMessage(message)'), src.indexOf('isExempt(member, config) {'));
    assert.ok(msg.indexOf('isGlobalBanAllowed(message.guild.id, message.author.id)') > 0 && msg.indexOf('isGlobalBanAllowed') < msg.indexOf('executeAction'));
    assert.ok(!/addAllow\(guild, 'user'/.test(src), 'the appeal path no longer uses the full allowlist');
});

test('trusted bots: the kind the Protection Settings page sends is accepted, listed and removable', async () => {
    reset();
    const g = fakeGuild();
    assert.deepEqual(await addAllow(g, 'bot', '600000000000000071', MOD), { ok: true });
    assert.deepEqual((await listAllowlist(G)).map(r => [r.kind, r.target_id]), [['bot', '600000000000000071']]);
    assert.equal((await removeAllow(g, 'bot', '600000000000000071', MOD)).removed, true);
    assert.deepEqual(await addAllow(g, 'manager', '1', MOD), { ok: false, error: 'Unknown kind.' });
});

test('migration 471: adds the kind once and moves only rows the appeal path made', async () => {
    const calls = [];
    let kinds = ['user', 'role', 'held', 'manager', 'channel', 'category', 'bot'];
    const db = { execute: async (q, p = []) => {
        const flat = q.replace(/\s+/g, ' ').trim();
        calls.push([flat, p]);
        if (/information_schema\.COLUMNS/.test(flat)) return [[{ COLUMN_TYPE: `enum(${kinds.map(k => `'${k}'`).join(',')})` }]];
        if (/^ALTER TABLE protection_allowlist/.test(flat)) { kinds = flat.match(/ENUM\((.+)\) NOT NULL/)[1].split(',').map(s => s.replace(/'/g, '')); return [{}]; }
        if (/information_schema\.tables/.test(flat)) return [[{ n: 1 }]];
        if (/^SELECT a\.guild_id/.test(flat)) return [[{ guild_id: G, target_id: USER, added_by: MOD, note: 'Global ban appeal #9 approved for this server', added_at: null }]];
        return [{ affectedRows: 1 }];
    } };
    const r = await up(db);
    assert.ok(kinds.includes('globalban'));
    assert.equal(r.moved, 1);
    assert.ok(calls.some(([q]) => /INSERT IGNORE INTO protection_allowlist .*'globalban'/.test(q)));
    assert.ok(calls.some(([q, p]) => /DELETE FROM protection_allowlist WHERE guild_id = \? AND kind = 'user'/.test(q) && p[2] === 'Global ban appeal #9 approved for this server'));
    const sel = calls.find(([q]) => /^SELECT a\.guild_id/.test(q))[0];
    assert.match(sel, /note LIKE 'Global ban appeal #% approved for this server'/);
    assert.match(sel, /l\.action = 'appeal_server_allow'/, 'only rows with the matching log entry');
    const alters = calls.filter(([q]) => /^ALTER/.test(q)).length;
    await up(db);
    assert.equal(calls.filter(([q]) => /^ALTER/.test(q)).length, alters, 'safe to re-run');
});

test('the texts say what the approval does now', () => {
    const cmd = fs.readFileSync(path.join(root, 'commands/admin/globalban.js'), 'utf8');
    assert.ok(cmd.includes('Every other protection (raids, scam links, name filters and the rest) still applies to them.'));
    assert.ok(!cmd.includes("is now on this server's protection allowlist"));
    const guide = fs.readFileSync(path.join(root, 'dashboard/content/guides/global-ban.js'), 'utf8');
    assert.ok(guide.includes('**Accepted global ban appeals**'));
    const page = fs.readFileSync(path.join(root, 'dashboard/views/partials/manage/protection-settings.ejs'), 'utf8');
    assert.ok(page.includes("api(`/allowlist/globalban/${u.id}`)"));
});
