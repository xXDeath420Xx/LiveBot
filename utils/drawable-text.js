/*
 * Characters the canvas can actually draw.
 *
 * A member called "JosClaps ꨄ" put a box on her welcome card. U+AA04 is a Cham
 * letter that people use as a decorative heart; no font on this machine covers
 * it, so Pango drew its hex box — a little rectangle with "AA 04" printed in it.
 * Names carry characters like that all the time and the card has no business
 * showing anybody the failure.
 *
 * Two dead ends before this, both worth recording:
 *
 *   - Measuring the width. A real glyph can be exactly as wide as the box.
 *   - Comparing the raster against a known-missing character. Pango prints each
 *     codepoint's own hex digits inside its box, so no two boxes are identical,
 *     and comparing against the frame they share cannot separate a box from a
 *     dense glyph: the real tofu covered 85% of that frame and 龘 covered 95%.
 *
 * fontconfig already knows the answer exactly, and it is the same library
 * node-canvas picks fonts with, so its answer is the canvas's answer.
 */
import { execFileSync } from 'child_process';

const coverage = new Map();     // codepoint -> true when some font has a glyph

/* Colour emoji are a separate problem with the same symptom. fontconfig reports
   Noto Color Emoji as covering them, and node-canvas then draws the glyph as a
   solid black blob rather than a box — technically rendered, still not something
   to put on a card. Emoji belong in the message text, where Discord draws them.
 *
 * Blanket-stripping the symbol BLOCKS is wrong, though: U+2605 ★ lives in the
 * same block as emoji and DejaVu draws it perfectly. The test has to be which
 * fonts actually cover the character, not which range it falls in. */
const EMOJI_FONT = /emoji/i;

/**
 * Can the canvas draw this codepoint?
 *
 * False when no font covers it at all (a hex box), and false when the only
 * fonts that do are colour-emoji faces (a black blob).
 */
function drawable(code) {
    if (coverage.has(code)) return coverage.get(code);
    let ok = true;
    try {
        const out = execFileSync('fc-list', [`:charset=${code.toString(16)}`, 'family'],
            { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
        const families = out.split('\n').map((l) => l.trim()).filter(Boolean);
        ok = families.length > 0 && !families.every((f) => EMOJI_FONT.test(f));
    } catch {
        // No fontconfig, or it failed: assume drawable rather than eat the name.
        ok = true;
    }
    coverage.set(code, ok);
    return ok;
}

/**
 * Drop every character that would render as a box or a blob.
 *
 * ASCII and Latin Extended-A skip the check entirely — they are always present
 * and the overwhelming majority of every name is made of them.
 *
 * If that leaves nothing at all, the original is returned: a member whose whole
 * name is undrawable is better served by a row of boxes than by a blank card.
 */
export function drawableText(text) {
    const input = String(text ?? '');
    if (!input) return '';

    let out = '';
    for (const ch of input) {
        const code = ch.codePointAt(0);
        if (code < 0x0250) { out += ch; continue; }
        if (drawable(code)) out += ch;
    }

    // Stripping a trailing decoration leaves the space it was sitting after.
    const cleaned = out.replace(/\s{2,}/g, ' ').trim();
    return cleaned || input;
}

export default { drawableText };
