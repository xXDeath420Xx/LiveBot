/**
 * Link the unified dropdown stylesheet into every view, and collapse the
 * divergent hardcoded <option> surfaces onto the design tokens.
 *
 * Two separate problems, fixed together because they cause the same symptom:
 *
 *   1. `dropdown-fix.css` existed but was linked in ONE view out of the 128
 *      that contain a <select>. Everywhere else the popup rendered in the
 *      browser's default light palette against a dark control.
 *
 *   2. The 27 views that DID style their options each picked their own grey —
 *      #1a1d21, #1a1f25, #12141b, #1a1e23, #161b1f, #141a1e — none matching
 *      --bg-secondary (#0f1316). Six near-identical-but-not-equal surfaces read
 *      as sloppiness rather than as a system.
 *
 * The stylesheet is linked into every view with a <head>, not only the ones with
 * a <select> today: a partial can inject a select into a page that has none, and
 * the rules also cover .dropdown-menu, which is not a <select> at all. A stylesheet
 * that matches nothing costs one cached request.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:  node scripts/apply-dropdown-styles.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'dashboard', 'views');
const DRY_RUN = process.argv.includes('--dry-run');

const LINK_TAG = '    <link rel="stylesheet" href="/css/dropdowns.css">';

/**
 * Divergent option/select surfaces -> the token they should have been using.
 *
 * Only surfaces are remapped. Accent and state colours (purples, the
 * rgba(167,139,250,…) selection tints) are left alone — those are intentional
 * and already consistent.
 */
const SURFACE_REMAP = new Map([
    ['#1a1d21', 'var(--bg-secondary, #0f1316)'],
    ['#1A1D21', 'var(--bg-secondary, #0f1316)'],
    ['#1a1f25', 'var(--bg-secondary, #0f1316)'],
    ['#1A1F25', 'var(--bg-secondary, #0f1316)'],
    ['#12141b', 'var(--bg-secondary, #0f1316)'],
    ['#12141B', 'var(--bg-secondary, #0f1316)'],
    ['#1a1e23', 'var(--bg-secondary, #0f1316)'],
    ['#1A1E23', 'var(--bg-secondary, #0f1316)'],
    ['#161b1f', 'var(--bg-secondary, #0f1316)'],
    ['#161B1F', 'var(--bg-secondary, #0f1316)'],
    ['#141a1e', 'var(--bg-secondary, #0f1316)'],
    ['#141A1E', 'var(--bg-secondary, #0f1316)'],
]);

function collectViews(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectViews(full, acc);
        else if (entry.endsWith('.ejs')) acc.push(full);
    }
    return acc;
}

/**
 * Rewrite hardcoded surfaces, but ONLY inside rules that target option/optgroup
 * or a select. Those hexes appear elsewhere as panel and card backgrounds, and
 * remapping every occurrence would recolour unrelated UI.
 */
function remapOptionSurfaces(source) {
    let count = 0;

    const out = source.replace(
        /([^{}]*\b(?:option|optgroup|select)\b[^{}]*\{)([^}]*)\}/gi,
        (full, selector, body) => {
            let newBody = body;
            for (const [hex, token] of SURFACE_REMAP) {
                if (!newBody.includes(hex)) continue;
                // Only where it is being used as a background.
                newBody = newBody.replace(
                    new RegExp(`(background(?:-color)?\\s*:\\s*)${hex}\\b`, 'g'),
                    (_m, prop) => { count++; return `${prop}${token}`; }
                );
            }
            return `${selector}${newBody}}`;
        }
    );

    return { out, count };
}

const stats = { linked: 0, alreadyLinked: 0, remapped: 0, filesRemapped: 0, noHead: 0 };
const remappedFiles = [];

for (const file of collectViews(VIEWS_DIR)) {
    const rel = path.relative(VIEWS_DIR, file);
    const source = await readFile(file, 'utf8');
    let out = source;

    // 1. Link the stylesheet, after a11y.css so ordering stays predictable.
    if (/<\/head>/i.test(out)) {
        if (out.includes('/css/dropdowns.css')) {
            stats.alreadyLinked++;
        } else {
            out = out.replace(/([ \t]*)<\/head>/i, `${LINK_TAG}\n$1</head>`);
            stats.linked++;
        }
    } else {
        stats.noHead++;
    }

    // 2. Collapse divergent option surfaces onto the token.
    const { out: remapped, count } = remapOptionSurfaces(out);
    out = remapped;
    if (count) {
        stats.remapped += count;
        stats.filesRemapped++;
        remappedFiles.push(`${rel} (${count})`);
    }

    if (out !== source && !DRY_RUN) await writeFile(file, out, 'utf8');
}

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
console.log(`  stylesheet linked        : ${stats.linked}`);
console.log(`  already linked           : ${stats.alreadyLinked}`);
console.log(`  fragments without <head> : ${stats.noHead} (parent view carries the link)`);
console.log(`  option surfaces remapped : ${stats.remapped} across ${stats.filesRemapped} file(s)`);
if (remappedFiles.length) {
    console.log('\n  Remapped:');
    for (const f of remappedFiles) console.log(`    ${f}`);
}
