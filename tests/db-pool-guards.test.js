// H-314: the DB pool wrappers (utils/db-guards.cjs, used by utils/db.js and utils/db.cjs).
// A real mysql2 pool with fake connections, so the pool logic runs without a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const { installPoolGuards } = require('../utils/db-guards.cjs');

function makePool({ limit = 2, queueLimit = 3, guarded = true } = {}) {
    // maxIdle === connectionLimit: no idle-sweeper timer, nothing keeps the test alive.
    const pool = mysql.createPool({
        host: '127.0.0.1', port: 9, user: 'x', database: 'x',
        connectionLimit: limit, maxIdle: limit, queueLimit, waitForConnections: true,
    });
    const core = pool.pool;
    const conns = [];
    for (let i = 0; i < limit; i++) {
        const c = new EventEmitter();
        c.id = i;
        c._pool = core;
        c.lastActiveTime = Date.now();
        // Like PoolConnection.release minus its own _released flag, so the pool-level guard is what's tested.
        c.release = () => core.releaseConnection(c);
        c.execute = (sql, values, cb) => {
            const cmd = new EventEmitter();
            setImmediate(() => { cb(null, [{ sql, conn: c.id }], []); cmd.emit('end'); });
            return cmd;
        };
        c.query = (cmd) => {
            const ee = new EventEmitter();
            setImmediate(() => { cmd.onResult(null, [{ sql: cmd.sql, conn: c.id }], []); ee.emit('end'); });
            return ee;
        };
        core._allConnections.push(c);
        core._freeConnections.push(c);
        conns.push(c);
    }
    const stats = guarded ? installPoolGuards(pool, { warn: () => {}, label: 'test' }) : null;
    return { pool, core, conns, stats };
}

const settlesWithin = (p, ms) => Promise.race([
    p.then(() => true, () => true),
    new Promise(r => setTimeout(() => r(false), ms)),
]);

test('H-314 as it was: a promise pool whose .pool is itself never settles a parameterised query', async () => {
    const { pool } = makePool({ guarded: false });
    pool.pool = pool; // what `module.exports = pool; module.exports.pool = pool;` did in utils/db.cjs
    const p = pool.execute('SELECT ?', [1]);
    p.catch(() => {});
    assert.equal(await settlesWithin(p, 300), false);
});

test('the guard refuses a pool whose .pool is not the core pool', () => {
    const { pool } = makePool({ guarded: false });
    pool.pool = pool;
    assert.throws(() => installPoolGuards(pool, { warn: () => {} }), /not the mysql2 core pool/);
});

test('once guarded, .pool can no longer be overwritten', () => {
    const { pool, core } = makePool();
    assert.throws(() => { pool.pool = pool; }, TypeError); // ESM is strict, as is utils/db.cjs
    assert.equal(pool.pool, core);
});

test('queue pressure: callers beyond connections + queue fail cleanly, the rest complete', async () => {
    const { pool, core } = makePool({ limit: 2, queueLimit: 3 });
    const results = await Promise.allSettled(
        Array.from({ length: 7 }, (_, i) => pool.execute('SELECT ?', [i])));
    const failed = results.filter(r => r.status === 'rejected');
    assert.equal(results.length - failed.length, 5);
    assert.equal(failed.length, 2);
    for (const f of failed) {
        assert.equal(f.reason.message, 'Queue limit reached.');
        assert.ok(!(f.reason instanceof RangeError));
    }
    assert.equal(core._connectionQueue.length, 0);
    assert.equal(core._freeConnections.length, 2);
});

test('a double release never leaves a duplicate in the free list', () => {
    const { core, conns, stats } = makePool();
    core._freeConnections.clear();
    conns[0].release();
    conns[0].release();
    conns[0].release();
    assert.deepEqual(core._freeConnections.toArray(), [conns[0]]);
    assert.equal(stats.doubleReleases, 2);
});

test('5,000 queries through a full queue neither recurse nor leak a connection', async () => {
    const { pool, core } = makePool({ limit: 2, queueLimit: 50 });
    let ok = 0;
    for (let round = 0; round < 100; round++) {
        const settled = await Promise.allSettled(
            Array.from({ length: 50 }, (_, i) => (i % 2 ? pool.query('SELECT ?', [i]) : pool.execute('SELECT ?', [i]))));
        for (const s of settled) {
            if (s.status === 'rejected') assert.ok(!(s.reason instanceof RangeError), s.reason?.message);
            else ok++;
        }
    }
    assert.ok(ok > 4000, `only ${ok} completed`);
    const held = [await pool.getConnection(), await pool.getConnection()];
    for (const c of held) c.release();
    assert.equal(core._freeConnections.length, 2);
    assert.equal(new Set(core._freeConnections.toArray()).size, 2);
    assert.equal(core._connectionQueue.length, 0);
});

test('installing the guards twice keeps one layer', () => {
    const { pool, stats } = makePool();
    assert.equal(installPoolGuards(pool, { warn: () => {} }), stats);
});

test('utils/db.cjs exports its promise pool without overwriting the pool’s own fields', async () => {
    const pool = require('../utils/db.cjs');
    try {
        assert.notEqual(pool.pool, pool);
        assert.equal(pool.pool.constructor.name, 'Pool');
        assert.equal(pool.default, pool); // what core/dj-manager.cjs uses
        assert.equal(pool.getConnection, Object.getPrototypeOf(pool).getConnection);
        assert.equal(pool.query, Object.getPrototypeOf(pool).query);
        // Resolves against the server's database or rejects without one; either way it settles.
        const p = pool.execute('SELECT ? AS a', [1]);
        p.catch(() => {});
        assert.equal(await settlesWithin(p, 10_000), true);
    } finally {
        await pool.end().catch(() => {});
    }
});
