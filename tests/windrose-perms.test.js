import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROLES, roleAtLeast, normaliseCommand, isCommandAllowed, catalogNames,
    getRole, setRole, audit, requireRole, OWNER_ONLY_COMMANDS,
} from '../dashboard/services/windrose-perms.js';

// In-memory stand-in for utils/db.js's query(). Every exported function takes
// an injectable db so these tests never touch MariaDB.
function fakeDb(rowsFor = () => []) {
    const calls = [];
    return {
        calls,
        query: async (sql, params = []) => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            return rowsFor(sql, params) ?? [];
        },
    };
}

test('role hierarchy is ordered weakest to strongest', () => {
    assert.deepEqual(ROLES, ['viewer', 'player', 'admin', 'owner']);
    assert.equal(roleAtLeast('owner', 'admin'), true);
    assert.equal(roleAtLeast('admin', 'admin'), true);
    assert.equal(roleAtLeast('player', 'admin'), false);
    assert.equal(roleAtLeast('viewer', 'player'), false);
});

test('unknown roles are denied rather than treated as the weakest', () => {
    // A typo in a DB row must not silently grant anything.
    assert.equal(roleAtLeast('administrator', 'viewer'), false);
    assert.equal(roleAtLeast(undefined, 'viewer'), false);
    assert.equal(roleAtLeast('viewer', 'godmode'), false);
});

test('command normalisation strips case, padding and arguments', () => {
    assert.equal(normaliseCommand('  WP.Inspect someActor '), 'wp.inspect');
    assert.equal(normaliseCommand('wp.status'), 'wp.status');
    assert.equal(normaliseCommand('   '), null);
    assert.equal(normaliseCommand(null), null);
});

test('the allowlist cannot be bypassed by casing or whitespace', () => {
    // The whole point of normalising: a raw string comparison lets these through.
    for (const variant of ['wp.inspect', 'WP.INSPECT', '  wp.Inspect  ', 'wp.inspect target']) {
        const out = isCommandAllowed('admin', variant);
        assert.equal(out.allowed, false, `${JSON.stringify(variant)} should be refused for admin`);
        assert.match(out.reason, /owner-only/);
    }
});

test('owner may run engine-introspection commands, admin may not', () => {
    for (const cmd of OWNER_ONLY_COMMANDS) {
        assert.equal(isCommandAllowed('owner', cmd).allowed, true, `${cmd} should be allowed for owner`);
        assert.equal(isCommandAllowed('admin', cmd).allowed, false, `${cmd} should be denied for admin`);
    }
});

test('players and viewers get no console at all', () => {
    for (const role of ['viewer', 'player']) {
        const out = isCommandAllowed(role, 'wp.status');
        assert.equal(out.allowed, false);
        assert.match(out.reason, /requires the admin role/);
    }
});

test('admin may run ordinary commands', () => {
    for (const cmd of ['wp.status', 'wp.players', 'wp.kick someone', 'wp.ban someone']) {
        assert.equal(isCommandAllowed('admin', cmd).allowed, true, `${cmd} should be allowed`);
    }
});

test('refuses anything outside the wp.* namespace', () => {
    for (const cmd of ['quit', 'exit', 'shutdown', '/kick', 'rm -rf /']) {
        const out = isCommandAllowed('owner', cmd);
        assert.equal(out.allowed, false, `${cmd} should be refused`);
        assert.match(out.reason, /only wp\.\* commands/);
    }
});

test('unknown commands are refused for admin when a catalog is supplied', () => {
    const catalog = ['wp.status', 'wp.players'];
    assert.equal(isCommandAllowed('admin', 'wp.status', catalog).allowed, true);
    const out = isCommandAllowed('admin', 'wp.notreal', catalog);
    assert.equal(out.allowed, false);
    assert.match(out.reason, /unknown command/);
});

test('the owner is not held to the catalog, because it is only the autocomplete list', () => {
    // Verified against v1.3.17: commands.json advertises 32 commands and omits
    // exactly the introspection families the owner tier exists to grant.
    // Enforcing it against the owner would block wp.inspect and friends.
    const catalog = ['wp.status', 'wp.players'];
    assert.equal(isCommandAllowed('owner', 'wp.inspect', catalog).allowed, true);
    assert.equal(isCommandAllowed('owner', 'wp.modreload', catalog).allowed, true);
    // The namespace rule still applies to the owner.
    assert.equal(isCommandAllowed('owner', 'shutdown', catalog).allowed, false);
});

test('catalogNames handles both shapes commands.json can take', () => {
    assert.deepEqual(catalogNames({ commands: ['WP.Status', 'wp.players'] }), ['wp.status', 'wp.players']);
    assert.deepEqual(catalogNames([{ name: 'WP.Uptime' }]), ['wp.uptime']);
    assert.deepEqual(catalogNames(null), []);
});

test('getRole returns the stored role', async () => {
    const db = fakeDb(() => [{ role: 'admin' }]);
    assert.equal(await getRole('123', { db }), 'admin');
});

test('unknown users default to viewer, not to an error', async () => {
    const db = fakeDb(() => []);
    assert.equal(await getRole('999', { db }), 'viewer');
});

test('bootstraps the configured owner when their row is missing', async () => {
    // A deleted row would otherwise lock the owner out with no way back in.
    const prev = process.env.WINDROSE_OWNER_DISCORD_ID;
    process.env.WINDROSE_OWNER_DISCORD_ID = '365905620060340224';
    try {
        const db = fakeDb(() => []);
        assert.equal(await getRole('365905620060340224', { db }), 'owner');
        assert.ok(db.calls.some((c) => c.sql.startsWith('INSERT INTO windrose_users')));
    } finally {
        if (prev === undefined) delete process.env.WINDROSE_OWNER_DISCORD_ID;
        else process.env.WINDROSE_OWNER_DISCORD_ID = prev;
    }
});

test('setRole rejects roles outside the hierarchy', async () => {
    const db = fakeDb();
    await assert.rejects(setRole('1', 'superuser', { db }), /unknown role/);
});

test('audit failures never propagate into the request path', async () => {
    const db = { query: async () => { throw new Error('db down'); } };
    // Losing an audit line is bad; failing the user's action because of it is worse.
    await assert.doesNotReject(audit('1', 'lifecycle.restart', { a: 1 }, 'ok', { db }));
});

test('requireRole denies below the minimum and records the attempt', async () => {
    const db = fakeDb((sql) => (sql.includes('SELECT role') ? [{ role: 'player' }] : []));
    const gate = requireRole('admin', { db });

    let status = null; let json = null;
    const req = { user: { id: '123' }, path: '/windrose/api/rcon', originalUrl: '/windrose/api/rcon' };
    const res = { status: (s) => { status = s; return res; }, json: (b) => { json = b; return res; } };

    let nexted = false;
    await gate(req, res, () => { nexted = true; });

    assert.equal(nexted, false);
    assert.equal(status, 403);
    assert.match(json.error, /requires the admin role/);
    assert.ok(db.calls.some((c) => c.sql.startsWith('INSERT INTO windrose_audit')), 'denial should be audited');
});

test('requireRole passes through at or above the minimum', async () => {
    const db = fakeDb((sql) => (sql.includes('SELECT role') ? [{ role: 'owner' }] : []));
    const gate = requireRole('admin', { db });

    const req = { user: { id: '123' }, path: '/windrose/api/rcon', originalUrl: '/x' };
    let nexted = false;
    await gate(req, { status: () => ({ json: () => {} }) }, () => { nexted = true; });

    assert.equal(nexted, true);
    assert.equal(req.windroseRole, 'owner');
});

test('unauthenticated API calls get 401 JSON, not a redirect', async () => {
    const gate = requireRole('viewer', { db: fakeDb() });
    let status = null;
    const res = { status: (s) => { status = s; return res; }, json: () => res, redirect: () => { status = 302; } };
    await gate({ path: '/windrose/api/status', originalUrl: '/windrose/api/status' }, res, () => {});
    assert.equal(status, 401);
});
