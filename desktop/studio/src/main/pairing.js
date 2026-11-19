'use strict';
/*
 * Pairing with the CertiFried dashboard (design §2.4).
 *
 *   normaliseCode(input)        what the person typed or pasted → 'XXXX-XXXX', or null
 *   codeFromDeepLink(url)       certifried-studio://pair?code=XXXX-XXXX → the code, or null
 *   checkServer(base)           the server address the app talks to: https, or http only on 127.0.0.1 (testing
 *                               through an SSH tunnel). Returns the normalised origin or throws 'bad_server'.
 *   wsUrlFor(base)              the realtime URL for that server (wss://host/stream/bot/ws)
 *   exchangeCode({ base, code, name, capabilities, fetchImpl, timeoutMs })
 *                               POST /stream/bot/api/pair → { token, deviceId, kind }
 *                               errors (err.code): invalid_code, rate_limited, server_error, network, bad_response
 */
const { PATHS } = require('./site');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_RE = /^sbd_[A-Za-z0-9_-]{43}$/;

function normaliseCode(input) {
    const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (s.length !== 8) return null;
    for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function codeFromDeepLink(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== 'certifried-studio:') return null;
    // certifried-studio://pair?code=… parses with host 'pair'; certifried-studio:pair?code=… with pathname 'pair'
    const what = (u.host || u.pathname || '').replace(/^\/+|\/+$/g, '').toLowerCase();
    if (what !== 'pair') return null;
    return normaliseCode(u.searchParams.get('code'));
}

function argvDeepLink(argv) {
    return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith('certifried-studio:')) || null;
}

function err(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
}

function checkServer(base) {
    let u;
    try { u = new URL(String(base || '').trim()); } catch { throw err('bad_server', 'Enter a full address like https://certifriedmultitool.com'); }
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && u.hostname === '127.0.0.1') return u.origin;
    throw err('bad_server', 'The server address must start with https:// (http:// only for 127.0.0.1)');
}

function wsUrlFor(base) {
    const origin = checkServer(base);
    return origin.replace(/^http/, 'ws') + PATHS.ws;
}

async function exchangeCode({ base, code, name, capabilities = [], fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    const origin = checkServer(base);
    const c = normaliseCode(code);
    if (!c) throw err('invalid_code', 'That code is not in the right format (XXXX-XXXX).');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
        res = await fetchImpl(`${origin}${PATHS.pair}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ code: c, name: String(name || 'CertiFried Studio').slice(0, 100), capabilities }),
            signal: ctrl.signal,
            redirect: 'error',
        });
    } catch (e) {
        throw err('network', 'Could not reach CertiFried. Check your internet connection.');
    } finally {
        clearTimeout(t);
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.status === 400) throw err('invalid_code', 'That code was not accepted. Codes last 10 minutes and work once; make a new one on the Devices page.');
    if (res.status === 429) throw err('rate_limited', 'Too many tries. Wait a minute and try again.');
    if (!res.ok) throw err('server_error', 'CertiFried could not pair right now. Try again shortly.');
    if (!body || !TOKEN_RE.test(String(body.token || '')) || !Number.isInteger(Number(body.deviceId))) throw err('bad_response', 'CertiFried sent an answer the app does not understand.');
    return { token: body.token, deviceId: Number(body.deviceId), kind: body.kind || 'studio' };
}

// ── "Sign in with CertiFried": approve in the browser instead of typing a code ─────────────────

async function postJson(fetchImpl, url, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body), signal: ctrl.signal, redirect: 'error',
        });
        let json = null;
        try { json = await res.json(); } catch { json = null; }
        return { status: res.status, json };
    } catch {
        throw err('network', 'Could not reach CertiFried. Check your internet connection.');
    } finally {
        clearTimeout(t);
    }
}

const LINK_ID = /^[A-Za-z0-9_-]{22}$/;
const LINK_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * Ask the server for a sign-in request. The browser page URL is built from the app's own server address, never taken
 * from the answer, and carries only the request id (the polling secret stays in the app).
 * → { request, secret, check, expiresAt, pollMs, url }
 */
async function startLink({ base, name, capabilities = [], fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    const origin = checkServer(base);
    const r = await postJson(fetchImpl, `${origin}${PATHS.linkRequest}`, { name: String(name || 'CertiFried Studio').slice(0, 100), capabilities }, timeoutMs);
    // A server without these routes answers 404, or 403 from its CSRF check (the route is not exempt there).
    if (r.status === 404 || r.status === 403 || r.status === 405) throw err('not_supported', 'This CertiFried server does not offer browser sign-in yet. Use a pairing code instead.');
    if (r.status === 429) throw err('rate_limited', 'Too many tries. Wait a minute and try again.');
    if (r.status === 503) throw err('busy', 'Sign-in is busy right now. Try again in a minute, or use a pairing code.');
    if (r.status !== 200) throw err('server_error', 'CertiFried could not start the sign-in. Try again shortly.');
    const j = r.json || {};
    if (!LINK_ID.test(String(j.request || '')) || !LINK_SECRET.test(String(j.secret || '')) || !/^[A-Z0-9]{4}$/.test(String(j.check || ''))) {
        throw err('bad_response', 'CertiFried sent an answer the app does not understand.');
    }
    return {
        request: j.request, secret: j.secret, check: j.check,
        expiresAt: Date.parse(j.expiresAt) || Date.now() + 10 * 60 * 1000,
        pollMs: Math.max(1500, Math.min(10000, Number(j.pollMs) || 2000)),
        url: `${origin}${PATHS.linkPage}?request=${encodeURIComponent(j.request)}`,
    };
}

/** One poll. → { status: 'pending' | 'cancelled' | 'expired' } or { status: 'approved', token, deviceId, kind } */
async function pollLink({ base, request, secret, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    const origin = checkServer(base);
    const r = await postJson(fetchImpl, `${origin}${PATHS.linkPoll}`, { request, secret }, timeoutMs);
    if (r.status === 404) return { status: 'expired' };
    if (r.status === 429) throw err('rate_limited', 'Checking too often.');
    if (r.status !== 200) throw err('server_error', 'CertiFried did not answer properly.');
    const j = r.json || {};
    if (j.status === 'pending' || j.status === 'cancelled') return { status: j.status };
    if (j.status === 'approved' && TOKEN_RE.test(String(j.token || '')) && Number.isInteger(Number(j.deviceId))) {
        return { status: 'approved', token: j.token, deviceId: Number(j.deviceId), kind: j.kind || 'studio' };
    }
    throw err('bad_response', 'CertiFried sent an answer the app does not understand.');
}

/**
 * Poll until approved, cancelled or expired. Network hiccups are retried with a growing gap. `isCancelled()` lets
 * the app stop waiting. Resolves to the final pollLink answer ({ status: 'stopped' } when cancelled locally).
 */
async function waitForLink({ base, request, secret, pollMs = 2000, expiresAt, fetchImpl = globalThis.fetch, isCancelled = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
    let gap = pollMs;
    for (;;) {
        if (isCancelled()) return { status: 'stopped' };
        if (now() > expiresAt + 5000) return { status: 'expired' };
        await sleep(gap);
        if (isCancelled()) return { status: 'stopped' };
        try {
            const r = await pollLink({ base, request, secret, fetchImpl });
            if (r.status !== 'pending') return r;
            gap = pollMs;
        } catch (e) {
            if (e.code === 'bad_response') throw e;
            gap = Math.min(15000, gap * 2);   // network or rate limit: back off, keep waiting until it expires
        }
    }
}

module.exports = { normaliseCode, codeFromDeepLink, argvDeepLink, checkServer, wsUrlFor, exchangeCode, startLink, pollLink, waitForLink, CODE_ALPHABET };
