/*
 * Stream bot overlays: the per-overlay key and the HTTP pieces every OBS browser-source page shares
 * (design §9; the pattern of the song request player in dashboard/routes/stream-bot-music.js).
 *
 *   newOverlayKey()            'sbo_' + 24 random bytes (base64url, 32 characters)
 *   isOverlayKeyShape(key)     the shape check every keyed route does before any database read
 *   keyHash(key)               SHA-256 hex, what is looked up (the same function the music key uses)
 *   keyHint(key)               the last 4 characters, shown on the Overlays tab next to a regenerated URL
 *   OVERLAY_HEADERS            no-store, no-referrer, noindex: the URL is a credential and must not leak or be cached
 *   setOverlayHeaders(res)
 *   openSse(req, res, opts)    an SSE response that LiteSpeed and OBS keep open (X-Accel-Buffering: no, a ping every
 *                              20 s, retry 3 s) → { send(event, data), comment(text), close(), closed }
 *
 * Kept free of the database and of Express so the music player routes can move onto openSse() as well.
 * Tested in tests/stream-bot-overlays.test.js.
 */
import crypto from 'node:crypto';
import { keyHash } from '../music/audio.js';

export { keyHash };
export const OVERLAY_KEY_SHAPE = /^sbo_[A-Za-z0-9_-]{32}$/;
export const newOverlayKey = () => `sbo_${crypto.randomBytes(24).toString('base64url')}`;
export const isOverlayKeyShape = (key) => OVERLAY_KEY_SHAPE.test(String(key || ''));
export const keyHint = (key) => String(key || '').slice(-4);

export const OVERLAY_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
});

export function setOverlayHeaders(res) {
    for (const [k, v] of Object.entries(OVERLAY_HEADERS)) res.setHeader(k, v);
}

/**
 * Turn a response into an SSE stream. `data` is JSON-encoded; event names are [a-z_]. Writes after the client went
 * away are dropped. `onClose` runs once when the request closes (the caller detaches there).
 */
export function openSse(req, res, { pingMs = 20_000, retryMs = 3_000, onClose = null } = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...OVERLAY_HEADERS,
    });
    const client = { closed: false };
    const write = (s) => {
        if (client.closed) return false;
        try { res.write(s); return true; } catch { return false; }
    };
    write(`retry: ${Math.max(500, Number(retryMs) || 3000)}\n\n`);
    const ping = setInterval(() => write(': ping\n\n'), Math.max(1000, Number(pingMs) || 20_000));
    ping.unref?.();
    client.send = (event, data) => {
        const name = /^[a-z_]{1,24}$/.test(String(event)) ? event : 'message';
        return write(`event: ${name}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    };
    client.comment = (text) => write(`: ${String(text).replace(/[\r\n]/g, ' ').slice(0, 100)}\n\n`);
    client.close = () => {
        if (client.closed) return;
        client.closed = true;
        clearInterval(ping);
        try { res.end(); } catch { /* gone */ }
    };
    let detached = false;
    req.on('close', () => {
        client.closed = true;
        clearInterval(ping);
        if (detached) return;
        detached = true;
        try { onClose?.(); } catch { /* the caller's detach never throws out */ }
    });
    return client;
}

export default { newOverlayKey, isOverlayKeyShape, keyHash, keyHint, OVERLAY_HEADERS, setOverlayHeaders, openSse, OVERLAY_KEY_SHAPE };
