/**
 * Kick webhook events: signature verification + event handling.
 *
 * Kick signs each webhook delivery with RSA-SHA256 over
 * `${messageId}.${timestamp}.${rawBody}` (signature Base64 in the
 * Kick-Event-Signature header). The public key comes from
 * GET /public/v1/public-key and is cached for 12h.
 *
 * Handled events: channel.followed and channel.subscription.* trigger
 * configurable chat thank-yous (features_enabled.thank_follow / thank_sub),
 * throttled per channel so a follow-bot raid can't spam chat. Every event is
 * stored in tokes_kick_events for dashboard feeds.
 */
import crypto from 'crypto';
import realPool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { sendChannelMessage } from '../../jobs/kick-timer-scheduler.js';

const KICK_API_BASE = 'https://api.kick.com/public/v1';

// ── Signature verification (pure) ───────────────────────────────────────────

export function verifyKickSignature({ messageId, timestamp, rawBody, signatureB64, publicKeyPem }) {
    try {
        if (!messageId || !timestamp || !signatureB64 || !publicKeyPem) return false;
        const payload = Buffer.from(`${messageId}.${timestamp}.${rawBody}`);
        return crypto.verify(
            'RSA-SHA256',
            payload,
            publicKeyPem,
            Buffer.from(String(signatureB64), 'base64')
        );
    } catch {
        return false;
    }
}

// ── Public-key cache ────────────────────────────────────────────────────────

let cachedKey = null;
let cachedKeyAt = 0;
const KEY_TTL_MS = 12 * 60 * 60 * 1000;

export async function getKickPublicKey(fetchImpl = fetch) {
    if (cachedKey && Date.now() - cachedKeyAt < KEY_TTL_MS) return cachedKey;
    const res = await fetchImpl(`${KICK_API_BASE}/public-key`);
    if (!res.ok) throw new Error(`public-key fetch failed (${res.status})`);
    const j = await res.json();
    const pem = j?.data?.public_key || j?.public_key;
    if (!pem) throw new Error('public-key missing in response');
    cachedKey = pem;
    cachedKeyAt = Date.now();
    return pem;
}

// ── Thank-you throttle (per channel) ───────────────────────────────────────

const sentTimestamps = new Map(); // broadcasterId -> number[] (epoch ms)
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX = 5;

export function allowThankYou(broadcasterId, now = Date.now()) {
    const key = String(broadcasterId);
    const list = (sentTimestamps.get(key) || []).filter(t => now - t < THROTTLE_WINDOW_MS);
    if (list.length >= THROTTLE_MAX) { sentTimestamps.set(key, list); return false; }
    list.push(now);
    sentTimestamps.set(key, list);
    return true;
}

// ── Event handling ──────────────────────────────────────────────────────────

async function getChannelFeatures(pool, broadcasterId) {
    const [[row]] = await pool.execute(
        "SELECT features_enabled FROM tokes_channels WHERE platform = 'kick' AND channel_id = ?",
        [String(broadcasterId)]
    );
    const raw = row?.features_enabled;
    try { return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { return null; }
}

/**
 * Process a verified Kick event. Returns the action taken (for logging/tests).
 * @param {string} eventType  Kick-Event-Type header (e.g. 'channel.followed')
 * @param {object} event      parsed event payload
 */
export function makeHandleKickEvent({ pool, send = sendChannelMessage, allow = allowThankYou }) {
    return async function handleKickEvent(eventType, event) {
        const broadcasterId = event?.broadcaster?.user_id ?? event?.broadcaster_user_id;
        if (broadcasterId == null) return 'ignored:no-broadcaster';
        const bid = String(broadcasterId);

        // Actor (follower/subscriber/gifter) username, shape varies per event.
        const actor = event?.follower?.username || event?.subscriber?.username
            || event?.gifter?.username || event?.user?.username || null;

        // Store every event (best-effort).
        try {
            await pool.execute(
                'INSERT INTO tokes_kick_events (channel_id, event_type, actor_username, payload) VALUES (?, ?, ?, ?)',
                [bid, String(eventType).slice(0, 64), actor ? String(actor).slice(0, 100) : null, JSON.stringify(event).slice(0, 8000)]
            );
        } catch (err) {
            logger.warn('[KickEvents] store failed', { error: err.message });
        }

        // Thank-yous.
        const feats = await getChannelFeatures(pool, bid);
        let template = null;
        if (eventType === 'channel.followed') template = feats?.thank_follow;
        else if (String(eventType).startsWith('channel.subscription')) template = feats?.thank_sub;
        if (!template || !actor) return 'stored';
        if (!allow(bid)) return 'throttled';

        const text = String(template).slice(0, 500).replace(/\{\{username\}\}/g, () => actor);
        const ok = await send(bid, text).catch(() => false);
        return ok ? 'thanked' : 'send-failed';
    };
}

export const handleKickEvent = makeHandleKickEvent({ pool: realPool });
