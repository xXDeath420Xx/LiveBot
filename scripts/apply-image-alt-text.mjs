/**
 * Add missing alt attributes to dashboard <img> tags.
 *
 * 99 of 163 img tags carried no alt at all. An <img> with no alt attribute is
 * the worst case for a screen reader: it has nothing to announce, so most
 * readers fall back to reading the filename or URL — which for our avatars is a
 * Discord CDN path, announced as a long string of digits.
 *
 * The fix is NOT "put something in every alt". The correct value depends on what
 * the image does on the page:
 *
 *   - Decorative / redundant: an avatar sitting immediately beside the username
 *     it depicts. The name is already in the DOM as text and will already be
 *     announced. alt="" marks the image as decorative so the reader skips it
 *     rather than announcing the person's name twice. This is the majority case
 *     here and alt="" is the correct, deliberate answer — not a cop-out.
 *
 *   - Informative: a preview pane, a QR code, a chart, a signature GIF. The
 *     image carries information available nowhere else, so it needs real text.
 *
 * Anything this script cannot confidently classify is reported for a human
 * rather than guessed at.
 *
 * Usage:  node scripts/apply-image-alt-text.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'dashboard', 'views');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Ordered rules. First match wins.
 * `test` runs against the full <img ...> tag source.
 */
const RULES = [
    // --- Decorative: avatar/icon next to its own label -------------------
    {
        name: 'avatar (decorative — name is adjacent text)',
        test: (tag) => /cdn\.discordapp\.com\/avatars|embed\/avatars|default-avatar|\bavatar\b/i.test(tag),
        alt: '',
    },
    {
        name: 'guild icon (decorative — server name is adjacent text)',
        test: (tag) => /cdn\.discordapp\.com\/icons|guild\.icon/i.test(tag),
        alt: '',
    },
    {
        name: 'bot avatar (decorative — bot name is adjacent text)',
        test: (tag) => /bot-avatar|b\.avatar/i.test(tag),
        alt: '',
    },

    // --- Informative: content available nowhere else ----------------------
    {
        name: 'upload preview pane',
        test: (tag) => /id=["'][a-z-]*preview-img["']/i.test(tag),
        alt: 'Preview of the selected image',
    },
    {
        name: 'birthday signature GIF',
        test: (tag) => /slide-gif|sig\.gif_url/i.test(tag),
        alt: 'Animated GIF attached to this birthday message',
    },
    {
        name: 'TikTok video thumbnail',
        test: (tag) => /video\.thumbnail_url/i.test(tag),
        alt: 'Video thumbnail',
    },
    {
        name: 'logo',
        test: (tag) => /logo/i.test(tag),
        alt: 'CertiFried',
    },
];

function collectViews(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collectViews(full, acc);
        else if (entry.endsWith('.ejs')) acc.push(full);
    }
    return acc;
}

/**
 * Find <img> tags, tolerating multi-line tags and EJS interpolation.
 *
 * Matching stops at the first '>' that is not inside a quoted attribute value,
 * so `src="<%= a > b %>"` does not truncate the tag the way a naive [^>]* would.
 */
function* findImgTags(source) {
    const re = /<img(?![a-zA-Z-])/gi;
    let m;
    while ((m = re.exec(source)) !== null) {
        let i = m.index + m[0].length;
        let quote = null;
        while (i < source.length) {
            const ch = source[i];
            if (quote) {
                if (ch === quote) quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === '>') {
                yield { start: m.index, end: i + 1, tag: source.slice(m.index, i + 1) };
                break;
            }
            i++;
        }
    }
}

const stats = { added: {}, alreadyHadAlt: 0, unclassified: [] };

for (const file of collectViews(VIEWS_DIR)) {
    const rel = path.relative(VIEWS_DIR, file);
    const source = await readFile(file, 'utf8');

    // Collect edits first, apply right-to-left so earlier offsets stay valid.
    const edits = [];
    for (const { start, end, tag } of findImgTags(source)) {
        if (/\salt\s*=/i.test(tag)) { stats.alreadyHadAlt++; continue; }

        const rule = RULES.find((r) => r.test(tag));
        if (!rule) {
            stats.unclassified.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 110)}`);
            continue;
        }

        // Insert immediately after the tag name — nothing there can be quoted.
        const insertAt = start + '<img'.length;
        edits.push({ insertAt, text: ` alt="${rule.alt}"` });
        stats.added[rule.name] = (stats.added[rule.name] || 0) + 1;
    }

    if (!edits.length) continue;

    let out = source;
    for (const { insertAt, text } of edits.sort((a, b) => b.insertAt - a.insertAt)) {
        out = out.slice(0, insertAt) + text + out.slice(insertAt);
    }
    if (!DRY_RUN) await writeFile(file, out, 'utf8');
}

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
console.log(`\nAlready had alt: ${stats.alreadyHadAlt}`);
console.log('\nAlt added:');
for (const [rule, n] of Object.entries(stats.added)) console.log(`  ${n.toString().padStart(3)}  ${rule}`);
console.log(`\nUNCLASSIFIED — needs a human decision: ${stats.unclassified.length}`);
for (const u of stats.unclassified) console.log(`  ${u}`);
