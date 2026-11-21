/*
 * Stream bot heart rate: the optional Pulsoid fallback (Studio 0.2.14), with the streamer's own Pulsoid access token
 * (Connections page; stored encrypted in the profile settings, store.js setHeartPulsoid).
 *
 *   Pulsoid real-time API v2 (docs.pulsoid.net, "Read data via WebSocket"): wss://dev.pulsoid.net/api/v2/data/real_time,
 *   token in the Authorization header (Bearer), messages { type: 'heart_rate', timestamp, heartRate: { bpm } }. A bad token
 *   is refused at the handshake with HTTP 401 (403 or 400 / 6003 when it lacks data:heart_rate:read).
 *
 *   createPulsoidFeeds({ listSources, onReading, setStatus, WebSocket, logger, now, refreshMs, setTimer, clearTimer })
 *     listSources() → [{ profileId, token }]   (store.heartPulsoidSources: decrypted, here only)
 *     onReading(profileId, { bpm, at })         heart/service.js reading(profileId, 'pulsoid', r)
 *     setStatus(profileId, status, error)       listening | ok | reconnecting | token_rejected (only on change)
 *     .start() / .refresh() / .stop()
 *   One socket per profile, opened while a token is saved. Its readings are only used while Studio's are missing (the
 *   service decides). Reconnects with backoff 5 s doubling to 5 min; a refused token stops until a new one is saved.
 *   The token is never put in a URL or a log line.
 */
import WebSocketDefault from 'ws';
import { parsePulsoid } from './rules.js';

export const PULSOID_URL = 'wss://dev.pulsoid.net/api/v2/data/real_time';
const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 5 * 60_000;

export function createPulsoidFeeds({
    listSources, onReading, setStatus = () => {}, WebSocket = WebSocketDefault, logger = null, now = () => Date.now(),
    refreshMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotHeart] ${msg}`, meta); } catch { /* ignore */ } };
    const conns = new Map();   // profileId -> conn
    let refresher = null;
    let stopped = true;

    function status(conn, s, error = null) {
        if (conn.status === s && conn.error === error) return;
        conn.status = s;
        conn.error = error;
        Promise.resolve().then(() => setStatus(conn.profileId, s, error)).catch(() => {});
    }

    function schedule(conn) {
        if (conn.closed || conn.rejected || stopped) return;
        const wait = conn.backoff;
        conn.backoff = Math.min(BACKOFF_MAX, conn.backoff * 2);
        conn.timer = setTimer(() => { conn.timer = null; open(conn); }, wait);
        conn.timer?.unref?.();
    }

    function open(conn) {
        if (conn.closed || stopped) return;
        let ws;
        try { ws = new WebSocket(PULSOID_URL, { headers: { Authorization: `Bearer ${conn.token}` }, handshakeTimeout: 15_000 }); } catch (e) {
            log('warn', 'Pulsoid socket could not open', { profileId: conn.profileId, error: e?.message });
            status(conn, 'reconnecting', 'Could not reach Pulsoid');
            schedule(conn);
            return;
        }
        conn.ws = ws;
        ws.on('unexpected-response', (_req, res) => {
            const code = res?.statusCode;
            if (code === 401 || code === 403 || code === 400) {
                conn.rejected = true;
                status(conn, 'token_rejected', code === 400 ? 'Pulsoid refused the token: it needs the heart rate permission (data:heart_rate:read).' : 'Pulsoid refused the token. Make a new one at pulsoid.net and save it again.');
                log('info', 'Pulsoid refused the token', { profileId: conn.profileId, status: code });
            } else status(conn, 'reconnecting', `Pulsoid answered ${code || 'with an error'}`);
            try { ws.terminate?.(); } catch { /* gone */ }
        });
        ws.on('open', () => { conn.backoff = BACKOFF_MIN; status(conn, 'listening'); });
        ws.on('message', (data) => {
            const r = parsePulsoid(String(data), now());
            if (!r) return;
            if (conn.status !== 'ok') status(conn, 'ok');
            try { onReading(conn.profileId, r); } catch { /* best effort */ }
        });
        ws.on('error', () => { /* close follows */ });
        ws.on('close', () => {
            if (conn.ws !== ws) return;
            conn.ws = null;
            if (conn.closed || conn.rejected || stopped) return;
            status(conn, 'reconnecting', conn.error);
            schedule(conn);
        });
    }

    function close(conn) {
        conn.closed = true;
        if (conn.timer) { clearTimer(conn.timer); conn.timer = null; }
        try { conn.ws?.close(); } catch { /* gone */ }
        conn.ws = null;
    }

    async function refresh() {
        let rows;
        try { rows = await listSources(); } catch (e) { log('warn', 'Pulsoid tokens not read', { error: e?.message }); return; }
        const want = new Map((rows || []).filter((r) => r && r.token).map((r) => [Number(r.profileId), String(r.token)]));
        for (const [pid, conn] of conns) {
            if (!want.has(pid) || want.get(pid) !== conn.token) { close(conn); conns.delete(pid); }
        }
        for (const [pid, token] of want) {
            if (conns.has(pid)) continue;
            const conn = { profileId: pid, token, ws: null, timer: null, backoff: BACKOFF_MIN, closed: false, rejected: false, status: null, error: null };
            conns.set(pid, conn);
            open(conn);
        }
    }

    return {
        async start() {
            stopped = false;
            await refresh();
            refresher = setInterval(() => { refresh().catch(() => {}); }, refreshMs);
            refresher.unref?.();
        },
        refresh,
        stop() {
            stopped = true;
            if (refresher) clearInterval(refresher);
            refresher = null;
            for (const c of conns.values()) close(c);
            conns.clear();
        },
        _conns: conns,
    };
}

export default { createPulsoidFeeds, PULSOID_URL };
