/*
 * Validation and formatting for suggestion tags — pure, so tests/suggestion-tags.test.js can run
 * without the database. Storage is core/suggestion-tags.js.
 */

export const MAX_TAGS_PER_GUILD = 25;      // one autocomplete page / one select menu
export const MAX_TAGS_PER_SUGGESTION = 5;  // also Discord's cap on applied forum tags
export const DEFAULT_TAG_COLOR = '#3498db';
export const SUGGESTION_STATUSES = Object.freeze(['pending', 'under_review', 'approved', 'rejected', 'implemented', 'duplicate']);
export const SORTS = Object.freeze(['newest', 'oldest', 'most_voted']);

/** Trimmed, single-spaced tag name (1-50 chars) or null. */
export function normaliseTagName(input) {
    if (input == null) return null;
    const name = String(input).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 50) return null;
    return name;
}

/** "#abc", "abc", "#AABBCC" -> "#aabbcc"; anything else -> null. */
export function normaliseTagColor(input) {
    if (input == null || input === '') return null;
    let s = String(input).trim().toLowerCase();
    if (!s.startsWith('#')) s = `#${s}`;
    if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * A unicode emoji (one grapheme cluster, possibly with modifiers) or a custom emoji mention
 * <:name:id> / <a:name:id>. Returns the emoji string, '' for "none", or null if invalid.
 */
export function normaliseTagEmoji(input) {
    if (input == null) return '';
    const s = String(input).trim();
    if (!s) return '';
    if (/^<a?:\w{2,32}:\d{15,25}>$/.test(s)) return s;
    if (s.length > 16 || /[\p{L}\s]/u.test(s)) return null;
    if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(s)) return null;
    return s;
}

/** "🐛 Bug, ✨ Feature" — or "None". Discord embed field values must be non-empty. */
export function formatTagList(tags) {
    if (!tags?.length) return 'None';
    return tags
        .map((t) => (t.tag_emoji && t.tag_emoji !== '?️' ? `${t.tag_emoji} ${t.tag_name}` : t.tag_name))
        .join(', ')
        .slice(0, 1024);
}

/** Filters from a query string, reduced to values the dashboard query accepts. */
export function normaliseFilters(query = {}) {
    const status = SUGGESTION_STATUSES.includes(query.status) ? query.status : null;
    const tagId = /^\d{1,10}$/.test(String(query.tag ?? '')) ? Number(query.tag) : null;
    const sort = SORTS.includes(query.sort) ? query.sort : 'newest';
    return { status, tagId, sort };
}

export default {
    MAX_TAGS_PER_GUILD, MAX_TAGS_PER_SUGGESTION, DEFAULT_TAG_COLOR, SUGGESTION_STATUSES, SORTS,
    normaliseTagName, normaliseTagColor, normaliseTagEmoji, formatTagList, normaliseFilters,
};
