/*
 * Stream bot music: finding songs and their audio through the pipeline the Discord music bot already uses.
 * Nothing here talks to YouTube, Spotify or a resolver itself:
 *
 *   core/spotify-resolver.js   Spotify links (track / album / playlist / artist) and catalogue search for plain text:
 *                              title, artist, length and the explicit flag, through CertiFried's own Spotify app
 *                              (client credentials, its token cache). Never a per-streamer Spotify app.
 *   core/ytdlp-extractor.js    metadata for YouTube / YouTube Music / SoundCloud / other links and YouTube search
 *                              (_fetchInfoLines: the residential resolvers' /info first, server1's yt-dlp last), and
 *                              the audio: stream() (prefetch cache, resolver relay, direct, search fallback, SoundCloud)
 *                              and bridge() (a Spotify track matched on YouTube Music by title, artist, length, explicit)
 *   prefetchStream()           the next YouTube song's audio is resolved while the current one plays
 *
 *   createResolver({ pipeline?, logger?, now? })
 *     .lookup(parsed, { max })  parseRequestInput() result → { ok: true, items[], playlist } | { ok: false, error }
 *     .audioFor(item)           → { url, playback, matchedVia, matchedTitle }  (throws when nothing plays)
 *     .prefetch(item)           start resolving a song's audio in the background
 *
 * An item: { source, title, artist, url, trackKey, durationMs, explicit (true/false/null), thumbnail, bridge? }
 * where `bridge` ({ query, track: { title, artist, explicit } }) marks a Spotify song that plays from YouTube Music.
 *
 * `pipeline` is injected by tests; the default loads the real modules on first use.
 * Tested in tests/stream-bot-music.test.js (fake pipeline).
 */
import { trackKeyOf } from './text.js';

const SPOTIFY_ID = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/;
const HLS = /\.m3u8(\?|$)/i;
const BRIDGE_CACHE_MS = 30 * 60 * 1000;

/** The real modules, loaded once. */
async function loadPipeline() {
    const [ext, sp, log] = await Promise.all([
        import('../../ytdlp-extractor.js'), import('../../spotify-resolver.js'), import('../../music-play-log.js'),
    ]);
    // A plain instance: the methods used here never build discord-player Tracks, so no player is needed.
    const extractor = new ext.YtDlpExtractor({ player: null }, {});
    return {
        extractor,
        resolveSpotify: sp.resolveSpotify, searchSpotifyTrack: sp.searchSpotifyTrack, buildBridgeQuery: sp.buildBridgeQuery,
        prefetchStream: ext.prefetchStream, prefetchExpiry: ext.prefetchExpiry, pickFor: ext.pickFor, pathOfUrl: log.pathOfUrl,
    };
}

const cleanArtist = (s) => String(s || '').replace(/\s+-\s+Topic$/i, '').trim();

/** One yt-dlp JSON entry → an item, or null. */
export function itemFromEntry(info, platform = null) {
    if (!info || typeof info !== 'object' || info._type === 'playlist') return null;
    let url = info.webpage_url || (typeof info.url === 'string' && /^https?:\/\//.test(info.url) ? info.url : null);
    if (!url && /^[\w-]{11}$/.test(String(info.id || ''))) url = `https://www.youtube.com/watch?v=${info.id}`;
    if (!url) return null;
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const source = /youtube\.com$|youtu\.be$/.test(host) ? 'youtube' : /soundcloud\.com$/.test(host) ? 'soundcloud' : (platform || 'other');
    const title = info.track || info.title || 'Unknown';
    const artist = cleanArtist(info.artist || info.creator || info.uploader || info.channel || '');
    const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
    return {
        source, title: String(title).slice(0, 300), artist: artist.slice(0, 300), url,
        trackKey: trackKeyOf(url),
        durationMs: Number(info.duration) > 0 ? Math.round(Number(info.duration) * 1000) : null,
        explicit: null,
        thumbnail: info.thumbnail || thumbs[thumbs.length - 1]?.url || null,
    };
}

/** A core/spotify-resolver.js track → an item that plays through the YouTube Music bridge. */
export function itemFromSpotify(t, buildBridgeQuery, source = 'spotify') {
    if (!t?.title) return null;
    const id = (String(t.url || '').match(SPOTIFY_ID) || [])[1];
    const url = id ? `https://open.spotify.com/track/${id}` : t.url || null;
    const explicit = typeof t.explicit === 'boolean' ? t.explicit : null;
    return {
        source, title: String(t.title).slice(0, 300), artist: String(t.artist || '').slice(0, 300), url,
        trackKey: url ? trackKeyOf(url) : `u:${t.title}`.slice(0, 191),
        durationMs: Number(t.durationMs) > 0 ? Number(t.durationMs) : null, explicit, thumbnail: t.thumbnail || null,
        bridge: { query: buildBridgeQuery({ title: t.title, artist: t.artist, explicit: !!explicit }), track: { title: t.title, artist: t.artist || '', ...(explicit == null ? {} : { explicit }) } },
    };
}

export function createResolver({ pipeline = null, logger = null, now = () => Date.now() } = {}) {
    let loading = null;
    const get = () => (pipeline ? Promise.resolve(pipeline) : (loading ||= loadPipeline().catch((e) => { loading = null; throw e; })));
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamMusic] ${msg}`, meta); } catch { /* ignore */ } };
    const bridged = new Map();   // trackKey -> { at, promise } : a Spotify song's audio resolved ahead of time

    async function entries(p, original, target, playlist) {
        const text = await p.extractor._fetchInfoLines(original, target, playlist);
        if (!text) return [];
        const out = [];
        for (const line of String(text).split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { /* skip a bad line */ }
        }
        return out;
    }

    async function lookup(parsed, { max = 1 } = {}) {
        const p = await get();
        const cap = Math.max(1, Math.min(200, Number(max) || 1));
        try {
            if (parsed.kind === 'spotify') {
                const r = await p.resolveSpotify(parsed.url);
                const items = (r?.tracks || []).map((t) => itemFromSpotify(t, p.buildBridgeQuery)).filter(Boolean);
                if (!items.length) return { ok: false, error: 'link_failed' };
                return { ok: true, items: items.slice(0, cap), playlist: parsed.type === 'track' ? null : (r.name || null), total: items.length };
            }
            if (parsed.kind === 'url') {
                const list = (await entries(p, parsed.url, parsed.url, !!parsed.playlist)).map((e) => itemFromEntry(e, parsed.platform)).filter(Boolean);
                if (!list.length) return { ok: false, error: 'link_failed' };
                return { ok: true, items: list.slice(0, cap), playlist: parsed.playlist ? 'that playlist' : null, total: list.length };
            }
            if (parsed.kind === 'search') {
                // Spotify's catalogue first (only a confident match: searchSpotifyTrack checks the words), then YouTube.
                const hit = await p.searchSpotifyTrack(parsed.query).catch(() => null);
                if (hit) return { ok: true, items: [itemFromSpotify(hit, p.buildBridgeQuery, 'search')], playlist: null, total: 1 };
                const first = (await entries(p, parsed.query, `ytsearch1:${parsed.query}`, false)).map((e) => itemFromEntry(e)).find(Boolean);
                if (!first) return { ok: false, error: 'not_found' };
                return { ok: true, items: [{ ...first, source: 'search' }], playlist: null, total: 1 };
            }
        } catch (err) {
            log('warn', 'lookup failed', { kind: parsed.kind, error: err?.message });
            return { ok: false, error: 'music_error' };
        }
        return { ok: false, error: 'not_found' };
    }

    async function bridgeAudio(p, item) {
        const t = { title: item.bridge.track.title, author: item.bridge.track.artist, url: item.url, durationMS: item.durationMs || 0,
            metadata: { bridgeQuery: item.bridge.query, ...(item.bridge.track.explicit == null ? {} : { explicit: item.bridge.track.explicit }) } };
        const url = await p.extractor.bridge(t, { identifier: 'com.certifried.stream-bot' });
        if (!url) throw Object.assign(new Error('no YouTube Music match'), { code: 'no_match' });
        const pick = p.pickFor(item.bridge.query);
        return { url, matchedVia: pick?.source || null, matchedTitle: pick ? `${pick.title}${pick.channel ? ` — ${pick.channel}` : ''}` : null };
    }

    /** A Spotify song stored without its bridge (a queued request, a playlist entry): build it the way the bot does. */
    const withBridge = (p, item) => (item.bridge || !String(item.trackKey || '').startsWith('sp:') ? item
        : { ...item, bridge: { query: p.buildBridgeQuery({ title: item.title, artist: item.artist, explicit: !!item.explicit }),
            track: { title: item.title, artist: item.artist || '', ...(item.explicit == null ? {} : { explicit: !!item.explicit }) } } });

    async function audioFor(rawItem) {
        const p = await get();
        const item = withBridge(p, rawItem);
        let out;
        if (item.bridge) {
            const cached = bridged.get(item.trackKey);
            bridged.delete(item.trackKey);
            if (cached && now() - cached.at < BRIDGE_CACHE_MS) out = await cached.promise.catch(() => null);
            if (out && p.prefetchExpiry && p.prefetchExpiry(out.url, now()) <= now()) out = null;
            if (!out) out = await bridgeAudio(p, item);
        } else {
            const info = { title: item.title, author: item.artist, url: item.url, durationMS: item.durationMs || 0, raw: { title: item.title, author: item.artist }, metadata: {} };
            let url = await p.extractor.stream(info);
            // SoundCloud's own audio is HLS for some tracks, which a browser <audio> cannot play: use the YouTube match then.
            if (typeof url === 'string' && HLS.test(url)) {
                const q = `${item.artist} ${item.title}`.trim();
                url = await p.extractor.getAudioUrlFromSearch(q, item.durationMs ? Math.round(item.durationMs / 1000) : null, { title: item.title, artist: item.artist });
                const pick = p.pickFor(q);
                out = { url, matchedVia: pick?.source || 'soundcloud-hls', matchedTitle: pick ? `${pick.title}${pick.channel ? ` — ${pick.channel}` : ''}` : null };
            } else out = { url, matchedVia: null, matchedTitle: null };
        }
        if (typeof out?.url !== 'string' || !/^https?:\/\//.test(out.url) || HLS.test(out.url)) throw Object.assign(new Error('no playable audio'), { code: 'no_audio' });
        return { ...out, playback: p.pathOfUrl ? p.pathOfUrl(out.url) : null };
    }

    async function prefetch(rawItem) {
        if (!rawItem) return;
        try {
            const p = await get();
            const item = withBridge(p, rawItem);
            if (item.bridge) {
                if (bridged.has(item.trackKey)) return;
                if (bridged.size > 50) bridged.delete(bridged.keys().next().value);
                const promise = bridgeAudio(p, item);
                promise.catch(() => bridged.delete(item.trackKey));
                bridged.set(item.trackKey, { at: now(), promise });
            } else if (item.source === 'youtube' || item.trackKey?.startsWith('yt:')) {
                p.prefetchStream({ url: item.url, title: item.title }).catch?.(() => {});
            }
        } catch (err) { log('debug', 'prefetch failed', { error: err?.message }); }
    }

    return { lookup, audioFor, prefetch, _bridged: bridged };
}

export default { createResolver, itemFromEntry, itemFromSpotify };
