/*
 * Settings-field search index: lets the manage overview's search and the Ctrl+K finder match the
 * individual settings INSIDE pages ("mute role", "log channel", "captcha tries"), not just page
 * titles. Choosing a result opens the page with ?field=<element id> (or ?field=text:<label> when
 * the setting has no id); cf-manage.js scrolls to that field and highlights it.
 *
 * Built from the templates themselves, so it can never list a setting that is not on the page:
 *
 *   page -> partial    the static pageMap in dashboard/views/manage-tailwind.ejs (the same block
 *                      tests/manage-nav.test.js parses); includes inside a partial are followed
 *   fields             <label for="id">Text</label>; a <label> wrapping its control
 *                      (<label><input id="x"> Text</label>); controls with an id and aria-label;
 *                      h2-h4 headings (by id when they have one, else by text)
 *   generated pages    core/feature-config-spec.js fields (label + the fc-f-<key> id the
 *                      feature-config partial gives each control)
 *
 * Scripts, styles and EJS comments are ignored; labels or ids built by EJS (<%= ... %>) are
 * skipped, since their text is not known until render. A partial that serves several pages is
 * indexed once, under the first of them in navigation order.
 *
 * Built lazily on the first request and cached until the dashboard's view engine reloads
 * (scripts/reload-dashboard.mjs bumps its generation). extractFields / parsePageMap /
 * buildIndex are pure and tested in tests/nav-polish.test.js; served by GET /api/settings-index.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_PER_PAGE = 80;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ', '&middot;': '·', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…' };

/** Visible text of a markup fragment: tags and EJS removed, entities decoded, spaces collapsed. */
export function cleanText(fragment) {
    return String(fragment ?? '')
        .replace(/<%[\s\S]*?%>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const usableLabel = (t) => t.length >= 2 && t.length <= 90 && /[a-z]/i.test(t) && !/^[\d\W]+$/.test(t);
const usableId = (id) => !!id && /^[A-Za-z][\w:.-]{0,80}$/.test(id);
const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, 'i'));
    return m ? m[1] : null;
};

/** The partial source with <script>, <style> and EJS comment/code blocks that cannot be fields removed. */
function stripNonMarkup(src) {
    return String(src ?? '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<%#[\s\S]*?%>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Fields in one template's source.
 * @returns {Array<{ label: string, field: string }>}  field = element id, or 'text:<label>'
 */
export function extractFields(src) {
    const s = stripNonMarkup(src);
    const out = [];
    const seen = new Set();
    const push = (label, field) => {
        const key = label.toLowerCase();
        if (!usableLabel(label) || seen.has(key)) return;
        seen.add(key);
        out.push({ label, field });
    };
    // <label ...>...</label>: for= wins; else the first control inside it.
    for (const m of s.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
        const open = `<label${m[1]}>`;
        const forId = attr(open, 'for');
        const inner = m[2];
        let id = forId;
        if (!id) {
            const control = inner.match(/<(?:input|select|textarea)\b[^>]*>/i);
            id = control ? attr(control[0], 'id') : null;
        }
        if (id && /<%/.test(id)) continue;
        // A label that carries its own help line (<strong>Name</strong><small>help</small>):
        // the name is the part before the first block of help text.
        let text = cleanText(inner);
        const cut = inner.search(/<(?:small|p|br|div[^>]*(?:hint|desc|help|muted))\b/i);
        if (cut > 0 && cleanText(inner.slice(0, cut)).length >= 3) text = cleanText(inner.slice(0, cut));
        if (usableId(id)) push(text, id);
    }
    // Controls labelled by aria-label.
    for (const m of s.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
        const id = attr(m[0], 'id');
        const label = attr(m[0], 'aria-label');
        if (usableId(id) && label && !/<%/.test(label) && !/<%/.test(id)) push(cleanText(label), id);
    }
    // Headings: by id when there is one, else by their text.
    for (const m of s.matchAll(/<h([234])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)) {
        const id = attr(`<h${m[2]}>`, 'id');
        const text = cleanText(m[3]);   // EJS output is dropped; a heading made only of it has no text
        if (!text) continue;
        push(text, usableId(id) && !/<%/.test(id) ? id : `text:${text}`);
    }
    return out.slice(0, MAX_PER_PAGE);
}

/** Includes named in a template: include('partials/manage/x') / include('./x'). */
export function includesIn(src) {
    return [...String(src ?? '').matchAll(/include\(\s*['"`]([^'"`$]+)['"`]/g)].map((m) => m[1]);
}

/** Static pageMap entries ({ page, partial }) from manage-tailwind.ejs. */
export function parsePageMap(template) {
    const start = template.indexOf('const pageMap = {');
    const end = template.indexOf('\n                };', start);
    if (start < 0 || end < 0) return [];
    const block = template.slice(start, end);
    return [...block.matchAll(/^\s*'([a-z0-9-]+)':\s*\{\s*partial:\s*'([a-z0-9-_]+)'/gm)].map((m) => ({ page: m[1], partial: m[2] }));
}

/**
 * The index.
 * @param {object} o
 *   nav         buildManageNav() sections (page order and which pages exist)
 *   pageMap     [{ page, partial }]
 *   readPartial (name) => source string or null   ('streaming', 'partials/manage/_x' ...)
 *   specs       FEATURE_SPECS (generated pages)
 * @returns {{ [page]: Array<[label, field]> }}
 */
export function buildIndex({ nav = [], pageMap = [], readPartial = () => null, specs = {} } = {}) {
    const order = [];
    for (const sec of nav) for (const it of sec.items || []) order.push(it.page);
    const inNav = new Set(order);
    const partialOf = new Map(pageMap.map((e) => [e.page, e.partial]));
    const claimed = new Set();
    const out = {};

    const fieldsOfPartial = (name, seen = new Set()) => {
        if (seen.has(name) || seen.size > 12) return [];
        seen.add(name);
        const src = readPartial(name);
        if (!src) return [];
        const own = extractFields(src);
        for (const inc of includesIn(src)) {
            const sub = inc.replace(/^\.\//, '').replace(/^partials\/manage\//, '');
            own.push(...fieldsOfPartial(sub, seen));
        }
        return own;
    };

    for (const page of order) {
        const partial = partialOf.get(page);
        let fields = [];
        if (partial && partial !== 'feature-config') {
            if (claimed.has(partial)) continue;
            claimed.add(partial);
            fields = fieldsOfPartial(partial);
        } else if (specs[page] && Array.isArray(specs[page].fields)) {
            fields = specs[page].fields
                .filter((f) => f && f.key && f.label)
                .map((f) => ({ label: cleanText(f.label), field: `fc-f-${f.key}` }));
        }
        const seen = new Set();
        const rows = [];
        for (const f of fields) {
            const k = f.label.toLowerCase();
            if (seen.has(k) || !usableLabel(f.label)) continue;
            seen.add(k);
            rows.push([f.label, f.field]);
        }
        if (rows.length && inNav.has(page)) out[page] = rows.slice(0, MAX_PER_PAGE);
    }
    return out;
}

let cached = null;   // { generation, index }

/**
 * The index for the running dashboard, rebuilt when the view engine's generation changes.
 * @param {object} o  { viewsDir, nav, specs, generation }
 */
export function getSettingsIndex({ viewsDir, nav, specs, generation = 0 }) {
    if (cached && cached.generation === generation) return cached.index;
    const read = (rel) => {
        try { return fs.readFileSync(path.join(viewsDir, rel), 'utf8'); } catch { return null; }
    };
    const pageMap = parsePageMap(read('manage-tailwind.ejs') || '');
    const index = buildIndex({
        nav, pageMap, specs,
        readPartial: (name) => read(path.join('partials/manage', name.endsWith('.ejs') ? name : `${name}.ejs`)),
    });
    cached = { generation, index };
    return index;
}

export default { cleanText, extractFields, includesIn, parsePageMap, buildIndex, getSettingsIndex };
