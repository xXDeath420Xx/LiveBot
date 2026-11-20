'use strict';
/*
 * Small helpers shared by the light drivers (no device knowledge here).
 *
 *   codeError(code, message?)         an Error with .code (short snake_case), message kept short
 *   clamp(n, lo, hi) / toInt(v, def)  numbers from untrusted params
 *   parseAddress(text, defaultPort)   'a.b.c.d' or 'a.b.c.d:port' → { host, port } | null (IPv4 only, no host names)
 *   formatAddress(host, port, def)    'a.b.c.d' when port is the default, else 'a.b.c.d:port'
 *   isLanIPv4(ip)                     loopback, private (10/8, 172.16/12, 192.168/16) or link-local (169.254/16)
 *   guardHost(sandbox, host)          throws sandbox_refused when a sandbox is set and host is not 127.0.0.1
 *   safeId(text)                      [A-Za-z0-9._-]{1,80} (fits the dev:<driver>:<id> secret names)
 *   sleep(setTimer, ms)               a promise on the injected timer
 *   httpRequest(opts)                 one HTTP(S) request → { status, text, json }; network failures throw device_unreachable
 *
 * httpRequest never puts the request path into an error or log line (Nanoleaf and Hue v1 carry the token in the path).
 */
const crypto = require('node:crypto');

function codeError(code, message) {
    const e = new Error(message ? String(message).slice(0, 240) : code);
    e.code = code;
    return e;
}

function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
}

function toInt(v, def = null) {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : def;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ADDRESS = /^([0-9.]+)(?::(\d{1,5}))?$/;

function isIPv4(s) { return typeof s === 'string' && IPV4.test(s); }

function isLanIPv4(ip) {
    if (!isIPv4(ip)) return false;
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function parseAddress(text, defaultPort) {
    if (typeof text !== 'string') return null;
    const s = text.trim();
    if (!s || s.length > 32) return null;
    const m = s.match(ADDRESS);
    if (!m || !isIPv4(m[1])) return null;
    const port = m[2] ? Number(m[2]) : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: m[1], port };
}

function formatAddress(host, port, defaultPort) {
    return port && port !== defaultPort ? `${host}:${port}` : host;
}

function guardHost(sandbox, host) {
    if (sandbox && host !== '127.0.0.1') throw codeError('sandbox_refused', 'The device sandbox only allows 127.0.0.1');
}

function safeId(text) {
    const s = String(text ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return s || crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

function sleep(setTimer, ms) {
    return new Promise((resolve) => setTimer(resolve, ms));
}

/**
 * opts: { http (node:http or node:https), method, host, port, path, headers, body (object → JSON), timeoutMs,
 *         maxBytes, createConnection (for a socket that is already verified), extra (more request options) }
 */
function httpRequest(opts) {
    const { http, method = 'GET', host, port, path = '/', headers = {}, body, timeoutMs = 4000, maxBytes = 4 * 1024 * 1024, createConnection, extra = {} } = opts;
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
        const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const h = { Accept: 'application/json', ...headers };
        if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
        let req;
        try {
            // With createConnection the agent must be left out (Node ignores createConnection when agent is false).
            req = http.request({ host, port, path, method, headers: h, ...(createConnection ? { createConnection } : { agent: false }), ...extra }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                    size += c.length;
                    if (size > maxBytes) { res.destroy(); finish(reject, codeError('driver_error', 'The device sent too much data')); return; }
                    chunks.push(c);
                });
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
                    finish(resolve, { status: res.statusCode, text, json });
                });
                res.on('error', () => finish(reject, codeError('device_unreachable', 'The connection to the device broke')));
            });
        } catch {
            finish(reject, codeError('device_unreachable', 'Could not reach the device'));
            return;
        }
        req.setTimeout(timeoutMs, () => { req.destroy(); finish(reject, codeError('device_unreachable', 'The device did not answer in time')); });
        req.on('error', (e) => {
            if (e && e.code && /^[a-z_]+$/.test(e.code)) finish(reject, e);   // our own coded errors (cert_changed)
            else finish(reject, codeError('device_unreachable', `Could not reach the device (${String(e?.code || 'error').slice(0, 30)})`));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

module.exports = { codeError, clamp, toInt, isIPv4, isLanIPv4, parseAddress, formatAddress, guardHost, safeId, sleep, httpRequest };
