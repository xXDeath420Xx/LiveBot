/*
 * Docs search: the matching and ranking, shared by the server (/docs/search, dashboard/services/docs-search.js)
 * and the search box on /docs and /docs/guides (cf-docs-search.js), so both give the same answers.
 * No DOM, no imports. An index is a list of entries built by the server:
 *
 *   { k: kind, t: title, u: url, s: summary, p: parent label, x: more searchable text }
 *     kind  'guide' | 'step' (one step of a guide) | 'doc' (a section of a docs page) | 'command'
 *
 * A query matches an entry when every word of the query starts a word somewhere in the entry. Title
 * matches count most, then the parent, the summary and the rest. Commands also match their exact path
 * typed with or without the slash ("/level rank", "level rank").
 */

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'my', 'i', 'is', 'it',
    'how', 'do', 'does', 'can', 'what', 'where', 'when', 'why', 'which', 'you', 'your', 'me', 'be', 'by', 'at', 'from', 'about']);

/** Lower case, accents dropped, anything that is not a letter, digit or hyphen becomes a space. */
export function normalize(text) {
    return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9぀-ヿ一-鿿-]+/g, ' ').trim();
}

/** A word's search form: plural and -ing endings dropped so "filters" finds "filter" and "logging" finds "log". */
export function stem(word) {
    let w = word;
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    return w;
}

/** Words of a text in search form, hyphenated words also split ("anti-nuke" gives "anti-nuke", "anti", "nuke"). */
export function words(text) {
    const out = [];
    for (const w of normalize(text).split(/\s+/)) {
        if (!w) continue;
        out.push(stem(w));
        if (w.includes('-')) for (const part of w.split('-')) if (part) out.push(stem(part));
    }
    return out;
}

/** The query's words, minus filler ("how do I", "the"); a query of only filler keeps its words. */
export function queryTerms(query) {
    const all = normalize(query).split(/\s+/).filter(Boolean).slice(0, 12);
    const kept = all.filter((w) => !STOP.has(w));
    return (kept.length ? kept : all).map(stem).filter(Boolean);
}

const WEIGHT = { t: 10, p: 4, s: 3, x: 1 };
const KIND_BOOST = { guide: 1.35, doc: 1.15, step: 1, command: 1 };

/** Precomputed words for each entry (done once per index). */
export function prepare(entries) {
    return entries.map((e) => ({
        e,
        f: { t: words(e.t), p: words(e.p), s: words(e.s), x: words(e.x) },
        path: e.k === 'command' ? normalize(e.t.replace(/^\//, '')) : null,
    }));
}

function fieldScore(list, term) {
    let best = 0;
    for (const w of list) {
        if (w === term) return 1;
        if (w.startsWith(term)) best = Math.max(best, term.length >= 3 ? 0.7 : 0.4);
    }
    return best;
}

/**
 * Ranked matches for a query. `prepared` is prepare(entries). Returns [{ entry, score }], best first.
 * `limit` caps the list; `kinds` (a Set) keeps only those kinds.
 */
export function search(prepared, query, { limit = 50, kinds = null } = {}) {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const phrase = normalize(query).replace(/^\/+/, '');
    const out = [];
    for (const item of prepared) {
        if (kinds && !kinds.has(item.e.k)) continue;
        let score = 0;
        let ok = true;
        for (const term of terms) {
            let best = 0;
            for (const key of ['t', 'p', 's', 'x']) {
                const s = fieldScore(item.f[key], term);
                if (s) best = Math.max(best, s * WEIGHT[key]);
                if (best >= WEIGHT.t) break;
            }
            if (!best) { ok = false; break; }
            score += best;
        }
        if (!ok) continue;
        const title = normalize(item.e.t);
        if (title === phrase || item.path === phrase) score += 25;
        else if (title.startsWith(phrase) || (item.path && item.path.startsWith(phrase))) score += 8;
        score *= KIND_BOOST[item.e.k] || 1;
        // Shorter titles first among equals: "Levels" before "Levels, role rewards and rank cards".
        score -= Math.min(item.f.t.length, 12) * 0.05;
        out.push({ entry: item.e, score });
    }
    out.sort((a, b) => b.score - a.score || a.entry.t.localeCompare(b.entry.t));
    return out.slice(0, limit);
}

/** Labels for each kind, as the page and the box show them. */
export const KIND_LABEL = Object.freeze({ guide: 'Guide', step: 'Guide step', doc: 'Docs', command: 'Command' });
