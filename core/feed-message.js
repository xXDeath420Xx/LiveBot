/*
 * Per-feed options shared by the social feed posters (core/reddit-feed.js, core/youtube-feed.js,
 * core/twitter-feed.js, core/bluesky-feed.js): the custom message template, the optional ping role,
 * and the keyword lists used by the title filters.
 *
 * Every helper treats an empty or missing option as "off", so a feed row saved before these options
 * existed (or a database the migration has not reached yet) posts exactly as it did before.
 */

/** Longest stored template / keyword list; the dashboard API enforces the same limits. */
export const FEED_MESSAGE_MAX = 1500;
export const FEED_KEYWORDS_MAX = 500;
/** Discord's message content limit. */
const CONTENT_MAX = 2000;

/**
 * A comma- or newline-separated list as an array of trimmed, lower-cased, de-duplicated entries.
 * Accepts an array too. Empty entries are dropped.
 */
export function parseList(raw) {
    if (raw == null) return [];
    const parts = Array.isArray(raw) ? raw : String(raw).split(/[,\n]/);
    const out = [];
    for (const p of parts) {
        const v = String(p).trim().toLowerCase();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

/** A list cleaned for storage: "a, b, c" or null when empty. Clipped to `max` characters. */
export function cleanList(raw, max = FEED_KEYWORDS_MAX) {
    if (raw == null) return null;
    const parts = (Array.isArray(raw) ? raw : String(raw).split(/[,\n]/))
        .map(p => String(p).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const seen = new Set();
    const kept = [];
    for (const p of parts) {
        const k = p.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(p);
    }
    let s = kept.join(', ');
    if (s.length > max) s = s.slice(0, max).replace(/,\s*[^,]*$/, '');
    return s || null;
}

/** True when any keyword appears (case-insensitive) in any of the texts. */
export function containsAny(keywords, ...texts) {
    const list = parseList(keywords);
    if (!list.length) return false;
    const hay = texts.flat().filter(t => t != null).map(t => String(t).toLowerCase());
    return list.some(k => hay.some(h => h.includes(k)));
}

/**
 * The title include/exclude filter. `include` empty means every title passes; any `exclude` keyword
 * found holds the post back.
 */
export function titlePasses({ include, exclude }, ...texts) {
    if (parseList(exclude).length && containsAny(exclude, ...texts)) return false;
    if (parseList(include).length && !containsAny(include, ...texts)) return false;
    return true;
}

/**
 * Fill {variables} in a template. Unknown variables are left as typed. Matching is case-insensitive
 * ({Title} and {title} both work). Values are plain text; nothing is evaluated.
 */
export function renderTemplate(template, vars = {}) {
    if (!template) return '';
    const lower = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
    return String(template).replace(/\{([a-z_]+)\}/gi, (whole, key) => {
        const v = lower[key.toLowerCase()];
        return v == null ? whole : String(v);
    });
}

/**
 * The ping for a feed's ping_role_id: a role id, the literal 'everyone', or empty for none.
 * Returns the mention text and the allowedMentions that lets exactly that ping through.
 */
export function pingFor(pingRoleId) {
    const id = pingRoleId ? String(pingRoleId).trim() : '';
    if (!id) return { mention: null, allowedMentions: null };
    if (id === 'everyone') return { mention: '@everyone', allowedMentions: { parse: ['everyone'] } };
    if (!/^\d{17,20}$/.test(id)) return { mention: null, allowedMentions: null };
    return { mention: `<@&${id}>`, allowedMentions: { parse: [], roles: [id] } };
}

/**
 * The message content for one post: the rendered template (or `fallback` when the feed has none),
 * with the ping in front when one is set. Returns { content, allowedMentions }.
 *
 * With no ping role, allowedMentions is left undefined, which is how these feeds always sent their
 * custom messages; with one, only that ping is let through.
 */
export function buildFeedContent({ template, vars, pingRoleId, fallback = null }) {
    const body = template && String(template).trim() ? renderTemplate(String(template).trim(), vars) : (fallback || '');
    const { mention, allowedMentions } = pingFor(pingRoleId);
    let content = mention ? (body ? `${mention} ${body}` : mention) : body;
    if (content.length > CONTENT_MAX) content = content.slice(0, CONTENT_MAX - 1) + '…';
    return { content: content || undefined, allowedMentions: allowedMentions || undefined };
}

/** The variables each feed type fills, for the dashboard's hints. */
export const FEED_TEMPLATE_VARS = Object.freeze({
    reddit: ['{subreddit}', '{title}', '{author}', '{flair}', '{url}'],
    youtube: ['{channel}', '{title}', '{type}', '{url}'],
    twitter: ['{username}', '{name}', '{url}'],
    bluesky: ['{handle}', '{name}', '{url}'],
});
