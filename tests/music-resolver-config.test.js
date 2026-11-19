import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolverGroups, resolverBases, resolverSecret } from '../utils/music-resolver-config.js';

/*
 * The resolver list decides where every YouTube play goes and in what order, and the secrets decide
 * whether those calls authenticate at all. A parsing slip here silently routes everything to the OVH
 * fallback, so the format and the hot-reload of rotated secrets are pinned down.
 */

function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}
const CLEAR = { MUSIC_RESOLVERS: undefined, MUSIC_RESOLVER_URL: undefined, MUSIC_RESOLVER_SECRET_FILE: undefined,
    MUSIC_RESOLVER_SECRET: undefined, MUSIC_RESOLVER_SECRET_FILE_SERVER2: undefined, MUSIC_RESOLVER_SECRET_FILE_WORKSTATION: undefined };

test('resolverGroups: named groups keep priority order and their tunnel order', () => {
    withEnv({ ...CLEAR, MUSIC_RESOLVERS: 'server2=http://a:1|http://a:2;workstation=http://b:3' }, () => {
        assert.deepEqual(resolverGroups(), [
            { name: 'server2', bases: ['http://a:1', 'http://a:2'] },
            { name: 'workstation', bases: ['http://b:3'] },
        ]);
        assert.deepEqual(resolverBases(), ['http://a:1', 'http://a:2', 'http://b:3']);
    });
});

test('resolverGroups: malformed or empty parts are dropped, whitespace tolerated', () => {
    withEnv({ ...CLEAR, MUSIC_RESOLVERS: ' server2 = http://a:1 | ; =http://x:9; empty=; workstation=http://b:3 ' }, () => {
        assert.deepEqual(resolverGroups(), [
            { name: 'server2', bases: ['http://a:1'] },
            { name: 'workstation', bases: ['http://b:3'] },
        ]);
    });
});

test('resolverGroups: legacy MUSIC_RESOLVER_URL becomes a single "server2" group', () => {
    withEnv({ ...CLEAR, MUSIC_RESOLVER_URL: 'http://a:1, http://a:2' }, () => {
        assert.deepEqual(resolverGroups(), [{ name: 'server2', bases: ['http://a:1', 'http://a:2'] }]);
    });
    withEnv({ ...CLEAR }, () => assert.deepEqual(resolverGroups(), []));
});

test('resolverSecret: per-resolver files, re-read after rotation, env fallback only for server2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrc-'));
    const s2 = path.join(dir, 's2'), ws = path.join(dir, 'ws');
    fs.writeFileSync(s2, 'secret-two\n');
    fs.writeFileSync(ws, 'secret-ws');
    try {
        withEnv({ ...CLEAR, MUSIC_RESOLVER_SECRET_FILE_SERVER2: s2, MUSIC_RESOLVER_SECRET_FILE_WORKSTATION: ws }, () => {
            assert.equal(resolverSecret('server2'), 'secret-two');
            assert.equal(resolverSecret('workstation'), 'secret-ws');
            // Rotation replaces the file (new mtime) — the next call must see the new value without a restart.
            fs.writeFileSync(ws, 'rotated-ws');
            const later = new Date(Date.now() + 5000);
            fs.utimesSync(ws, later, later);
            assert.equal(resolverSecret('workstation'), 'rotated-ws');
            assert.equal(resolverSecret('nobody'), '');
        });
        withEnv({ ...CLEAR, MUSIC_RESOLVER_SECRET: 'legacy-env' }, () => {
            assert.equal(resolverSecret('server2'), 'legacy-env');
            assert.equal(resolverSecret('workstation'), '', 'the legacy env secret must not leak to other resolvers');
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
