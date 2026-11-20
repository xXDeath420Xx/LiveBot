/**
 * Search across /docs: the guides (dashboard/content/guides), the docs pages (/docs and /docs/rpg) and the
 * command list (core/command-catalog.js, the same data as /commands). Built once in the dashboard process
 * from those sources, never from a hand-kept list, so it cannot drift from what the pages say. No external
 * search service: the index is served whole to the search box (GET /docs/search.json) and searched in
 * the browser, and /docs/search?q= answers the same query on the server for readers without JavaScript.
 * Matching and ranking: dashboard/public/js/cf-docs-search-core.js (shared by both sides).
 *
 * Entry: { k: 'guide' | 'step' | 'doc' | 'command', t: title, u: url, s: summary, p: parent label, x: more text }
 */
import crypto from 'node:crypto';
import { prepare, search, KIND_LABEL } from '../public/js/cf-docs-search-core.js';

const MAX_SUMMARY = 220;
const MAX_EXTRA = 1500;

/** Guide text without its inline marks: `code`, **bold** and [label](href) become their words. */
export function plain(text) {
    return String(text ?? '').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');
}
const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    const cut = t.lastIndexOf(' ', n - 1);
    return `${t.slice(0, cut > n * 0.6 ? cut : n - 1)}…`;
};

/** One entry per guide and one per step (linked to the step's anchor, #step-N on the guide page). */
export function guideEntries(guides = [], areas = []) {
    const areaTitle = new Map(areas.map((a) => [a.id, a.title]));
    const out = [];
    for (const g of guides) {
        const url = `/docs/guides/${g.slug}`;
        out.push({
            k: 'guide', t: g.title, u: url, s: clip(plain(g.summary), MAX_SUMMARY), p: areaTitle.get(g.area) || '',
            x: clip([g.result?.caption, ...(g.before || []), ...g.steps.map((s) => s.title), ...(g.notes || [])].map(plain).join(' '), MAX_EXTRA),
        });
        g.steps.forEach((s, i) => {
            out.push({
                k: 'step', t: plain(s.title), u: `${url}#step-${i + 1}`, s: clip(plain((s.text || [])[0]), MAX_SUMMARY), p: g.title,
                x: clip([...(s.text || []).slice(1), s.command || ''].map(plain).join(' '), MAX_EXTRA),
            });
        });
    }
    return out;
}

/** How a command path is written: the slash form, else the "/" form typed as a message, else the chat path. */
function pathLabel(p) {
    if (p.slash) return `/${p.slash}`;
    if (p.text) return p.text.startsWith('/') ? p.text : `/${p.text}`;
    return `/${p.path}`;
}

/** One entry per command and one per command path, from the /commands catalog. Links open the command's card. */
export function commandEntries(catalog) {
    const out = [];
    for (const c of catalog?.commands || []) {
        const url = `/commands#${encodeURIComponent(c.name)}`;
        // A right-click menu is reached by its name, not by typing it.
        const label = c.menu ? c.name : c.slash ? `/${c.slash}` : (c.text || `/${c.name}`);
        const paths = c.paths || [];
        const howTo = c.menu ? 'Right-click menu' : c.type === 'text' ? 'Typed as a message' : 'Slash command';
        out.push({
            k: 'command', t: label, u: url, s: clip(c.description, MAX_SUMMARY), p: `${howTo} · ${c.category || 'General'}`,
            x: clip([c.name, ...(c.builtinAliases || []), ...paths.map((p) => p.path)].join(' '), MAX_EXTRA),
        });
        // A command with a single path is already its own entry.
        if (paths.length === 1 && paths[0].path === c.name) continue;
        for (const p of paths) {
            if (p.path === c.name) continue;
            out.push({
                k: 'command', t: pathLabel(p), u: url, s: clip(p.description, MAX_SUMMARY), p: label,
                x: clip([p.path, ...(p.shortcuts || []), ...(p.options || []).map((o) => o.name)].join(' '), MAX_EXTRA),
            });
        }
    }
    return out;
}

const decode = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
const textOf = (html) => decode(String(html).replace(/<(script|style|nav)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * The sections of a rendered docs page: every element with an id inside <main> that has a heading, with
 * the text up to the next such element. `skip` lists ids that are not content (the guide list on /docs).
 */
export function docEntries(html, { url, page, skip = [] }) {
    const main = (String(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || [])[1] || '';
    const marks = [...main.matchAll(/<(h2|h3|div|section)\b[^>]*\sid="([\w-]+)"[^>]*>/gi)].map((m) => ({ tag: m[1].toLowerCase(), id: m[2], at: m.index, end: m.index + m[0].length }));
    const out = [];
    marks.forEach((m, i) => {
        if (skip.includes(m.id) || m.id === 'main-content') return;
        const body = main.slice(m.end, i + 1 < marks.length ? marks[i + 1].at : main.length);
        let title;
        if (m.tag === 'h2' || m.tag === 'h3') title = textOf((body.match(new RegExp(`^([\\s\\S]*?)</${m.tag}>`, 'i')) || [])[1] || '');
        else title = textOf((body.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i) || [])[1] || '');
        const text = textOf(m.tag === 'h2' || m.tag === 'h3' ? body.replace(new RegExp(`^[\\s\\S]*?</${m.tag}>`, 'i'), '') : body.replace(/<h[23]\b[^>]*>[\s\S]*?<\/h[23]>/i, ''));
        if (!title || text.length < 30) return;
        out.push({ k: 'doc', t: title, u: `${url}#${m.id}`, s: clip(text, MAX_SUMMARY), p: page, x: clip(text, MAX_EXTRA) });
    });
    return out;
}

/** The whole index from its sources. Pure. */
export function buildIndex({ guides = [], areas = [], catalog = null, pages = [] } = {}) {
    return [
        ...guideEntries(guides, areas),
        ...pages.flatMap((p) => docEntries(p.html, p)),
        ...commandEntries(catalog),
    ];
}

/** The index as the search box loads it: entries as arrays, and a version for caching. */
export function toClientJson(entries) {
    const e = entries.map((x) => [x.k, x.t, x.u, x.s, x.p, x.x]);
    const body = JSON.stringify({ v: 1, n: e.length, e });
    return { body, etag: `"ds-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
}

/** Results for the no-JavaScript page, grouped the way the page shows them. */
export function groupedResults(prepared, query, { perGroup = 12 } = {}) {
    const all = search(prepared, query, { limit: 500 });
    const groups = [
        { id: 'guides', title: 'Guides', kinds: ['guide', 'step'] },
        { id: 'docs', title: 'Documentation', kinds: ['doc'] },
        { id: 'commands', title: 'Commands', kinds: ['command'] },
    ].map((g) => {
        const hits = all.filter((r) => g.kinds.includes(r.entry.k));
        return { ...g, total: hits.length, results: hits.slice(0, perGroup).map((r) => ({ ...r.entry, label: KIND_LABEL[r.entry.k] })) };
    });
    return { query, total: all.length, groups: groups.filter((g) => g.total) };
}

/**
 * The live search. `getGuides()` -> { GUIDES, AREAS }; `getCatalog()` -> the /commands catalog;
 * `renderPages()` -> [{ url, page, html, skip }] (rendered once). The index is rebuilt when the guides or
 * the command catalog change (a catalog with no commands yet, before the bot has loaded them, is not kept).
 */
export function createDocsSearch({ getGuides, getCatalog, renderPages }) {
    let built = null;
    let pages = null;
    return {
        async get() {
            const { GUIDES = [], AREAS = [] } = getGuides() || {};
            const catalog = getCatalog();
            if (built && built.guides === GUIDES && built.catalog === catalog) return built;
            if (!pages) {
                try { pages = await renderPages(); } catch { pages = null; }
            }
            const entries = buildIndex({ guides: GUIDES, areas: AREAS, catalog, pages: pages || [] });
            const next = { guides: GUIDES, catalog, entries, prepared: prepare(entries), ...toClientJson(entries) };
            if (catalog?.commands?.length && pages) built = next;
            return next;
        },
        async search(query, opts) {
            const { prepared } = await this.get();
            return groupedResults(prepared, query, opts);
        },
    };
}

export default { plain, guideEntries, commandEntries, docEntries, buildIndex, toClientJson, groupedResults, createDocsSearch };
