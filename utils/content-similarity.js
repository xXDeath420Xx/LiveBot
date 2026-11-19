/*
 * "Have we already said this?"
 *
 * A feed channel that also follows the publisher's own announcement channel will
 * carry the same news twice in different words — Epic posts "Power Hours: Cheat
 * Master Sprites This Weekend" and a games site posts "Fortnite Power Hour Today
 * Schedule: Featured Sprites and Rewards". Exact-match dedup sees two different
 * strings; a reader sees the same story.
 *
 * So the comparison is on meaning-bearing words, not characters:
 *   - markdown, punctuation, emoji and Discord timestamps are stripped
 *   - stopwords go, along with words that appear in nearly every gaming headline
 *     ("fortnite", "update", "new") — leaving them in makes everything look alike
 *   - trailing plurals are folded, so "hours" and "hour" match
 *   - what remains is compared with the Dice coefficient, which is forgiving of
 *     one side being longer than the other
 *
 * A shared link is treated as proof on its own: two posts pointing at the same
 * article are the same post however differently they are worded.
 */

const STOP = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'come', 'comes',
    'for', 'from', 'get', 'gets', 'has', 'have', 'here', 'how', 'in', 'into', 'is', 'it', 'its',
    'more', 'no', 'not', 'now', 'of', 'off', 'on', 'or', 'our', 'out', 'over', 'so', 'some',
    'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'via',
    'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'will', 'with', 'you',
    'your', 'all', 'also', 'about', 'after', 'again', 'back', 'just', 'like', 'only', 'today',
    'tomorrow', 'week', 'weekend', 'day', 'days',
    // Words in nearly every gaming headline. Keeping them makes unrelated posts
    // look related, which is worse than missing a duplicate.
    'fortnite', 'game', 'games', 'gaming', 'update', 'updates', 'patch', 'notes', 'new',
    'news', 'full', 'list', 'guide', 'everything', 'revealed', 'reveal', 'leak', 'leaks',
    'leaked', 'coming', 'available', 'season', 'chapter', 'players', 'player',
]);

/** Strip the things that differ between two tellings of the same story. */
export function normalise(text) {
    return String(text || '')
        .replace(/<t:\d+(?::[a-zA-Z])?>/g, ' ')      // Discord timestamps
        .replace(/<a?:\w+:\d+>/g, ' ')               // custom emoji
        .replace(/https?:\/\/\S+/g, ' ')             // urls compared separately
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
        .replace(/[#*_~`>|]/g, ' ')                  // markdown
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The words worth comparing, de-pluralised. */
export function significantTokens(text) {
    return new Set(
        normalise(text)
            .split(' ')
            .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
            .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
    );
}

/** Dice coefficient: 2×shared / (a + b). 1 is identical, 0 shares nothing. */
export function similarity(a, b) {
    const A = a instanceof Set ? a : significantTokens(a);
    const B = b instanceof Set ? b : significantTokens(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return (2 * shared) / (A.size + B.size);
}

/**
 * Links that identify a specific piece of content.
 *
 * A landing page is not an identity. Every Epic message-of-the-day points at
 * fortnite.com/news, and every shop post at fortnite.com/item-shop, so treating
 * any shared link as proof would collapse four distinct announcements into one.
 * A link only counts when it names something: two or more path segments, or a
 * single segment long enough to be a slug rather than a section.
 */
export function links(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(/https?:\/\/([^\s<>"')]+)/g)) {
        const clean = m[1].replace(/[).,]+$/, '').replace(/\/$/, '').toLowerCase().split('?')[0];
        const segments = clean.split('/').slice(1).filter(Boolean);
        const identifying = segments.length >= 2
            || (segments.length === 1 && segments[0].length >= 12);
        if (identifying) out.add(clean);
    }
    return out;
}

/**
 * Is `candidate` already covered by something in `existing`?
 *
 * `existing` is a list of {text, url} already visible in the channel. Returns the
 * match so the caller can log WHY something was held back — a feed that silently
 * drops posts is impossible to trust or debug.
 */
export function findDuplicate(candidate, existing, { threshold = 0.5 } = {}) {
    const candTokens = significantTokens(`${candidate.title || ''} ${candidate.blurb || ''}`);
    const candLinks = links(`${candidate.url || ''} ${candidate.blurb || ''}`);
    let best = null;

    for (const item of existing) {
        // Same link, same story. No scoring needed.
        for (const l of links(`${item.url || ''} ${item.text || ''}`)) {
            if (candLinks.has(l)) return { match: item, score: 1, reason: `same link (${l})` };
        }
        const score = similarity(candTokens, significantTokens(item.text));
        if (!best || score > best.score) best = { match: item, score, reason: 'wording overlap' };
    }
    if (best && best.score >= threshold) return best;
    return null;
}

export default { normalise, significantTokens, similarity, links, findDuplicate };
