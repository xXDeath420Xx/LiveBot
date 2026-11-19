/**
 * One place to get posts out of a subreddit.
 *
 * Reddit closed its unauthenticated JSON endpoints. As of Aug 2026,
 * `https://www.reddit.com/r/<sub>/new.json` returns HTTP 403 for every User-Agent
 * we tried — descriptive, browser-shaped, and Reddit's own recommended
 * `platform:app:version (by /u/user)` format alike — and old.reddit.com does the
 * same. Three separate callers were still hitting that endpoint directly
 * (core/reddit-feed.js, core/auto-meme-manager.js, core/poker-meme-generator.js),
 * and all three had been silently returning nothing: the 403 landed in a catch that
 * logged at warn/error level and moved on, so feeds simply stopped posting.
 *
 * Two paths remain:
 *
 *   1. OAuth (preferred). A free "script" app at https://www.reddit.com/prefs/apps
 *      gives a client id + secret; the client_credentials grant then returns an
 *      app-only token good for ~24h against oauth.reddit.com, which serves the full
 *      post objects — including `over_18`, `score` and `stickied`. Set
 *      REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable it.
 *
 *   2. The public Atom feed (`/r/<sub>/<sort>/.rss`), which is still served
 *      anonymously. It carries id, title, permalink, author, timestamp, thumbnail
 *      and the post body, but NOT the score, NOT `stickied`, and — critically — no
 *      NSFW flag.
 *
 * Callers that must not surface NSFW content (the meme pickers) have to check
 * `nsfwKnown` on the result and refuse to post when it's false. There is no way to
 * filter what the feed doesn't tell us, and guessing is not an option.
 */

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import logger from './logger.js';

const LOG_TAG = '[Reddit]';
const USER_AGENT = 'nodejs:CertiFriedUtility:1.0 (by /u/certifried)';

const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const OAUTH_API_BASE = 'https://oauth.reddit.com';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Cached app-only token. Reddit issues these for ~24h; refresh a minute early.
let tokenCache = null; // { token, expiresAt }
let warnedNoCredentials = false;

/** True when Reddit API credentials are configured. Without them Reddit refuses the server (H-201). */
export function redditAvailable() { return hasCredentials(); }
export const REDDIT_UNAVAILABLE_NOTE = "Reddit no longer lets bots read subreddits: since November 2025 its API needs approval Reddit is not granting to new apps, and it blocks requests from bot servers.";

function hasCredentials() {
    return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function getAppToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;

    const auth = Buffer
        .from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`)
        .toString('base64');

    const response = await axios.post(
        OAUTH_TOKEN_URL,
        'grant_type=client_credentials',
        {
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
            },
            timeout: 10000,
        },
    );

    const token = response.data?.access_token;
    if (!token) throw new Error('Reddit returned no access_token');

    const ttlMs = ((response.data.expires_in || 3600) - 60) * 1000;
    tokenCache = { token, expiresAt: Date.now() + ttlMs };
    return token;
}

/** `fast-xml-parser` returns a bare object rather than an array when there's one entry. */
function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * Pull the direct media URL out of an Atom entry's HTML body.
 *
 * Reddit renders image/link posts as `<a href="<media>">[link]</a>`, where <media>
 * is i.redd.it / imgur / whatever was submitted. For a self post the same anchor
 * points back at the comments page, so compare against the permalink and treat a
 * match as "no external media".
 */
function extractMediaUrl(contentHtml, permalink) {
    if (!contentHtml) return null;
    const match = contentHtml.match(/<a href="([^"]+)">\s*\[link\]\s*<\/a>/i);
    const url = match?.[1];
    if (!url || url === permalink) return null;
    return url;
}

/** Strip tags and collapse whitespace, for use as an embed description. */
function htmlToText(html) {
    if (!html) return '';
    return html
        .replace(/<!--.*?-->/gs, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#32;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeOAuthPost(child) {
    const d = child.data;
    return {
        id: d.id,
        title: d.title || '',
        permalink: `https://www.reddit.com${d.permalink}`,
        author: d.author,
        createdAt: d.created_utc ? new Date(d.created_utc * 1000) : null,
        thumbnail: d.thumbnail && d.thumbnail.startsWith('http') ? d.thumbnail : null,
        mediaUrl: d.url || null,
        selftext: d.selftext || '',
        score: typeof d.ups === 'number' ? d.ups : null,
        isNsfw: !!d.over_18,
        isStickied: !!d.stickied,
        isImage: d.post_hint === 'image' || /\.(jpg|jpeg|png|gif)$/i.test(d.url || ''),
        flair: d.link_flair_text || null,
    };
}

function normalizeRssEntry(entry) {
    // Atom ids are fullnames ("t3_1vp4ot3"); every other caller works in bare ids.
    const rawId = String(entry.id || '');
    const id = rawId.startsWith('t3_') ? rawId.slice(3) : rawId;
    const permalink = entry.link?.['@_href'] || '';
    const contentHtml = typeof entry.content === 'object'
        ? (entry.content['#text'] || '')
        : (entry.content || '');
    const mediaUrl = extractMediaUrl(contentHtml, permalink);
    const published = entry.published || entry.updated;

    return {
        id,
        title: typeof entry.title === 'object' ? (entry.title['#text'] || '') : (entry.title || ''),
        permalink,
        // Atom spells authors "/u/name"; callers render their own "u/" prefix.
        author: String(entry.author?.name || '').replace(/^\/u\//, ''),
        createdAt: published ? new Date(published) : null,
        thumbnail: entry['media:thumbnail']?.['@_url'] || null,
        mediaUrl,
        selftext: htmlToText(contentHtml).replace(/\s*submitted by\s*\/u\/\S+\s*\[link\]\s*\[comments\]\s*$/i, ''),
        // The Atom feed carries none of these.
        score: null,
        isNsfw: false,
        isStickied: false,
        isImage: /\.(jpg|jpeg|png|gif)$/i.test(mediaUrl || ''),
        // The Atom feed does not carry the post flair.
        flair: null,
    };
}

/**
 * Fetch posts from a subreddit.
 *
 * @param {string} subreddit    Name without the leading `r/`.
 * @param {object} [options]
 * @param {string} [options.sort='new']   'new' | 'hot' | 'top' | 'rising'
 * @param {number} [options.limit=25]
 * @returns {Promise<{posts: Array, nsfwKnown: boolean, source: 'oauth'|'rss'}>}
 *          `nsfwKnown` is false on the RSS path — `isNsfw` is then a default, not a
 *          verdict, and must not be treated as "this post is safe".
 */
export async function fetchSubredditPosts(subreddit, { sort = 'new', limit = 25 } = {}) {
    if (hasCredentials()) {
        try {
            const token = await getAppToken();
            const response = await axios.get(
                `${OAUTH_API_BASE}/r/${encodeURIComponent(subreddit)}/${sort}`,
                {
                    params: { limit, raw_json: 1 },
                    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
                    timeout: 10000,
                },
            );
            const children = response.data?.data?.children || [];
            return { posts: children.map(normalizeOAuthPost), nsfwKnown: true, source: 'oauth' };
        } catch (error) {
            // A bad token is worth retrying from scratch next call.
            tokenCache = null;
            logger.warn(`${LOG_TAG} OAuth fetch failed for r/${subreddit}, falling back to the public feed`, {
                error: error.message,
            });
        }
    } else if (!warnedNoCredentials) {
        warnedNoCredentials = true;
        logger.warn(`${LOG_TAG} REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set — using the public Atom feed. ` +
            'Scores and NSFW flags are unavailable, so NSFW-filtered features stay disabled.');
    }

    const response = await axios.get(
        `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}/.rss`,
        { params: { limit }, headers: { 'User-Agent': USER_AGENT }, timeout: 10000 },
    );

    const feed = parser.parse(response.data)?.feed;
    const entries = asArray(feed?.entry);
    return { posts: entries.map(normalizeRssEntry), nsfwKnown: false, source: 'rss' };
}

export { hasCredentials as hasRedditCredentials };
