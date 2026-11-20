import './fixtures/test-log-dir.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import pool from '../utils/db.js';
import { createServiceKeysRouter, ALLOWED_KEYS } from '../dashboard/routes/service-keys.js';

/*
 * The Service keys route: super-admin guard and the no-value-leak contract, against a THROWAWAY
 * temp .env and a fake db (the real .env and audit table are never touched). '685127470625980501'
 * is a hard-coded super-admin in utils/constants.js, so it is the admin here regardless of env.
 */

const ADMIN = '685127470625980501';
const NON_ADMIN = '111111111111111111';
const GIPHY_SECRET = 'storedGiphySecretDoNotLeak0123456789';

let server;
let base;
let dir;
let envPath;

// Fake db: audit writes/read are no-ops so nothing hits a real database.
const fakeDb = { execute: async () => [{ insertId: 1 }], query: async () => [[]] };

// Auth stub: the X-Test-Auth header picks who is calling.
function authStub(req, res, next) {
    const who = req.headers['x-test-auth'];
    if (who === 'admin') { req.user = { id: ADMIN, username: 'owner' }; req.isAuthenticated = () => true; }
    else if (who === 'user') { req.user = { id: NON_ADMIN, username: 'rando' }; req.isAuthenticated = () => true; }
    else { req.user = undefined; req.isAuthenticated = () => false; }
    next();
}

async function call(method, url, { auth, body } = {}) {
    const res = await fetch(base + url, {
        method,
        headers: { ...(auth ? { 'x-test-auth': auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, text, json };
}

before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-route-'));
    envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, `DB_HOST=127.0.0.1\nGIPHY_API_KEY=${GIPHY_SECRET}\n`);
    const app = express();
    app.use(express.json());
    app.use(authStub);
    app.use('/', createServiceKeysRouter({ envPath, backupDir: path.join(dir, 'backups', 'env'), db: fakeDb }));
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(r => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    // service-keys.js constructs the real db pool at import (its default router). Close it so the
    // test process exits on its own instead of being held open by idle pool handles.
    try { await pool.end(); } catch { /* already closed / never connected */ }
});

test('GET state requires authentication (401)', async () => {
    const r = await call('GET', '/api/super-admin/service-keys');
    assert.equal(r.status, 401);
});

test('GET state rejects a non-super-admin (403)', async () => {
    const r = await call('GET', '/api/super-admin/service-keys', { auth: 'user' });
    assert.equal(r.status, 403);
});

test('GET state returns booleans only and never the stored value', async () => {
    const r = await call('GET', '/api/super-admin/service-keys', { auth: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.keys.length, ALLOWED_KEYS.length);
    const giphy = r.json.keys.find(k => k.key === 'GIPHY_API_KEY');
    assert.equal(giphy.set, true);                          // reported as SET
    assert.ok(!('value' in giphy));                         // no value field
    assert.equal(typeof giphy.set, 'boolean');
    assert.ok(!r.text.includes(GIPHY_SECRET), 'the stored secret must never appear in the response');
    const steam = r.json.keys.find(k => k.key === 'STEAM_API_KEY');
    assert.equal(steam.set, false);
});

test('POST set is blocked for a non-super-admin (403)', async () => {
    const r = await call('POST', '/api/super-admin/service-keys/GIPHY_API_KEY', { auth: 'user', body: { value: 'x'.repeat(30) } });
    assert.equal(r.status, 403);
});

test('POST set rejects a key not on the allow-list (400)', async () => {
    const r = await call('POST', '/api/super-admin/service-keys/DB_PASSWORD', { auth: 'admin', body: { value: 'whatever' } });
    assert.equal(r.status, 400);
});

test('POST set rejects an invalid value without echoing it', async () => {
    const bad = 'nope has spaces';
    const r = await call('POST', '/api/super-admin/service-keys/GIPHY_API_KEY', { auth: 'admin', body: { value: bad } });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes(bad), 'the rejected value must not be echoed back');
});

test('POST set writes the key, responds { ok:true, set:true } with no value, and backs up', async () => {
    const newVal = 'freshGiphyKeyABCDEFGHIJKLMNOP123456';
    const r = await call('POST', '/api/super-admin/service-keys/GIPHY_API_KEY', { auth: 'admin', body: { value: newVal } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, set: true });
    assert.ok(!r.text.includes(newVal), 'the saved value must not appear in the response');
    // The temp .env now holds the new value; the other line survives.
    const env = fs.readFileSync(envPath, 'utf8');
    assert.match(env, new RegExp(`^GIPHY_API_KEY=${newVal}$`, 'm'));
    assert.ok(env.includes('DB_HOST=127.0.0.1'));
    // A backup was made.
    assert.ok(fs.readdirSync(path.join(dir, 'backups', 'env')).some(n => n.startsWith('.env.')));
});

test('POST clear removes the key and responds { ok:true, set:false }', async () => {
    const r = await call('POST', '/api/super-admin/service-keys/GIPHY_API_KEY/clear', { auth: 'admin' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, set: false });
    assert.ok(!/^GIPHY_API_KEY=/m.test(fs.readFileSync(envPath, 'utf8')));
});
