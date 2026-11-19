// Greenhouse Tycoon (cfx v2) test helpers: an isolated schema on the live database.
//
// The DB user cannot create databases, so each test file creates the 24 v2 tables under its own random
// prefix (ghtest_<6 hex>_), never touching gh_* or the old cfx_* tables, and drops them in after().
// If a run is killed, leftovers can be listed with:
//   SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ghtest\_%';
import crypto from 'node:crypto';
import pool from '../../../utils/db.js';
import { createSchema, dropSchema, existingTables } from '../../../services/cfx/store/schema.js';
import { createStore } from '../../../services/cfx/store/index.js';

export const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

export async function setupTestDb(storeOptions = {}) {
    const prefix = `ghtest_${crypto.randomBytes(3).toString('hex')}_`;
    if (!/^ghtest_[0-9a-f]{6}_$/.test(prefix)) throw new Error('unexpected test prefix');
    await createSchema(pool, prefix);
    const store = createStore({ db: pool, prefix, allowDevPlatform: true, logger: quietLogger, ...storeOptions });
    return {
        pool,
        prefix,
        store,
        t: store.t,
        /** Drop this run's tables; returns the names still present (should be []). */
        async cleanup() {
            await dropSchema(pool, prefix);
            return existingTables(pool, prefix);
        }
    };
}

/** A bare account row (no identity, no starter kit), funded through the ledger. */
export async function makeAccount(store, { cash = 0, items = [], name = 'Test grower' } = {}) {
    const [r] = await store.db.query(`INSERT INTO ${store.t.accounts} (display_name) VALUES (?)`, [name]);
    const accountId = Number(r.insertId);
    if (cash || items.length) {
        await store.ledger.apply({ accountId, key: `fund:${accountId}:0001`, reason: 'test', cash, items });
    }
    return accountId;
}

export async function closePool() {
    await pool.end();
}

// ------------------------------------------------------------------ phase 2: HTTP helpers

/**
 * Start the real app on 127.0.0.1:<random port>. Returns { base, call, close, errorsLogged, app }.
 * call(method, path, { token, body, raw, headers, key }) -> { status, json, text, headers }.
 * key: true (default) sends a fresh Idempotency-Key on POST, a string sends that key, false sends none.
 */
export async function startApp(appOptions) {
    const http = await import('node:http');
    const { createApp } = await import('../../../services/cfx/http/app.js');
    const errorsLogged = [];
    const logger = { ...quietLogger, error: (msg, meta) => errorsLogged.push({ msg, meta }) };
    const app = createApp({ logger, ...appOptions });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const root = `http://127.0.0.1:${server.address().port}`;
    let seq = 0;
    async function call(method, path, { token, body, raw, headers = {}, key = true, prefix = '/api/v2' } = {}) {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (key && method !== 'GET' && method !== 'OPTIONS') h['idempotency-key'] = typeof key === 'string' ? key : `k-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
        let payload;
        if (raw !== undefined) {
            payload = raw;
            if (!h['content-type']) h['content-type'] = 'application/json';
        } else if (body !== undefined) {
            payload = JSON.stringify(body);
            h['content-type'] = 'application/json';
        }
        const res = await fetch(root + prefix + path, { method, headers: h, body: payload, redirect: 'manual' });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text, headers: res.headers };
    }
    return {
        app, server, root, base: `${root}/api/v2`, call, errorsLogged,
        close: () => new Promise(r => server.close(() => r()))
    };
}

/** Assert the one error shape { error: { code, message } } with a 4xx status (never a 500). */
export function errorShape(assert, res, expectedCode, label = '') {
    assert.ok(res.status >= 400 && res.status < 500, `${label} status ${res.status} (${String(res.text).slice(0, 200)})`);
    assert.ok(res.json && typeof res.json.error === 'object', `${label} has an error object`);
    assert.equal(typeof res.json.error.code, 'string', label);
    assert.equal(typeof res.json.error.message, 'string', label);
    assert.ok(!/\bat \S+:\d+:\d+/.test(res.text), `${label} no stack trace`);
    if (expectedCode) assert.equal(res.json.error.code, expectedCode, `${label}: ${res.json.error.code}`);
}
