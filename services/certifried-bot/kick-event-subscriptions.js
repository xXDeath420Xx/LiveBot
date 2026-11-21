/**
 * Kick webhook event subscriptions (chat, follows, subs, stream status, bans) and chat-delivery health.
 *
 * Since 2026-11-18 Kick chat reaches the bot only through the official `chat.message.sent`
 * webhook (Kick retired the Pusher key the old socket used; see kick-client.js). Each channel
 * needs its own subscription. Kick lets the app's own token (client credentials) subscribe any
 * channel by broadcaster id, which is what scripts/kick-subscribe-events.mjs does by hand; this
 * module does the same from the dashboard (Connect button, defender enrolment, first sign-in) and
 * reports which channels are subscribed for the /kick status rows. A channel subscribed before an event was added
 * here gets it from the next ensureSubscribed() call, or now from `node scripts/kick-subscribe-events.mjs --all`.
 *
 * lastChatAt is in-process memory fed by dashboard/routes/kick-webhooks.js: when the last chat
 * message for a channel arrived since the process started.
 */
import logger from '../../utils/logger.js';
import { getAccessToken } from '../../utils/platforms/kick.js';

export const KICK_EVENT_TYPES = Object.freeze([
    { name: 'channel.followed', version: 1 },
    { name: 'channel.subscription.new', version: 1 },
    { name: 'channel.subscription.renewal', version: 1 },
    { name: 'channel.subscription.gifts', version: 1 },
    { name: 'livestream.status.updated', version: 1 },
    // Chat for commands, automod and the defender (replaces the retired Pusher socket).
    { name: 'chat.message.sent', version: 1 },
    // Bans and timeouts (docs.kick.com/events/event-types: moderation.banned v1; expires_at null = permanent). The
    // stream bot's Chat overlay removes the banned viewer's lines (core/stream-bot/overlays/chat.js kickChat, H-773).
    { name: 'moderation.banned', version: 1 },
    // Stream bot wave 2 group A (core/stream-bot/control/events.js, docs.kick.com/events/event-types, checked 2026-11-20):
    // Kicks gifted, channel reward redemptions (pending = new, accepted / rejected) and title or category changes.
    { name: 'kicks.gifted', version: 1 },
    { name: 'channel.reward.redemption.updated', version: 1 },
    { name: 'livestream.metadata.updated', version: 1 },
]);

const API = 'https://api.kick.com/public/v1/events/subscriptions';
const LIST_TTL_MS = 60_000;

let listCache = null;          // { at, map: Map<broadcasterId, Set<event>> | null, error }
const lastChat = new Map();    // broadcasterId -> ms of the last chat delivery

export function noteChatDelivery(broadcasterId) {
    if (broadcasterId == null) return;
    if (lastChat.size > 10_000) lastChat.clear();
    lastChat.set(String(broadcasterId), Date.now());
}

export function lastChatAt(broadcasterId) {
    return lastChat.get(String(broadcasterId)) || null;
}

async function appToken() {
    try { return await getAccessToken(); } catch { return null; }
}

/**
 * Every subscription the app holds, grouped by broadcaster. Cached for a minute.
 * Returns { map, error } — map is null when Kick couldn't be asked.
 */
export async function listSubscriptions({ force = false } = {}) {
    if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache;
    const token = await appToken();
    if (!token) {
        listCache = { at: Date.now(), map: null, error: 'No Kick app token' };
        return listCache;
    }
    try {
        const r = await fetch(API, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`Kick answered ${r.status}`);
        const map = new Map();
        for (const s of j.data || []) {
            const b = String(s.broadcaster_user_id);
            if (!map.has(b)) map.set(b, new Set());
            map.get(b).add(s.event);
        }
        listCache = { at: Date.now(), map, error: null };
    } catch (error) {
        logger.warn('[KickEvents] Could not list webhook subscriptions', { error: error.message });
        listCache = { at: Date.now(), map: null, error: error.message };
    }
    return listCache;
}

/** { known, chat, missing[] } for one channel, from the cached list. */
export async function subscriptionStatus(broadcasterId) {
    const { map, error } = await listSubscriptions();
    if (!map) return { known: false, chat: null, missing: null, error };
    const have = map.get(String(broadcasterId)) || new Set();
    return {
        known: true,
        chat: have.has('chat.message.sent'),
        missing: KICK_EVENT_TYPES.filter(e => !have.has(e.name)).map(e => e.name),
        error: null,
    };
}

/**
 * Subscribe a channel to every event in KICK_EVENT_TYPES it doesn't have yet. Uses the app token;
 * `fallbackToken` (the owner's token, needs events:subscribe) is only used if there is no app token.
 * Returns { ok, already, added[], errors[], status, error }.
 */
export async function ensureSubscribed(broadcasterId, { fallbackToken = null } = {}) {
    const id = parseInt(broadcasterId, 10);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Invalid channel id' };
    const token = (await appToken()) || fallbackToken;
    if (!token) return { ok: false, error: 'No Kick token available to subscribe with' };

    const { map } = await listSubscriptions({ force: true });
    const have = map?.get(String(id)) || new Set();
    const missing = KICK_EVENT_TYPES.filter(e => !have.has(e.name));
    if (!missing.length) return { ok: true, already: true, added: [], errors: [] };

    try {
        const r = await fetch(API, {
            method: 'POST',
            signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ broadcaster_user_id: id, events: missing, method: 'webhook' }),
        });
        const j = await r.json().catch(() => ({}));
        listCache = null; // next status read sees the change
        const results = Array.isArray(j.data) ? j.data : [];
        const errors = results.filter(x => x && x.error).map(x => `${x.name}: ${x.error}`);
        if (!r.ok) {
            logger.warn('[KickEvents] Subscribe rejected', { broadcasterId: id, status: r.status, body: JSON.stringify(j).slice(0, 300) });
            return { ok: false, status: r.status, added: [], errors, error: `Kick rejected the subscription (status ${r.status}).` };
        }
        const added = results.filter(x => x && !x.error).map(x => x.name);
        logger.info('[KickEvents] Subscribed channel to webhook events', { broadcasterId: id, added, errors });
        return { ok: errors.length === 0, status: r.status, added, errors, results, error: errors.length ? errors.join('; ') : null };
    } catch (error) {
        logger.warn('[KickEvents] Subscribe failed', { broadcasterId: id, error: error.message });
        return { ok: false, added: [], errors: [], error: 'Could not reach Kick to subscribe.' };
    }
}
