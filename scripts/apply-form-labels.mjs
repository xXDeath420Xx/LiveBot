/**
 * Programmatically associate dashboard form labels with their controls.
 *
 * The dashboard is not missing labels — it has 1,232 of them. What it is missing
 * is the *association*. 967 labels have no `for=` and do not wrap their control,
 * so they are visible text sitting next to an input with nothing tying the two
 * together. A sighted user sees a labelled field; a screen reader announces
 * "edit, blank". The information is on screen and unreachable, which is a more
 * insidious failure than a missing label because it is invisible in review.
 *
 * Two cases are handled:
 *
 *   1. The control already has a static id  -> add for="thatId" to the label.
 *      Zero risk: nothing is renamed, nothing else can reference the label.
 *
 *   2. The control has no id -> mint one from its `name`, scoped per file to
 *      avoid collisions, then add the matching for=.
 *
 * Controls whose id is EJS-interpolated are skipped. A dynamic id can repeat
 * across loop iterations, and duplicate ids make `for=` ambiguous — the reader
 * binds to the first match, so every row in a table would announce row one's
 * label. Those need a per-iteration suffix that only a human can choose safely.
 *
 * Usage:  node scripts/apply-form-labels.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'dashboard', 'views');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * A <label> with no for=, containing no control of its own, immediately
 * followed by a control. Whitespace and comments between the two are allowed;
 * any other markup is not, because then "immediately followed by" stops being
 * a safe proxy for "labels this control".
 */
const PAIR = /<label(?![a-zA-Z-])((?:(?!\bfor=)[^>])*)>((?:(?!<\/label>)[\s\S])*?)<\/label>(\s*(?:<!--[\s\S]*?-->\s*)?)(<(?:input|select|textarea)(?![a-zA-Z-])[^>]*>)/gi;

function collectViews(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectViews(full, acc);
        else if (entry.endsWith('.ejs')) acc.push(full);
    }
    return acc;
}

const isDynamic = (v) => v.includes('<%') || v.includes('${');

/**
 * Stable, readable id derived from the control's name.
 *
 * Namespaced by the file it came from, not just uniquified within it. Views are
 * assembled from partials, and two partials that both contain a field called
 * "enabled" would otherwise both mint `f-enabled`; if they ever co-render, the
 * duplicate id silently rebinds one label to the other's input. The file prefix
 * makes that impossible without having to reason about which partials can
 * appear together.
 */
function mintId(name, used, scope) {
    const slug = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const base = `f-${slug(scope)}-${slug(name)}`;
    if (!used.has(base)) { used.add(base); return base; }
    let n = 2;
    while (used.has(`${base}-${n}`)) n++;
    used.add(`${base}-${n}`);
    return `${base}-${n}`;
}

const stats = { linkedExisting: 0, mintedId: 0, skippedDynamic: 0, skippedNoName: 0, filesChanged: 0 };

for (const file of collectViews(VIEWS_DIR)) {
    const source = await readFile(file, 'utf8');
    const scope = path.basename(file, '.ejs');

    // Every id already present in this file, so minted ids cannot collide.
    const used = new Set();
    for (const m of source.matchAll(/\bid=["']([^"']+)["']/g)) used.add(m[1]);

    let changed = false;
    const out = source.replace(PAIR, (full, labelAttrs, labelText, gap, control) => {
        // A label that already wraps a control is implicitly associated; leave it.
        if (/<(input|select|textarea)(?![a-zA-Z-])/i.test(labelText)) return full;

        const idMatch = control.match(/\bid=["']([^"']+)["']/);

        let id;
        let newControl = control;

        if (idMatch) {
            if (isDynamic(idMatch[1])) { stats.skippedDynamic++; return full; }
            id = idMatch[1];
            stats.linkedExisting++;
        } else {
            const nameMatch = control.match(/\bname=["']([^"']+)["']/);
            if (!nameMatch || isDynamic(nameMatch[1])) { stats.skippedNoName++; return full; }
            id = mintId(nameMatch[1], used, scope);
            // Insert right after the tag name, where nothing can be quoted.
            const tagEnd = control.match(/^<[a-zA-Z]+/)[0].length;
            newControl = `${control.slice(0, tagEnd)} id="${id}"${control.slice(tagEnd)}`;
            stats.mintedId++;
        }

        changed = true;
        return `<label${labelAttrs} for="${id}">${labelText}</label>${gap}${newControl}`;
    });

    if (changed) {
        stats.filesChanged++;
        if (!DRY_RUN) await writeFile(file, out, 'utf8');
    }
}

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
console.log(`  for= added to control's existing id : ${stats.linkedExisting}`);
console.log(`  id minted from name, then linked    : ${stats.mintedId}`);
console.log(`  skipped (EJS-interpolated id)       : ${stats.skippedDynamic}`);
console.log(`  skipped (no id and no usable name)  : ${stats.skippedNoName}`);
console.log(`  files changed                       : ${stats.filesChanged}`);
