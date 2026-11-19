/*
 * Stream bot: title, category, viewers and uptime of a linked channel, for {stream.*} in templates and for the
 * timers' "only while live". Cached for at most 60 seconds per channel (a failed read for 15 seconds), and
 * concurrent readers of one channel share one request.
 *
 *   createStreamInfo({ fetchers: { twitch(ctx), kick(ctx) }, now?, ttlMs?, errorTtlMs? })
 *     .get({ profileId, platform, channelId })  → { live, title, category, viewers, startedAt } | null
 *     .forget(platform, channelId)              drop a cached entry (after a title or category change)
 *   formatUptime(startedAt, now)               → '2h 05m' | '14m' | 'offline'
 *   streamValues(info, now)                    → { 'stream.title', 'stream.category', 'stream.uptime', 'stream.viewers', 'stream.live' }
 */

export const STREAM_INFO_TTL_MS = 60_000;

export function formatUptime(startedAt, now = Date.now()) {
    const t = startedAt ? new Date(startedAt).getTime() : NaN;
    if (!Number.isFinite(t)) return 'offline';
    const mins = Math.max(0, Math.floor((now - t) / 60_000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function streamValues(info, now = Date.now()) {
    if (!info) return { 'stream.title': '', 'stream.category': '', 'stream.uptime': '', 'stream.viewers': '', 'stream.live': '' };
    return {
        'stream.title': info.title || '',
        'stream.category': info.category || '',
        'stream.uptime': info.live ? formatUptime(info.startedAt, now) : 'offline',
        'stream.viewers': String(info.live ? Number(info.viewers) || 0 : 0),
        'stream.live': info.live ? 'yes' : 'no',
    };
}

export function createStreamInfo({ fetchers = {}, now = () => Date.now(), ttlMs = STREAM_INFO_TTL_MS, errorTtlMs = 15_000 } = {}) {
    const cache = new Map();     // 'platform:channelId' -> { at, ttl, value }
    const inflight = new Map();

    async function get({ profileId, platform, channelId }) {
        if (!platform || channelId == null || !fetchers[platform]) return null;
        const key = `${platform}:${channelId}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < hit.ttl) return hit.value;
        if (!inflight.has(key)) {
            inflight.set(key, (async () => {
                try {
                    const value = await fetchers[platform]({ profileId, channelId: String(channelId) });
                    cache.set(key, { at: now(), ttl: ttlMs, value: value || null });
                    return value || null;
                } catch {
                    cache.set(key, { at: now(), ttl: errorTtlMs, value: null });
                    return null;
                } finally {
                    inflight.delete(key);
                    if (cache.size > 5000) cache.clear();
                }
            })());
        }
        return inflight.get(key);
    }

    return { get, forget(platform, channelId) { cache.delete(`${platform}:${channelId}`); }, _cache: cache };
}

/** The channel {stream.*} describes for an event: the event's own Twitch/Kick channel, else the first linked Twitch, else Kick. */
export function pickInfoChannel(ev, channels = []) {
    if ((ev?.platform === 'twitch' || ev?.platform === 'kick') && ev.channelId != null) return { platform: ev.platform, channelId: String(ev.channelId) };
    const c = channels.find((x) => x.platform === 'twitch') || channels.find((x) => x.platform === 'kick');
    return c ? { platform: c.platform, channelId: String(c.platform_user_id) } : null;
}

/**
 * Twitch stream info with the app token (GET /helix/streams and /helix/channels need no user scope), so it works for
 * any linked Twitch channel, with or without the Stream bot grant.
 */
export async function twitchAppStreamInfo(channelId, { fetchImpl = (...a) => fetch(...a), appToken = null, clientId = process.env.TWITCH_CLIENT_ID } = {}) {
    const token = appToken ? await appToken() : await (await import('../../utils/platforms/twitch.js')).getAccessToken();
    if (!token) return null;
    const get = async (path) => {
        const res = await fetchImpl(`https://api.twitch.tv/helix${path}`, { headers: { 'Client-Id': clientId || '', Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Twitch answered HTTP ${res.status}`);
        return res.json();
    };
    const id = encodeURIComponent(String(channelId));
    const s = await get(`/streams?user_id=${id}&first=1`);
    const live = s?.data?.[0];
    if (live) return { live: true, title: live.title || '', category: live.game_name || '', viewers: Number(live.viewer_count) || 0, startedAt: live.started_at || null };
    const c = await get(`/channels?broadcaster_id=${id}`);
    const ch = c?.data?.[0] || {};
    return { live: false, title: ch.title || '', category: ch.game_name || '', viewers: 0, startedAt: null };
}

export default { createStreamInfo, formatUptime, streamValues, pickInfoChannel, twitchAppStreamInfo, STREAM_INFO_TTL_MS };
