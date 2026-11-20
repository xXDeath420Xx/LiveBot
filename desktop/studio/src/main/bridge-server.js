'use strict';
/*
 * The local bridge for the Stream Deck plugin: a WebSocket server on 127.0.0.1 only, off by default.
 *
 *   const bridge = createBridgeServer({ logger, port = 39720, getToken, handlers, version, now?, helloMs? })
 *     start()            → Promise<{ port }>   listens on 127.0.0.1:<port> (port 0 picks a free one; tests);
 *                          rejects with code port_in_use when the port is taken
 *     stop()             → Promise              closes every client (1001) and the listener
 *     status()           { running, port, clients (signed in), pending, lockedUntil, clientList: [{ app, version, since }] }
 *     broadcast(msg)     sends msg (an object, e.g. { type: 'state', ... } or { type: 'obs', event, data }) to every
 *                        signed-in client; returns how many got it
 *     dropClients()      closes every client with 4403 (the token was regenerated); they must sign in again
 *
 * Who may connect (checked before the upgrade; refusals answer 403 and are logged by reason only, no header values):
 *   - no Origin header (browsers always send one; the plugin is Node and sends none)
 *   - Host is exactly 127.0.0.1:<port> or localhost:<port> (DNS rebinding)
 *   - at most 8 connections at a time (503 beyond that)
 *
 * Protocol (JSON text frames, at most 16 KB each):
 *   client  { type: 'hello', token, client: { app, version } }          first frame, within 5 s
 *   server  { type: 'welcome', proto: 1, studio: { version }, features: ['request', 'state', 'obs'], methods: [...] }
 *   client  { type: 'request', id, method, params }                     20 a second per client
 *   server  { type: 'response', id, ok: true, result } | { type: 'response', id, ok: false, error, message }
 *   server  { type: 'state', ... } / { type: 'obs', event, data }       pushes through broadcast()
 *   server  { type: 'error', code, message }                            for a bad frame, then (for auth) the close below
 * The token (sdk_…, from the secrets store through getToken) is compared as SHA-256 digests with timingSafeEqual.
 * After 10 failed hellos within a minute (from anyone), every hello is refused for 60 s.
 *
 * Close codes: 1001 Studio stopping the bridge; 4400 bad first frame; 4401 auth_failed; 4403 token regenerated;
 *   4408 no hello within 5 s; 4429 locked_out (too many failed hellos).
 * Request errors: bad_request, unknown_method, rate_limited, and whatever code a handler throws (`failed` without one).
 */
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const MAX_PAYLOAD = 16 * 1024;
const MAX_CLIENTS = 8;
const HELLO_MS = 5000;
const RATE_PER_SEC = 20;
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const LOCK_MS = 60_000;
const PING_MS = 30_000;
const CLOSE = { going: 1001, badHello: 4400, auth: 4401, revoked: 4403, helloTimeout: 4408, locked: 4429 };

const digest = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
const clip = (s, n) => String(s ?? '').replace(/[\x00-\x1f]/g, '').slice(0, n);

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

function createBridgeServer({ logger = null, port = 39720, getToken = () => null, handlers = {}, version = '0.0.0', now = Date.now, helloMs = HELLO_MS } = {}) {
    let wss = null;
    let boundPort = null;
    let pingTimer = null;
    const clients = new Set();            // { ws, authed, app, version, since, helloTimer, rate: { second, count }, alive }
    const failures = [];                  // timestamps of failed hellos
    let lockedUntil = 0;
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[bridge] ${m}`, meta); } catch { /* ignore */ } };
    const methods = () => Object.keys(handlers).filter((k) => typeof handlers[k] === 'function').sort();

    const send = (c, msg) => { try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); } catch { /* closed meanwhile */ } };
    const close = (c, code, reason) => { try { c.ws.close(code, reason); } catch { /* ignore */ } };

    function verifyClient(info, cb) {
        const h = info.req.headers;
        let reason = null;
        if (h.origin !== undefined || h['sec-websocket-origin'] !== undefined) reason = 'origin_present';
        else {
            const host = String(h.host || '').toLowerCase();
            if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) reason = 'bad_host';
            else if (clients.size >= MAX_CLIENTS) reason = 'too_many_clients';
        }
        if (!reason) return cb(true);
        log('warn', 'refused a connection', { reason });
        return cb(false, reason === 'too_many_clients' ? 503 : 403);
    }

    function tokenMatches(given) {
        const expected = getToken();
        if (typeof expected !== 'string' || !expected || typeof given !== 'string' || !given || given.length > 200) return false;
        return crypto.timingSafeEqual(digest(given), digest(expected));
    }

    function locked() {
        const t = now();
        if (t < lockedUntil) return true;
        while (failures.length && failures[0] <= t - FAIL_WINDOW_MS) failures.shift();
        return false;
    }

    function hello(c, msg) {
        clearTimeout(c.helloTimer);
        if (locked()) {
            send(c, { type: 'error', code: 'locked_out', message: 'Too many failed sign-ins. Try again in a minute.' });
            return close(c, CLOSE.locked, 'locked_out');
        }
        if (!tokenMatches(msg.token)) {
            const t = now();
            failures.push(t);
            if (failures.length >= FAIL_LIMIT) {
                lockedUntil = t + LOCK_MS;
                failures.length = 0;
                log('warn', 'too many failed sign-ins: refusing all for 60 s');
            }
            log('info', 'sign-in refused', { reason: 'auth_failed' });
            send(c, { type: 'error', code: 'auth_failed', message: 'The pairing token is not right. Copy it again from Studio.' });
            return close(c, CLOSE.auth, 'auth_failed');
        }
        c.authed = true;
        c.app = clip(msg.client?.app, 40) || 'unknown';
        c.version = clip(msg.client?.version, 20);
        c.since = now();
        log('info', 'client signed in', { app: c.app, version: c.version });
        send(c, { type: 'welcome', proto: 1, studio: { version: String(version) }, features: ['request', 'state', 'obs'], methods: methods() });
    }

    async function request(c, msg) {
        const id = msg.id;
        if (!((typeof id === 'string' && id.length > 0 && id.length <= 64) || Number.isSafeInteger(id))) {
            return send(c, { type: 'error', code: 'bad_request', message: 'id is required' });
        }
        const t = Math.floor(now() / 1000);
        if (c.rate.second !== t) { c.rate.second = t; c.rate.count = 0; }
        if (++c.rate.count > RATE_PER_SEC) return send(c, { type: 'response', id, ok: false, error: 'rate_limited', message: 'Too many requests.' });
        const method = typeof msg.method === 'string' ? msg.method : '';
        if (!Object.prototype.hasOwnProperty.call(handlers, method) || typeof handlers[method] !== 'function') {
            return send(c, { type: 'response', id, ok: false, error: 'unknown_method', message: `Unknown method ${clip(method, 60)}` });
        }
        const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
        try {
            const result = await handlers[method](params, { app: c.app });
            send(c, { type: 'response', id, ok: true, result: result === undefined ? {} : result });
        } catch (e) {
            const code = clip(e?.code || 'failed', 60);
            const message = e?.message && e.message !== code ? clip(e.message, 200) : '';
            log('info', `${method} failed`, { error: code });
            send(c, { type: 'response', id, ok: false, error: code, message });
        }
    }

    function onConnection(ws) {
        const c = { ws, authed: false, app: null, version: null, since: null, rate: { second: 0, count: 0 }, alive: true, helloTimer: null };
        clients.add(c);
        c.helloTimer = setTimeout(() => {
            if (!c.authed) { send(c, { type: 'error', code: 'hello_timeout', message: 'No hello received.' }); close(c, CLOSE.helloTimeout, 'hello_timeout'); }
        }, helloMs);
        c.helloTimer.unref?.();
        ws.on('pong', () => { c.alive = true; });
        ws.on('message', (data, isBinary) => {
            let msg = null;
            if (!isBinary) { try { msg = JSON.parse(String(data)); } catch { msg = null; } }
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
                send(c, { type: 'error', code: 'bad_frame', message: 'Frames are JSON objects.' });
                if (!c.authed) close(c, CLOSE.badHello, 'bad_frame');
                return;
            }
            if (!c.authed) {
                if (msg.type === 'hello') return hello(c, msg);
                send(c, { type: 'error', code: 'hello_required', message: 'Send hello first.' });
                return close(c, CLOSE.badHello, 'hello_required');
            }
            if (msg.type === 'request') { request(c, msg); return; }
            if (msg.type === 'hello') return send(c, { type: 'error', code: 'already_signed_in' });
            return send(c, { type: 'error', code: 'unknown_type', message: 'Unknown frame type.' });
        });
        ws.on('close', () => { clearTimeout(c.helloTimer); clients.delete(c); });
        ws.on('error', () => { /* the close event follows */ });
    }

    function start() {
        if (wss) return Promise.resolve({ port: boundPort });
        return new Promise((resolve, reject) => {
            const server = new WebSocketServer({ host: HOST, port, maxPayload: MAX_PAYLOAD, verifyClient, perMessageDeflate: false, clientTracking: false });
            const onError = (e) => {
                server.close();
                wss = null;
                const err = fail(e?.code === 'EADDRINUSE' ? 'port_in_use' : 'bridge_failed', e?.code === 'EADDRINUSE' ? `port ${port} is in use` : e?.message);
                log('warn', 'could not start', { code: err.code });
                reject(err);
            };
            server.once('error', onError);
            server.once('listening', () => {
                server.off('error', onError);
                server.on('error', (e) => log('warn', 'server error', { message: e?.message }));
                wss = server;
                boundPort = server.address().port;
                server.on('connection', onConnection);
                pingTimer = setInterval(() => {
                    for (const c of clients) {
                        if (!c.alive) { try { c.ws.terminate(); } catch { /* ignore */ } continue; }
                        c.alive = false;
                        try { c.ws.ping(); } catch { /* ignore */ }
                    }
                }, PING_MS);
                pingTimer.unref?.();
                log('info', `listening on ${HOST}:${boundPort}`);
                resolve({ port: boundPort });
            });
        });
    }

    function stop() {
        clearInterval(pingTimer); pingTimer = null;
        for (const c of clients) { clearTimeout(c.helloTimer); close(c, CLOSE.going, 'studio_stopped'); }
        const s = wss;
        wss = null;
        if (!s) return Promise.resolve();
        return new Promise((resolve) => {
            // Give the close frames a moment to go out, then cut whatever is left so the listener can close.
            const end = Date.now() + 1000;
            const finish = () => {
                if (clients.size && Date.now() < end) { setTimeout(finish, 20); return; }
                for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } }
                clients.clear();
                s.close(() => resolve());
            };
            finish();
        });
    }

    function broadcast(msg) {
        if (!msg || typeof msg !== 'object') return 0;
        let text;
        try { text = JSON.stringify(msg); } catch { return 0; }
        let n = 0;
        for (const c of clients) {
            if (!c.authed || c.ws.readyState !== 1) continue;
            try { c.ws.send(text); n++; } catch { /* ignore */ }
        }
        return n;
    }

    function dropClients() {
        let n = 0;
        for (const c of clients) { close(c, CLOSE.revoked, 'token_changed'); n++; }
        if (n) log('info', 'dropped every client (token regenerated)');
        return n;
    }

    function status() {
        const authed = [...clients].filter((c) => c.authed);
        return {
            running: !!wss,
            port: wss ? boundPort : null,
            clients: authed.length,
            pending: clients.size - authed.length,
            lockedUntil: lockedUntil > now() ? lockedUntil : null,
            clientList: authed.map((c) => ({ app: c.app, version: c.version, since: c.since })),
        };
    }

    return { start, stop, status, broadcast, dropClients };
}

/** A new pairing token: sdk_ + 24 random bytes, base64url. */
function generateBridgeToken() {
    return `sdk_${crypto.randomBytes(24).toString('base64url')}`;
}

module.exports = { createBridgeServer, generateBridgeToken, BRIDGE_CLOSE: CLOSE };
