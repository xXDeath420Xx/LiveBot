import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

/*
 * H-703: each right-click menu's switch and role limit (context_menu_config.enabled / permission_roles,
 * enforced by core/context-menu-config.js checkAccess) can be changed on the Context Menus page:
 * the spec's list has an editor keyed by menu name, PUT /api/guilds/:id/feature-config/context-menus/rows/:menu
 * saves through updateMenu(), and the change applies at once (the cached row is cleared).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h703-'));
process.env.LOG_DIR = tmp;
const pool = (await import('../utils/db.js')).default;
const { updateMenu, checkAccess, ensureRows } = await import('../core/context-menu-config.js');
const { FEATURE_SPECS } = await import('../core/feature-config-spec.js');
const router = (await import('../dashboard/routes/api/features/feature-config.js')).default;

const GUILD = '900000000000000703';
const ROLE = '900000000000000704';
const member = (roles = []) => ({ roles: { cache: new Map(roles.map((r) => [r, {}])) } });

let server;
let base;
test.before(async () => {
    await pool.execute('DELETE FROM context_menu_config WHERE guild_id = ?', [GUILD]);
    const app = express();
    app.use(express.json());
    app.use('/api/guilds/:guildId/feature-config', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/guilds/${GUILD}/feature-config/context-menus`;
});
test.after(async () => {
    await pool.execute('DELETE FROM context_menu_config WHERE guild_id = ?', [GUILD]);
    await pool.execute("DELETE FROM guild_feature_config WHERE guild_id = ? AND feature_key = 'context-menus'", [GUILD]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('the spec gives the list an editor keyed by menu name, with no Add', () => {
    const list = FEATURE_SPECS['context-menus'].list;
    assert.equal(list.editor, 'context-menus');
    assert.equal(list.key, 'menu_name');
    assert.equal(list.canAdd, false);
    assert.deepEqual(list.edit.map((f) => [f.key, f.type]), [['enabled', 'toggle'], ['permission_roles', 'roles']]);
    assert.doesNotMatch(FEATURE_SPECS['context-menus'].note, /cannot be switched/);
});

test('updateMenu changes the row checkAccess reads, at once', async () => {
    await ensureRows(GUILD, [{ name: 'User Info', type: 'user' }]);
    assert.equal((await checkAccess(GUILD, 'User Info', member())).allowed, true);   // also caches the row

    assert.equal((await updateMenu(GUILD, 'User Info', { enabled: 0 }, { guild: null })).ok, true);
    const off = await checkAccess(GUILD, 'User Info', member());
    assert.equal(off.allowed, false);
    assert.match(off.reason, /turned off/);

    const res = await updateMenu(GUILD, 'User Info', { enabled: 1, permission_roles: [ROLE] }, { guild: null });
    assert.equal(res.ok, true);
    assert.deepEqual(JSON.parse(res.row.permission_roles), [ROLE]);
    assert.equal((await checkAccess(GUILD, 'User Info', member())).allowed, false);
    assert.equal((await checkAccess(GUILD, 'User Info', member([ROLE]))).allowed, true);

    // An empty list stores NULL: anyone.
    assert.equal((await updateMenu(GUILD, 'User Info', { permission_roles: [] }, { guild: null })).row.permission_roles, null);
});

test('updateMenu refuses unknown menus, bad role ids and roles from another server', async () => {
    assert.equal((await updateMenu(GUILD, 'No Such Menu', { enabled: 0 }, { guild: null })).ok, false);
    assert.equal((await updateMenu(GUILD, 'User Info', { permission_roles: ['abc'] }, { guild: null })).ok, false);
    const guild = { roles: { cache: new Map([[ROLE, {}]]) } };
    assert.equal((await updateMenu(GUILD, 'User Info', { permission_roles: ['900000000000000999'] }, { guild })).error, 'A role is not in this server.');
    assert.equal((await updateMenu(GUILD, 'User Info', { permission_roles: [ROLE] }, { guild })).ok, true);
    assert.equal((await updateMenu(GUILD, 'User Info', {}, { guild: null })).ok, false);
});

test('the page API saves a menu by name and has no Add for this list', async () => {
    const page = await (await fetch(base)).json();
    assert.equal(page.spec.listKey, 'menu_name');
    assert.equal(page.spec.listAddLabel, null);
    assert.deepEqual(page.spec.listNoun, ['menu', 'menus']);
    assert.equal(page.spec.listSaveLabel, 'Save menu');
    assert.ok(page.rows.some((r) => r.menu_name === 'User Info' && 'permission_roles' in r), 'rows carry the editable columns');

    const put = await fetch(`${base}/rows/${encodeURIComponent('User Info')}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, permission_roles: [] }),
    });
    const body = await put.json();
    assert.equal(put.status, 200, JSON.stringify(body));
    assert.equal(body.row.menu_name, 'User Info');
    assert.equal(Number(body.row.enabled), 0);
    assert.equal((await checkAccess(GUILD, 'User Info', member())).allowed, false);

    const bad = await fetch(`${base}/rows/${encodeURIComponent('<script>')}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
    assert.equal(bad.status, 400);
    const add = await fetch(`${base}/rows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"x"}' });
    assert.equal(add.status, 404);
});
