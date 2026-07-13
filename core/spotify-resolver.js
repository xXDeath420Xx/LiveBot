// Own Spotify resolution so playlists/albums come back COMPLETE and EXPLICIT-aware.
//
// Why this exists: @discord-player/extractor's SpotifyExtractor (a) caps playlists at
// 100 tracks, (b) drops the `explicit` flag entirely, and (c) bridges with an
// "official audio" query that surfaces CLEAN/radio-edit YouTube uploads. So explicit
// songs (e.g. Eminem) played as censored versions and long playlists were truncated.
//
// This fetches the full track list (paginated) via the Spotify Web API including each
// track's `explicit` flag, and builds an explicit-aware YouTube bridge query. The bot's
// play handler tags/extends the search result with this data; the YtDlp bridge honours
// `track.metadata.bridgeQuery`.

import axios from 'axios';
import { Track, Playlist } from 'discord-player';
import logger from '../utils/logger.js';

function msToTimecode(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const SP_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SP_API = 'https://api.spotify.com/v1';

let _token = null;
let _tokenExp = 0;

async function getToken() {
    if (_token && Date.now() < _tokenExp - 30000) return _token;
    const id = process.env.SPOTIFY_CLIENT_ID;
    const secret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!id || !secret) throw new Error('SPOTIFY_CLIENT_ID/SECRET not set');
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const { data } = await axios.post(SP_TOKEN_URL, 'grant_type=client_credentials', {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
    });
    _token = data.access_token;
    _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
    return _token;
}

async function spGet(path) {
    const token = await getToken();
    const { data } = await axios.get(`${SP_API}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
    });
    return data;
}

export function parseSpotifyUrl(url) {
    const m = String(url || '').match(/spotify\.com\/(track|playlist|album|artist)\/([A-Za-z0-9]+)/);
    return m ? { type: m[1], id: m[2] } : null;
}

// Explicit-aware YouTube bridge query. Uses the PRIMARY artist (the "<Artist> - Topic"
// channel + duration match nails the exact official cut); appends "explicit" for explicit
// tracks so YouTube serves the uncensored version instead of a radio edit.
export function buildBridgeQuery({ title, artist, explicit }) {
    const primary = String(artist || '').split(',')[0].trim();
    const base = `${title} ${primary}`.replace(/\s+/g, ' ').trim();
    return explicit ? `${base} explicit` : base;
}

function mapTrack(t) {
    if (!t) return null;
    return {
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        durationMs: t.duration_ms || 0,
        explicit: !!t.explicit,
        url: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : null),
        thumbnail: t.album?.images?.[0]?.url || null,
    };
}

/** Words that carry no matching signal, so they should not count for or against a match. */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'feat', 'ft', 'official', 'video',
    'audio', 'lyrics', 'hd', 'remix', 'live', 'music']);

const tokens = (s) => String(s || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(t => t && !STOPWORDS.has(t));

/**
 * How much of the query is actually present in a candidate's "artist title"?
 * Spotify's search NEVER returns empty — ask it for "lofi hip hop radio 24/7" and it will
 * cheerfully hand back some unrelated song. Without this guard, Spotify-first would hijack
 * every query that was really meant for YouTube.
 */
export function matchScore(query, candidate) {
    const q = tokens(query);
    if (!q.length) return 0;
    const hay = new Set(tokens(`${candidate.title} ${candidate.artist}`));
    return q.filter(t => hay.has(t)).length / q.length;
}

/** Below this share of query words matched, we do not trust the Spotify hit. */
const MIN_MATCH = 0.6;

/**
 * Find the best Spotify track for a free-text query, so a plain `?play <song>` starts life as a
 * Spotify track rather than a YouTube one. Returns `mapTrack()` shape, or null when Spotify has
 * no confident match, credentials are absent, or the API is unreachable — every one of which
 * must fall through silently to the yt-dlp path rather than fail the command.
 */
export async function searchSpotifyTrack(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return null;

    try {
        const data = await spGet(`/search?q=${encodeURIComponent(q)}&type=track&limit=5`);
        const candidates = (data?.tracks?.items || []).map(mapTrack).filter(Boolean);
        if (!candidates.length) return null;

        let best = null, bestScore = 0;
        for (const c of candidates) {
            const score = matchScore(q, c);
            if (score > bestScore) { best = c; bestScore = score; }
        }
        if (!best || bestScore < MIN_MATCH) {
            logger.info(`[Spotify] no confident match for "${q}" (best ${bestScore.toFixed(2)}) — using yt-dlp`);
            return null;
        }
        return best;
    } catch (err) {
        logger.warn(`[Spotify] text search failed for "${q}": ${err.message}`);
        return null;
    }
}

async function pageThrough(firstPath) {
    const items = [];
    let data = await spGet(firstPath);
    const collect = (d) => {
        const arr = d.items || d.tracks?.items || [];
        for (const it of arr) items.push(it.track ? it.track : it); // playlist items wrap in .track
    };
    collect(data);
    let next = data.next || data.tracks?.next;
    while (typeof next === 'string') {
        const token = await getToken();
        const r = await axios.get(next, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
        collect(r.data);
        next = r.data.next;
    }
    return items;
}

// Returns { name, type, tracks: [{title, artist, durationMs, explicit, url, thumbnail}] }
// or null. Fully paginated; never truncated at 100.
export async function resolveSpotify(url) {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return null;
    const { type, id } = parsed;
    try {
        if (type === 'track') {
            const t = await spGet(`/tracks/${id}`);
            const mapped = mapTrack(t);
            return mapped ? { name: t.name, type, tracks: [mapped] } : null;
        }
        if (type === 'playlist') {
            const meta = await spGet(`/playlists/${id}?fields=name`);
            const raw = await pageThrough(
                `/playlists/${id}/tracks?limit=100&fields=items(track(name,duration_ms,explicit,artists(name),external_urls,album(images))),next`
            );
            const tracks = raw.map(mapTrack).filter(Boolean);
            return tracks.length ? { name: meta.name, type, tracks } : null;
        }
        if (type === 'album') {
            const album = await spGet(`/albums/${id}`);
            // album track objects lack album.images; backfill the album cover.
            const raw = await pageThrough(`/albums/${id}/tracks?limit=50`);
            const cover = album.images?.[0]?.url || null;
            const tracks = raw.map(t => {
                const m = mapTrack(t);
                if (m && !m.thumbnail) m.thumbnail = cover;
                return m;
            }).filter(Boolean);
            return tracks.length ? { name: album.name, type, tracks } : null;
        }
        if (type === 'artist') {
            const top = await spGet(`/artists/${id}/top-tracks?market=US`);
            const tracks = (top.tracks || []).map(mapTrack).filter(Boolean);
            const artist = await spGet(`/artists/${id}`);
            return tracks.length ? { name: `${artist.name} — Top Tracks`, type, tracks } : null;
        }
    } catch (err) {
        logger.error(`[SpotifyResolver] ${type}/${id} failed: ${err.response?.data?.error?.message || err.message}`);
        return null;
    }
    return null;
}

// Build playable discord-player Tracks for a Spotify URL using ONLY our Spotify Web API
// credentials — no dependency on the bundled SpotifyExtractor. This is the "play from
// Spotify links/playlists directly" path: if player.search() comes back empty (extractor
// token hiccup, identifier drift, etc.) we still get the full, explicit-aware list and
// bridge the audio. Returns { tracks, playlist } or null. The bridge (YtDlp → SoundCloud
// fallback) plays each track's `metadata.bridgeQuery`.
export async function buildSpotifyEntity(player, url, requestedBy) {
    const resolved = await resolveSpotify(url);
    if (!resolved || !resolved.tracks.length) return null;

    const tracks = resolved.tracks.map(item => {
        const t = new Track(player, {
            title: item.title,
            author: item.artist,
            duration: msToTimecode(item.durationMs),
            url: item.url || 'https://open.spotify.com/',
            thumbnail: item.thumbnail || undefined,
            source: 'spotify',
            requestedBy,
            metadata: { bridgeQuery: buildBridgeQuery(item), explicit: item.explicit },
        });
        return t;
    });

    if (resolved.type === 'track') {
        return { tracks, playlist: null };
    }

    const playlist = new Playlist(player, {
        title: resolved.name || 'Spotify',
        thumbnail: tracks[0]?.thumbnail,
        description: `${tracks.length} tracks`,
        type: 'playlist',
        source: 'spotify',
        author: { name: 'Spotify', url },
        tracks,
        id: url,
        url,
        rawPlaylist: null,
    });
    tracks.forEach(t => { t.playlist = playlist; });
    return { tracks, playlist };
}

// Take a discord-player searchResult from player.search(spotifyUrl) — which the
// SpotifyExtractor caps at 100 tracks and strips `explicit` from — and:
//   1. tag EXPLICIT tracks with an explicit-aware bridge query (so YouTube serves the
//      uncensored version instead of a radio edit), and
//   2. append the tracks the extractor truncated (101..N) so the FULL list plays.
// Clean tracks keep the extractor's default bridge behaviour. Mutates searchResult.
export async function enrichSpotifySearchResult(player, searchResult, url, requestedBy) {
    const resolved = await resolveSpotify(url);
    if (!resolved || !resolved.tracks.length) {
        return { added: 0, total: searchResult.tracks.length, explicit: 0, ok: false };
    }
    const full = resolved.tracks;
    const existing = searchResult.tracks;
    const spotifyExt = existing[0]?.extractor
        || player.extractors?.get?.('com.discord-player.spotifyextractor')
        || null;

    let explicitCount = full.filter(t => t.explicit).length;

    // 1) Give EVERY present track an exact-match bridge query (primary artist + duration
    // match → the official cut; explicit songs get the uncensored version). Track.metadata
    // is getter-only in discord-player v7 — must use setMetadata().
    for (let i = 0; i < existing.length; i++) {
        const item = full[i];
        if (item) {
            existing[i].setMetadata({ ...(existing[i].metadata || {}), bridgeQuery: buildBridgeQuery(item), explicit: item.explicit });
        }
    }

    // 2) append the remainder the extractor dropped
    let added = 0;
    for (let i = existing.length; i < full.length; i++) {
        const item = full[i];
        const t = new Track(player, {
            title: item.title,
            author: item.artist,
            duration: msToTimecode(item.durationMs),
            url: item.url || `https://open.spotify.com/track/unknown`,
            thumbnail: item.thumbnail || undefined,
            source: 'spotify',
            requestedBy,
            metadata: { bridgeQuery: buildBridgeQuery(item), explicit: item.explicit },
        });
        if (spotifyExt) t.extractor = spotifyExt;
        searchResult.tracks.push(t);
        // In discord-player, searchResult.tracks is often the SAME array as
        // searchResult.playlist.tracks — only push to both when they differ.
        if (searchResult.playlist?.tracks && searchResult.playlist.tracks !== searchResult.tracks) {
            searchResult.playlist.tracks.push(t);
        }
        added++;
    }

    return { added, total: searchResult.tracks.length, explicit: explicitCount, ok: true };
}
