/*
 * Stream bot: StreamElements and Streamlabs tip feeds, with the streamer's own token (design §2.2).
 * CertiFried only reads notifications of tips paid on those services; it never handles money.
 *
 *   StreamElements  Astro gateway wss://astro.streamelements.com; after open:
 *                   { type: 'subscribe', nonce, data: { topic: 'channel.tips', token, token_type: 'jwt' } }
 *                   tips arrive as { type: 'message', topic: 'channel.tips', data: <tip> }
 *   Streamlabs      Socket API (Engine.IO 3) wss://sockets.streamlabs.com/socket.io/?token=…&EIO=3&transport=websocket
 *                   '0{…pingInterval…}' open, '40' connected, '2' ping from us every pingInterval, '3' pong,
 *                   '42["event",{ type: 'donation', message: [ … ] }]' events
 *
 *   createTipFeeds({ store, ingest, WebSocket?, logger?, now?, refreshMs? })
 *     .start()     read enabled sources, connect, re-read every refreshMs (60 s)
 *     .refresh()   connect new sources, close removed ones
 *     .stop()
 * One socket per source, reconnecting with backoff (5 s doubling to 5 min). A rejected token sets the source's
 * status to 'token_rejected' and stops retrying until the streamer saves a new token.
 * Tested in tests/stream-bot-events.test.js with a fake socket.
 */
import crypto from 'node:crypto';
import WebSocketDefault from 'ws';

const SE_URL = 'wss://astro.streamelements.com';
const SL_URL = 'wss://sockets.streamlabs.com/socket.io/?EIO=3&transport=websocket&token=';
const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 5 * 60_000;

export function parseEngineIo3(frame) {
    const s = String(frame);
    if (s[0] === '0') { try { return { kind: 'open', data: JSON.parse(s.slice(1)) }; } catch { return { kind: 'open', data: {} }; } }
    if (s === '3' || s.startsWith('3')) return { kind: 'pong' };
    if (s === '2') return { kind: 'ping' };
    if (s.startsWith('40')) return { kind: 'connect' };
    if (s.startsWith('41')) return { kind: 'disconnect' };
    if (s.startsWith('44')) return { kind: 'error', data: s.slice(2) };
    if (s.startsWith('42')) {
        try {
            const arr = JSON.parse(s.slice(2));
            return Array.isArray(arr) ? { kind: 'event', name: arr[0], data: arr[1] } : { kind: 'unknown' };
        } catch { return { kind: 'unknown' }; }
    }
    if (s[0] === '1') return { kind: 'close' };
    return { kind: 'unknown' };
}

export function createTipFeeds({ store, ingest, WebSocket = WebSocketDefault, logger = null, now = () => Date.now(), refreshMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotTips] ${msg}`, meta); } catch { /* ignore */ } };
    const conns = new Map();   // source row id -> conn
    let refresher = null;
    let stopped = false;

    function connect(row) {
        const conn = { row, ws: null, backoff: BACKOFF_MIN, timer: null, ping: null, closed: false, rejected: false, connectedAt: null };
        conns.set(row.id, conn);
        open(conn);
        return conn;
    }

    function schedule(conn) {
        if (conn.closed || conn.rejected || stopped) return;
        const wait = conn.backoff;
        conn.backoff = Math.min(BACKOFF_MAX, conn.backoff * 2);
        conn.timer = setTimer(() => open(conn), wait);
        conn.timer?.unref?.();
    }

    function reject(conn, why) {
        conn.rejected = true;
        store.setTipSourceStatus(conn.row.id, 'token_rejected', why).catch(() => {});
        log('warn', 'token rejected', { sourceId: conn.row.id, source: conn.row.source });
        try { conn.ws?.close(); } catch { /* ignore */ }
    }

    function open(conn) {
        if (conn.closed || stopped) return;
        const { row } = conn;
        let ws;
        try {
            ws = new WebSocket(row.source === 'streamelements' ? SE_URL : SL_URL + encodeURIComponent(row.token));
        } catch (err) {
            store.setTipSourceStatus(row.id, 'error', err.message).catch(() => {});
            return schedule(conn);
        }
        conn.ws = ws;
        ws.on('open', () => {
            conn.connectedAt = now();
            if (row.source === 'streamelements') {
                ws.send(JSON.stringify({ type: 'subscribe', nonce: crypto.randomUUID(), data: { topic: 'channel.tips', token: row.token, token_type: 'jwt' } }));
            }
        });
        ws.on('message', (data) => {
            if (row.source === 'streamelements') onSe(conn, data); else onSl(conn, data);
        });
        ws.on('close', () => {
            if (conn.ping) { clearInterval(conn.ping); conn.ping = null; }
            if (!conn.closed && !conn.rejected) {
                // A connection that dropped within seconds of opening, three times running, is treated as a bad token.
                conn.quickDrops = conn.connectedAt && now() - conn.connectedAt < 10_000 ? (conn.quickDrops || 0) + 1 : 0;
                if (row.source === 'streamlabs' && conn.quickDrops >= 3) return reject(conn, 'Streamlabs closed the connection each time; check the Socket API token');
                store.setTipSourceStatus(row.id, 'reconnecting').catch(() => {});
                schedule(conn);
            }
        });
        ws.on('error', (err) => log('debug', 'socket error', { sourceId: row.id, error: err?.message }));
    }

    function onSe(conn, data) {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.type === 'response') {
            if (msg.error) {
                const e = String(msg.error);
                if (/unauthori|invalid|token/i.test(e) || /unauthori|invalid/i.test(String(msg.data?.message || ''))) return reject(conn, 'StreamElements rejected the JWT token');
                store.setTipSourceStatus(conn.row.id, 'error', e).catch(() => {});
                return;
            }
            conn.backoff = BACKOFF_MIN;
            store.setTipSourceStatus(conn.row.id, 'listening').catch(() => {});
            return;
        }
        if (msg.type === 'reconnect') { try { conn.ws.close(); } catch { /* close handler reconnects */ } return; }
        if (msg.type === 'message' && msg.topic === 'channel.tips' && msg.data) ingest.tipForSource(conn.row, msg.data);
    }

    function onSl(conn, data) {
        const p = parseEngineIo3(data);
        if (p.kind === 'open') {
            const every = Number(p.data?.pingInterval) || 25_000;
            if (conn.ping) clearInterval(conn.ping);
            conn.ping = setInterval(() => { try { conn.ws.send('2'); } catch { /* close follows */ } }, every);
            conn.ping.unref?.();
            return;
        }
        if (p.kind === 'connect') { conn.backoff = BACKOFF_MIN; store.setTipSourceStatus(conn.row.id, 'listening').catch(() => {}); return; }
        if (p.kind === 'error') return reject(conn, 'Streamlabs rejected the Socket API token');
        if (p.kind === 'event' && p.name === 'event' && p.data?.type === 'donation') ingest.tipForSource(conn.row, p.data);
    }

    function close(id) {
        const c = conns.get(id);
        if (!c) return;
        c.closed = true;
        if (c.timer) clearTimer(c.timer);
        if (c.ping) clearInterval(c.ping);
        try { c.ws?.close(); } catch { /* ignore */ }
        conns.delete(id);
    }

    async function refresh() {
        let rows;
        try { rows = await store.socketTipSources(); } catch (err) { log('warn', 'could not read tip sources', { error: err.message }); return; }
        const want = new Map(rows.map((r) => [r.id, r]));
        for (const [id, c] of conns) {
            const r = want.get(id);
            if (!r || r.token !== c.row.token) close(id);   // removed, turned off or given a new token
        }
        for (const r of rows) if (!conns.has(r.id)) connect(r);
    }

    return {
        async start() {
            stopped = false;
            await refresh();
            refresher = setInterval(() => refresh().catch(() => {}), refreshMs);
            refresher.unref?.();
        },
        refresh,
        stop() {
            stopped = true;
            if (refresher) clearInterval(refresher);
            for (const id of [...conns.keys()]) close(id);
        },
        _conns: conns,
    };
}

export default { createTipFeeds, parseEngineIo3 };
