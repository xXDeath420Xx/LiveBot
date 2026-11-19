import { BaseExtractor, Track, Playlist } from 'discord-player';
import { existsSync, copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import ytdlpPool from '../utils/processPool.js';
import { notifyCookieRotation } from '../utils/cookie-health-monitor.js';
import { resolverGroups, resolverSecret } from '../utils/music-resolver-config.js';
import { tunnelProbeOk, playbackProbeOk } from './music-health-monitor.js';
import { noteRequestKind, notePlayback, pathOfUrl } from './music-play-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = join(__dirname, '..', 'cookies.txt');
// Any audio EXCEPT SoundCloud's 30-second Go+ preview formats (format_id "..._preview").
// Non-SoundCloud sources never use that id, so this is a plain bestaudio for them.
const SOUNDCLOUD_FULL_AUDIO = 'bestaudio[format_id!*=preview]/best[format_id!*=preview]';

// ── Residential resolver (server2 via SSH reverse tunnel) ────────────────────
//
// server2 (Comcast residential, always on) runs a tiny HTTP service that invokes a
// local yt-dlp with the bgutil PO-token plugin, --js-runtimes node, --remote-components
// ejs:github and the FRESHLY SYNCED Firefox cookie jar. It returns a signed googlevideo
// URL — exactly what -g on this host would print, except it's actually obtainable from
// a Comcast IP that YouTube doesn't rate-limit. server1 then fetches audio bytes from
// that URL directly (ipbypass=yes on the CDN redirect lets OVH consume the stream).
//
// This runs BEFORE the local yt-dlp attempt in getAudioUrlDirect / getAudioUrlFromSearch.
// Any failure (timeout, non-2xx, env not set, tunnel down) falls through to the
// existing path, so the local pool is strictly the backup — nothing degraded.
//
// Env (read lazily inside tryLocalResolver — this module is imported before
// index.js's dotenv.config() runs, so reading at module-top gives empty strings):
//   MUSIC_RESOLVER_URL     = http://127.0.0.1:49999   (via the reverse tunnel)
//   MUSIC_RESOLVER_SECRET  = <bearer token>           (same secret.txt as server2)
//   MUSIC_RESOLVER_TIMEOUT = 25000                    (ms; optional)

/**
 * POST to the residential resolver. Returns the parsed JSON body when it says ok, null otherwise.
 * NEVER throws — a failure here must NOT prevent the caller from falling through to the local
 * yt-dlp pool, which is still a working path for most tracks.
 */
// ── Circuit breaker + counters ───────────────────────────────────────────────
// A dead tunnel fails in ~1ms, but a hung one (or a wedged yt-dlp on server2) costs the full timeout
// on EVERY play. After BREAKER_THRESHOLD consecutive slow failures on a tunnel, skip it for
// BREAKER_COOLDOWN_MS; the first call after the cooldown is the probe that closes or re-opens it.
// Fast per-video answers (502 unavailable / age-gate / no match) say nothing about the tunnel and
// neither trip nor reset it.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 2 * 60 * 1000;
const breakers = new Map(); // base -> { failures, openUntil }
const resolverCounters = { since: new Date().toISOString(), calls: 0, hits: 0, negative: 0, slowFailures: 0,
    unreachable: 0, skippedOpen: 0, noTunnel: 0, localOk: 0, localFail: 0, byResolver: {} };

function breakerOpen(base) { return (breakers.get(base)?.openUntil || 0) > Date.now(); }
function breakerRecord(base, healthy) {
    const b = breakers.get(base) || { failures: 0, openUntil: 0 };
    if (healthy) { b.failures = 0; b.openUntil = 0; }
    else if (++b.failures >= BREAKER_THRESHOLD) {
        b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        logger.warn(`[LocalResolver] circuit OPEN for ${base} after ${b.failures} slow failures; skipping it for ${BREAKER_COOLDOWN_MS / 1000}s`);
    }
    breakers.set(base, b);
}

/** Snapshot for the music health monitor. */
export function getResolverStats() {
    return {
        ...resolverCounters,
        breakers: [...breakers].map(([base, b]) => ({ base, failures: b.failures, open: b.openUntil > Date.now() })),
    };
}

// Failures tied to ONE resolver's environment (its IP, cookie jar, yt-dlp install, load) — another
// resolver on a different network may well succeed. Anything else (video removed / private /
// age-gated / no search match) is the same everywhere, so it ends the attempt.
const RETRY_ELSEWHERE = new Set(['bot_wall', 'cookies_invalid', 'cookie_jar_unreadable', 'js_challenge', 'ytdlp_error',
    'ytdlp_timeout', 'no_format', 'no_playable_candidate', 'no_entries', 'exception', 'bad_auth']);
// When another resolver is still to come, leave it this much of the budget.
const NEXT_RESOLVER_RESERVE_MS = 9000;

/**
 * Walk the resolvers in priority order (server2, then the workstation), and the tunnels within each.
 * A tunnel that is down moves to the resolver's next tunnel; a resolver-specific failure moves to the
 * next RESOLVER; a per-video failure stops. Returns the parsed body on success, else null (the caller
 * then falls back to server1's own yt-dlp).
 */
export async function callResolver(path, payload, label, timeoutMs) {
    // A resolver whose audio the health monitor just failed to play here goes last (stable sort keeps
    // the configured priority otherwise): resolving fine is worthless if the result won't stream.
    const groups = resolverGroups().map(g => ({ ...g, secret: resolverSecret(g.name) })).filter(g => g.secret)
        .sort((a, b) => Number(playbackProbeOk(a.name) === false) - Number(playbackProbeOk(b.name) === false));
    const timeout = timeoutMs || Math.max(5000, Number(process.env.MUSIC_RESOLVER_TIMEOUT) || 25000);
    if (!groups.length) return null;
    resolverCounters.calls++;

    const started = Date.now();
    const deadline = started + timeout;
    for (let gi = 0; gi < groups.length; gi++) {
        const { name, bases, secret } = groups[gi];
        const by = resolverCounters.byResolver[name] ||= { hits: 0, failovers: 0 };
        const moreAfter = gi < groups.length - 1;
        // Route around tunnels the health monitor just saw fail (a HUNG tunnel would otherwise cost a
        // full timeout per play) — but never skip all of a resolver's tunnels on probe data alone.
        const closed = bases.filter(b => { const open = breakerOpen(b); if (open) resolverCounters.skippedOpen++; return !open; });
        const probedOk = closed.filter(b => tunnelProbeOk(b) !== false);
        const order = probedOk.length ? probedOk : closed;
        let moveOn = false;

        for (const base of order) {
            const left = deadline - Date.now();
            const minBudget = Number(process.env.MUSIC_RESOLVER_ATTEMPT_MIN_MS) || 8000;
            const budget = moreAfter ? Math.max(minBudget, left - NEXT_RESOLVER_RESERVE_MS) : left;
            if (left < Math.min(3000, minBudget)) break; // too little time left for a useful attempt
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.min(budget, left));
            try {
                const resp = await fetch(`${base}${path}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
                    body: JSON.stringify({ ...payload, timeoutMs: Math.min(budget, left) - 2000 }),
                    signal: controller.signal,
                });
                const data = await resp.json().catch(() => null);
                if (resp.ok && data?.ok) {
                    breakerRecord(base, true);
                    resolverCounters.hits++; by.hits++;
                    logger.info(`[LocalResolver] ${path} hit via ${name} ${base}${gi > 0 ? ' (failover)' : ''}`
                        + `${data.mode === 'cookieless' ? ' (cookieless rescue)' : ''} (${Date.now() - started}ms) for ${label}`);
                    return { ...data, via: base };   // the tunnel that answered also carries its audio relay
                }
                // 500/503/504 = the resolver is struggling; 4xx/502 = a fast, per-request answer.
                if ([500, 503, 504].includes(resp.status)) { breakerRecord(base, false); resolverCounters.slowFailures++; }
                else resolverCounters.negative++;
                const reason = resp.status === 401 ? 'bad_auth' : (data?.reason || `http_${resp.status}`);
                if (resp.status === 401) logger.error(`[LocalResolver] ${name} rejected our secret (401) — check MUSIC_RESOLVER_SECRET_FILE_${name.toUpperCase()}`);
                if (RETRY_ELSEWHERE.has(reason) || [500, 503, 504].includes(resp.status)) {
                    logger.warn(`[LocalResolver] ${path} ${name} failed (${reason}) for ${label}${moreAfter ? ' — trying next resolver' : ''}`);
                    moveOn = true;
                } else {
                    logger.warn(`[LocalResolver] ${path} ${name}: ${reason} for ${label} (${Date.now() - started}ms) — not retrying elsewhere`);
                    return null;
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    // Reached but slow: this resolver's other tunnel won't be faster — try the next resolver.
                    breakerRecord(base, false);
                    resolverCounters.slowFailures++;
                    logger.warn(`[LocalResolver] ${path} timed out via ${name} ${base} (${Date.now() - started}ms)${moreAfter ? ' — trying next resolver' : ''}`);
                    moveOn = true;
                } else {
                    // Refused / reset / closed: this tunnel is down. Try the resolver's next tunnel.
                    resolverCounters.unreachable++;
                    const code = err.cause?.code || err.cause?.errors?.[0]?.code || err.message;
                    logger.warn(`[LocalResolver] ${path} tunnel ${name} ${base} unusable: ${code}`);
                }
            } finally {
                clearTimeout(timer);
            }
            if (moveOn) break;
        }
        if (moreAfter) by.failovers++;
    }
    resolverCounters.noTunnel++;
    logger.warn(`[LocalResolver] ${path} no residential resolver could serve ${label} (${Date.now() - started}ms); falling back to local yt-dlp`);
    return null;
}

/**
 * Spotify's own metadata for a bridged track, so the resolver can find the same recording on
 * YouTube Music. `explicit` is only known for tracks that came through core/spotify-resolver.js —
 * it is omitted (not guessed) otherwise.
 */
export function bridgeTrackMeta(track) {
    if (!track?.title) return null;
    const explicit = track.metadata?.explicit;
    return { title: track.title, artist: track.author || '', ...(typeof explicit === 'boolean' ? { explicit } : {}) };
}

/**
 * Signed audio URL for { url } or { searchQuery, expectedDurationSec?, track? }. With a duration the
 * resolver matches YouTube Music's catalogue first (track = { title, artist, explicit? }), then the
 * same official-"Topic"-then-closest-duration ranking as _rankDurationMatches.
 */
// The resolver's pick for a bridged search, for the play log (by search query; bounded).
const lastPicks = new Map();
export const pickFor = (searchQuery) => lastPicks.get(searchQuery) || null;

async function tryLocalResolver(payload) {
    const data = await callResolver('/resolve', payload, payload.url || payload.searchQuery);
    const p = data?.picked;
    if (p && payload.searchQuery) {
        lastPicks.set(payload.searchQuery, p);
        if (lastPicks.size > 500) lastPicks.delete(lastPicks.keys().next().value);
    }
    if (p) {
        logger.info(`[LocalResolver] picked "${p.title}" — ${p.channel || '?'}${p.album ? ` · ${p.album}` : ''} `
            + `(${p.source || 'search'}, Δ${p.delta ?? '?'}s${p.explicit ? ', explicit' : ''}) for "${payload.searchQuery}"`);
    }
    // Play through the resolver's relay: YouTube refuses this server's datacenter IP for links signed
    // on a home IP, so the machine that signed the link also fetches the audio and streams it back over
    // the tunnel. A resolver without a relay (older build) still gets the direct link.
    if (typeof data?.streamPath === 'string' && data.streamPath.startsWith('/audio/') && data.via) return `${data.via}${data.streamPath}`;
    return typeof data?.audioUrl === 'string' && data.audioUrl.startsWith('http') ? data.audioUrl : null;
}

/** yt-dlp --dump-json entries (trimmed to the fields we read). `flat` = list entries only, no per-video extraction. */
async function tryResolverInfo(target, flat) {
    const data = await callResolver('/info', { target, isPlaylist: flat }, target, flat ? 60000 : 30000);
    return Array.isArray(data?.entries) && data.entries.length ? data.entries : null;
}

/** A soundcloud.com link (also m.soundcloud.com); on.soundcloud.com short links redirect there inside yt-dlp. */
export function isSoundCloudUrl(url) {
    return typeof url === 'string' && /^https?:\/\/([a-z0-9-]+\.)*soundcloud\.com\//i.test(url);
}

/** The resolver is YouTube-only: its format ladder would pick a 30s preview on a SoundCloud Go+ track. */
function isYouTubeTarget(target) {
    return typeof target === 'string' && (/^ytsearch\d*:/.test(target) || /(^|\/\/|\.)(youtube\.com|youtu\.be)\//.test(target));
}

// YouTube's player.js signature challenge cannot be solved in pure Python since mid-2026 ("The page
// needs to be reloaded" even with fresh cookies + PO tokens): yt-dlp must shell out to a JS runtime
// and fetch the EJS solver library. Applied to EVERY YouTube invocation. Overridable via env.
function ytJsArgs() {
    return [
        '--js-runtimes', process.env.YTDLP_JS_RUNTIMES || 'node:/usr/local/bin/node',
        '--remote-components', process.env.YTDLP_REMOTE_COMPONENTS || 'ejs:github',
    ];
}

// yt-dlp REWRITES the file passed to `--cookies` after every request. When YouTube
// serves a "confirm you're not a bot" challenge, its response strips the auth cookies,
// and yt-dlp persists that logged-out jar back over the file — permanently gutting it.
// So we NEVER hand the master cookies.txt to yt-dlp. Each run gets a throwaway copy;
// yt-dlp mangles the copy, the master stays pristine. Returns ['--cookies', tmpPath]
// or [] when no cookie jar exists. The temp dir self-deletes after 2 min (well past
// the 30s yt-dlp timeout); the timer is unref'd so it never holds the process open.
/** A jar that still carries the bits that make it an authenticated session. */
function looksAuthenticated(text) {
    return /(^|\s)__Secure-1PSID\s/.test(text) || /(^|\s)SAPISID\s/.test(text) || /(^|\s)LOGIN_INFO\s/.test(text);
}

/**
 * Hand yt-dlp a throwaway copy of the cookie jar, then decide whether to keep what it wrote back.
 *
 * yt-dlp REWRITES whatever file is given to `--cookies`. That cuts both ways:
 *
 *   - On a BOT-CHALLENGE, the response carries no auth cookies, so yt-dlp writes back a stripped
 *     jar. Handing it the master would therefore destroy the master on the first challenge. This is
 *     why it gets a copy — and that part was right.
 *
 *   - But on a SUCCESSFUL request, YouTube ROTATES the session (__Secure-1PSIDTS and friends) and
 *     yt-dlp writes those fresh cookies back too. Throwing the copy away every time meant the master
 *     never learned the rotation, so every later run replayed a stale token until YouTube declared
 *     the whole session dead ("cookies are no longer valid"). A freshly-exported jar would work for
 *     a handful of plays and then self-destruct — which is precisely what kept happening.
 *
 * So: commit the copy back to the master when the request SUCCEEDED and the jar still looks
 * authenticated; discard it otherwise. Written via a temp file + rename so a crash mid-write can
 * never leave a half-written jar behind.
 */
function cookieSession() {
    const noop = { args: [], commit() {} };
    if (!existsSync(COOKIES_PATH)) return noop;
    try {
        const dir = mkdtempSync(join(tmpdir(), 'cfx-ck-'));
        const copy = join(dir, 'cookies.txt');
        copyFileSync(COOKIES_PATH, copy);
        setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 120000).unref();

        return {
            args: ['--cookies', copy],
            commit(ok) {
                if (!ok) return;                       // a challenge response would strip the jar
                try {
                    const fresh = readFileSync(copy, 'utf8');
                    if (!looksAuthenticated(fresh)) return;              // never clobber with a stripped jar
                    if (fresh === readFileSync(COOKIES_PATH, 'utf8')) return;  // nothing rotated
                    const staging = `${COOKIES_PATH}.new`;
                    writeFileSync(staging, fresh, { mode: 0o600 });
                    renameSync(staging, COOKIES_PATH);                   // atomic swap
                    logger.info('[YtDlp] cookie jar refreshed from a successful request (rotation persisted)');
                } catch (e) {
                    logger.warn(`[YtDlp] could not persist rotated cookies: ${e.message}`);
                }
            },
        };
    } catch (e) {
        logger.warn(`[YtDlp] cookie copy failed (${e.message}); skipping cookies this run to protect the master jar`);
        return noop;
    }
}

/** Back-compat for the call sites that only read cookies and never need to commit a rotation. */
function cookieArgs() {
    return cookieSession().args;
}

/** YouTube's age gate also begins "Sign in to confirm…", and it is not a bot-check. */
function isAgeGate(stderr) {
    const s = (stderr || '').toLowerCase();
    return s.includes('confirm your age')
        || s.includes('age-restricted')
        || s.includes('inappropriate for some users');
}

function looksLikeCookieRotation(stderr) {
    if (!stderr) return false;
    // "Sign in to confirm" is deliberately broad, but it also matches "Sign in to confirm your age" —
    // an age-restricted video is not a bot-check, and treating it as one fired a bogus
    // "your cookies rotated" DM at the owner every time somebody queued a rated-R music video.
    if (isAgeGate(stderr)) return false;
    return stderr.includes('cookies are no longer valid')
        || stderr.includes("confirm you're not a bot")
        || stderr.includes("confirm you’re not a bot")
        || stderr.includes('Sign in to confirm');
}

// ── Why an extraction actually failed ────────────────────────────────────────
//
// discord-player's search API has no error channel: handle() can only hand back tracks, so "YouTube
// blocked us", "the cookie jar is dead" and "that search genuinely matched nothing" all arrive at
// the play command looking identical — and it says "No results found" to all three. That message has
// sent people (and me) hunting a search bug when the real cause was an upstream block.
//
// So the reason gets recorded here, and the play command reads it back to tell the user the truth.

const failures = new Map(); // query -> { message, at }
const FAILURE_TTL_MS = 120_000;
const FAILURE_MAX = 200;    // bounded: this is a diagnostic breadcrumb, not a cache

const keyOf = (q) => String(q ?? '').trim().toLowerCase();

/**
 * What a SoundCloud `--dump-json` entry (fetched with `-f SOUNDCLOUD_FULL_AUDIO --ignore-no-formats-error`)
 * says about playing it here (H-666):
 *   'ok'      SoundCloud serves the full track; `url` is its audio (HLS, which ffmpeg plays);
 *   'drm'     SoundCloud serves it only encrypted. Most major-label releases are like this;
 *   'preview' only the 30-second SoundCloud Go+ clip is offered.
 * The last two are matched on YouTube by title, artist and length, the way a Spotify track is.
 */
export function soundcloudPlayability(info) {
    if (typeof info?.url === 'string' && /^https?:\/\//.test(info.url) && info.format_id && !/preview/.test(String(info.format_id))) {
        return { status: 'ok', url: info.url };
    }
    const formats = Array.isArray(info?.formats) ? info.formats : [];
    return { status: formats.length ? 'preview' : 'drm' };
}

/** A readable title from a URL slug ("city-ports" -> "City Ports"); SoundCloud set entries listed flat have no title. */
export function titleFromSlug(slug) {
    const words = String(slug || '').split(/[-_]+/).filter(Boolean);
    return words.length ? words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : null;
}

/** Turn yt-dlp stderr into something a user can act on. null = nothing recognisable. */
export function classifyFailure(stderr) {
    if (!stderr) return null;
    const s = stderr.toLowerCase();

    // SoundCloud first: its errors also say "HTTP Error", which below would be blamed on YouTube.
    if (s.includes('[soundcloud')) {
        if (s.includes('http error 404')) return "SoundCloud can't find that link. Check it, and that the track or set is public.";
        if (s.includes('http error 401') || s.includes('http error 403')) return 'that SoundCloud track or set is private.';
        if (s.includes('timed out') || s.includes('timeout')) return 'SoundCloud took too long to answer. Try again shortly.';
        return 'SoundCloud did not return that link. Try again shortly, or search for the song by name.';
    }

    // Order matters. The age gate and a dead cookie jar BOTH contain "Sign in to confirm", so they
    // have to be ruled out before the generic bot-check, or every one of them reads as a bot-check.
    if (isAgeGate(stderr)) {
        return 'That video is age-restricted, and YouTube will not serve it to the bot.';
    }
    if (s.includes('cookies are no longer valid')) {
        return 'the YouTube cookie jar has expired and needs refreshing (`cookies.txt`).';
    }
    if (looksLikeCookieRotation(stderr)) {
        return 'YouTube is challenging this server with a bot-check. That is almost always the server IP being rate-limited rather than a bad link — try again shortly.';
    }
    if (s.includes('private video')) return 'that video is private.';
    if (s.includes('members-only') || s.includes('members only')) return 'that video is members-only.';
    // "The uploader has not made this video available in your country" — note it is NOT phrased as
    // "not available in your country", which is why the obvious substring misses it.
    if (s.includes('available in your country') || s.includes('geo-restricted') || s.includes('geo restricted')) {
        return "that video is geo-blocked for the server's region.";
    }
    if (s.includes('video unavailable') || s.includes("content isn't available") || s.includes('content isn’t available')) {
        return 'YouTube says that video is unavailable to this server. It can be region/age locked, taken down — or the server IP is flagged, in which case retrying shortly usually works.';
    }
    if (s.includes('timed out') || s.includes('timeout')) {
        return 'The extractor timed out talking to YouTube.';
    }
    if (s.includes('unable to download') || s.includes('http error 4') || s.includes('http error 5')) {
        return 'YouTube refused the request (HTTP error). The server IP may be rate-limited.';
    }
    return null;
}

/**
 * Record why a query failed. Keeps the FIRST meaningful cause within the window: YouTube is tried
 * first and the SoundCloud fallback runs after it, so without this the useful YouTube reason would
 * be overwritten by whatever noise SoundCloud produced.
 */
function noteFailure(query, stderr) {
    const message = classifyFailure(stderr);
    if (!message) return;
    const key = keyOf(query);
    const prev = failures.get(key);
    if (prev && Date.now() - prev.at < FAILURE_TTL_MS) return;
    if (failures.size >= FAILURE_MAX) {
        for (const [k, v] of failures) if (Date.now() - v.at > FAILURE_TTL_MS) failures.delete(k);
        if (failures.size >= FAILURE_MAX) failures.delete(failures.keys().next().value);
    }
    failures.set(key, { message, at: Date.now() });
}

/** Read (and clear) why `query` failed, if we know. Called by the play command on an empty result. */
export function takeExtractionFailure(query) {
    const key = keyOf(query);
    const hit = failures.get(key);
    if (!hit) return null;
    failures.delete(key);
    return Date.now() - hit.at > FAILURE_TTL_MS ? null : hit.message;
}

/**
 * Universal extractor using yt-dlp for ALL sources
 * Supports YouTube, SoundCloud, Spotify, and 1000+ other sites
 * Supports playlists from YouTube and Spotify
 */
class YtDlpExtractor extends BaseExtractor {
    static identifier = 'com.certifried.ytdlp-universal';

    async validate(query, type) {
        if (typeof query !== 'string' || query.length === 0) {
            return false;
        }

        // yt-dlp cannot extract Spotify (DRM-protected). SpotifyExtractor owns
        // Spotify metadata; we provide the audio via bridge() at stream time.
        if (query.includes('spotify.com/')) {
            return false;
        }

        logger.info(`[YtDlp] validate() accepting query: ${query.substring(0, 50)}..., type: ${type}`);
        return true;
    }

    /**
     * Detect the source platform from a URL or query
     * @returns {{ platform: string, type: string, id: string|null }}
     */
    detectQuerySource(query) {
        // Spotify patterns
        const spotifyMatch = query.match(/spotify\.com\/(track|playlist|album|artist)\/([a-zA-Z0-9]+)/);
        if (spotifyMatch) {
            return { platform: 'spotify', type: spotifyMatch[1], id: spotifyMatch[2] };
        }

        // YouTube patterns
        if (query.includes('youtube.com') || query.includes('youtu.be')) {
            if (query.includes('/playlist') || query.match(/[?&]list=PL/)) {
                return { platform: 'youtube', type: 'playlist', id: null };
            }
            if (query.match(/[?&]list=RD/)) {
                return { platform: 'youtube', type: 'mix', id: null };
            }
            if (query.includes('/shorts/')) {
                return { platform: 'youtube', type: 'short', id: null };
            }
            return { platform: 'youtube', type: 'video', id: null };
        }

        // SoundCloud patterns
        if (query.includes('soundcloud.com')) {
            if (query.includes('/sets/')) {
                return { platform: 'soundcloud', type: 'playlist', id: null };
            }
            return { platform: 'soundcloud', type: 'track', id: null };
        }

        // Not a URL - it's a search query
        return { platform: 'search', type: 'query', id: null };
    }

    isPlaylistUrl(query) {
        const source = this.detectQuerySource(query);
        // Playlists, albums, and mixes are multi-track
        return ['playlist', 'album', 'artist', 'mix'].includes(source.type);
    }

    isYouTubeMixPlaylist(query) {
        // YouTube Mix/Radio playlists have list IDs starting with RD
        const match = query.match(/[?&]list=(RD[A-Za-z0-9_-]+)/);
        return match !== null;
    }

    sanitizeUrl(url) {
        // Remove tracking parameters that can cause issues
        try {
            const urlObj = new URL(url);
            urlObj.searchParams.delete('si'); // YouTube tracking
            urlObj.searchParams.delete('playnext');
            urlObj.searchParams.delete('start_radio');
            return urlObj.toString();
        } catch {
            return url;
        }
    }

    /** Tags each resulting track with the kind of request it came from (link vs search) for the play log. */
    async handle(query, context) {
        const result = await this._handle(query, context);
        for (const track of result?.tracks || []) noteRequestKind(track, query);
        return result;
    }

    async _handle(query, context) {
        logger.info(`[YtDlp] handle() called with query: ${query}`);

        // Detect source and type from the query
        const source = this.detectQuerySource(query);
        logger.info(`[YtDlp] Detected source: ${source.platform}, type: ${source.type}${source.id ? `, id: ${source.id}` : ''}`);

        const isPlaylist = this.isPlaylistUrl(query);
        const isMixPlaylist = this.isYouTubeMixPlaylist(query);

        // Handle YouTube Shorts early - they don't play properly
        if (source.type === 'short') {
            logger.warn(`[YtDlp] YouTube Short detected - not supported`);
            return this.createResponse();
        }

        // Sanitize URL to remove problematic parameters
        const sanitizedQuery = this.sanitizeUrl(query);
        if (sanitizedQuery !== query) {
            logger.info(`[YtDlp] Sanitized URL: ${sanitizedQuery}`);
        }

        const isUrl = sanitizedQuery.match(/^https?:\/\//);

        // Handle YouTube Mix/Radio playlists - try as playlist first, fall back to single video
        if (isMixPlaylist) {
            logger.info(`[YtDlp] YouTube Mix/Radio playlist detected, attempting playlist extraction`);
            const mixResult = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, true);
            if (mixResult?.tracks?.length > 1) {
                logger.info(`[YtDlp] Mix playlist extracted successfully: ${mixResult.tracks.length} tracks`);
                return mixResult;
            }
            // Fallback: extract just the single video by stripping the list param
            logger.info(`[YtDlp] Mix playlist extraction returned ${mixResult?.tracks?.length || 0} tracks, falling back to single video`);
            try {
                const fallbackUrl = new URL(sanitizedQuery);
                fallbackUrl.searchParams.delete('list');
                fallbackUrl.searchParams.delete('index');
                const fallbackResult = await this.searchWithSource(fallbackUrl.toString(), context, fallbackUrl.toString(), false);
                if (fallbackResult?.tracks?.length > 0) {
                    logger.info(`[YtDlp] Fallback single video extracted: ${fallbackResult.tracks[0].title}`);
                    return fallbackResult;
                }
            } catch (fallbackErr) {
                logger.error(`[YtDlp] Mix fallback failed: ${fallbackErr.message}`);
            }
            return mixResult || this.createResponse();
        }

        // Spotify URLs never reach here — validate() rejects them so SpotifyExtractor
        // can fetch metadata via the Spotify Web API. We bridge audio in bridge().

        if (source.platform === 'soundcloud') {
            logger.info(`[YtDlp] Processing SoundCloud ${source.type}: ${sanitizedQuery}`);
            const result = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, isPlaylist);
            logger.info(`[YtDlp] SoundCloud ${source.type}: found ${result?.tracks?.length || 0} track(s)`);
            // No second try through the URL branch below: it would run the same lookup again.
            return result;
        }

        // YouTube URLs or search queries
        if (isUrl) {
            logger.info(`[YtDlp] Processing URL directly: ${sanitizedQuery}`);
            const result = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, isPlaylist);
            logger.info(`[YtDlp] URL result: tracks=${result?.tracks?.length || 0}, playlist=${!!result?.playlist}`);
            // A bot-challenged video URL yields nothing here, so it never reached the queue and
            // stream()'s search/SoundCloud fallback never got a chance. Queue it from oEmbed
            // metadata instead (oEmbed isn't behind the player-endpoint bot check).
            if (!result?.tracks?.length && source.platform === 'youtube' && source.type === 'video') {
                const fallbackTrack = await this._trackFromOEmbed(sanitizedQuery, context);
                if (fallbackTrack) return this.createResponse(null, [fallbackTrack]);
            }
            return result;
        }

        // Search query - try YouTube first, retry once on bot detection, then SoundCloud fallback
        logger.info(`[YtDlp] Search query: trying YouTube first`);
        let result = await this.searchWithSource(sanitizedQuery, context, `ytsearch:${sanitizedQuery}`, false);
        logger.info(`[YtDlp] YouTube search result: tracks=${result?.tracks?.length || 0}`);

        // Retry once after delay if YouTube returned nothing (often bot detection)
        if ((!result?.tracks || result.tracks.length === 0)) {
            logger.warn(`[YtDlp] YouTube search returned 0 tracks, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            result = await this.searchWithSource(sanitizedQuery, context, `ytsearch:${sanitizedQuery}`, false);
            logger.info(`[YtDlp] YouTube search retry result: tracks=${result?.tracks?.length || 0}`);
        }

        // No SoundCloud fallback, by owner's decision: SoundCloud uploads are usually covers,
        // remixes or low-bitrate re-uploads — not the version people asked for. Spotify and
        // YouTube only; if both fail the user is told why instead of getting a wrong song.

        return result;
    }

    /**
     * Metadata via the residential resolver first (YouTube only), then the local pool. Returns
     * yt-dlp --dump-json output as JSONL text, or null after recording why it failed.
     */
    async _fetchInfoLines(originalQuery, searchQuery, isPlaylist) {
        // A ytsearch only needs what the search page already lists (title, channel, duration,
        // thumbnails, url). Full extraction adds a per-video player request — the request YouTube
        // bot-walls on the OVH IP — and stream() resolves the audio URL separately anyway.
        const flat = isPlaylist || /^ytsearch\d*:/.test(searchQuery);

        if (isYouTubeTarget(searchQuery)) {
            const entries = await tryResolverInfo(searchQuery, flat);
            if (entries) return entries.map(e => JSON.stringify(e)).join('\n');
        }

        // Routed through ytdlpPool so metadata extraction uses the SAME venv yt-dlp as streaming —
        // the one that loads the bgutil PO-token plugin.
        const args = ['--dump-json', '--ignore-errors', '--no-check-formats'];
        if (isYouTubeTarget(searchQuery)) args.push('--extractor-args', 'youtube:player_client=default', ...ytJsArgs());
        // SoundCloud Go+ tracks only expose a 30s preview to us; refuse those formats so the
        // entry fails (and --ignore-errors skips it) instead of queueing a clip.
        // --ignore-no-formats-error keeps the title, artist and length of a track SoundCloud serves only with
        // DRM or as a preview, so it can still be queued and matched on YouTube when it plays (H-666).
        if (searchQuery.startsWith('scsearch') || searchQuery.includes('soundcloud.com')) {
            args.push('-f', SOUNDCLOUD_FULL_AUDIO, '--ignore-no-formats-error');
        }
        const cookies = cookieSession();
        args.push(...cookies.args);
        args.push(flat ? '--flat-playlist' : '--no-playlist');
        args.push(searchQuery);

        let result;
        try {
            // Playlists can take a while to enumerate; give metadata more headroom.
            result = await ytdlpPool.execute(args, { timeout: isPlaylist ? 60000 : 35000 });
        } catch (err) {
            logger.error(`[YtDlp] searchWithSource pool error: ${err.message}`);
            noteFailure(originalQuery, err.message);
            cookies.commit(false);
            return null;
        }

        const jsonData = result.stdout || '';
        const errorOutput = result.stderr || '';
        // Carry YouTube's rotated session cookies back to the master jar — but only from a request
        // that actually worked. Without this the jar goes stale and dies within a few plays.
        cookies.commit(result.code === 0 && !!jsonData.trim());
        if (looksLikeCookieRotation(errorOutput)) {
            notifyCookieRotation({ source: 'searchWithSource', query: searchQuery, stderr: errorOutput }).catch(() => {});
        }
        // With --ignore-errors yt-dlp can exit non-zero yet still emit good entries
        // (e.g. one dead track in a 100-song playlist). Only bail when stdout is genuinely empty.
        if (!jsonData.trim()) {
            logger.error(`[YtDlp] Search failed (code ${result.code}): ${errorOutput.substring(0, 300)}`);
            // Keep the real reason so the play command can say it out loud instead of "no results".
            noteFailure(originalQuery, errorOutput);
            return null;
        }
        return jsonData;
    }

    async searchWithSource(originalQuery, context, searchQuery, isPlaylist) {
        const jsonData = await this._fetchInfoLines(originalQuery, searchQuery, isPlaylist);
        if (!jsonData) return this.createResponse();

        return new Promise((resolve) => {
            {
                try {
                    // For playlists, yt-dlp outputs one JSON object per line
                    const lines = jsonData.trim().split('\n').filter(line => line.trim());
                    logger.info(`[YtDlp] Got ${lines.length} result lines, isPlaylist: ${isPlaylist}`);

                    if (isPlaylist && lines.length >= 1) {
                        // Handle as playlist - even with 1 entry it might be playlist metadata
                        const tracks = [];
                        let playlistTitle = 'Unknown Playlist';

                        for (const line of lines) {
                            try {
                                const info = JSON.parse(line);

                                // Check for playlist metadata
                                if (info._type === 'playlist' && !info.id) {
                                    playlistTitle = info.title || playlistTitle;
                                    continue;
                                }

                                // Get playlist title from first entry if available
                                if (info.playlist_title && playlistTitle === 'Unknown Playlist') {
                                    playlistTitle = info.playlist_title;
                                }

                                // Build track URL
                                let trackUrl = info.webpage_url || info.url;
                                if (!trackUrl && info.id) {
                                    // Flat playlist entries only have id
                                    trackUrl = `https://www.youtube.com/watch?v=${info.id}`;
                                }

                                if (!trackUrl) continue;

                                const source = this.detectSource(trackUrl, info);

                                const track = new Track(this.context.player, {
                                    // SoundCloud sets listed flat carry no title: use the link's slug and the set's owner.
                                    title: info.title || titleFromSlug(info.webpage_url_basename) || 'Unknown',
                                    description: info.description || '',
                                    author: info.uploader || info.channel || info.artist || info.playlist_uploader || 'Unknown',
                                    url: trackUrl,
                                    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
                                    duration: this.formatDuration(info.duration),
                                    views: info.view_count || 0,
                                    requestedBy: context.requestedBy,
                                    source: source,
                                    metadata: context.metadata
                                });

                                tracks.push(track);
                            } catch (parseErr) {
                                logger.warn(`[YtDlp] Failed to parse line: ${parseErr.message}`);
                                continue;
                            }
                        }

                        if (tracks.length > 0) {
                            logger.info(`[YtDlp] Found playlist "${playlistTitle}" with ${tracks.length} tracks`);

                            const playlist = new Playlist(this.context.player, {
                                title: playlistTitle,
                                thumbnail: tracks[0]?.thumbnail,
                                description: `Playlist with ${tracks.length} tracks`,
                                type: 'playlist',
                                source: this.detectSource(originalQuery, {}),
                                author: {
                                    name: tracks[0]?.author || 'Unknown',
                                    url: originalQuery
                                },
                                tracks: tracks,
                                id: originalQuery,
                                url: originalQuery,
                                rawPlaylist: null
                            });

                            // Link tracks to playlist
                            tracks.forEach(track => {
                                track.playlist = playlist;
                            });

                            resolve(this.createResponse(playlist, tracks));
                        } else {
                            logger.warn('[YtDlp] Playlist detected but no tracks could be parsed');
                            resolve(this.createResponse());
                        }
                    } else if (lines.length > 0) {
                        // Single track
                        const info = JSON.parse(lines[0]);
                        const source = this.detectSource(info.webpage_url || info.url || '', info);
                        // A SoundCloud track served only with DRM or as a preview is queued anyway and matched
                        // on YouTube when it plays (stream() -> _streamSoundCloud). A preview's length is the clip's.
                        const sc = source === 'soundcloud' ? soundcloudPlayability(info) : null;
                        const scBridge = sc && sc.status !== 'ok' ? sc.status : null;

                        const track = new Track(this.context.player, {
                            title: info.title || 'Unknown',
                            description: info.description || '',
                            author: info.uploader || info.channel || 'Unknown',
                            url: info.webpage_url || info.url,
                            // Flat search entries carry only a thumbnails[] list (last = largest).
                            thumbnail: info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url,
                            duration: this.formatDuration(scBridge === 'preview' ? null : info.duration),
                            views: info.view_count || 0,
                            requestedBy: context.requestedBy,
                            source: source,
                            metadata: context.metadata,
                            ...(scBridge ? { scBridge } : {})
                        });

                        logger.info(`[YtDlp] Found: ${track.title}`);
                        resolve(this.createResponse(null, [track]));
                    } else {
                        logger.warn('[YtDlp] No results found');
                        resolve(this.createResponse());
                    }
                } catch (error) {
                    logger.error(`[YtDlp] Parse error: ${error.message}`);
                    resolve(this.createResponse());
                }
            }
        });
    }

    /**
     * Build a Track for a YouTube video yt-dlp couldn't extract, using the public oEmbed
     * endpoint for title/channel. Flagged `ytdlpUnresolved` so stream() skips the doomed
     * direct attempts and goes straight to search (YouTube candidates, then SoundCloud).
     */
    async _trackFromOEmbed(url, context) {
        try {
            const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
                signal: AbortSignal.timeout(8000)
            });
            if (!res.ok) {
                logger.warn(`[YtDlp] oEmbed fallback HTTP ${res.status} for ${url}`);
                return null;
            }
            const data = await res.json();
            if (!data?.title) return null;

            const author = (data.author_name || 'Unknown').replace(/ - Topic$/, '');
            logger.warn(`[YtDlp] Extraction failed; queueing from oEmbed metadata: ${data.title} — ${author}`);
            return new Track(this.context.player, {
                title: data.title,
                description: '',
                author,
                url,
                thumbnail: data.thumbnail_url,
                duration: '0:00',
                views: 0,
                requestedBy: context.requestedBy,
                source: 'youtube',
                metadata: context.metadata,
                ytdlpUnresolved: true
            });
        } catch (err) {
            logger.warn(`[YtDlp] oEmbed fallback failed for ${url}: ${err.message}`);
            return null;
        }
    }

    detectSource(url, info) {
        if (url.includes('youtube.com') || url.includes('youtu.be') || info.extractor?.toLowerCase().includes('youtube')) {
            return 'youtube';
        } else if (url.includes('soundcloud.com') || info.extractor?.toLowerCase().includes('soundcloud')) {
            return 'soundcloud';
        } else if (url.includes('spotify.com') || info.extractor?.toLowerCase().includes('spotify')) {
            return 'spotify';
        }
        return 'arbitrary';
    }

    /** Records how the audio is reached (relay of which resolver / server1 directly) for the play log. */
    async stream(info) {
        const url = await this._stream(info);
        if (typeof url === 'string') notePlayback(info, { path: pathOfUrl(url) });
        return url;
    }

    async _stream(info) {
        logger.info(`[YtDlp] Streaming: ${info.title} from ${info.url}`);

        try {
            // Defensive: if a Spotify URL ever reaches stream() directly, search YouTube
            const isSpotifyUrl = info.url?.includes('spotify.com');

            if (isSpotifyUrl) {
                const customQuery = info?.metadata?.bridgeQuery;
                const searchQuery = (typeof customQuery === 'string' && customQuery.trim())
                    ? customQuery.trim()
                    : `${info.title} ${info.author || ''}`.trim();
                logger.info(`[YtDlp] Spotify URL detected, searching YouTube for: ${searchQuery}`);
                return await this.getAudioUrlFromSearch(searchQuery);
            }

            // Queued from oEmbed because extraction was already bot-challenged — the direct URL
            // would just burn three more blocked attempts. raw holds the un-escaped title.
            if (info.raw?.ytdlpUnresolved) {
                const searchQuery = `${info.raw.title || ''} ${info.raw.author || ''}`.trim();
                logger.info(`[YtDlp] Unresolved YouTube track, searching for: ${searchQuery}`);
                return await this.getAudioUrlFromSearch(searchQuery);
            }

            // SoundCloud links: SoundCloud's own audio when it serves it, otherwise the same song from YouTube.
            if (isSoundCloudUrl(info.url)) return await this._streamSoundCloud(info);

            // A URL prefetched while the previous track played (or still being prefetched) skips the
            // 2-4s resolve at the track change.
            const prefetched = await takePrefetched(info.url);
            if (prefetched) { notePlayback(info, { prefetched: true }); return prefetched; }

            // Try direct URL first
            try {
                return await this.getAudioUrlDirect(info.url);
            } catch (directErr) {
                // Try with title + author first, then title only as last resort
                const fullQuery = `${info.title || ''} ${info.author || ''}`.replace(/\[Deleted video\]/gi, '').trim();
                const titleOnly = (info.title || '').replace(/\[Deleted video\]/gi, '').trim();
                const searchQuery = fullQuery.length >= 3 ? fullQuery : titleOnly;
                if (!searchQuery || searchQuery.length < 3) {
                    throw new Error(`Cannot search for deleted/unavailable video: ${info.url}`);
                }
                logger.warn(`[YtDlp] Direct URL failed (${directErr.message}), searching YouTube for: ${searchQuery}`);
                return await this.getAudioUrlFromSearch(searchQuery);
            }
        } catch (err) {
            logger.error(`[YtDlp] Stream completely failed for "${info.title}": ${err.message}`);
            throw err; // Let discord-player handle via playerError event
        }
    }

    /**
     * Audio for a SoundCloud link (H-666). SoundCloud does not block this server, so its own audio is
     * fetched here, no resolver needed. A track it serves only with DRM (most major-label releases) or only
     * as a 30-second Go+ preview is matched on YouTube by title, artist and length instead, like a Spotify
     * track; with no match the track fails and the queue moves on, as for any unplayable track.
     */
    async _streamSoundCloud(info) {
        let status = info.raw?.scBridge || null;
        let title = info.raw?.title || info.title || '';
        let artist = info.raw?.author || info.author || '';
        let durationSec = status === 'preview' ? null : this._resolveExpectedDurationSec(info);

        if (!status) {
            const data = await this._soundcloudInfo(info.url);
            const p = soundcloudPlayability(data);
            if (p.status === 'ok') return p.url;
            status = p.status;
            title = data.title || title;
            artist = data.uploader || artist;
            durationSec = status === 'preview' ? null : (Number(data.duration) > 0 ? Math.round(Number(data.duration)) : durationSec);
        }

        const cleanArtist = artist && artist !== 'Unknown' ? artist : '';
        const query = `${cleanArtist} ${title}`.trim();
        if (!title || title === 'Unknown') throw new Error(`SoundCloud serves no playable audio for ${info.url}`);
        logger.info(`[YtDlp] SoundCloud serves ${status === 'drm' ? 'only DRM-protected audio' : 'only a preview'} for "${title}"; matching it on YouTube`);
        const audioUrl = await this.getAudioUrlFromSearch(query, durationSec || null, { title, artist: cleanArtist });
        const pick = pickFor(query);
        notePlayback(info, { matchedVia: pick?.source || `soundcloud-${status}`,
            matchedTitle: pick ? `${pick.title}${pick.channel ? ` — ${pick.channel}` : ''}` : null });
        return audioUrl;
    }

    /** One SoundCloud track's yt-dlp JSON, with its playable audio picked (or none, see soundcloudPlayability). */
    async _soundcloudInfo(url) {
        const args = ['--dump-json', '--no-playlist', '--no-warnings', '--no-check-formats',
            '--ignore-no-formats-error', '-f', SOUNDCLOUD_FULL_AUDIO, url];
        const result = await ytdlpPool.execute(args, { timeout: 30000 });
        const line = (result.stdout || '').split('\n').find(l => l.trim().startsWith('{'));
        if (!line) {
            noteFailure(url, result.stderr || '');
            throw new Error(classifyFailure(result.stderr || '') || `SoundCloud did not return ${url}`);
        }
        return JSON.parse(line);
    }

    /**
     * Bridge a track from another extractor (e.g. SpotifyExtractor) to a playable
     * audio stream by searching YouTube for "title author" and returning the URL.
     * discord-player's requestBridge() iterates registered extractors and calls
     * bridge() on each one; BaseExtractor's default returns null, so extractors
     * that want to serve as a bridge MUST override this.
     */
    async bridge(track, sourceExtractor) {
        if (sourceExtractor?.identifier === this.identifier) {
            return this.stream(track);
        }

        // An explicit-aware query set by core/spotify-resolver.js wins over the source
        // extractor's createBridgeQuery (which appends "official audio" → clean uploads).
        const customQuery = track?.metadata?.bridgeQuery;
        const bridgeQuery = (typeof customQuery === 'string' && customQuery.trim())
            ? customQuery
            : (typeof sourceExtractor?.createBridgeQuery === 'function'
                ? sourceExtractor.createBridgeQuery(track)
                : null);
        const query = (bridgeQuery && bridgeQuery.trim())
            || `${track.title || ''} ${track.author || ''}`.trim();

        if (!query || query.length < 2) {
            logger.error(`[YtDlp] bridge() got empty query for "${track.title}"`);
            return null;
        }

        const expectedDurationSec = this._resolveExpectedDurationSec(track);
        const trackMeta = bridgeTrackMeta(track);

        try {
            logger.info(`[YtDlp] Bridging "${track.title}" via YouTube search: ${query} (expected ${expectedDurationSec ?? 'unknown'}s)`);
            const audioUrl = await this.getAudioUrlFromSearch(query, expectedDurationSec, trackMeta);
            // For the play log: a Spotify track that played from YouTube, through which relay, as which recording.
            const pick = pickFor(query);
            notePlayback(track, { path: pathOfUrl(audioUrl), matchedVia: pick?.source || null,
                matchedTitle: pick ? `${pick.title}${pick.channel ? ` — ${pick.channel}` : ''}` : null });
            return audioUrl;
        } catch (err) {
            logger.error(`[YtDlp] bridge() failed for "${track.title}": ${err.message}`);
            return null;
        }
    }

    _resolveExpectedDurationSec(track) {
        if (typeof track?.durationMS === 'number' && track.durationMS > 0) {
            return Math.floor(track.durationMS / 1000);
        }
        if (typeof track?.duration === 'string' && track.duration.includes(':')) {
            const parts = track.duration.split(':').map(p => parseInt(p, 10));
            if (parts.every(n => Number.isFinite(n))) {
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
        }
        return null;
    }

    /**
     * Rank duration-matched candidates for a query on a given search engine, BEST first.
     * Returns an ordered array (not just one) so the caller can fall through to the next
     * candidate when the top pick is blocked (age-gate / bot-detection / DRM). `engine`
     * is a yt-dlp search prefix: 'ytsearch10' (YouTube) or 'scsearch10' (SoundCloud).
     */
    async _rankDurationMatches(searchQuery, expectedDurationSec, engine = 'ytsearch10') {
        const isYoutube = engine.startsWith('yt');
        const args = [
            '--no-warnings',
            '--no-playlist',
            '--flat-playlist',
            // Tab-separated, title LAST: titles often contain "|" ("Song | Official Video").
            '--print', '%(duration)s\t%(webpage_url)s\t%(channel,uploader)s\t%(title)s',
        ];
        if (isYoutube) args.push('--extractor-args', 'youtube:player_client=default', ...ytJsArgs());
        args.push(...cookieArgs());
        // Search wider so the exact official cut (often ranked below remixes/covers/
        // lyric videos) is actually in the candidate set.
        args.push(`${engine}:${searchQuery}`);

        const result = await ytdlpPool.execute(args, { timeout: 30000 });
        const stderr = result.stderr || '';

        if (isYoutube && looksLikeCookieRotation(stderr)) {
            notifyCookieRotation({ source: '_rankDurationMatches', query: searchQuery, stderr }).catch(() => {});
        }

        if (!result.stdout?.trim()) {
            logger.error(`[YtDlp] Duration-aware ${engine} search failed: ${stderr.substring(0, 200)}`);
            return [];
        }

        const candidates = result.stdout.trim().split('\n').map(line => {
            const parts = line.split('\t');
            if (parts.length < 3) return null;
            const duration = parseInt(parts[0], 10);
            const webpage_url = parts[1];
            const channel = parts[2] || '';
            const title = parts.slice(3).join('\t');
            if (!Number.isFinite(duration) || duration <= 0 || !webpage_url) return null;
            return { duration, webpage_url, title, channel, delta: Math.abs(duration - expectedDurationSec) };
        }).filter(Boolean);

        if (candidates.length === 0) {
            logger.warn(`[YtDlp] No usable candidates from ${engine} for "${searchQuery}"`);
            return [];
        }

        // Official auto-generated "Art Track" uploads live on "<Artist> - Topic" channels
        // and mirror the exact album release (correct length + explicit preserved). Prefer
        // them, then prefer the CLOSEST duration — never just the first within a window.
        const isOfficial = (c) => /-\s*topic$/i.test(c.channel) || /provided to youtube|official audio/i.test(c.title);
        const rank = (a, b) => (Number(isOfficial(b)) - Number(isOfficial(a))) || (a.delta - b.delta);

        // EXACT cut first (within max(3s, 2%)), then anything within ±15%, each block
        // internally ranked official-then-closest. Concatenating the blocks gives a
        // single best-first list to walk.
        const exactThresh = Math.max(3, expectedDurationSec * 0.02);
        const exact = candidates.filter(c => c.delta <= exactThresh).sort(rank);
        const near = candidates.filter(c => c.delta > exactThresh && c.delta <= expectedDurationSec * 0.15).sort(rank);
        const ordered = [...exact, ...near];

        if (ordered.length === 0) {
            const summary = candidates.map(c => `${c.duration}s`).join(', ');
            logger.warn(`[YtDlp] No duration match for "${searchQuery}" (expected ${expectedDurationSec}s). Candidates: ${summary}`);
        } else {
            const m = ordered[0];
            logger.info(`[YtDlp] ${engine} best: "${m.title}" [${m.channel}] (${m.duration}s vs ${expectedDurationSec}s, Δ${m.delta}s${isOfficial(m) ? ', official' : ''}) — ${ordered.length} candidate(s)`);
        }
        return ordered;
    }

    /**
     * Walk a ranked candidate list and return the audio URL of the FIRST one that
     * actually resolves. Skips age-gated / DRM / bot-blocked uploads (one attempt each
     * so we move on fast) instead of dying on the top pick.
     */
    async _firstPlayable(candidates, max = 4) {
        for (const c of candidates.slice(0, max)) {
            try {
                const url = await this.getAudioUrlDirect(c.webpage_url, 1);
                if (url) return url;
            } catch (err) {
                logger.warn(`[YtDlp] Candidate blocked (${err.message}), trying next: ${c.title}`);
            }
        }
        return null;
    }

    _buildStreamArgs(url) {
        const isYoutube = url && (url.includes('youtube.com') || url.includes('youtu.be'));
        const args = [
            // Prefer audio-only formats: 140 (m4a 128k) and 251 (webm Opus 128k)
            // have long URL TTLs and don't suffer the format-18 mid-stream cutoff
            // that plagues YouTube's combined-stream fallback. Format 18 stays
            // as a last-resort safety net.
            // Opus (251, ~160k) first — it's the best-quality audio YouTube serves and decodes
            // losslessly into our pipeline; m4a/140 (128k AAC) next; 18 is the last-resort net.
            '-f', isYoutube ? 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/251/140/18/b' : SOUNDCLOUD_FULL_AUDIO,
            '-g',
            '--no-playlist',
            '--no-warnings',
            '--no-check-formats',
        ];
        // Use yt-dlp's `default` client chain — it tries multiple clients and
        // picks the one that returns audio-only formats. Single-client choices
        // (web, android) often miss formats 140/251 entirely.
        if (isYoutube) {
            args.push('--extractor-args', 'youtube:player_client=default', ...ytJsArgs());
        }
        args.push(...cookieArgs());
        return args;
    }

    async getAudioUrlDirect(url, maxAttempts = 3) {
        // Residential resolver first (server2 via tunnel). On any failure — tunnel down,
        // resolver timeout, cookies dead on server2 — fall through to the local yt-dlp
        // pool below without any change in behaviour.
        if (isYouTubeTarget(url)) {
            const resolverUrl = await tryLocalResolver({ url });
            if (resolverUrl) return resolverUrl;
        }
        try {
            const localUrl = await this._localAudioUrlDirect(url, maxAttempts);
            resolverCounters.localOk++;
            return localUrl;
        } catch (err) {
            resolverCounters.localFail++;
            throw err;
        }
    }

    async _localAudioUrlDirect(url, maxAttempts) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const args = this._buildStreamArgs(url);
            args.push(url);

            const result = await ytdlpPool.execute(args, { timeout: 30000 });

            if (result.code === 0 && result.stdout.trim()) {
                // --print urls can return multiple lines (video + audio), take first
                const resultUrl = result.stdout.trim().split('\n')[0].trim();
                logger.info(`[YtDlp] Got audio URL (attempt ${attempt + 1})`);
                return resultUrl;
            }

            const stderrFull = result.stderr || '';
            const stderr = stderrFull.substring(0, 200);
            // Don't retry on permanent / per-video failures — the caller (bridge /
            // _firstPlayable) should move to the next candidate, not hammer this one.
            if (stderr.includes('Video unavailable') || stderr.includes('terminated') || stderr.includes('removed') || stderr.includes('Private video')) {
                logger.error(`[YtDlp] Permanent failure: ${stderr}`);
                throw new Error('Video unavailable');
            }
            if (stderr.includes('confirm your age') || stderr.includes('age-restricted')) {
                throw new Error('Video is age-restricted');
            }
            if (stderr.includes('DRM')) {
                throw new Error('DRM protected');
            }

            if (looksLikeCookieRotation(stderrFull)) {
                notifyCookieRotation({ source: 'getAudioUrlDirect', query: url, stderr: stderrFull }).catch(() => {});
            }

            if (attempt < maxAttempts - 1) {
                const isBotDetect = looksLikeCookieRotation(stderrFull);
                const delay = isBotDetect ? 4000 : 2000;
                logger.warn(`[YtDlp] Attempt ${attempt + 1} failed (${isBotDetect ? 'bot detection' : stderr.substring(0, 80)}), retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                if (looksLikeCookieRotation(stderrFull)) throw new Error("Sign in to confirm you're not a bot");
                logger.error(`[YtDlp] All ${maxAttempts} attempt(s) failed: ${stderr}`);
                throw new Error('Failed to get audio URL');
            }
        }
    }

    /**
     * Resolve a playable audio URL for a free-text query. Tries, in order:
     *   1. the residential resolvers: with an expected length (Spotify bridge) they match the
     *      track in YouTube Music's song catalogue — same recording, same explicit/clean version —
     *      and fall back to a duration-ranked YouTube search;
     *   2. server1's own duration-ranked YouTube search, walking down the candidates so an
     *      age-gated/blocked top result doesn't kill it;
     *   3. a plain ytsearch when no duration hint is available.
     * `track` ({ title, artist, explicit? }) lets the resolver match on the real metadata instead
     * of guessing from the query string.
     */
    async getAudioUrlFromSearch(searchQuery, expectedDurationSec = null, track = null) {
        const resolverUrl = await tryLocalResolver({
            searchQuery,
            ...(expectedDurationSec ? { expectedDurationSec } : {}),
            ...(track ? { track } : {}),
        });
        if (resolverUrl) return resolverUrl;

        // Duration-aware path: prefer the exact official cut, but try every close
        // candidate (YouTube then SoundCloud) before giving up. Prevents 30s preview
        // clips from masquerading as full tracks when bridging Spotify.
        if (expectedDurationSec && expectedDurationSec > 0) {
            const ytCandidates = await this._rankDurationMatches(searchQuery, expectedDurationSec, 'ytsearch10');
            const ytUrl = await this._firstPlayable(ytCandidates);
            if (ytUrl) return ytUrl;

            // No SoundCloud fallback (owner's decision — wrong versions, low quality).
            throw new Error(`No playable full-length YouTube match for "${searchQuery}" (expected ${expectedDurationSec}s)`);
        }

        // No duration hint: plain search. Try YouTube (with one bot-detection retry),
        // then fall back to SoundCloud.
        for (const engine of ['ytsearch']) {   // YouTube only — no SoundCloud fallback (owner's decision)
            for (let attempt = 0; attempt < 2; attempt++) {
                const args = this._buildStreamArgs(engine === 'ytsearch' ? 'https://youtube.com' : 'https://soundcloud.com');
                // Several SoundCloud candidates: DRM / preview-only hits fail and are skipped.
                if (engine === 'scsearch') args.push('--ignore-errors');
                args.push(engine === 'scsearch' ? `scsearch5:${searchQuery}` : `${engine}:${searchQuery}`);

                const result = await ytdlpPool.execute(args, { timeout: 30000 });

                logger.info(`[YtDlp] ${engine} stream (attempt ${attempt + 1}): code=${result.code}, stdout=${result.stdout?.length || 0} bytes, stderr=${(result.stderr || '').substring(0, 120)}`);

                // With --ignore-errors a skipped DRM entry makes the exit code non-zero even
                // though a later candidate printed a good URL — trust stdout for SoundCloud.
                if ((result.code === 0 || engine === 'scsearch') && result.stdout.trim()) {
                    const resultUrl = result.stdout.trim().split('\n')[0].trim();
                    logger.info(`[YtDlp] Got audio URL from ${engine}`);
                    return resultUrl;
                }

                const stderr = result.stderr || '';
                if (engine === 'ytsearch' && looksLikeCookieRotation(stderr)) {
                    notifyCookieRotation({ source: 'getAudioUrlFromSearch', query: searchQuery, stderr }).catch(() => {});
                    if (attempt === 0) {
                        logger.warn(`[YtDlp] YouTube bot detection on search, retrying in 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                }
                // This engine failed for a non-retryable reason — move to the next one.
                logger.error(`[YtDlp] ${engine} stream failed (code ${result.code}): ${stderr.substring(0, 200)}`);
                break;
            }
        }

        throw new Error(`Failed to find audio for: ${searchQuery}`);
    }

    formatDuration(seconds) {
        if (!seconds) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

// ── Next-track prefetch ──────────────────────────────────────────────────────
// While a track plays, the NEXT YouTube track's signed audio URL is resolved in the background
// (residential resolver only — never the OVH pool, so prefetching can't add bot-wall noise) and
// cached until shortly before googlevideo's own `expire`. stream() takes it, or awaits an in-flight
// prefetch for the same URL instead of starting a duplicate resolve.
const PREFETCH_MAX_ENTRIES = 200;
const PREFETCH_MAX_AGE_MS = 60 * 60 * 1000;
const PREFETCH_EXPIRY_MARGIN_MS = 10 * 60 * 1000;
const prefetchCache = new Map();    // canonical url -> { url, expiresAt }
const prefetchInFlight = new Map(); // canonical url -> Promise<string|null>
const prefetchCounters = { started: 0, cached: 0, hits: 0, awaitedInFlight: 0, expired: 0, stale: 0, failed: 0 };

/** youtu.be / music / shorts / watch?v=…&list=… all key on the video id. */
export function canonicalYouTubeUrl(url) {
    try {
        const u = new URL(url);
        const id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0]
            : u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
        return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
    } catch { return null; }
}

/** Usable-until time for a signed googlevideo URL, or a relay URL carrying its `expire` (minus a margin, capped). */
export function prefetchExpiry(audioUrl, now = Date.now()) {
    let expireMs = now + PREFETCH_MAX_AGE_MS;
    try {
        const e = Number(new URL(audioUrl).searchParams.get('expire'));
        if (e > 0) expireMs = Math.min(expireMs, e * 1000 - PREFETCH_EXPIRY_MARGIN_MS);
    } catch { /* keep the cap */ }
    return expireMs;
}

export function prefetchStream(track) {
    const key = canonicalYouTubeUrl(track?.url);
    if (!key || track?.raw?.ytdlpUnresolved) return Promise.resolve(null);
    const hit = prefetchCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.url);
    if (prefetchInFlight.has(key)) return prefetchInFlight.get(key);

    prefetchCounters.started++;
    const p = tryLocalResolver({ url: key }).then((audioUrl) => {
        if (!audioUrl) { prefetchCounters.failed++; return null; }
        if (prefetchCache.size >= PREFETCH_MAX_ENTRIES) prefetchCache.delete(prefetchCache.keys().next().value);
        prefetchCache.set(key, { url: audioUrl, expiresAt: prefetchExpiry(audioUrl) });
        prefetchCounters.cached++;
        logger.info(`[Prefetch] ready: ${track.title || key}`);
        return audioUrl;
    }).catch(() => { prefetchCounters.failed++; return null; })
      .finally(() => prefetchInFlight.delete(key));
    prefetchInFlight.set(key, p);
    return p;
}

/** A prefetched URL for this track (awaiting an in-flight prefetch), or null. Single-use. */
export async function takePrefetched(url) {
    const key = canonicalYouTubeUrl(url);
    if (!key) return null;
    if (prefetchInFlight.has(key)) { prefetchCounters.awaitedInFlight++; await prefetchInFlight.get(key); }
    const hit = prefetchCache.get(key);
    if (!hit) return null;
    prefetchCache.delete(key);
    if (hit.expiresAt <= Date.now()) { prefetchCounters.expired++; return null; }
    // A relay token lives in the resolver's memory: if that resolver restarted since the prefetch
    // (crash, reboot, deploy), the URL is dead. One byte through the relay settles it in ~0.2s.
    if (hit.url.includes('/audio/') && !(await relayAnswers(hit.url))) {
        prefetchCounters.stale++;
        logger.warn(`[Prefetch] relay link for ${key} no longer answers — resolving again`);
        return null;
    }
    prefetchCounters.hits++;
    logger.info(`[Prefetch] hit for ${key}`);
    return hit.url;
}

async function relayAnswers(url) {
    try {
        const r = await fetch(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(4000) });
        await r.body?.cancel().catch(() => {});
        return r.status === 206 || r.status === 200;
    } catch { return false; }
}

export function getPrefetchStats() { return { ...prefetchCounters, cached_now: prefetchCache.size, inFlight: prefetchInFlight.size }; }

export { YtDlpExtractor };
