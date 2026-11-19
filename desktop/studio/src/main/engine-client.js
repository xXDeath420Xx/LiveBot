'use strict';
/*
 * The connection to the CertiFried engine: wss://certifriedmultitool.com/stream/bot/ws (design §2.4).
 *
 *   const c = createEngineClient({ url, getToken, clientInfo, capabilities, onAction, logger, WebSocketImpl, backoff })
 *   c.start() / c.stop()
 *   c.status            'idle' | 'connecting' | 'connected' | 'reconnecting' | 'auth_failed' | 'revoked' | 'replaced' | 'stopped'
 *   c.features          what the server announced in welcome (state, event, request on phase 2 servers)
 *   c.sendState(obj)    only when the server supports 'state'; identical state is not resent
 *   c.sendEvent(ev)     only when the server supports 'event'; at most 20 per 10 s
 *   c.request(method, params, timeoutMs) → result   only when the server supports 'request'
 *   events: 'status' (status, detail), 'welcome' (msg), 'action' ({ msg, outcome }), 'server-error' (msg),
 *           'sounds-changed' (the dashboard sound library changed)
 *
 * Protocol (proto 1): hello → welcome; ping every heartbeatMs → pong; action → ack. The app answers every action
 * exactly once; a repeated id (the server retried because our ack was lost) gets the same answer again without
 * running the action twice. Close 4401 (bad token) and 4403 (revoked) stop reconnecting: the device must be paired
 * again. 4409 (the same token connected from somewhere else) stops too, so two copies never fight. Anything else
 * reconnects with exponential backoff and jitter.
 */
const { EventEmitter } = require('node:events');

const PROTO = 1;
const CLOSE = { bad: 4400, auth: 4401, revoked: 4403, timeout: 4408, replaced: 4409, rate: 4429 };
const STOP_CODES = new Map([[CLOSE.auth, 'auth_failed'], [CLOSE.revoked, 'revoked'], [CLOSE.replaced, 'replaced']]);
const MAX_STATE_BYTES = 60 * 1024;

function createEngineClient({
    url, getToken, clientInfo = { app: 'certifried-studio', version: '0.0.0' }, capabilities = [], onAction,
    logger = null, WebSocketImpl = require('ws'), backoff = { min: 1000, max: 60000 }, now = () => Date.now(),
    eventLimit = { count: 20, windowMs: 10000 },
} = {}) {
    const em = new EventEmitter();
    let ws = null;
    let status = 'idle';
    let stopped = true;
    let attempt = 0;
    let retryTimer = null;
    let pingTimer = null;
    let heartbeatMs = 20000;
    let lastPong = 0;
    let features = [];
    let lastStateJson = null;
    let pendingState = null;
    const done = new Map();          // action id -> ack frame (kept for repeats)
    const running = new Set();       // action ids in progress
    const requests = new Map();      // request id -> { resolve, reject, timer }
    let eventTimes = [];
    let reqSeq = 0;

    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[engine] ${m}`, meta); } catch { /* ignore */ } };
    function setStatus(s, detail = null) {
        if (status === s && !detail) return;
        status = s;
        em.emit('status', s, detail);
    }
    function send(obj) {
        if (!ws || ws.readyState !== 1) return false;
        try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    function clearTimers() {
        clearTimeout(retryTimer); retryTimer = null;
        clearInterval(pingTimer); pingTimer = null;
    }
    function failRequests(reason) {
        for (const [id, r] of requests) { clearTimeout(r.timer); r.reject(Object.assign(new Error(reason), { code: reason })); requests.delete(id); }
    }

    function scheduleReconnect() {
        if (stopped) return;
        const base = Math.min(backoff.max, backoff.min * 2 ** Math.min(attempt, 10));
        const delay = Math.round(base / 2 + Math.random() * base / 2);
        attempt++;
        setStatus('reconnecting', { inMs: delay });
        retryTimer = setTimeout(open, delay);
        retryTimer.unref?.();
    }

    function open() {
        clearTimers();
        if (stopped) return;
        const token = getToken?.();
        if (!token) { setStatus('auth_failed', { reason: 'not_paired' }); stopped = true; return; }
        setStatus(attempt ? 'reconnecting' : 'connecting');
        let sock;
        try {
            sock = new WebSocketImpl(url, { handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
        } catch (e) {
            log('warn', 'could not open the connection', { error: e.message });
            return scheduleReconnect();
        }
        ws = sock;
        let welcomed = false;
        sock.on('open', () => {
            send({ type: 'hello', proto: PROTO, token, client: clientInfo, capabilities });
        });
        sock.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(String(data)); } catch { return; }
            if (!msg || typeof msg.type !== 'string') return;
            switch (msg.type) {
                case 'welcome':
                    welcomed = true;
                    attempt = 0;
                    heartbeatMs = Math.max(5000, Math.min(120000, Number(msg.heartbeatMs) || 20000));
                    features = Array.isArray(msg.features) ? msg.features.map(String) : [];
                    lastPong = now();
                    lastStateJson = null;
                    pingTimer = setInterval(heartbeat, heartbeatMs);
                    pingTimer.unref?.();
                    setStatus('connected', { deviceId: msg.deviceId });
                    em.emit('welcome', msg);
                    if (pendingState) sendState(pendingState);
                    break;
                case 'pong':
                    lastPong = now();
                    break;
                case 'action':
                    handleAction(msg);
                    break;
                case 'response': {
                    const r = requests.get(String(msg.id));
                    if (!r) break;
                    requests.delete(String(msg.id));
                    clearTimeout(r.timer);
                    if (msg.ok) r.resolve(msg.result ?? null);
                    else r.reject(Object.assign(new Error(String(msg.error || 'request_failed')), { code: String(msg.error || 'request_failed') }));
                    break;
                }
                case 'sounds_changed':
                    em.emit('sounds-changed');
                    break;
                case 'automations_changed':
                    em.emit('automations-changed');
                    break;
                case 'error':
                    log('warn', 'server error frame', { code: msg.code, message: msg.message });
                    em.emit('server-error', msg);
                    break;
                default: break;   // newer server message types are ignored
            }
        });
        sock.on('close', (code) => {
            if (ws === sock) ws = null;
            clearTimers();
            failRequests('disconnected');
            const stopAs = STOP_CODES.get(code);
            log(stopAs ? 'warn' : 'info', 'connection closed', { code, welcomed });
            if (stopAs) { stopped = true; setStatus(stopAs, { code }); return; }
            if (stopped) { setStatus('stopped'); return; }
            scheduleReconnect();
        });
        sock.on('error', (e) => { log('warn', 'connection error', { error: e.message }); });
    }

    function heartbeat() {
        if (!ws || ws.readyState !== 1) return;
        if (now() - lastPong > heartbeatMs * 2.5) {
            log('warn', 'no answer to pings; reconnecting');
            try { ws.terminate(); } catch { /* ignore */ }
            return;
        }
        send({ type: 'ping', t: now() });
    }

    async function handleAction(msg) {
        const id = String(msg.id || '');
        if (!id) return;
        if (done.has(id)) { send(done.get(id)); return; }       // our ack was lost: same answer again
        if (running.has(id)) return;
        running.add(id);
        const started = now();
        let outcome;
        try {
            outcome = await onAction({ id, action: String(msg.action || ''), params: msg.params && typeof msg.params === 'object' ? msg.params : {}, runId: msg.runId ?? null, attempt: msg.attempt });
        } catch (e) {
            outcome = { ok: false, error: String(e?.code || e?.message || 'failed') };
        }
        running.delete(id);
        const ack = outcome?.ok
            ? { type: 'ack', id, ok: true, result: outcome.result && typeof outcome.result === 'object' ? outcome.result : {} }
            : { type: 'ack', id, ok: false, error: String(outcome?.error || 'failed').slice(0, 250) };
        done.set(id, ack);
        if (done.size > 300) done.delete(done.keys().next().value);
        send(ack);
        em.emit('action', { msg, outcome: ack, ms: now() - started });
    }

    function supports(f) { return status === 'connected' && features.includes(f); }

    function sendState(state) {
        pendingState = state;
        if (!supports('state')) return false;
        let json = JSON.stringify({ type: 'state', ...state });
        if (Buffer.byteLength(json) > MAX_STATE_BYTES) {
            log('warn', 'state too large; sending a shorter one', { bytes: Buffer.byteLength(json) });
            return false;
        }
        if (json === lastStateJson) return true;
        if (!ws || ws.readyState !== 1) return false;
        try { ws.send(json); lastStateJson = json; return true; } catch { return false; }
    }

    function sendEvent(event) {
        if (!supports('event')) return false;
        const t = now();
        eventTimes = eventTimes.filter((x) => t - x < eventLimit.windowMs);
        if (eventTimes.length >= eventLimit.count) { log('warn', 'too many OBS events; one was not sent', { type: event?.type }); return false; }
        eventTimes.push(t);
        return send({ type: 'event', event: { ...event, occurredAt: event.occurredAt || t } });
    }

    function request(method, params = {}, timeoutMs = 15000) {
        if (!supports('request')) return Promise.reject(Object.assign(new Error('not_supported'), { code: status === 'connected' ? 'not_supported' : 'not_connected' }));
        const id = `r_${(++reqSeq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { requests.delete(id); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, timeoutMs);
            timer.unref?.();
            requests.set(id, { resolve, reject, timer });
            if (!send({ type: 'request', id, method, params })) { clearTimeout(timer); requests.delete(id); reject(Object.assign(new Error('not_connected'), { code: 'not_connected' })); }
        });
    }

    return Object.defineProperties(em, Object.getOwnPropertyDescriptors({
        start() {
            if (!stopped && ws) return;
            stopped = false;
            attempt = 0;
            open();
        },
        stop() {
            stopped = true;
            clearTimers();
            failRequests('stopped');
            if (ws) { try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
            ws = null;
            setStatus('stopped');
        },
        get status() { return status; },
        get features() { return [...features]; },
        get connected() { return status === 'connected'; },
        supports,
        sendState,
        sendEvent,
        request,
        setUrl(u) { url = u; },
        setCapabilities(c) { capabilities = c; },
    }));
}

module.exports = { createEngineClient, PROTO, CLOSE };
