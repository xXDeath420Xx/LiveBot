/**
 * Rumble platform module — live detection with NO API key.
 *
 * rumble.com itself sits behind a Cloudflare managed challenge that this host's IP
 * cannot pass (verified: curl, spoofed crawler UAs, and both headless and headful
 * Chrome with puppeteer-stealth all get a 403 "Just a moment..." that never
 * resolves). So the channel page can't be fetched from the apex domain.
 *
 * Rumble's own frontend hosts — web1/web7/web8/web9/wn0.rumble.com — serve the
 * identical channel page WITHOUT the challenge. Those pages embed the video grid
 * as JSON:
 *
 *   <rum-videos-grid><script type="application/json">{"items":[ ... ]}</script>
 *
 * Each item carries `live` (bool), `livestream_status` (2 = live), `watching_now`,
 * `title`, `thumb`, `upload_date` and the canonical per-stream `url`. That is
 * everything the stream checker needs, so no per-streamer Live Stream API key is
 * required.
 *
 * The key-based path (callApi/validateKey against the official Live Stream API) is
 * retained: `/rumble add` still accepts an optional key, and a stored key is used
 * as a fallback if the scrape ever fails.
 */
import logger from '../logger.js';
import pool from '../db.js';
import encryption from '../encryption.js';

const API = 'https://rumble.com/-livestream-api/get-data';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Rumble's frontend hosts. The apex (rumble.com) is Cloudflare-gated; these are not.
const HOSTS = ['web7.rumble.com', 'web8.rumble.com', 'web9.rumble.com', 'web1.rumble.com', 'wn0.rumble.com'];

// A channel lives at /user/<name> OR /c/<name>. We can't tell which from a bare
// username, so try both — Rumble 200s on the wrong one but omits the video grid.
const PATHS = (u) => [`/user/${u}`, `/c/${u}`];

const GRID_RE = /<rum-videos-grid>\s*<script type="application\/json">\s*([\s\S]*?)<\/script>/;

// The stream checker calls isStreamerLive() then getStreamDetails() back to back.
// One fetch answers both — cache the parsed grid briefly so we don't pull ~470KB twice.
const _cache = new Map(); // username(lowercased) -> { at, items }
const CACHE_MS = 20_000;

/** Fetch + parse a channel's video grid. Returns items[] or null. */
async function fetchItems(username) {
    const name = String(username).replace(/^@/, '');
    const ck = name.toLowerCase();
    const hit = _cache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;

    for (const host of HOSTS) {
        for (const path of PATHS(name)) {
            try {
                const res = await fetch(`https://${host}${path}`, {
                    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
                    signal: AbortSignal.timeout(15000),
                });
                if (!res.ok) continue;
                const html = await res.text();
                // Shouldn't happen on these hosts, but never parse a challenge page.
                if (/Just a moment|security verification/i.test(html)) continue;
                const m = html.match(GRID_RE);
                if (!m) continue; // 200 but wrong path form (e.g. /c/ for a /user/ channel)
                const items = JSON.parse(m[1])?.items;
                if (!Array.isArray(items)) continue;
                _cache.set(ck, { at: Date.now(), items });
                return items;
            } catch {
                // try the next host/path
            }
        }
    }
    logger.warn(`[Rumble] Could not load channel grid for "${username}" from any frontend host.`);
    return null;
}

/** The currently-live item in a grid, or null. */
function liveItem(items) {
    if (!Array.isArray(items)) return null;
    return items.find(i => i?.live === true || i?.livestream_status === 2) || null;
}

/** Does this Rumble channel exist? Used to verify a username at signup time. */
export async function validateUser(username) {
    const items = await fetchItems(username);
    if (!items) return null;
    const name = String(username).replace(/^@/, '');
    // `by.name` is the canonical capitalisation; fall back to what we were given.
    const canonical = items[0]?.by?.name || name;
    return { platformUserId: canonical, canonicalUsername: canonical };
}

/** Interface used by the stream checker: is this streamer live right now? */
export async function isStreamerLive(username) {
    const items = await fetchItems(username);
    if (items) return !!liveItem(items);
    return keyedIsLive(username); // scrape failed — fall back to a stored key, if any
}

/** Interface used by the stream checker: details for the current live stream. */
export async function getStreamDetails(username) {
    const items = await fetchItems(username);
    if (!items) return keyedDetails(username);
    const s = liveItem(items);
    if (!s) return null;
    const name = s.by?.name || String(username).replace(/^@/, '');
    return {
        title: s.title || 'Live on Rumble',
        game_name: (Array.isArray(s.tags) && s.tags[0]) || 'Live',
        viewer_count: s.watching_now ?? 'N/A',
        thumbnail_url: s.thumb || null,
        started_at: s.upload_date || null,
        // The per-stream permalink, so the announcement links the actual stream.
        url: s.url || `https://rumble.com/user/${name}`,
    };
}

/* ------------------------------------------------------------------ *
 * Optional Live Stream API key path (fallback / legacy)
 * ------------------------------------------------------------------ */

/** Load + decrypt a stored API key for a rumble username (null if none linked). */
async function getApiKey(username) {
    try {
        const [rows] = await pool.execute(
            'SELECT api_key FROM rumble_stream_keys WHERE LOWER(rumble_username) = LOWER(?) LIMIT 1',
            [username]
        );
        if (!rows.length) return null;
        return encryption.decrypt(JSON.parse(rows[0].api_key));
    } catch (e) {
        logger.error(`[Rumble] Failed to load API key for ${username}: ${e.message}`);
        return null;
    }
}

/** Call the Live Stream API with a raw key. Returns parsed JSON or {errors:[...]}. */
export async function callApi(key) {
    const res = await fetch(`${API}?key=${encodeURIComponent(key)}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    // The API returns JSON even on auth errors (e.g. {"errors":[{"code":"403"...}]})
    return res.json();
}

async function keyedData(username) {
    const key = await getApiKey(username);
    if (!key) return null;
    try {
        const data = await callApi(key);
        if (Array.isArray(data?.errors) && data.errors.length) return null;
        return data;
    } catch { return null; }
}

const keyedLive = (d) => (Array.isArray(d?.livestreams) ? d.livestreams : []).find(s => s?.is_live === true) || null;

async function keyedIsLive(username) {
    return !!keyedLive(await keyedData(username));
}

async function keyedDetails(username) {
    const s = keyedLive(await keyedData(username));
    if (!s) return null;
    const name = String(username).replace(/^@/, '');
    return {
        title: s.title || 'Live on Rumble',
        game_name: s.categories?.primary?.title || 'Live',
        viewer_count: (s.watching_now ?? s.watching ?? 'N/A'),
        thumbnail_url: null,
        started_at: s.created_on || null,
        url: `https://rumble.com/user/${name}`,
    };
}

/**
 * Validate an API key by calling the endpoint. Returns { ok, reason?, username?, live? }.
 * Only needed when someone explicitly supplies a key — detection no longer requires one.
 */
export async function validateKey(key) {
    try {
        const data = await callApi(key);
        if (!data || typeof data !== 'object') return { ok: false, reason: 'No response from Rumble' };
        if (Array.isArray(data.errors) && data.errors.length) {
            return { ok: false, reason: data.errors[0]?.message || 'Invalid API key' };
        }
        const s = keyedLive(data);
        return {
            ok: true,
            username: data.user?.username || null,
            channelId: data.channel_id || data.user?.id || null,
            live: !!s,
            title: s?.title || null,
            viewers: s?.watching_now ?? null,
        };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

export default { isStreamerLive, getStreamDetails, validateUser, validateKey, callApi };
