/**
 * Surface Settings in the header navigation.
 *
 * Settings was reachable from exactly two places: the `topbar.ejs` dropdown
 * (used by 2 views) and `sidebar.ejs`. The 24 views with the main `.navbar-links`
 * header — including the manage dashboard people actually live in — had no link
 * to it at all, and their user dropdown listed Profile / Servers / Bot Management
 * / Super Admin / CAH Admin but not Settings.
 *
 * So the page that controls themes, density and layout was effectively hidden.
 *
 * This adds it in BOTH places, which is not redundancy:
 *
 *   - `.navbar-links` — one click from anywhere, which is what was asked for.
 *   - the user dropdown — where people conventionally look for account settings,
 *     and where it sits beside Profile.
 *
 * Both are wrapped in `locals.user`, because /settings is behind checkAuth and a
 * link that bounces a logged-out visitor to Discord OAuth is worse than no link.
 *
 * Idempotent. Usage: node scripts/surface-settings-link.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'dashboard', 'views');
const DRY_RUN = process.argv.includes('--dry-run');

/** Marker so re-runs are detectable regardless of surrounding formatting. */
const NAV_MARKER = 'data-nav="settings"';
const DROPDOWN_MARKER = 'data-dd="settings"';

const NAV_LINK = `                    <% if (locals.user) { %><a href="/settings" data-nav="settings">Settings</a><% } %>`;

const DROPDOWN_LINK = `                        <a href="/settings" class="dropdown-item" data-dd="settings">
                            <i class="fas fa-sliders-h"></i>
                            <span>Settings</span>
                        </a>`;

function collectViews(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectViews(full, acc);
        else if (entry.endsWith('.ejs')) acc.push(full);
    }
    return acc;
}

const stats = { nav: 0, dropdown: 0, navSkipped: 0, ddSkipped: 0 };
const touched = [];

for (const file of collectViews(VIEWS_DIR)) {
    const rel = path.relative(VIEWS_DIR, file);
    const source = await readFile(file, 'utf8');
    let out = source;

    // ---- 1. Header nav ----------------------------------------------------
    // Append as the last item in .navbar-links so it doesn't displace the
    // existing order people already navigate by muscle memory.
    if (out.includes('class="navbar-links"')) {
        // Skip on the marker OR on any pre-existing /settings link inside the
        // nav block — topbar.ejs already ships one, and checking only for our
        // own marker would add a duplicate beside it.
        const navBlock = out.match(/<div class="navbar-links">[\s\S]*?<\/div>/)?.[0] || '';
        if (out.includes(NAV_MARKER) || navBlock.includes('href="/settings"')) {
            stats.navSkipped++;
        } else {
            // Match the .navbar-links block and insert before its closing tag.
            const m = out.match(/(<div class="navbar-links">)([\s\S]*?)(\n\s*<\/div>)/);
            if (m) {
                out = out.slice(0, m.index) + m[1] + m[2] + '\n' + NAV_LINK + m[3] + out.slice(m.index + m[0].length);
                stats.nav++;
            }
        }
    }

    // ---- 2. User dropdown -------------------------------------------------
    // Immediately before the divider that precedes Log Out, so it groups with
    // the other account links rather than landing under the admin section.
    if (out.includes('class="user-dropdown"') || out.includes('dropdown-divider')) {
        // Same guard: an existing dropdown link to /settings means there is
        // nothing to add, whoever wrote it.
        if (out.includes(DROPDOWN_MARKER) || /class="dropdown-item"[^>]*>\s*(<[^>]*>\s*)*Settings|href="\/settings" class="dropdown-item"/.test(out)) {
            stats.ddSkipped++;
        } else {
            const divider = out.indexOf('<div class="dropdown-divider"></div>');
            if (divider !== -1) {
                const lineStart = out.lastIndexOf('\n', divider) + 1;
                out = out.slice(0, lineStart) + DROPDOWN_LINK + '\n' + out.slice(lineStart);
                stats.dropdown++;
            }
        }
    }

    if (out !== source) {
        touched.push(rel);
        if (!DRY_RUN) await writeFile(file, out, 'utf8');
    }
}

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
console.log(`  header nav links added : ${stats.nav}`);
console.log(`  dropdown links added   : ${stats.dropdown}`);
console.log(`  already had nav link   : ${stats.navSkipped}`);
console.log(`  already had dropdown   : ${stats.ddSkipped}`);
console.log(`\n  views touched: ${touched.length}`);
touched.forEach((t) => console.log(`    ${t}`));
