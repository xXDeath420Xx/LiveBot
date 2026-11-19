/*
 * Channel name styling.
 *
 * Servers that decorate their channel names — a Unicode alphabet plus a matching
 * pair of ornaments — have no way to keep a NEW channel consistent except by
 * hand-copying an existing name and editing the middle of it. Get one codepoint
 * wrong and the odd channel out is visible forever in the sidebar.
 *
 * This reads the style off the channels already in a category and applies it to a
 * plain name, so the owner types "movie night" and gets a name that matches its
 * neighbours exactly.
 *
 * Known limit: a per-channel emoji prefix ("🎮・gaming", "🎨・art") has no common
 * prefix to find, so those servers fall through to a plain name. That is a miss,
 * not a corruption — nothing invented, nothing mangled — and the owner can still
 * type the emoji themselves.
 *
 * The alphabets are Unicode's Mathematical Alphanumeric Symbols. They are NOT a
 * contiguous run: several letters were already encoded in Letterlike Symbols
 * years earlier, so the maths block skips them and those letters live somewhere
 * else entirely. Italic lowercase h is the one that bites most often (U+210E,
 * PLANCK CONSTANT) — walking the block arithmetically produces a reserved
 * codepoint and the name renders as a hole.
 */

const A = 'A'.codePointAt(0);
const a = 'a'.codePointAt(0);

// [upperBase, lowerBase, digitBase|null, {gaps}]
const ALPHABETS = {
    bold:              [0x1D400, 0x1D41A, 0x1D7CE, {}],
    italic:            [0x1D434, 0x1D44E, null,    { h: 0x210E }],
    boldItalic:        [0x1D468, 0x1D482, null,    {}],
    script:            [0x1D49C, 0x1D4B6, null,    { B: 0x212C, E: 0x2130, F: 0x2131, H: 0x210B, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211B, e: 0x212F, g: 0x210A, o: 0x2134 }],
    boldScript:        [0x1D4D0, 0x1D4EA, null,    {}],
    fraktur:           [0x1D504, 0x1D51E, null,    { C: 0x212D, H: 0x210C, I: 0x2111, R: 0x211C, Z: 0x2128 }],
    boldFraktur:       [0x1D56C, 0x1D586, null,    {}],
    doubleStruck:      [0x1D538, 0x1D552, 0x1D7D8, { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 }],
    sansSerif:         [0x1D5A0, 0x1D5BA, 0x1D7E2, {}],
    sansBold:          [0x1D5D4, 0x1D5EE, 0x1D7EC, {}],
    sansItalic:        [0x1D608, 0x1D622, null,    {}],
    sansBoldItalic:    [0x1D63C, 0x1D656, null,    {}],
    monospace:         [0x1D670, 0x1D68A, 0x1D7F6, {}],
};

/** Build the reverse lookup once: styled codepoint -> plain character. */
const DECODE = new Map();
for (const [name, [up, low, dig, gaps]] of Object.entries(ALPHABETS)) {
    for (let i = 0; i < 26; i++) {
        const U = String.fromCharCode(A + i);
        const L = String.fromCharCode(a + i);
        DECODE.set(gaps[U] ?? up + i, [U, name]);
        DECODE.set(gaps[L] ?? low + i, [L, name]);
    }
    if (dig) for (let i = 0; i < 10; i++) DECODE.set(dig + i, [String(i), name]);
}

/** A letter or digit in any alphabet — i.e. part of the name, not decoration. */
function isLetterish(ch) {
    if (!ch) return false;
    if (DECODE.has(ch.codePointAt(0))) return true;
    return /[0-9A-Za-z]/.test(ch);
}

/** Style a single character, leaving anything the alphabet lacks untouched. */
function styleChar(ch, alphabet) {
    const spec = ALPHABETS[alphabet];
    if (!spec) return ch;
    const [up, low, dig, gaps] = spec;
    if (gaps[ch]) return String.fromCodePoint(gaps[ch]);
    const cp = ch.codePointAt(0);
    if (cp >= A && cp <= A + 25) return String.fromCodePoint(up + (cp - A));
    if (cp >= a && cp <= a + 25) return String.fromCodePoint(low + (cp - a));
    // Most alphabets have no digits — italic and script included. Leaving the
    // digit plain is what a human doing this by hand does, and it matches the
    // server name this was written for ("MetalGurl2K" keeps a plain 2).
    if (dig && ch >= '0' && ch <= '9') return String.fromCodePoint(dig + (+ch));
    return ch;
}

/** Strip styling back to plain ASCII. */
export function toPlain(name) {
    let out = '';
    for (const ch of String(name)) {
        const hit = DECODE.get(ch.codePointAt(0));
        out += hit ? hit[0] : ch;
    }
    return out;
}

/**
 * A name fit for somewhere small and plain — an embed footer, a log line, an
 * audit reason.
 *
 * Decorated names are designed for the server list, where the text is large.
 * The same name at 12px is a row of ornaments nobody can parse, and any digit
 * in it stays an ordinary upright numeral because most of these alphabets have
 * no digits — which is precisely what makes it look broken rather than styled.
 *
 * Letters come back to plain ASCII and the ornaments are trimmed off each end.
 * Emoji are kept: a lotus or a wolf in a server's name is part of its identity,
 * not decoration, and dropping it loses something. A name that was already
 * plain passes through untouched.
 */
export function readableName(name) {
    let out = toPlain(name);
    const keep = (ch) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(ch);
    const chars = [...out];
    let a = 0, b = chars.length;
    while (a < b && !keep(chars[a])) a++;
    while (b > a && !keep(chars[b - 1])) b--;
    return chars.slice(a, b).join('').trim();
}

/**
 * Read the decoration off a set of sibling channel names.
 *
 * Returns the ornaments that wrap every name and the alphabet the letters use.
 * Everything is optional: a server with plain names gets a style that is a no-op,
 * which is the right answer rather than an error.
 */
export function detectStyle(names) {
    const list = (names || []).map(n => String(n)).filter(Boolean);
    if (list.length < 2) return { prefix: '', suffix: '', alphabet: null, confidence: 0 };

    const chars = list.map(n => [...n]);

    // Ornaments are read from the MAJORITY, not from every name. One channel that
    // was never styled — there is usually one, the staff channel nobody thought
    // about — otherwise drags the common affix to nothing and every new channel
    // gets created bare. Codepoints throughout, so a surrogate pair is never
    // split down the middle.
    const quorum = Math.max(2, Math.ceil(list.length * 0.6));
    const affix = (at) => {
        let best = 0;
        for (let len = 1; len <= Math.min(...chars.map(c => c.length)); len++) {
            const tally = new Map();
            for (const c of chars) {
                const key = at === 'start'
                    ? c.slice(0, len).join('')
                    : c.slice(c.length - len).join('');
                tally.set(key, (tally.get(key) || 0) + 1);
            }
            const top = [...tally.values()].reduce((m, v) => Math.max(m, v), 0);
            if (top >= quorum) best = len; else break;
        }
        return best;
    };
    let pre = affix('start');
    let suf = affix('end');

    // Re-anchor on a name that actually carries the ornaments, so the slices below
    // read the decoration rather than the outlier's first characters.
    const anchor = chars.find(c => {
        const p = c.slice(0, pre).join('');
        return chars.filter(o => o.slice(0, pre).join('') === p).length >= quorum;
    }) || chars[0];
    chars[0] = anchor;

    // An ornament contains no letters or digits — that is the whole rule, and it
    // is what stops the two failure modes a common-affix match falls into:
    // channels that happen to share a last letter (Updates / Guidelines /
    // Announcements all end in "s") and channels that share a whole word
    // ("Community-Rules", "Community-Updates"). Cut the prefix at its first
    // letter and the suffix after its last.
    const pchars = chars[0].slice(0, pre);
    const firstLetter = pchars.findIndex(isLetterish);
    if (firstLetter !== -1) pre = firstLetter;

    const schars = chars[0].slice(chars[0].length - suf);
    let lastLetter = -1;
    schars.forEach((c, i) => { if (isLetterish(c)) lastLetter = i; });
    if (lastLetter !== -1) suf -= lastLetter + 1;

    const prefix = chars[0].slice(0, pre).join('');
    const suffix = suf ? chars[0].slice(chars[0].length - suf).join('') : '';

    // Which separator the siblings use between words, where they show one.
    let dash = 0, space = 0;
    for (const c of chars) {
        const core = c.slice(pre, c.length - suf).join('');
        if (core.includes('-')) dash++;
        if (core.includes(' ')) space++;
    }

    // Whichever alphabet the stripped middles mostly use.
    const tally = {};
    let letters = 0;
    for (const c of chars) {
        for (const ch of c.slice(pre, c.length - suf)) {
            const hit = DECODE.get(ch.codePointAt(0));
            if (hit) { tally[hit[1]] = (tally[hit[1]] || 0) + 1; letters++; }
        }
    }
    const best = Object.entries(tally).sort((x, y) => y[1] - x[1])[0];
    return {
        prefix, suffix,
        alphabet: best ? best[0] : null,
        // Voice channels are usually written with spaces and text channels with
        // hyphens, so this is read off the neighbours rather than assumed.
        separator: space > dash ? ' ' : '-',
        confidence: letters ? (best[1] / letters) : 0,
    };
}

/**
 * Apply a detected style to a plain name.
 *
 * The input is normalised first, so re-styling an already-decorated name is safe
 * and idempotent — an owner pasting an existing name back in doesn't end up with
 * the ornaments doubled.
 */
export function applyStyle(plainName, style, overrides = {}) {
    const { prefix = '', suffix = '', alphabet = null } = style || {};
    const separator = overrides.separator ?? style?.separator ?? '-';
    let core = toPlain(plainName).trim();

    if (prefix && core.startsWith(toPlain(prefix))) core = core.slice(toPlain(prefix).length);
    if (suffix && core.endsWith(toPlain(suffix))) core = core.slice(0, core.length - toPlain(suffix).length);

    core = core.trim().replace(/[\s-]+/g, separator);
    const styled = alphabet ? [...core].map(ch => styleChar(ch, alphabet)).join('') : core;
    return prefix + styled + suffix;
}

export const ALPHABET_NAMES = Object.keys(ALPHABETS);
