/**
 * Classic site style: put the manage page partials' original CSS back.
 *
 * The 2026-10-13 redesign re-tinted every manage partial's CSS: purple literals became
 * design tokens (var(--accent-purple), var(--cf-accent) ...), purple gradients became a
 * flat accent fill and faint purple washes became neutral surfaces. That rewrite is lossy
 * (many different originals map to the same token), so no set of token values can bring
 * the old look back. The "Classic" style (manage-classic.ejs) needs the real thing.
 *
 * classic-style-map.json holds, per partial, every CSS rule body and style="" value the
 * redesign changed: the key is the CSS exactly as it reads today, the value the original
 * CSS (a list, in order of appearance, where several originals collapsed to the same
 * text). restoreClassicCss() swaps them back in the template SOURCE, only inside <style>
 * blocks and style="" attributes, never in scripts, EJS tags or markup, so all of a
 * partial's behaviour, ids and hooks stay exactly as they are today. A rule edited since
 * the redesign simply no longer matches and keeps its current (token) styling, so later
 * changes to a partial are never undone.
 *
 * Each restored rule then goes through themeClassicCss() (below): its dark-only colours
 * become --clx-* tokens with the original literal as their fallback, and manage-classic.ejs
 * defines those tokens for Light and Sand only, so Dark renders exactly the original.
 *
 * Used by the dashboard view engine (services/view-engine.js) for every include made while rendering
 * with `classicCss: true`, which only the manage route sets when it renders the classic
 * template. Pure apart from the JSON load (once, again after a dashboard reload); tested in
 * tests/manage-classic.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'classic-style-map.json');

// Same tokenisation the redesign's re-tint used: scripts are skipped whole, then style
// blocks and style attributes. EJS tags inside a style block split it into pieces.
const SECTION = /(<script\b[\s\S]*?<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)|(\sstyle=")([^"]*)(")/gi;
const EJS_TAG = /<%[\s\S]*?%>/g;
const RULE_BODY = /\{([^{}]*)\}/g;

let mapCache = null;

/** The manage page template for a site style: classic has its own, cards and compact share one. */
export function manageTemplateFor(style) {
    return style === 'classic' ? 'manage-classic' : 'manage-tailwind';
}

/** The restore map ({ 'partials/manage/x.ejs': { rules, attrs } }); loaded once per reload. */
export function loadClassicMap() {
    if (!mapCache) {
        try {
            mapCache = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')).files || {};
        } catch {
            mapCache = {};    // a missing map means token styling, never a broken page
        }
    }
    return mapCache;
}

/** Forget the loaded map so the next lookup re-reads the JSON (a dashboard reload). */
export function resetClassicMap() {
    mapCache = null;
}

/** 'partials/manage/x.ejs' for a template path under viewsDir (posix separators), or null. */
export function viewKey(viewsDir, filePath) {
    const rel = path.relative(viewsDir, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

// Picks the next original for a key: entries are consumed in order of appearance, and the
// last one is reused if today's file has more occurrences than the original did.
function picker(table) {
    const seen = new Map();
    return (key) => {
        const list = table[key];
        if (!list || !list.length) return null;
        const i = seen.get(key) || 0;
        seen.set(key, i + 1);
        return list[Math.min(i, list.length - 1)];
    };
}

function mapOutsideEjs(text, fn) {
    let out = '';
    let last = 0;
    for (const m of text.matchAll(EJS_TAG)) {
        out += fn(text.slice(last, m.index)) + m[0];
        last = m.index + m[0].length;
    }
    return out + fn(text.slice(last));
}

/**
 * Template source with its original (pre-redesign) CSS restored. `entry` is the map entry
 * for this file ({ rules, attrs }); without one the source is returned unchanged.
 */
export function restoreClassicCss(source, entry) {
    if (!entry || typeof source !== 'string') return source;
    const rule = picker(entry.rules || {});
    const attr = picker(entry.attrs || {});
    return source.replace(SECTION, (whole, script, open, body, close, attrOpen, value, attrClose) => {
        if (script) return whole;
        if (open) {
            const restored = mapOutsideEjs(body, (piece) => piece.replace(RULE_BODY, (m, decls) => {
                const orig = rule(decls);
                return orig === null ? m : `{${themeClassicCss(orig, decls)}}`;
            }));
            return open + restored + close;
        }
        const orig = attr(value);
        return orig === null ? whole : attrOpen + themeClassicCss(orig, value) + attrClose;
    });
}

// ── Light and Sand ─────────────────────────────────────────────────────────────────────
// The originals were drawn for a dark page only: white text and white hairlines, pale
// "400" hues as text, near-black panels. On Light and Sand they vanished. themeClassicCss()
// rewrites each restored rule so that every such colour becomes a --clx-* token WITH THE
// ORIGINAL LITERAL AS ITS FALLBACK:
//     color: #a78bfa                     ->  var(--clx-violet, #a78bfa)
//     background: rgba(167,139,250,.15)  ->  color-mix(in srgb, var(--clx-violet, #a78bfa) 15%, transparent)
//     border: 1px solid rgba(255,255,255,.08) -> color-mix(in srgb, var(--clx-white, #ffffff) 8%, transparent)
//     color: rgba(255,255,255,.5)        ->  var(--clx-ink-3, rgba(255,255,255,.5))
// manage-classic.ejs defines the --clx-* tokens for Light and Sand only, so Dark (and every
// dark named theme) renders exactly the colours it did before, and Light and Sand get
// readable ink. White text on a purple/colour fill stays white: the redesign's version of
// the same rule (the map key) says which (var(--cf-on-accent), or a literal it kept white);
// with no key, a coloured background in the same rule decides.
const BRAND = new Set(['5865f2', '7289da', '9146ff', '6441a5', '53fc18', 'ff0000', '1da1f2', 'e1306c', 'ff4500', '1db954']);
const TEXT_PROPS = /^(color|-webkit-text-fill-color|caret-color|fill|stroke|text-decoration-color|accent-color)$/;
const BG_PROPS = /^background(-color|-image)?$/;
const LINE_PROPS = /^(border(-[a-z]+)*|outline(-color)?|box-shadow|text-shadow|filter|column-rule(-color)?)$/;
const COLOR_TOKEN = /var\((?:[^()]|\([^()]*\))*\)|url\([^)]*\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b(?!-)/gi;
const FILL_VAR = /var\(--(?:cf-)?(?:accent|success|danger|warning|info|card-accent|stat-accent|tab-accent|color-primary)(?:-[a-z0-9]+)*\b(?<!-soft|-line|-ink|-fg)/;
const HEX = /^#([0-9a-f]{3,8})$/;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/;
const DECL = /^(\s*(?:\/\*[\s\S]*?\*\/\s*)*)(-{0,2}[a-zA-Z][-\w]*)(\s*:)([\s\S]*)$/;

function parseColor(s) {
    const t = s.trim().toLowerCase();
    if (t === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    let m = t.match(HEX);
    if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
        if (h.length !== 6 && h.length !== 8) return null;
        const n = (i) => parseInt(h.slice(i, i + 2), 16);
        return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    m = t.match(RGB);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a: Math.min(1, a) };
}

function luminance({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const hex6 = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const pct = (a) => `${+(a * 100).toFixed(2)}%`;

/** { Y, hex, fam, brand }: fam is the hue family of a saturated colour, null for a neutral. */
function classify(c) {
    const r = c.r / 255; const g = c.g / 255; const b = c.b / 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
    const hex = hex6(c);
    const out = { Y: luminance(c), hex, fam: null, brand: BRAND.has(hex.slice(1)) };
    if (out.brand || d < 0.16) return out;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    out.fam = h < 12 || h >= 350 ? 'red' : h < 38 ? 'orange' : h < 62 ? 'yellow' : h < 165 ? 'green'
        : h < 182 ? 'teal' : h < 200 ? 'cyan' : h < 228 ? 'blue' : h < 250 ? 'indigo' : h < 295 ? 'violet' : 'pink';
    return out;
}

const contrastOnWhite = (Y) => 1.05 / (Y + 0.05);
const inkFor = (level) => (level >= 0.8 ? '--clx-ink' : level >= 0.55 ? '--clx-ink-2' : '--clx-ink-3');

function splitTopLevel(body) {
    const out = [];
    let depth = 0; let start = 0; let q = null;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (q) { if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") q = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    }
    out.push(body.slice(start));
    return out;
}

function declMap(css) {
    const map = {};
    for (const seg of splitTopLevel(css)) {
        const m = seg.match(DECL);
        if (m) (map[m[2].toLowerCase()] ||= []).push(m[4].trim());
    }
    return map;
}

function themeValue(prop, value, ctx, keyValue) {
    // Gradient text (background-clip: text) is text, whatever property paints it.
    const isText = TEXT_PROPS.test(prop) || (ctx.clipText && BG_PROPS.test(prop));
    const isBg = !isText && BG_PROPS.test(prop);
    const isLine = LINE_PROPS.test(prop);
    if (!isText && !isBg && !isLine && !prop.startsWith('--')) return value;
    return value.replace(COLOR_TOKEN, (tok) => {
        if (/^(var|url)\(/i.test(tok)) return tok;
        const c = parseColor(tok);
        if (!c) return tok;
        const k = classify(c);
        if (k.brand) return tok;
        if (k.fam) {
            if (c.a < 1) return `color-mix(in srgb, var(--clx-${k.fam}, ${k.hex}) ${pct(c.a)}, transparent)`;
            // A fill keeps its colour when white text on it already reads, or dark text sits on it.
            if (isBg && (ctx.textDark || contrastOnWhite(k.Y) >= 4.5)) return tok;
            return `var(--clx-${k.fam}, ${tok})`;
        }
        const whiteish = k.Y > 0.8;
        if (isText) {
            if (whiteish) {
                // The redesign's token says page or fill; a literal it left alone says nothing.
                const keep = ctx.clipText ? false
                    : keyValue != null && /var\(/.test(keyValue) ? /on-accent/.test(keyValue) : ctx.hasFill;
                return keep ? tok : `var(${inkFor(c.a)}, ${tok})`;
            }
            if (c.a === 1 && k.Y > 0.18 && contrastOnWhite(k.Y) < 4.5) {
                return `var(${k.Y >= 0.6 ? '--clx-ink' : k.Y >= 0.35 ? '--clx-ink-2' : '--clx-ink-3'}, ${tok})`;
            }
            return tok;
        }
        if (isBg) {
            if (whiteish) return c.a <= 0.25 ? `color-mix(in srgb, var(--clx-white, ${k.hex}) ${pct(c.a)}, transparent)` : tok;
            if (k.Y < 0.05) {
                if (c.a >= 0.85) return `var(--clx-surface, ${tok})`;
                // A faint black inset (or a darker one with text or a border: an input, a panel);
                // a heavier black with neither is an overlay or scrim and stays dark.
                if (c.a <= 0.45 || ctx.isBox) return `var(${c.a <= 0.2 ? '--clx-shade-1' : '--clx-shade-2'}, ${tok})`;
            }
            return tok;
        }
        if (isLine && whiteish && c.a <= 0.5) return `color-mix(in srgb, var(--clx-white, ${k.hex}) ${pct(c.a)}, transparent)`;
        return tok;
    });
}

function themeDecls(css, keyMap) {
    const decls = declMap(css);
    const bg = [...(decls.background || []), ...(decls['background-color'] || []), ...(decls['background-image'] || [])].join(' ');
    const ctx = {
        hasFill: /url\((?!\s*["']?data:image\/svg)/.test(bg) || FILL_VAR.test(bg) || (bg.match(COLOR_TOKEN) || []).some((t) => {
            const c = parseColor(t);
            if (!c || c.a < 0.5) return false;
            const k = classify(c);
            return Boolean(k.fam || k.brand);
        }),
        clipText: /\btext\b/.test([...(decls['background-clip'] || []), ...(decls['-webkit-background-clip'] || [])].join(' ')),
        isBox: Boolean(decls.color) || Object.keys(decls).some((p) => /^border(-(top|right|bottom|left))?(-color)?$/.test(p)),
        textDark: (decls.color || []).some((v) => (v.match(COLOR_TOKEN) || []).some((t) => {
            const c = parseColor(t);
            return Boolean(c) && c.a >= 0.5 && luminance(c) < 0.2;
        })),
    };
    const seen = {};
    return splitTopLevel(css).map((seg) => {
        const m = seg.match(DECL);
        if (!m) return seg;
        const prop = m[2].toLowerCase();
        const i = seen[prop] = (seen[prop] ?? -1) + 1;
        const kv = keyMap && keyMap[prop] ? keyMap[prop][Math.min(i, keyMap[prop].length - 1)] : null;
        return m[1] + m[2] + m[3] + themeValue(prop, m[4], ctx, kv);
    }).join(';');
}

const themed = new Map();

/**
 * A restored rule body or style="" value made theme-aware (see above). `key` is the
 * redesign's version of the same CSS (the map key): it tells white-on-a-fill from
 * white-on-the-page. Pure; results are memoised (the same few thousand rules repeat).
 */
export function themeClassicCss(css, key) {
    if (typeof css !== 'string' || !css) return css;
    const id = css + '\u0000' + (key || '');
    let out = themed.get(id);
    if (out === undefined) {
        const keyMap = typeof key === 'string' ? declMap(key.replace(EJS_TAG, '')) : null;
        out = mapOutsideEjs(css, (piece) => themeDecls(piece, keyMap));
        if (themed.size > 20000) themed.clear();
        themed.set(id, out);
    }
    return out;
}

/** restoreClassicCss for a template file, looked up in the map by its path under viewsDir. */
export function classicSource(viewsDir, filePath, source) {
    const key = viewKey(viewsDir, filePath);
    return key ? restoreClassicCss(source, loadClassicMap()[key]) : source;
}
