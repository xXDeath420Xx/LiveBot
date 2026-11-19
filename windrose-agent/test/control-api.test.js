import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlApi } from '../src/control-api.js';
import { createCache } from '../src/cache.js';
import { createQueue } from '../src/queue.js';
import { FileError } from '../src/files.js';

const SECRET = 'a'.repeat(64);

function stubs(overrides = {}) {
    const calls = [];
    const base = {
        docker: {
            state: async () => ({ exists: true, running: true, status: 'running' }),
            stats: async () => ({ running: true, cpuPercent: 5, memUsedBytes: 1, memLimitBytes: 2, memPercent: 50 }),
            logs: async () => 'log output',
            start: async () => { calls.push('start'); return { changed: true }; },
            stop: async () => { calls.push('stop'); return { changed: true }; },
            restart: async () => { calls.push('restart'); return { changed: true }; },
        },
        spool: {
            heartbeat: async () => ({ alive: true, state: 'running' }),
            serverStatus: async () => ({ server: { name: 'CertiFried', player_count: 0 }, players: [], multipliers: {} }),
            livemap: async () => ({ players: [] }),
            commands: async () => ({ commands: [] }),
            consoleHistory: async () => ({ entries: [] }),
        },
        client: { rcon: async (c) => { calls.push(`rcon:${c}`); return { status: 'ok', message: 'done' }; } },
        backups: { list: async () => [], snapshot: async () => ({ filename: 'x.zip' }), prune: async () => ({}), restore: async () => ({}) },
        // /status reads the active world's identity so the panel can show the
        // world name rather than the server name.
        saves: {
            activeWorld: async () => ({ id: 'W1', name: 'The Pacific', presetType: 'Medium', version: '0.10.0' }),
            connectionInfo: async () => ({ inviteCode: 'certifried', useDirectConnection: true, port: 7777, passwordProtected: true }),
        },
        configWriter: { readAll: async () => ({ multipliers: {} }), setMultipliers: async () => ({}), setWorldSettings: async () => ({}), setRcon: async () => ({}) },
        files: {
            list: async () => ({ path: '.', entries: [] }),
            read: async (p) => { if (p === 'bad') throw new FileError('path escapes server-files'); return { content: '' }; },
            write: async () => ({}), remove: async () => ({}), mkdirp: async () => ({}),
        },
        mods: { list: async () => [], install: async () => ({}), remove: async () => ({}) },
        scheduler: { status: () => ({ scheduled: false }), scheduleDaily: () => ({}), cancel: () => {}, restartNow: async () => { calls.push('gracefulRestart'); return {}; } },
        queue: createQueue({ minIntervalMs: 0 }),
        cache: createCache(),
        secret: SECRET,
        logger: { error: () => {} },
    };
    return { deps: { ...base, ...overrides }, calls };
}

async function withServer(deps, fn) {
    const api = createControlApi(deps);
    const { port } = await api.listen(0);
    try {
        return await fn(port);
    } finally {
        await api.close();
    }
}

const call = (port, path, { method = 'GET', secret = SECRET, body } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(secret ? { 'x-agent-secret': secret } : {}), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

test('rejects requests with no secret', async () => {
    const { deps } = stubs();
    await withServer(deps, async (port) => {
        const res = await call(port, '/status', { secret: null });
        assert.equal(res.status, 401);
    });
});

test('rejects requests with a wrong secret', async () => {
    const { deps } = stubs();
    await withServer(deps, async (port) => {
        assert.equal((await call(port, '/status', { secret: 'b'.repeat(64) })).status, 401);
        // Wrong length must also fail, not throw inside timingSafeEqual.
        assert.equal((await call(port, '/status', { secret: 'short' })).status, 401);
    });
});

test('unauthenticated callers cannot probe which routes exist', async () => {
    // Auth runs before routing, so a bogus path returns 401 rather than 404.
    const { deps } = stubs();
    await withServer(deps, async (port) => {
        assert.equal((await call(port, '/definitely-not-a-route', { secret: null })).status, 401);
    });
});

test('serves status from the spool without spending RCON', async () => {
    const { deps, calls } = stubs();
    await withServer(deps, async (port) => {
        const res = await call(port, '/status');
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.healthy, true);
        assert.equal(body.server.name, 'CertiFried');
        assert.equal(body.world.name, 'The Pacific', 'world identity travels with the save');
        assert.equal(body.connection.inviteCode, 'certifried');
        // The join password must never leave the agent — the panel shows the
        // invite code publicly, so a leak here would be a public leak.
        assert.equal(body.connection.password, undefined);
        assert.equal(JSON.stringify(body).includes('pirates'), false, 'no join password anywhere in the payload');
        assert.equal(calls.filter((c) => c.startsWith('rcon:')).length, 0, 'status must not use RCON');
    });
});

test('routes RCON through the queue', async () => {
    const { deps, calls } = stubs();
    await withServer(deps, async (port) => {
        const res = await call(port, '/rcon', { method: 'POST', body: { command: 'wp.status' } });
        assert.equal(res.status, 200);
        assert.deepEqual(calls, ['rcon:wp.status']);
    });
});

test('rejects an RCON call with no command', async () => {
    const { deps } = stubs();
    await withServer(deps, async (port) => {
        const res = await call(port, '/rcon', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
    });
});

test('restart is graceful by default and blunt only when asked', async () => {
    const { deps, calls } = stubs();
    await withServer(deps, async (port) => {
        await call(port, '/lifecycle/restart', { method: 'POST', body: {} });
        assert.ok(calls.includes('gracefulRestart'), 'default must warn players first');

        await call(port, '/lifecycle/restart', { method: 'POST', body: { immediate: true } });
        assert.ok(calls.includes('restart'));
    });
});

test('surfaces jail errors as 400 with the message intact', async () => {
    const { deps } = stubs();
    await withServer(deps, async (port) => {
        const res = await call(port, '/file?path=bad');
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /escapes server-files/);
    });
});

test('unknown routes return 404 when authenticated', async () => {
    const { deps } = stubs();
    await withServer(deps, async (port) => {
        assert.equal((await call(port, '/nope')).status, 404);
    });
});

test('internal errors do not leak stack traces', async () => {
    const { deps } = stubs({
        docker: { state: async () => { throw new Error('socket exploded at /var/run/docker.sock'); } },
        // Promise.all rejects fast; the sibling call must not become an
        // unhandled rejection when its partner throws first.
        saves: { activeWorld: async () => { throw new Error('also broken'); }, connectionInfo: async () => { throw new Error('also broken'); } },
    });
    await withServer(deps, async (port) => {
        const res = await call(port, '/status');
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal('stack' in body, false);
    });
});
