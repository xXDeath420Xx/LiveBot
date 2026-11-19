/*
 * Stream bot music: the overlay key, short-lived signed audio links, and the audio proxy.
 *
 * The OBS browser source (/stream/bot/overlay/music/<key>) is the only player. It never gets a resolver or
 * googlevideo address: it gets /stream/bot/overlay/music/<key>/audio/<playId>?exp=…&sig=…, signed with HMAC-SHA256
 * over (profile, overlay key hash, play id, expiry), and this server fetches the audio from the resolver relay
 * (or wherever the music pipeline found it) and streams it back, Range requests passed through.
 *
 *   newOverlayKey()                 'sbm_' + 24 random bytes (base64url)
 *   keyHash(key)                    SHA-256 hex, what is looked up
 *   createSigner({ secret, now })   .sign({ profileId, keyHash, playId, ttlMs }) → { exp, sig }; .verify({ … exp, sig }) → bool
 *   audioPath(key, playId, { exp, sig })
 *   proxyAudio(req, res, upstreamUrl, { fetchImpl, timeoutMs })   pipe one request (Range kept) → resolves when done
 *
 * Tested in tests/stream-bot-music-audio.test.js (a local upstream server, Range and errors).
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

export const KEY_SHAPE = /^sbm_[A-Za-z0-9_-]{32}$/;
export const newOverlayKey = () => `sbm_${crypto.randomBytes(24).toString('base64url')}`;
export const keyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const isKeyShape = (key) => KEY_SHAPE.test(String(key || ''));

/** The signing secret: STREAM_BOT_MUSIC_SECRET, else derived from the session secret, else random for this process. */
export function defaultSecret(env = process.env) {
    if (env.STREAM_BOT_MUSIC_SECRET && env.STREAM_BOT_MUSIC_SECRET.length >= 32) return env.STREAM_BOT_MUSIC_SECRET;
    const base = env.SESSION_SECRET || env.ENCRYPTION_KEY || null;
    if (base) return crypto.createHmac('sha256', base).update('stream-bot-music-audio-v1').digest('hex');
    return crypto.randomBytes(32).toString('hex');
}

export function createSigner({ secret, now = () => Date.now() } = {}) {
    if (!secret || String(secret).length < 16) throw new Error('createSigner needs a secret');
    const mac = (profileId, kh, playId, exp) => crypto.createHmac('sha256', String(secret)).update(`${profileId}|${kh}|${playId}|${exp}`).digest('base64url');
    return {
        sign({ profileId, keyHash: kh, playId, ttlMs }) {
            const exp = Math.floor((now() + Math.max(60_000, Number(ttlMs) || 0)) / 1000);
            return { exp, sig: mac(profileId, kh, playId, exp) };
        },
        verify({ profileId, keyHash: kh, playId, exp, sig }) {
            const e = Number(exp);
            if (!Number.isInteger(e) || e * 1000 < now() || typeof sig !== 'string' || sig.length !== 43) return false;
            const want = Buffer.from(mac(profileId, kh, playId, e));
            const got = Buffer.from(sig);
            return want.length === got.length && crypto.timingSafeEqual(want, got);
        },
    };
}

export const audioPath = (key, playId, { exp, sig }) => `/stream/bot/overlay/music/${encodeURIComponent(key)}/audio/${encodeURIComponent(playId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`;

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const RANGE = /^bytes=\d*-\d*$/;

/**
 * Stream `upstreamUrl` to the response. Only the Range header goes upstream; only media headers come back.
 * 502 when the upstream answers with an error or cannot be reached; nothing is retried here (the player reports
 * the failure and the engine resolves the song again).
 */
export async function proxyAudio(req, res, upstreamUrl, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => controller.abort();
    req.on?.('close', onClose);
    let upstream;
    try {
        const headers = { 'user-agent': 'CertiFried stream music' };
        const range = String(req.headers?.range || '');
        if (RANGE.test(range)) headers.range = range;
        upstream = await fetchImpl(upstreamUrl, { headers, redirect: 'follow', signal: controller.signal });
    } catch {
        clearTimeout(timer);
        req.off?.('close', onClose);
        if (!res.headersSent) res.status(502).json({ ok: false, error: 'audio_unreachable' });
        return false;
    }
    clearTimeout(timer);   // the connect timeout; the body streams for as long as the song
    if (!upstream.ok && upstream.status !== 206) {
        try { await upstream.body?.cancel(); } catch { /* ignore */ }
        req.off?.('close', onClose);
        if (!res.headersSent) res.status(upstream.status === 416 ? 416 : 502).json({ ok: false, error: 'audio_upstream' });
        return false;
    }
    res.status(upstream.status);
    for (const h of PASS) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
    if (!upstream.headers.get('accept-ranges')) res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (!upstream.body) { res.end(); return true; }
    return new Promise((resolve) => {
        const body = Readable.fromWeb(upstream.body);
        body.on('error', () => { try { res.destroy(); } catch { /* gone */ } resolve(false); });
        res.on('close', () => { req.off?.('close', onClose); body.destroy(); resolve(true); });
        body.pipe(res);
    });
}

export default { newOverlayKey, keyHash, isKeyShape, defaultSecret, createSigner, audioPath, proxyAudio, KEY_SHAPE };
