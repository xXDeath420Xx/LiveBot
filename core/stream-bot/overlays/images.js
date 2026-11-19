/*
 * Stream bot overlays: chat emotes and badges served from CertiFried's own address, so the overlay in OBS loads
 * nothing from another site (design §9).
 *
 *   createImageProxy({ fetchImpl, appToken, clientId, now, limits })
 *     .get(kind, parts, { twitchChannelId }) → { body: Buffer, type } | null
 *        tw-emote   [id]            static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/2.0
 *        kick-emote [id]            files.kick.com/emotes/<id>/fullsize
 *        tw-badge   [set, version]  the image Twitch lists for that badge (channel badges first, then global), read with
 *                                   the app token from Helix GET /chat/badges and /chat/badges/global (cached 6 hours)
 *
 * Only those two hosts are fetched (also after redirects), 5 s timeout, images only, at most 512 KB each. A small
 * in-memory cache (400 images or 24 MB, 6 hours) keeps a busy chat from fetching the same emote twice.
 */
export const IMAGE_LIMITS = Object.freeze({ items: 400, bytes: 24 * 1024 * 1024, ttlMs: 6 * 60 * 60 * 1000, fileBytes: 512 * 1024, timeoutMs: 5000, badgeTtlMs: 6 * 60 * 60 * 1000 });
const HOSTS = new Set(['static-cdn.jtvnw.net', 'files.kick.com']);
const TW_EMOTE = /^[A-Za-z0-9_]{1,80}$/;
const KICK_EMOTE = /^\d{1,12}$/;
const BADGE_PART = /^[A-Za-z0-9_-]{1,40}$/;

export function createImageProxy({ fetchImpl = (...a) => fetch(...a), appToken = null, clientId = process.env.TWITCH_CLIENT_ID, now = () => Date.now(), limits = {}, logger = null } = {}) {
    const L = { ...IMAGE_LIMITS, ...limits };
    const cache = new Map();   // url -> { at, body, type }
    let bytes = 0;
    const badgeSets = new Map();   // 'global' | channelId -> { at, map: Map<'set/version', url>, pending }

    const evict = () => {
        for (const [k, v] of cache) {
            if (cache.size <= L.items && bytes <= L.bytes && now() - v.at < L.ttlMs) break;
            cache.delete(k);
            bytes -= v.body.length;
        }
    };

    async function fetchImage(url) {
        let u;
        try { u = new URL(url); } catch { return null; }
        if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) return null;
        const hit = cache.get(url);
        if (hit && now() - hit.at < L.ttlMs) { cache.delete(url); cache.set(url, hit); return hit; }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), L.timeoutMs);
        try {
            const res = await fetchImpl(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'CertiFried overlay images' } });
            const final = new URL(res.url || url);
            if (!res.ok || final.protocol !== 'https:' || !HOSTS.has(final.hostname)) return null;
            const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!/^image\/(png|gif|webp|jpeg|avif)$/.test(type)) return null;
            const len = Number(res.headers.get('content-length') || 0);
            if (len > L.fileBytes) return null;
            const body = Buffer.from(await res.arrayBuffer());
            if (body.length > L.fileBytes || !body.length) return null;
            const item = { at: now(), body, type };
            cache.set(url, item);
            bytes += body.length;
            evict();
            return item;
        } catch (err) {
            logger?.debug?.(`[StreamBotOverlay] image fetch failed: ${err?.message}`);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function badgeMap(scope) {
        const hit = badgeSets.get(scope);
        if (hit?.map && now() - hit.at < L.badgeTtlMs) return hit.map;
        if (hit?.pending) return hit.pending;
        const pending = (async () => {
            const map = new Map();
            try {
                const token = appToken ? await appToken() : await (await import('../../../utils/platforms/twitch.js')).getAccessToken();
                if (!token) return map;
                const path = scope === 'global' ? '/chat/badges/global' : `/chat/badges?broadcaster_id=${encodeURIComponent(scope)}`;
                const res = await fetchImpl(`https://api.twitch.tv/helix${path}`, { headers: { 'Client-Id': clientId || '', Authorization: `Bearer ${token}` } });
                if (!res.ok) return map;
                const data = await res.json();
                for (const set of Array.isArray(data?.data) ? data.data : []) {
                    for (const v of Array.isArray(set?.versions) ? set.versions : []) {
                        const url = v?.image_url_2x || v?.image_url_1x;
                        if (BADGE_PART.test(String(set.set_id)) && BADGE_PART.test(String(v.id)) && url) map.set(`${set.set_id}/${v.id}`, String(url));
                    }
                }
            } catch (err) { logger?.debug?.(`[StreamBotOverlay] badge list failed: ${err?.message}`); }
            return map;
        })();
        badgeSets.set(scope, { at: 0, map: null, pending });
        const map = await pending;
        badgeSets.set(scope, { at: now(), map, pending: null });
        return map;
    }

    return {
        async get(kind, parts = [], { twitchChannelId = null } = {}) {
            const [a, b] = parts;
            if (kind === 'tw-emote' && TW_EMOTE.test(String(a))) return fetchImage(`https://static-cdn.jtvnw.net/emoticons/v2/${a}/default/dark/2.0`);
            if (kind === 'kick-emote' && KICK_EMOTE.test(String(a))) return fetchImage(`https://files.kick.com/emotes/${a}/fullsize`);
            if (kind === 'tw-badge' && BADGE_PART.test(String(a)) && BADGE_PART.test(String(b))) {
                const key = `${a}/${b}`;
                let url = null;
                if (twitchChannelId && /^\d{1,20}$/.test(String(twitchChannelId))) url = (await badgeMap(String(twitchChannelId))).get(key) || null;
                if (!url) url = (await badgeMap('global')).get(key) || null;
                return url ? fetchImage(url) : null;
            }
            return null;
        },
        _cache: cache,
    };
}

export default { createImageProxy, IMAGE_LIMITS };
