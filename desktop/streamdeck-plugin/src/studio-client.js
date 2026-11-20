/*
 * The connection to CertiFried Studio's local bridge (Studio's src/main/bridge-server.js).
 *
 *   const client = createStudioClient({ WebSocket?, setTimer?, clearTimer?, random?, log?, pluginVersion })
 *     configure({ port, token })   (re)connects when either changed; no token = status 'not_configured'
 *     stop()
 *     request(method, params, { timeoutMs = 8000 }) → Promise<result>; rejects Error with .code
 *                                  (not_connected, timeout, or the error code Studio answered)
 *     status                       'not_configured' | 'connecting' | 'connected' | 'unreachable' | 'auth_failed'
 *                                  | 'locked_out' | 'stopped'
 *     connected                    true once Studio answered hello with welcome
 *     on(event, fn) → off()        'status' (status, detail), 'welcome' (frame), 'push' (frame: type 'state' or 'obs')
 *
 * Always ws://127.0.0.1:<port>, never another host. Node's ws sends no Origin header unless asked to, and none is
 * asked for (Studio refuses connections that carry one). The token goes only in the hello frame and is never logged.
 * Reconnects with backoff (1 s doubling to 30 s, with jitter). A wrong or regenerated token (4401/4403) stops retrying
 * until the token is changed; a lockout (4429) waits 65 s.
 */
import WebSocketImpl from 'ws';

const MAX_BACKOFF = 30_000;
const LOCKOUT_WAIT = 65_000;

export function createStudioClient({
    WebSocket = WebSocketImpl, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
    log = () => {}, pluginVersion = '0.0.0',
} = {}) {
    let cfg = { port: 39720, token: '' };
    let ws = null;
    let status = 'not_configured';
    let detail = null;
    let connected = false;
    let attempt = 0;
    let retryTimer = null;
    let seq = 0;
    let stopped = false;
    let authBlocked = false;         // the current token was refused; wait for a new one
    const pending = new Map();        // id → { resolve, reject, timer }
    const listeners = { status: new Set(), welcome: new Set(), push: new Set() };
    const emit = (ev, ...a) => { for (const fn of listeners[ev]) { try { fn(...a); } catch (e) { log('warn', `listener failed: ${e?.message}`); } } };

    function setStatus(s, d = null) {
        if (s === status && d === detail) return;
        status = s; detail = d;
        emit('status', s, d);
    }

    function failPending(code) {
        for (const [id, p] of pending) { clearTimer(p.timer); p.reject(err(code)); pending.delete(id); }
    }

    function teardown() {
        clearTimer(retryTimer); retryTimer = null;
        connected = false;
        const s = ws;
        ws = null;
        if (s) { try { s.removeAllListeners(); s.on('error', () => {}); s.terminate(); } catch { /* ignore */ } }
        failPending('not_connected');
    }

    function scheduleRetry(delay) {
        if (stopped || authBlocked || !cfg.token) return;
        const base = delay ?? Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(attempt, 5));
        attempt++;
        const wait = delay ?? Math.round(base * (0.8 + random() * 0.4));
        clearTimer(retryTimer);
        retryTimer = setTimer(() => { retryTimer = null; open(); }, wait);
        retryTimer?.unref?.();
    }

    function open() {
        teardown();
        if (stopped) return;
        if (!cfg.token) { setStatus('not_configured'); return; }
        setStatus('connecting');
        let sock;
        try {
            sock = new WebSocket(`ws://127.0.0.1:${cfg.port}`, { perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
        } catch (e) {
            setStatus('unreachable', e?.code || 'connect_failed');
            scheduleRetry();
            return;
        }
        ws = sock;
        sock.on('open', () => {
            if (ws !== sock) return;
            sock.send(JSON.stringify({ type: 'hello', token: cfg.token, client: { app: 'streamdeck', version: pluginVersion } }));
        });
        sock.on('message', (data) => { if (ws === sock) onFrame(data); });
        sock.on('close', (code) => { if (ws === sock) onClose(code); });
        sock.on('error', (e) => { if (ws === sock) log('debug', `connection error: ${e?.code || e?.message}`); });
    }

    function onFrame(data) {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'welcome') {
            connected = true;
            attempt = 0;
            setStatus('connected');
            emit('welcome', msg);
            return;
        }
        if (msg.type === 'response') {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            clearTimer(p.timer);
            if (msg.ok) p.resolve(msg.result ?? {});
            else p.reject(err(String(msg.error || 'failed'), msg.message));
            return;
        }
        if (msg.type === 'error') {
            if (msg.code === 'auth_failed' || msg.code === 'locked_out') detail = msg.code;
            log('info', `Studio answered ${msg.code}`);
            return;
        }
        if (msg.type === 'state' || msg.type === 'obs') emit('push', msg);
    }

    function onClose(code) {
        connected = false;
        ws = null;
        failPending('not_connected');
        if (stopped) return;
        if (code === 4401 || code === 4403) {
            authBlocked = true;
            setStatus('auth_failed', code === 4403 ? 'token_changed' : 'auth_failed');
            return;
        }
        if (code === 4429) { setStatus('locked_out'); scheduleRetry(LOCKOUT_WAIT); return; }
        setStatus('unreachable', code ? String(code) : null);
        scheduleRetry();
    }

    function configure({ port, token } = {}) {
        const p = Number(port);
        const next = {
            port: Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 39720,
            token: typeof token === 'string' ? token.trim().slice(0, 200) : '',
        };
        stopped = false;
        if (next.port === cfg.port && next.token === cfg.token && (ws || retryTimer || authBlocked)) return;
        if (next.token !== cfg.token) authBlocked = false;
        cfg = next;
        attempt = 0;
        open();
    }

    function stop() {
        stopped = true;
        teardown();
        setStatus('stopped');
    }

    function request(method, params = {}, { timeoutMs = 8000 } = {}) {
        if (!connected || !ws) return Promise.reject(err('not_connected', 'Studio is not connected'));
        const id = `r${++seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimer(() => { pending.delete(id); reject(err('timeout', 'Studio did not answer')); }, timeoutMs);
            timer?.unref?.();
            pending.set(id, { resolve, reject, timer });
            try { ws.send(JSON.stringify({ type: 'request', id, method, params })); } catch {
                clearTimer(timer); pending.delete(id); reject(err('not_connected'));
            }
        });
    }

    return {
        configure,
        stop,
        request,
        on(ev, fn) { listeners[ev].add(fn); return () => listeners[ev].delete(fn); },
        get status() { return status; },
        get detail() { return detail; },
        get connected() { return connected; },
    };
}

function err(code, message) { const e = new Error(message || code); e.code = code; return e; }
