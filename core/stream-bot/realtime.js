/*
 * Stream bot: the realtime channel for CertiFried Studio and overlays (design §2.4).
 *
 *   createHub({ store, logger?, now?, heartbeatMs?, helloTimeoutMs?, ackTimeoutMs?, maxAttempts?, WebSocketServer? })
 *   hub.attach(httpServer, path)          WebSocket upgrades on `path` only (default /stream/bot/ws)
 *   hub.dispatch({ profileId, runId, target, capability, actionType, params, queueSeconds })
 *                                         → { id, status: 'sent' | 'queued' | 'none', devices }
 *   hub.publishEvent(profileId, event)    to sockets that subscribed to 'events'
 *   hub.connected(profileId)              devices online now
 *   hub.disconnectDevice(deviceId, code)  revoke: close at once (4403)
 *   hub.sweep()                           heartbeat and hello timeouts, expired queue rows (every 5 s once attached)
 *   hub.use({ onState, onEvent, onRequest, onConnect })  Phase 2 handlers for CertiFried Studio (core/stream-bot/studio.js);
 *                                         onConnect(conn) runs after each welcome (the "CertiFried Studio connected" event)
 *   hub.close()
 *
 * Protocol (JSON text frames, proto 1):
 *   → hello { proto, token, client: { app, version }, capabilities[] }      within helloTimeoutMs
 *   ← welcome { proto, deviceId, kind, heartbeatMs, serverTime }
 *   → ping { t }  ← pong { t }                                               every heartbeatMs
 *   ← action { id, action, params, runId, attempt, expiresAt }
 *   → ack { id, ok, result?, error? }
 *   → subscribe { topics: ['events'] }   ← event { event }
 *   ← error { code, message }
 * Phase 2 (additive; a client uses these only when welcome.features lists them):
 *   ← welcome { ..., features: ['state', 'event', 'request'] }
 *   → state { obs: { connected, version, studioMode, currentScene, scenes[], sources{}, inputs[], filters{} }, sounds[] }   ← state_ok
 *   → event { event: { type: 'obs.*', metadata, occurredAt } }   (error frame, not a close, for an unknown type or too many)
 *   → request { id, method, params }   ← response { id, ok, result? | error?, message? }
 *   ← sounds_changed {}   the dashboard sound library changed: ask sounds.list again
 * Close codes: 4400 bad message, 4401 bad token, 4403 revoked, 4408 hello/heartbeat timeout,
 * 4409 replaced by a newer connection with the same token, 4429 too many messages.
 *
 * Dispatch: one connected device of the target kind with the capability (newest connection first); no ack in
 * ackTimeoutMs → resent (another device of that kind when there is one) up to maxAttempts, then failed. No
 * device → queued until expiresAt and delivered in order at the next hello, else expired.
 *
 * Tested in tests/stream-bot-realtime.test.js (throwaway tables, a real ws server on 127.0.0.1).
 */
import crypto from 'node:crypto';
import { WebSocketServer as DefaultWSS } from 'ws';
import { hashSecret, isTokenShape } from './pairing.js';

export const PROTO = 1;
export const CLOSE = Object.freeze({ bad: 4400, auth: 4401, revoked: 4403, timeout: 4408, replaced: 4409, rate: 4429 });
export const WS_PATH = '/stream/bot/ws';
const MAX_PAYLOAD = 64 * 1024;
const MAX_SOCKETS_PER_PROFILE = 20;
const MAX_SOCKETS = 2000;

export function createHub({
    store, logger = null, now = () => Date.now(), heartbeatMs = 20_000, helloTimeoutMs = 10_000, ackTimeoutMs = 10_000,
    maxAttempts = 3, rate = { count: 50, windowMs: 10_000 }, WebSocketServer = DefaultWSS, sweepMs = 5_000,
} = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotWS] ${msg}`, meta); } catch { /* ignore */ } };
    const sockets = new Set();             // every open socket (conn objects)
    const byDevice = new Map();            // deviceId -> conn
    const pending = new Map();             // dispatch id -> { timer, deviceId, record }
    let wss = null;
    let sweeper = null;
    let handlers = {};             // Phase 2: { onState, onEvent, onRequest }
    const features = () => [handlers.onState && 'state', handlers.onEvent && 'event', handlers.onRequest && 'request'].filter(Boolean);
    const REQ_ID = /^[A-Za-z0-9_-]{1,40}$/;

    const send = (conn, msg) => {
        try { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
    };
    const shut = (conn, code, reason = '') => {
        try { conn.ws.close(code, reason.slice(0, 100)); } catch { /* already closing */ }
        setTimeout(() => { try { conn.ws.terminate(); } catch { /* gone */ } }, 2000).unref?.();
    };

    function devicesFor(profileId, target, capability) {
        return [...byDevice.values()]
            .filter((c) => c.profileId === profileId && c.kind === target && (!capability || !c.capabilities.length || c.capabilities.includes(capability)))
            .sort((a, b) => b.connectedAt - a.connectedAt);
    }

    async function sendDispatch(record, conn, attempt) {
        const msg = { type: 'action', id: record.id, action: record.actionType, params: record.params || {}, runId: record.runId ?? null, attempt,
            expiresAt: new Date(record.expiresAt).getTime() };
        if (conn.ws.readyState !== 1) return false;
        // Pending and 'sent' first, then the frame: a fast ack must find the record, and its 'acked' write must
        // come after the 'sent' write, never before it.
        record.attempts = attempt;
        const prev = pending.get(record.id);
        if (prev?.timer) clearTimeout(prev.timer);
        const timer = setTimeout(() => onAckTimeout(record.id), ackTimeoutMs);
        timer.unref?.();
        pending.set(record.id, { timer, deviceId: conn.deviceId, record, tried: new Set([...(prev?.tried || []), conn.deviceId]) });
        await store.updateDispatch(record.id, { status: 'sent', attempts: attempt, deviceId: conn.deviceId, sentAt: new Date(now()) }).catch((e) => log('warn', 'dispatch update failed', { error: e.message }));
        if (!send(conn, msg)) {
            // The socket went away between the check and the send: back to the queue.
            clearTimeout(timer);
            pending.delete(record.id);
            await store.updateDispatch(record.id, { status: 'queued', deviceId: null }).catch(() => {});
            return false;
        }
        return true;
    }

    async function onAckTimeout(id) {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        const rec = p.record;
        if (new Date(rec.expiresAt).getTime() <= now()) {
            await store.updateDispatch(id, { status: 'expired', error: 'no answer before it expired' }).catch(() => {});
            return;
        }
        if ((rec.attempts || 1) >= maxAttempts) {
            await store.updateDispatch(id, { status: 'failed', error: `no answer after ${rec.attempts} tries` }).catch(() => {});
            return;
        }
        const devices = devicesFor(rec.profileId, rec.target, rec.capability);
        const next = devices.find((d) => !p.tried.has(d.deviceId)) || devices[0];
        if (next) {
            pending.set(id, { ...p, timer: null });   // keep the tried set for sendDispatch
            const ok = await sendDispatch(rec, next, (rec.attempts || 1) + 1);
            if (ok) return;
            pending.delete(id);
        }
        await store.updateDispatch(id, { status: 'queued', deviceId: null }).catch(() => {});
    }

    async function flushQueue(conn) {
        let rows = [];
        try { rows = await store.queuedDispatches(conn.profileId, conn.kind, new Date(now())); } catch (e) { log('warn', 'queue read failed', { error: e.message }); return; }
        for (const r of rows) {
            if (r.capability && conn.capabilities.length && !conn.capabilities.includes(r.capability)) continue;
            if (pending.has(r.id)) continue;
            await sendDispatch({ ...r, expiresAt: r.expiresAt }, conn, (r.attempts || 0) + 1);
        }
    }

    async function onHello(conn, msg) {
        if (msg.proto != null && Number(msg.proto) !== PROTO) { send(conn, { type: 'error', code: 'proto', message: `protocol ${PROTO} only` }); return shut(conn, CLOSE.bad, 'protocol'); }
        if (!isTokenShape(msg.token)) { send(conn, { type: 'error', code: 'auth_failed', message: 'Unknown or revoked token' }); return shut(conn, CLOSE.auth, 'auth'); }
        let device;
        try { device = await store.deviceByTokenHash(hashSecret(msg.token)); } catch (e) {
            log('error', 'device lookup failed', { error: e.message });
            send(conn, { type: 'error', code: 'server', message: 'Try again shortly' });
            return shut(conn, 1011, 'server');
        }
        if (!device) { send(conn, { type: 'error', code: 'auth_failed', message: 'Unknown or revoked token' }); return shut(conn, CLOSE.auth, 'auth'); }
        const sameProfile = [...byDevice.values()].filter((c) => c.profileId === device.profileId);
        if (sameProfile.length >= MAX_SOCKETS_PER_PROFILE && !byDevice.has(device.id)) { send(conn, { type: 'error', code: 'too_many', message: 'Too many devices connected' }); return shut(conn, CLOSE.rate, 'too many'); }
        const old = byDevice.get(device.id);
        if (old && old !== conn) { send(old, { type: 'error', code: 'replaced', message: 'Connected again from somewhere else' }); shut(old, CLOSE.replaced, 'replaced'); }
        const caps = (Array.isArray(msg.capabilities) ? msg.capabilities : []).map((c) => String(c).toLowerCase()).filter((c) => /^[a-z0-9_.-]{1,20}$/.test(c)).slice(0, 20);
        const client = msg.client && typeof msg.client === 'object' ? `${String(msg.client.app || '').slice(0, 40)} ${String(msg.client.version || '').slice(0, 20)}`.trim() : null;
        Object.assign(conn, { authed: true, deviceId: device.id, profileId: device.profileId, kind: device.kind, name: device.name, capabilities: caps, connectedAt: now(), client });
        byDevice.set(device.id, conn);
        store.touchDevice(device.id, { clientInfo: client, capabilities: caps }).catch(() => {});
        const feats = features();
        send(conn, { type: 'welcome', proto: PROTO, deviceId: device.id, kind: device.kind, heartbeatMs, serverTime: now(), ...(feats.length ? { features: feats } : {}) });
        log('info', 'device connected', { deviceId: device.id, profileId: device.profileId, kind: device.kind });
        if (handlers.onConnect) Promise.resolve().then(() => handlers.onConnect(conn)).catch((e) => log('warn', 'connect hook failed', { error: e?.message }));
        await flushQueue(conn);
    }

    async function onAck(conn, msg) {
        const id = String(msg.id || '');
        const p = pending.get(id);
        if (!p || p.deviceId !== conn.deviceId) return;
        clearTimeout(p.timer);
        pending.delete(id);
        const fields = msg.ok
            ? { status: 'acked', ackedAt: new Date(now()), result: msg.result && typeof msg.result === 'object' ? msg.result : null, error: null }
            : { status: 'failed', ackedAt: new Date(now()), error: String(msg.error || 'the device reported a failure').slice(0, 255) };
        await store.updateDispatch(id, fields).catch((e) => log('warn', 'ack update failed', { error: e.message }));
    }

    function onMessage(conn, data, isBinary) {
        conn.lastSeen = now();
        conn.times = conn.times.filter((t) => conn.lastSeen - t < rate.windowMs);
        conn.times.push(conn.lastSeen);
        if (conn.times.length > rate.count) { send(conn, { type: 'error', code: 'rate', message: 'Too many messages' }); return shut(conn, CLOSE.rate, 'rate'); }
        let msg;
        try { msg = isBinary ? null : JSON.parse(String(data)); } catch { msg = null; }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') { send(conn, { type: 'error', code: 'bad_message', message: 'Send JSON with a type' }); return shut(conn, CLOSE.bad, 'bad message'); }
        if (!conn.authed) {
            if (msg.type !== 'hello') { send(conn, { type: 'error', code: 'hello_first', message: 'Send hello first' }); return shut(conn, CLOSE.auth, 'hello first'); }
            if (conn.helloStarted) return;
            conn.helloStarted = true;
            return onHello(conn, msg).catch((e) => log('error', 'hello failed', { error: e.message }));
        }
        switch (msg.type) {
            case 'ping': return send(conn, { type: 'pong', t: msg.t ?? now() });
            case 'ack': return onAck(conn, msg).catch(() => {});
            case 'subscribe':
                for (const t of Array.isArray(msg.topics) ? msg.topics : []) if (t === 'events') conn.subs.add('events');
                return send(conn, { type: 'subscribed', topics: [...conn.subs] });
            case 'hello': return undefined;   // already authenticated
            case 'state':
                if (!handlers.onState) break;
                try {
                    if (handlers.onState(conn, msg)) send(conn, { type: 'state_ok' });
                    else send(conn, { type: 'error', code: 'bad_state', message: 'State must be an object' });
                } catch (e) { log('warn', 'state failed', { error: e.message }); }
                return undefined;
            case 'event':
                if (!handlers.onEvent) break;
                Promise.resolve(handlers.onEvent(conn, msg.event)).then((r) => {
                    if (r === 'unknown') send(conn, { type: 'error', code: 'unknown_event', message: 'Unknown event type' });
                    else if (r === 'rate') send(conn, { type: 'error', code: 'event_rate', message: 'Too many events; some were dropped' });
                }).catch((e) => log('warn', 'event failed', { error: e.message }));
                return undefined;
            case 'request': {
                if (!handlers.onRequest) break;
                const id = String(msg.id ?? '');
                if (!REQ_ID.test(id)) { send(conn, { type: 'error', code: 'bad_request', message: 'A request needs an id of 1 to 40 letters, numbers, _ or -' }); return undefined; }
                const method = String(msg.method ?? '').slice(0, 40);
                Promise.resolve().then(() => handlers.onRequest(conn, method, msg.params && typeof msg.params === 'object' ? msg.params : {}))
                    .then((result) => send(conn, { type: 'response', id, ok: true, result: result ?? {} }))
                    .catch((e) => {
                        if (!e?.code) log('warn', 'request failed', { method, error: e?.message });
                        send(conn, { type: 'response', id, ok: false, error: e?.code || 'server', message: e?.code ? String(e.message || '').slice(0, 200) : 'Try again shortly' });
                    });
                return undefined;
            }
            default: break;
        }
        send(conn, { type: 'error', code: 'unknown_type', message: `Unknown type ${String(msg.type).slice(0, 30)}` });
        return shut(conn, CLOSE.bad, 'unknown type');
    }

    function onClose(conn) {
        sockets.delete(conn);
        if (conn.deviceId && byDevice.get(conn.deviceId) === conn) {
            byDevice.delete(conn.deviceId);
            // Actions waiting on this device: retry elsewhere (or queue) now rather than after the timeout.
            for (const [id, p] of pending) if (p.deviceId === conn.deviceId) { clearTimeout(p.timer); onAckTimeout(id).catch(() => {}); }
            store.touchDevice(conn.deviceId, {}).catch(() => {});
            log('info', 'device disconnected', { deviceId: conn.deviceId });
        }
    }

    function handleConnection(ws) {
        if (sockets.size >= MAX_SOCKETS) { try { ws.close(1013, 'busy'); } catch { /* ignore */ } return; }
        const conn = { ws, authed: false, connectedAt: now(), lastSeen: now(), times: [], subs: new Set(), capabilities: [] };
        sockets.add(conn);
        ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
        ws.on('close', () => onClose(conn));
        ws.on('error', () => { /* close follows */ });
    }

    async function sweep() {
        const t = now();
        for (const conn of sockets) {
            if (!conn.authed && t - conn.connectedAt > helloTimeoutMs) { send(conn, { type: 'error', code: 'hello_timeout', message: 'No hello' }); shut(conn, CLOSE.timeout, 'hello timeout'); }
            else if (conn.authed && t - conn.lastSeen > heartbeatMs * 2.5) { send(conn, { type: 'error', code: 'heartbeat_timeout', message: 'No ping' }); shut(conn, CLOSE.timeout, 'heartbeat timeout'); }
        }
        try { await store.expireDispatches(new Date(t)); } catch (e) { log('warn', 'expire failed', { error: e.message }); }
    }

    const newId = () => `d_${crypto.randomBytes(12).toString('hex')}`;

    return {
        attach(server, path = WS_PATH) {
            if (wss) return wss;
            wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
            wss.on('connection', (ws) => handleConnection(ws));
            server.on('upgrade', (req, socket, head) => {
                let pathname = '';
                try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch { return; }
                if (pathname !== path) return;
                wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
            });
            sweeper = setInterval(() => sweep().catch(() => {}), sweepMs);
            sweeper.unref?.();
            return wss;
        },
        handleConnection,

        async dispatch({ profileId, runId = null, target, capability = null, actionType, params = {}, queueSeconds = 120 }) {
            const id = newId();
            const ttl = Math.max(0, Number(queueSeconds) || 0) * 1000;
            const record = { id, profileId, runId, target, capability, actionType, params, expiresAt: new Date(now() + Math.max(ttl, ackTimeoutMs * maxAttempts)), attempts: 0 };
            const devices = devicesFor(profileId, target, capability);
            if (!devices.length && ttl === 0) {
                await store.insertDispatch({ ...record, status: 'expired' });
                return { id, status: 'none', devices: 0 };
            }
            if (!devices.length) record.expiresAt = new Date(now() + ttl);
            await store.insertDispatch({ ...record, status: 'queued' });
            if (devices.length && await sendDispatch(record, devices[0], 1)) return { id, status: 'sent', devices: 1 };
            return { id, status: 'queued', devices: 0 };
        },

        /** Send a frame to every connected device of one kind in a profile (Phase 2: sounds_changed). Returns how many. */
        notify(profileId, kind, msg) {
            let n = 0;
            for (const c of byDevice.values()) if (c.profileId === profileId && c.kind === kind && send(c, msg)) n++;
            return n;
        },
        publishEvent(profileId, event) {
            for (const c of byDevice.values()) if (c.profileId === profileId && c.subs.has('events')) send(c, { type: 'event', event });
        },
        connected(profileId) {
            return [...byDevice.values()].filter((c) => c.profileId === profileId)
                .map((c) => ({ deviceId: c.deviceId, kind: c.kind, name: c.name, capabilities: c.capabilities, connectedAt: new Date(c.connectedAt),
                    client: c.client || null, state: c.state || null }));
        },
        /** Phase 2: handlers for Studio's state, event and request frames (each optional; welcome lists those set). */
        use(h = {}) { handlers = { ...handlers, ...h }; return this; },
        hasDevice(profileId, target, capability = null) { return devicesFor(profileId, target, capability).length > 0; },
        disconnectDevice(deviceId, code = CLOSE.revoked) {
            const c = byDevice.get(Number(deviceId));
            if (!c) return false;
            send(c, { type: 'error', code: 'revoked', message: 'This device was removed on the dashboard' });
            shut(c, code, 'revoked');
            return true;
        },
        sweep,
        close() {
            if (sweeper) clearInterval(sweeper);
            for (const p of pending.values()) clearTimeout(p.timer);
            pending.clear();
            for (const c of sockets) { try { c.ws.terminate(); } catch { /* ignore */ } }
            sockets.clear();
            byDevice.clear();
            try { wss?.close(); } catch { /* ignore */ }
        },
        _state: { sockets, byDevice, pending },
    };
}

export default { createHub, PROTO, CLOSE, WS_PATH };
