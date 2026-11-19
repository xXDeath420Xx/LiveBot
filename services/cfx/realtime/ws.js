// Greenhouse Tycoon (cfx v2): WebSocket hints. Optional: polling GET /api/v2/state?v=<etag> every 15 s
// does everything without it; the socket only makes changes from elsewhere (staff claim on another
// device, the Discord daily, a link) show up at once.
//
// Protocol (path /gh-api/ws publicly, /ws on loopback):
//   client -> {"type":"auth","token":"<session token>"}      first message, within 5 s (never in the URL)
//   server -> {"type":"ready","v":<state version>}
//   server -> {"type":"state","v":<state version>}           whenever the account's state changes; the
//                                                            client then fetches /state?v=<its etag>
//   server closes 4001 when the session expires or goes stale, 4003 for a refused origin or bad auth,
//   1013 when this account or address has too many sockets. Messages are capped at 4 KB; anything
//   after the auth message is ignored. Ping every 30 s; a socket that misses a pong is dropped.
import { WebSocketServer } from 'ws';
import { PUBLIC_PREFIX } from '../config/env.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createWsHub({
    server,
    auth,
    hints,
    origins,
    paths = ['/ws', `${PUBLIC_PREFIX}/ws`],
    maxPerIp = 20,
    maxTotal = 5000,
    authTimeoutMs = 5000,
    pingMs = 30_000,
    logger = console
}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
    const perIp = new Map();

    function ipOf(req) {
        const peer = req.socket.remoteAddress || '';
        const cf = req.headers['cf-connecting-ip'];
        return LOOPBACK.has(peer) && typeof cf === 'string' && cf.length < 64 ? cf : peer;
    }

    function onUpgrade(req, socket, head) {
        const path = (req.url || '').split('?')[0];
        if (!paths.includes(path)) { socket.destroy(); return; } // the only upgrade paths this service serves
        const origin = req.headers.origin;
        const ip = ipOf(req);
        const refuse = (status) => {
            socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            socket.destroy();
        };
        if (origin && !origins.has(origin)) return refuse('403 Forbidden');
        if (wss.clients.size >= maxTotal || (perIp.get(ip) || 0) >= maxPerIp) return refuse('503 Service Unavailable');
        wss.handleUpgrade(req, socket, head, (ws) => attach(ws, ip));
    }

    function attach(ws, ip) {
        perIp.set(ip, (perIp.get(ip) || 0) + 1);
        let unsubscribe = null;
        let expiryTimer = null;
        let alive = true;
        const authTimer = setTimeout(() => ws.close(4003, 'auth timeout'), authTimeoutMs);
        const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

        ws.on('pong', () => { alive = true; });
        ws.on('message', async (data, isBinary) => {
            if (unsubscribe || isBinary) return; // one auth message; everything after it is ignored
            clearTimeout(authTimer);
            let msg;
            try { msg = JSON.parse(String(data)); } catch { return ws.close(4003, 'bad message'); }
            if (!msg || msg.type !== 'auth' || typeof msg.token !== 'string') return ws.close(4003, 'auth required');
            let session;
            try {
                session = await auth.verifyToken(msg.token);
            } catch (err) {
                return ws.close(err?.code === 'SESSION_STALE' ? 4001 : 4003, err?.code || 'auth failed');
            }
            if (ws.readyState !== ws.OPEN) return;
            try {
                unsubscribe = hints.subscribe(session.accountId, ({ version }) => send({ type: 'state', v: version }));
            } catch {
                return ws.close(1013, 'too many connections');
            }
            const ms = session.exp * 1000 - Date.now();
            expiryTimer = setTimeout(() => ws.close(4001, 'session expired'), Math.max(1000, Math.min(ms, 24 * 3600 * 1000)));
            send({ type: 'ready', v: session.stateVersion });
        });
        ws.on('close', () => {
            clearTimeout(authTimer);
            clearTimeout(expiryTimer);
            if (unsubscribe) unsubscribe();
            const n = (perIp.get(ip) || 1) - 1;
            if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
        });
        ws.on('error', (err) => logger.debug?.('[cfx2] ws error', { error: err.message }));
        ws.isAliveCheck = () => {
            if (!alive) return ws.terminate();
            alive = false;
            try { ws.ping(); } catch { /* closing */ }
        };
    }

    const pinger = setInterval(() => { for (const ws of wss.clients) ws.isAliveCheck?.(); }, pingMs);
    pinger.unref?.();
    server.on('upgrade', onUpgrade);

    return {
        wss,
        size: () => wss.clients.size,
        close: () => new Promise((resolve) => {
            clearInterval(pinger);
            server.off('upgrade', onUpgrade);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => resolve());
        })
    };
}
