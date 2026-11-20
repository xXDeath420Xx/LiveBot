'use strict';
/*
 * Rotating log file with secrets removed.
 *
 *   createLogger({ dir, fileName?, maxBytes?, keep?, console? })
 *   log.info(msg, meta?) / warn / error / debug
 *   redact(value)      the same scrubbing, exported for tests and for the Activity view
 *
 * One line per entry: ISO time, level, message, meta as JSON. When the file passes maxBytes it is renamed
 * studio.1.log (older ones shift up) and at most `keep` old files are kept.
 * Device tokens (sbd_…), pairing codes, and any meta key that looks like a secret are replaced before writing.
 */
const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEY = /pass(word)?|token|secret|authorization|^auth$|authentication|cookie|pairing_?code/i;
const TOKEN_RE = /sbd_[A-Za-z0-9_-]{8,}/g;
const BRIDGE_TOKEN_RE = /sdk_[A-Za-z0-9_-]{8,}/g;   // the Stream Deck pairing token (bridge-server.js)
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const CODE_RE = /\b[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}\b/g;
const PAIR_URL_RE = /(code=)[^&\s"]+/gi;

function scrubString(s) {
    return String(s)
        .replace(TOKEN_RE, 'sbd_[hidden]')
        .replace(BRIDGE_TOKEN_RE, 'sdk_[hidden]')
        .replace(BEARER_RE, '$1[hidden]')
        .replace(PAIR_URL_RE, '$1[hidden]')
        .replace(CODE_RE, '[code hidden]');
}

function redact(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return scrubString(value);
    if (typeof value !== 'object') return value;
    if (depth > 5) return '[deep]';
    if (value instanceof Error) return { message: scrubString(value.message), code: value.code };
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY.test(k) && v != null && v !== '' && typeof v !== 'boolean' ? '[hidden]' : redact(v, depth + 1);
    }
    return out;
}

function createLogger({ dir, fileName = 'studio.log', maxBytes = 1024 * 1024, keep = 5, console: echo = false } = {}) {
    let file = null;
    if (dir) {
        try { fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, fileName); } catch { file = null; }
    }
    const listeners = new Set();

    function rotate() {
        try {
            const st = fs.statSync(file);
            if (st.size < maxBytes) return;
        } catch { return; }
        const base = file.replace(/\.log$/, '');
        try { fs.rmSync(`${base}.${keep}.log`, { force: true }); } catch { /* ignore */ }
        for (let i = keep - 1; i >= 1; i--) {
            try { fs.renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`); } catch { /* missing */ }
        }
        try { fs.renameSync(file, `${base}.1.log`); } catch { /* ignore */ }
    }

    function write(level, msg, meta) {
        const entry = { t: new Date().toISOString(), level, msg: scrubString(msg) };
        if (meta !== undefined) entry.meta = redact(meta);
        const line = `${entry.t} ${level.toUpperCase().padEnd(5)} ${entry.msg}${entry.meta !== undefined ? ` ${safeJson(entry.meta)}` : ''}\n`;
        if (file) {
            try { rotate(); fs.appendFileSync(file, line, 'utf8'); } catch { /* disk full or locked: keep running */ }
        }
        if (echo) process.stdout.write(line);
        for (const fn of listeners) { try { fn(entry); } catch { /* ignore */ } }
    }

    return {
        info: (m, meta) => write('info', m, meta),
        warn: (m, meta) => write('warn', m, meta),
        error: (m, meta) => write('error', m, meta),
        debug: (m, meta) => write('debug', m, meta),
        onEntry(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        get file() { return file; },
    };
}

function safeJson(v) {
    try { return JSON.stringify(v); } catch { return '"[unserialisable]"'; }
}

const nullLogger = { info() {}, warn() {}, error() {}, debug() {}, onEntry() { return () => {}; }, file: null };

module.exports = { createLogger, redact, scrubString, nullLogger };
