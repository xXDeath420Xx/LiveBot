/*
 * Stream bot overlays: 7TV, BTTV and FFZ emotes for the Chat overlay and the Emote wall (the emotes Streamer.bot showed).
 *
 * The emote lists are read here, on the server, from each service's public API for the streamer's Twitch channel plus the
 * global sets, and cached for 30 minutes. The overlay page never contacts those services: an emote becomes an image path
 * under the overlay's own address (img/7tv-emote/<id>, img/bttv-emote/<id>, img/ffz-emote/<id>), which images.js fetches
 * from the services' image hosts and caches. Nothing about viewers is sent anywhere; the requests carry only the
 * streamer's public Twitch user id.
 *
 *   createThirdPartyEmotes({ fetchImpl, now, ttlMs, logger })
 *     .forChannel(twitchChannelId) → Map<name, { src, provider }>   (empty on any failure; never throws)
 *   splitEmotes(parts, map) → parts   text parts split into text and emote parts wherever a word is a known emote name
 *
 * APIs (read 2026-11-20): 7tv.io/v3/users/twitch/<id> (emote_set.emotes[]: id, name) and /v3/emote-sets/global;
 * api.betterttv.net/3/cached/users/twitch/<id> (channelEmotes[], sharedEmotes[]: id, code) and /3/cached/emotes/global;
 * api.frankerfacez.com/v1/room/id/<id> (sets{}.emoticons[]: id, name) and /v1/set/global (default_sets).
 */
export const EMOTE_LIMITS = Object.freeze({ ttlMs: 30 * 60_000, errorTtlMs: 5 * 60_000, timeoutMs: 6000, perProvider: 2000, bodyBytes: 4 * 1024 * 1024 });

const ID = { '7tv': /^[A-Za-z0-9]{1,40}$/, bttv: /^[a-f0-9]{24}$/, ffz: /^\d{1,12}$/ };
const NAME = /^\S{1,60}$/;

export function createThirdPartyEmotes({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), limits = {}, logger = null } = {}) {
    const L = { ...EMOTE_LIMITS, ...limits };
    const cache = new Map();   // key -> { at, ttl, map, pending }

    async function getJson(url) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), L.timeoutMs);
        try {
            const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'CertiFried overlay emotes' } });
            if (!res.ok) return null;
            const text = await res.text();
            if (text.length > L.bodyBytes) return null;
            return JSON.parse(text);
        } catch (err) {
            logger?.debug?.(`[StreamBotOverlay] emote list failed: ${err?.message}`);
            return null;
        } finally { clearTimeout(timer); }
    }
    const add = (map, provider, id, name) => {
        id = String(id ?? ''); name = String(name ?? '');
        if (!ID[provider].test(id) || !NAME.test(name) || map.has(name)) return;
        map.set(name, { src: `img/${provider}-emote/${id}`, provider });
    };
    const seventv = (map, list) => { for (const e of (Array.isArray(list) ? list : []).slice(0, L.perProvider)) add(map, '7tv', e?.id, e?.name); };
    const bttv = (map, list) => { for (const e of (Array.isArray(list) ? list : []).slice(0, L.perProvider)) add(map, 'bttv', e?.id, e?.code); };
    const ffz = (map, sets, only = null) => {
        for (const [k, s] of Object.entries(sets && typeof sets === 'object' ? sets : {})) {
            if (only && !only.includes(Number(k))) continue;
            for (const e of (Array.isArray(s?.emoticons) ? s.emoticons : []).slice(0, L.perProvider)) add(map, 'ffz', e?.id, e?.name);
        }
    };

    async function build(id) {
        const map = new Map();
        const [stv, stvG, bt, btG, fz, fzG] = await Promise.all([
            id ? getJson(`https://7tv.io/v3/users/twitch/${id}`) : null, getJson('https://7tv.io/v3/emote-sets/global'),
            id ? getJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`) : null, getJson('https://api.betterttv.net/3/cached/emotes/global'),
            id ? getJson(`https://api.frankerfacez.com/v1/room/id/${id}`) : null, getJson('https://api.frankerfacez.com/v1/set/global'),
        ]);
        // The channel's own emotes first, so a channel emote wins over a global one with the same name.
        seventv(map, stv?.emote_set?.emotes);
        bttv(map, bt?.channelEmotes); bttv(map, bt?.sharedEmotes);
        ffz(map, fz?.sets);
        seventv(map, stvG?.emotes);
        bttv(map, btG);
        ffz(map, fzG?.sets, Array.isArray(fzG?.default_sets) ? fzG.default_sets.map(Number) : []);
        return map;
    }

    async function forChannel(twitchChannelId) {
        const id = /^\d{1,20}$/.test(String(twitchChannelId ?? '')) ? String(twitchChannelId) : '';
        const key = id || 'global';
        const hit = cache.get(key);
        if (hit?.map && now() - hit.at < hit.ttl) return hit.map;
        if (hit?.pending) return hit.pending;
        const pending = build(id).then((map) => {
            cache.set(key, { at: now(), ttl: map.size ? L.ttlMs : L.errorTtlMs, map, pending: null });
            return map;
        }).catch(() => { const map = new Map(); cache.set(key, { at: now(), ttl: L.errorTtlMs, map, pending: null }); return map; });
        cache.set(key, { ...(hit || {}), pending });
        if (cache.size > 500) for (const k of cache.keys()) { if (k !== key) { cache.delete(k); break; } }
        return pending;
    }
    return { forChannel, _cache: cache };
}

/** Text parts split around words that are third-party emote names; other parts are kept as they are. */
export function splitEmotes(parts, map) {
    if (!map || !map.size || !Array.isArray(parts)) return parts;
    const out = [];
    for (const p of parts) {
        if (p?.t !== 'text' || !p.v) { out.push(p); continue; }
        let buf = '';
        for (const piece of String(p.v).split(/(\s+)/)) {
            const e = piece && !/^\s+$/.test(piece) ? map.get(piece) : null;
            if (e) {
                if (buf) out.push({ t: 'text', v: buf });
                buf = '';
                out.push({ t: 'emote', src: e.src, alt: piece });
            } else buf += piece;
        }
        if (buf) out.push({ t: 'text', v: buf });
        if (out.length > 300) break;
    }
    return out;
}

export default { createThirdPartyEmotes, splitEmotes, EMOTE_LIMITS };
