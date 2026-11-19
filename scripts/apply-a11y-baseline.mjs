/**
 * Inject the accessibility baseline into every dashboard view.
 *
 * The 50 views each own their <head> and inline <style> rather than sharing a
 * layout, so there is no single place to add cross-cutting markup. This walks
 * them and applies three things:
 *
 *   1. <link> to /css/a11y.css, last in <head> so its overrides win.
 *   2. A skip-to-content link as the first child of <body>.
 *   3. id="main-content" tabindex="-1" on the skip target.
 *
 * Idempotent — safe to re-run after new views are added. Reports what it
 * changed and what it could not resolve rather than guessing.
 *
 * Usage:  node scripts/apply-a11y-baseline.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'dashboard', 'views');
const DRY_RUN = process.argv.includes('--dry-run');

const LINK_TAG = '    <link rel="stylesheet" href="/css/a11y.css">';
const SKIP_LINK = '    <a class="skip-to-content" href="#main-content">Skip to main content</a>';

/** Every .ejs under views/, including partials. */
function collectViews(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectViews(full, acc);
        else if (entry.endsWith('.ejs')) acc.push(full);
    }
    return acc;
}

/**
 * Give the skip link something to land on.
 *
 * Preference order: an existing <main>, then the page's primary content
 * container. Partials that are fragments (no <body>) are left alone — their
 * parent view owns the landmark.
 */
function addSkipTarget(html) {
    if (/id=["']main-content["']/.test(html)) return { html, changed: false, reason: 'already present' };

    // These are EJS templates, not HTML, and an embedded expression can contain
    // a bare '>' — `<main class="<%= a > b ? 'x' : 'y' %>">` is legal and does
    // occur. A naive [^>]* attribute matcher truncates the tag at the '>' inside
    // the expression and silently corrupts the file. So rather than trying to
    // match the whole tag, insert the attributes immediately after the tag NAME,
    // where nothing can be quoted or interpolated.
    const insertAfterTagName = (source, tagRegex, label) => {
        const m = source.match(tagRegex);
        if (!m) return null;
        const at = m.index + m[0].length;
        return {
            html: `${source.slice(0, at)} id="main-content" tabindex="-1"${source.slice(at)}`,
            changed: true,
            reason: label,
        };
    };

    // 1. An existing <main> is the correct landmark.
    const viaMain = insertAfterTagName(html, /<main(?![a-zA-Z-])/, '<main>');
    if (viaMain) return viaMain;

    // 2. Fall back to the page-content wrapper the manage views use. Matching
    //    the class needs the attribute list, so bound the search to a single tag
    //    and reject any candidate containing an EJS delimiter.
    const contentMatch = html.match(/<div(?![a-zA-Z-])([^<>]*\bclass=["'][^"']*\bpage-content\b[^"']*["'][^<>]*)>/);
    if (contentMatch && !contentMatch[1].includes('<%') && !contentMatch[1].includes('%>')) {
        const replacement = `<div${contentMatch[1]} id="main-content" tabindex="-1">`;
        return { html: html.replace(contentMatch[0], replacement), changed: true, reason: '.page-content' };
    }

    return { html, changed: false, reason: 'no landmark found' };
}

const results = { linked: [], skipped: [], targeted: [], noTarget: [], fragments: [] };

for (const file of collectViews(VIEWS_DIR)) {
    const rel = path.relative(VIEWS_DIR, file);
    let html = await readFile(file, 'utf8');
    const before = html;

    const hasHead = /<\/head>/i.test(html);
    const hasBody = /<body[^>]*>/i.test(html);

    if (!hasHead && !hasBody) {
        results.fragments.push(rel);
        continue;
    }

    // 1. Stylesheet, last in <head>.
    if (hasHead && !html.includes('/css/a11y.css')) {
        html = html.replace(/([ \t]*)<\/head>/i, `${LINK_TAG}\n$1</head>`);
        results.linked.push(rel);
    }

    // 2 & 3. Resolve the skip target FIRST, and only add the link if one exists.
    //
    // A skip link pointing at a missing #main-content is worse than no skip
    // link: it is the first thing a keyboard user reaches, it looks like it
    // works, and activating it does nothing. Views with no landmark are
    // reported for a human to add a <main> rather than wired up blind.
    if (hasBody) {
        const { html: withTarget, changed, reason } = addSkipTarget(html);

        const hasTarget = changed || reason === 'already present';
        if (hasTarget) {
            html = withTarget;
            if (changed) results.targeted.push(`${rel} (${reason})`);

            if (!html.includes('skip-to-content')) {
                html = html.replace(/(<body[^>]*>)/i, `$1\n${SKIP_LINK}`);
                results.skipped.push(rel);
            }
        } else {
            results.noTarget.push(rel);
        }
    }

    if (html !== before && !DRY_RUN) await writeFile(file, html, 'utf8');
}

const report = (label, list) => {
    console.log(`\n${label}: ${list.length}`);
    for (const item of list) console.log(`  ${item}`);
};

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
report('Stylesheet linked', results.linked);
report('Skip link added', results.skipped);
report('Skip target set', results.targeted);
report('NO LANDMARK — skip link has nowhere to go, needs a manual <main>', results.noTarget);
console.log(`\nFragments without <head>/<body> (left alone, parent view owns the landmark): ${results.fragments.length}`);
