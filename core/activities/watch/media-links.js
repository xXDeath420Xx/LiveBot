/*
 * Watch Together: the short-lived signed links the video player fetches, and the playlist rewrite that makes them.
 *
 * Jellyfin's HLS playlists point at Jellyfin (main.m3u8, hls1/main/<n>.ts, Trickplay/...), and Jellyfin writes its
 * API key into some of those addresses (the Trickplay line, even when we authenticate with a header). The browser
 * must never see either. So every playlist goes through rewritePlaylist():
 *   - each address is resolved against the playlist it came from, any api_key / ApiKey parameter is removed, and it
 *     must be one of Jellyfin's video paths for the playing title (allowedUpstreamPath) or the line is dropped;
 *   - it is replaced by a sibling file name "<base64url(path)>.<signature>.<ext>". The signature is an HMAC with a
 *     key derived from the session secret, the session id and the media generation (mediaKey), so a link only works
 *     for the title that session is playing now, and a new title (or the end of the session) kills every old link;
 *   - the image (Trickplay) stream line is dropped.
 * All links live in one folder, media/<session id>/<generation>/, so a relative name resolves the same inside Discord's
 * proxy (<app>.discordsays.com/media/...) and on the site (/activity/media/...).
 */
import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

/** The signing key for one session's one title. */
export function mediaKey(secret, sessionId, gen) {
    return crypto.createHmac('sha256', String(secret)).update(`watch-media:${sessionId}:${gen}`).digest();
}

const sig = (key, rel) => crypto.createHmac('sha256', key).update(rel).digest('base64url').slice(0, 27);

/** "<base64url(rel)>.<sig>.<ext>" for an upstream path (path + query, no key). */
export function signRef(key, rel) {
    const ext = (rel.split('?')[0].match(/\.(m3u8|ts|mp4|m4s|vtt|aac)$/i) || [null, 'bin'])[1].toLowerCase();
    return `${b64(rel)}.${sig(key, rel)}.${ext}`;
}

const REF_RE = /^([A-Za-z0-9_-]{4,3000})\.([A-Za-z0-9_-]{27})\.(m3u8|ts|mp4|m4s|vtt|aac|bin)$/;

/** The upstream path a signed name stands for, or null (bad shape or signature). */
export function verifyRef(key, name) {
    const m = String(name || '').match(REF_RE);
    if (!m) return null;
    let rel;
    try { rel = unb64(m[1]); } catch { return null; }
    const want = Buffer.from(sig(key, rel));
    const got = Buffer.from(m[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return rel;
}

const KEY_PARAMS = /^(api_key|apikey|api-key|x-emby-token|x-mediabrowser-token)$/i;

/** path + query of a URL with every API-key style parameter removed. */
export function stripKeyParams(u) {
    const url = u instanceof URL ? new URL(u.href) : new URL(String(u), 'http://x');
    for (const k of [...url.searchParams.keys()]) if (KEY_PARAMS.test(k)) url.searchParams.delete(k);
    const q = url.searchParams.toString();
    return url.pathname + (q ? `?${q}` : '');
}

/** Jellyfin ids appear as 32 hex (API) or as a dashed GUID (paths). */
export const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase();

const VIDEO_PATH_RE = /^\/videos\/([0-9a-f-]{32,36})\/(.+)$/i;

/**
 * Only Jellyfin's video files for this title may be fetched through a signed link: its HLS playlists and segments,
 * and its subtitle files. Matched case-insensitively (Jellyfin writes /videos/ and /Videos/).
 */
export function allowedUpstreamPath(rel, itemId) {
    const path = String(rel).split('?')[0];
    if (path.includes('..') || path.includes('//') || /%2e|%2f|%5c/i.test(path)) return false;
    const m = path.match(VIDEO_PATH_RE);
    if (!m || normId(m[1]) !== normId(itemId)) return false;
    const rest = m[2];
    return /^(master|main|live)\.m3u8$/i.test(rest)
        || /^hls\d*\/[A-Za-z0-9_]{1,40}\/-?\d{1,6}\.(ts|mp4|m4s|aac)$/i.test(rest)
        || /^hls\d*\/[A-Za-z0-9_]{1,40}\/[A-Za-z0-9_-]{1,40}\.m3u8$/i.test(rest)
        || /^[0-9a-f-]{32,36}\/subtitles\/\d{1,4}\/\d{1,9}\/stream\.vtt$/i.test(rest);
}

/**
 * Rewrite one HLS playlist. `base` is the upstream path (+ query) it was fetched from. Returns the new text; an
 * address that is not allowed is dropped together with the tag line that announces it.
 */
export function rewritePlaylist(text, base, { key, itemId }) {
    const baseUrl = new URL(String(base), 'http://jellyfin.invalid');
    const map = (uri) => {
        let abs;
        try { abs = new URL(uri, baseUrl); } catch { return null; }
        if (abs.origin !== baseUrl.origin) return null; // an absolute address elsewhere: never followed
        const rel = stripKeyParams(abs);
        return allowedUpstreamPath(rel, itemId) ? signRef(key, rel) : null;
    };
    const out = [];
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let pendingTag = null; // an #EXT-X-STREAM-INF / #EXTINF line waiting for its address line
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            if (/^#EXT-X-IMAGE-STREAM-INF/i.test(line)) continue; // Trickplay thumbnails: not needed, and carry the key
            if (/^#EXT-X-(KEY|SESSION-KEY)\b/i.test(line)) continue; // Jellyfin's HLS is not encrypted; never proxy keys
            if (/URI="/i.test(line)) {
                let ok = true;
                const re = line.replace(/URI="([^"]*)"/gi, (_, u) => {
                    const r = map(u);
                    if (!r) ok = false;
                    return `URI="${r || ''}"`;
                });
                if (ok) out.push(re);
                continue;
            }
            if (/^#(EXTINF|EXT-X-STREAM-INF)/i.test(line)) { pendingTag = line; continue; }
            out.push(line);
            continue;
        }
        const r = map(line);
        if (r) {
            if (pendingTag) out.push(pendingTag);
            out.push(r);
        }
        pendingTag = null;
    }
    return out.join('\n') + '\n';
}
