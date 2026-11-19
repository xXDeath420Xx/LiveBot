/**
 * Wire the theme system into every view's <html> tag.
 *
 * Three things per view:
 *
 *   1. `data-theme` / `data-density` on <html>, rendered SERVER-SIDE from
 *      res.locals. Doing it server-side is the whole point: a theme applied by
 *      JS after load produces a visible flash of the wrong theme on every
 *      navigation, which is worse than not having themes.
 *
 *   2. A link to /css/themes.css.
 *
 *   3. A tiny anti-flash script, inline and BEFORE any stylesheet, for the two
 *      cases server-side rendering can't cover: a logged-out visitor, and a page
 *      served from bfcache/CDN with a stale attribute. It reads the same value
 *      from localStorage and corrects <html> before first paint.
 *
 * The script writes localStorage on every authenticated render so the two stores
 * stay in step — otherwise a logged-in user who changed theme would still see
 * the old one flash on the logged-out landing page.
 *
 * Idempotent. Usage: node scripts/apply-theme-attributes.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'dashboard', 'views');
const DRY_RUN = process.argv.includes('--dry-run');

const THEME_LINK = '    <link rel="stylesheet" href="/css/themes.css">';

/**
 * Runs before any stylesheet, so the corrected attribute is in place for the
 * first paint. Deliberately tiny and dependency-free — anything that has to
 * parse or fetch defeats the purpose.
 */
const ANTIFLASH = `    <script>
    // Anti-flash: reconcile <html> with the stored preference before first paint.
    // Server-side rendering covers authenticated pages; this covers logged-out
    // visitors and bfcache restores, where the server value may be absent or stale.
    (function () {
        try {
            var d = document.documentElement;
            var t = localStorage.getItem('ui-theme');
            var n = localStorage.getItem('ui-density');
            // A server-rendered non-default value wins — it is the authoritative
            // one and localStorage may be from a different account on this browser.
            if (d.getAttribute('data-theme') && d.getAttribute('data-theme') !== 'dark') {
                localStorage.setItem('ui-theme', d.getAttribute('data-theme'));
            } else if (t) {
                d.setAttribute('data-theme', t);
            }
            if (d.getAttribute('data-density') && d.getAttribute('data-density') !== 'comfortable') {
                localStorage.setItem('ui-density', d.getAttribute('data-density'));
            } else if (n) {
                d.setAttribute('data-density', n);
            }
        } catch (e) { /* private mode / storage disabled — server value stands */ }
    })();
    </script>`;

function collectViews(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectViews(full, acc);
        else if (entry.endsWith('.ejs')) acc.push(full);
    }
    return acc;
}

const stats = { htmlAttrs: 0, linked: 0, antiflash: 0, skipped: 0, noHtml: 0 };

for (const file of collectViews(VIEWS_DIR)) {
    const source = await readFile(file, 'utf8');
    let out = source;

    const hasHtml = /<html[^>]*>/i.test(out);
    if (!hasHtml) { stats.noHtml++; continue; }

    // 1. Attributes on <html>. Inserted right after the tag NAME so existing
    //    attributes (lang, class, data-bs-theme) are untouched — matching the
    //    approach that avoided corrupting EJS expressions in the a11y pass.
    // Test the <html> TAG, not the document. settings-tailwind.ejs contains
    // data-theme="dark" on its theme-picker buttons, and a document-wide test
    // skipped the whole file — silently excluding the two views that most needed
    // theming, including the settings page itself.
    const htmlTag = out.match(/<html[^>]*>/i)?.[0] || '';
    if (!/data-theme=/.test(htmlTag)) {
        out = out.replace(/<html(?![a-zA-Z-])/i,
            `<html data-theme="<%= locals.uiTheme || 'dark' %>" data-density="<%= locals.uiDensity || 'comfortable' %>"`);
        stats.htmlAttrs++;
    } else {
        stats.skipped++;
    }

    // 2. Stylesheet, last in <head> so its [data-theme] blocks sit after the
    //    view's own inline :root — though specificity already decides this.
    if (/<\/head>/i.test(out) && !out.includes('/css/themes.css')) {
        out = out.replace(/([ \t]*)<\/head>/i, `${THEME_LINK}\n$1</head>`);
        stats.linked++;
    }

    // 3. Anti-flash, immediately after <head> so it precedes every stylesheet.
    if (/<head[^>]*>/i.test(out) && !out.includes("localStorage.getItem('ui-theme')")) {
        out = out.replace(/(<head[^>]*>)/i, `$1\n${ANTIFLASH}`);
        stats.antiflash++;
    }

    if (out !== source && !DRY_RUN) await writeFile(file, out, 'utf8');
}

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
console.log(`  <html> attributes added : ${stats.htmlAttrs}`);
console.log(`  themes.css linked       : ${stats.linked}`);
console.log(`  anti-flash script added : ${stats.antiflash}`);
console.log(`  already had data-theme  : ${stats.skipped}`);
console.log(`  fragments without <html>: ${stats.noHtml} (parent view carries it)`);
