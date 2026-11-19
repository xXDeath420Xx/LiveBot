/*
 * Text folding — the one place lookalike text is turned back into plain ASCII for matching.
 * Pure (no imports), unit-tested in tests/text-fold.test.js.
 *
 * Used by name filters (core/name-filter-logic.js) and by the older call sites that each had their
 * own partial copy: duplicate-message comparison (core/automod.js), the self-promo channel-name
 * check (events/messageCreate.js), takeover channel lookup (core/takeover-manager.js) and the
 * commission filter (core/commission-spam-match.js).
 *
 * NFKC alone is not enough. It folds fullwidth, mathematical alphanumerics (𝐬𝐮𝐩𝐩𝐨𝐫𝐭), circled
 * and superscript letters, but leaves alone everything a scammer actually reaches for:
 *
 *   Cyrillic / Greek / Armenian / Cherokee letters that look Latin    ѕuррогt  Ꮪupport
 *   small capitals and IPA letters                                    ꜱᴜᴘᴘᴏʀᴛ
 *   negative-circled / negative-squared / regional-indicator letters  🅢🅤🅟  🆂🆄🅿  🇸🇺🇵
 *   parenthesised letters (NFKC turns ⒮ into "(s)")                   ⒮⒰⒫
 *   combining marks — accents and "zalgo" stacks                      s̷̢u̵p̴p̶o̸r̷t̶
 *   invisible characters: zero-width, bidi controls, Hangul fillers   sup​port
 *
 * Three levels, each built on the one before:
 *
 *   foldConfusables  lookalikes → ASCII, marks and invisibles gone, lower case, spaces collapsed
 *   foldLeet         also 0→o 1→i 3→e 4→a 5→s 7→t 8→b 9→g @→a $→s !→i |→l, but only inside a
 *                    word that has a letter in it ("m0d3rat0r" → "moderator"; "2024" stays)
 *   skeleton         also merges the shapes that read the same at a glance (i/l/1, rn/m, vv/w),
 *                    for comparing two strings: compare skeleton(a) with skeleton(b), never a
 *                    skeleton with plain text — "official" becomes "offlclal" on both sides.
 *
 * collapse() optionally strips separators and repeated letters ("s.u.p.p.o.o.r.t" → "suport"); it
 * has to be applied to both sides of a comparison as well.
 */

// Letters NFKC leaves alone, mapped by sight. Upper and lower case listed separately where the two
// look different (Cyrillic Н is H, н is a small-capital h).
const CONFUSABLES = {
    // Cyrillic
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'з': '3', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'п': 'n',
    'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ь': 'b', 'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j',
    'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'һ': 'h', 'ѡ': 'w', 'ү': 'y', 'ґ': 'r', 'г': 'r', 'д': 'd',
    'и': 'u', 'л': 'n', 'ц': 'u', 'ш': 'w', 'щ': 'w', 'ъ': 'b', 'ы': 'bi', 'э': 'e', 'ю': 'io', 'я': 'r',
    'А': 'A', 'В': 'B', 'Е': 'E', 'Ё': 'E', 'З': '3', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'П': 'N',
    'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ь': 'B', 'Ѕ': 'S', 'І': 'I', 'Ї': 'I', 'Ј': 'J',
    'Ԁ': 'D', 'Ԛ': 'Q', 'Ԝ': 'W', 'Ӏ': 'I', 'Һ': 'H', 'Ү': 'Y', 'Г': 'R', 'Д': 'D', 'И': 'U', 'Л': 'N',
    'Ц': 'U', 'Ш': 'W', 'Щ': 'W', 'Я': 'R',
    // Greek
    'α': 'a', 'β': 'b', 'γ': 'y', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'θ': 'o', 'ι': 'i', 'κ': 'k',
    'λ': 'l', 'μ': 'u', 'ν': 'v', 'ο': 'o', 'π': 'n', 'ρ': 'p', 'σ': 'o', 'ς': 'c', 'τ': 't', 'υ': 'u',
    'φ': 'o', 'χ': 'x', 'ψ': 'w', 'ω': 'w', 'ϲ': 'c', 'ϳ': 'j', 'ϐ': 'b', 'ϑ': 'o', 'ϱ': 'p', 'ϵ': 'e',
    'Α': 'A', 'Β': 'B', 'Γ': 'R', 'Δ': 'A', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Θ': 'O', 'Ι': 'I', 'Κ': 'K',
    'Λ': 'A', 'Μ': 'M', 'Ν': 'N', 'Ξ': 'E', 'Ο': 'O', 'Π': 'N', 'Ρ': 'P', 'Σ': 'E', 'Τ': 'T', 'Υ': 'Y',
    'Φ': 'O', 'Χ': 'X', 'Ψ': 'W', 'Ω': 'O', 'Ϲ': 'C', 'Ϳ': 'J',
    // Armenian
    'օ': 'o', 'ս': 'u', 'հ': 'h', 'ո': 'n', 'ց': 'g', 'զ': 'q', 'ա': 'w', 'ւ': 'l', 'ք': 'p', 'Օ': 'O',
    'Ս': 'U', 'Ց': 'G', 'Ք': 'P',
    // Cherokee (capital forms; NFKC does not touch them)
    'Ꭺ': 'A', 'Ᏼ': 'B', 'Ꮯ': 'C', 'Ꭰ': 'D', 'Ꭼ': 'E', 'Ꮐ': 'G', 'Ꮋ': 'H', 'Ꭵ': 'I', 'Ꭻ': 'J', 'Ꮶ': 'K',
    'Ꮮ': 'L', 'Ꮇ': 'M', 'Ꮑ': 'N', 'Ꮎ': 'O', 'Ꮲ': 'P', 'Ꭱ': 'R', 'Ꮪ': 'S', 'Ꭲ': 'T', 'Ꮩ': 'V', 'Ꮃ': 'W',
    'Ꮍ': 'Y', 'Ꮓ': 'Z',
    // Latin small capitals and IPA letters
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j',
    'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't',
    'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z', 'ᴁ': 'ae', 'ᴂ': 'ae', 'ᴃ': 'b', 'ᴆ': 'd', 'ᴈ': 'e',
    'ᴉ': 'i', 'ᴌ': 'l', 'ᴎ': 'n', 'ᴐ': 'o', 'ᴑ': 'o', 'ᴒ': 'o', 'ᴓ': 'o', 'ᴔ': 'oe', 'ᴕ': 'ou', 'ᴖ': 'o',
    'ᴗ': 'o', 'ᴙ': 'r', 'ᴚ': 'r', 'ᴝ': 'u', 'ᴞ': 'u', 'ᴟ': 'm',
    'ɑ': 'a', 'ɐ': 'a', 'ɒ': 'a', 'ɓ': 'b', 'ƀ': 'b', 'ƈ': 'c', 'ɔ': 'c', 'ɕ': 'c', 'ɗ': 'd', 'ɖ': 'd',
    'đ': 'd', 'ð': 'd', 'ɛ': 'e', 'ɘ': 'e', 'ə': 'e', 'ƒ': 'f', 'ɠ': 'g', 'ɡ': 'g', 'ɦ': 'h', 'ħ': 'h',
    'ı': 'i', 'ɨ': 'i', 'ɩ': 'i', 'ȷ': 'j', 'ʝ': 'j', 'ƙ': 'k', 'ł': 'l', 'ɫ': 'l', 'ɭ': 'l', 'ɱ': 'm',
    'ɲ': 'n', 'ɳ': 'n', 'ŋ': 'n', 'ø': 'o', 'ɵ': 'o', 'ƥ': 'p', 'þ': 'p', 'ʠ': 'q', 'ɍ': 'r', 'ɾ': 'r',
    'ʂ': 's', 'ƭ': 't', 'ŧ': 't', 'ʈ': 't', 'ʉ': 'u', 'ʋ': 'v', 'ʌ': 'v', 'ⱳ': 'w', 'ʍ': 'w', 'ƴ': 'y',
    'ɏ': 'y', 'ȥ': 'z', 'ʐ': 'z', 'ƶ': 'z', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'Ø': 'O', 'Đ': 'D', 'Ð': 'D',
    'Ħ': 'H', 'Ł': 'L', 'Ŧ': 'T', 'Æ': 'AE', 'Œ': 'OE', 'Þ': 'P', 'Ŋ': 'N', 'Ɓ': 'B', 'Ɗ': 'D', 'Ƒ': 'F',
    'Ɠ': 'G', 'Ɩ': 'I', 'Ƙ': 'K', 'Ɲ': 'N', 'Ƥ': 'P', 'Ƭ': 'T', 'Ʋ': 'V', 'Ƴ': 'Y', 'Ȥ': 'Z',
    // Canadian syllabics and CJK strokes used by "fancy font" generators (ᗩᗪᗰᓰᑎ, 卂刀爪丨几)
    'ᗩ': 'a', 'ᗷ': 'b', 'ᑕ': 'c', 'ᗪ': 'd', 'ᗴ': 'e', 'ᕮ': 'e', 'ᖴ': 'f', 'ᘜ': 'g', 'ᕼ': 'h', 'ᓰ': 'i',
    'ᒍ': 'j', 'ᛕ': 'k', 'ᒪ': 'l', 'ᗰ': 'm', 'ᑎ': 'n', 'ᑭ': 'p', 'ᑫ': 'q', 'ᖇ': 'r', 'ᔕ': 's', 'ᑌ': 'u',
    'ᐯ': 'v', 'ᗯ': 'w', '᙭': 'x', 'ᖻ': 'y', 'ᘔ': 'z', 'ᗅ': 'a', 'ᗞ': 'd', 'ᑢ': 'c', 'ᒧ': 'j', 'ᑊ': 'i',
    '卂': 'a', '乃': 'b', '匚': 'c', '刀': 'd', '乇': 'e', '千': 'f', '厶': 'g', '卄': 'h', '丨': 'i', 'ﾌ': 'j',
    'Ҝ': 'k', 'ㄥ': 'l', '爪': 'm', '几': 'n', 'ㄖ': 'o', '卩': 'p', 'Ɋ': 'q', '尺': 'r', '丂': 's', 'ㄒ': 't',
    'ㄩ': 'u', '山': 'w', '乂': 'x', 'ㄚ': 'y', '乙': 'z',
    // Letterlike symbols NFKC keeps
    '℮': 'e', '℩': 'i', 'Ⅎ': 'F', 'ⅎ': 'f', '∂': 'd', '∅': 'o',
};

// Characters with no visible width, used to split a word without changing how it looks:
// format controls (zero-width space/joiner, bidi overrides, soft hyphen, tag characters) and the
// "blank" letters people use for invisible names (Hangul fillers, braille blank, Mongolian separator).
const INVISIBLE_RE = /[\p{Cf}ᅟᅠㅤﾠ⠀᠎͏]/gu;
const MARKS_RE = /\p{M}/gu;
const SPACES_RE = /\s+/gu;

/** Map one code point that lives in a lettered block NFKC does not decompose; null when it doesn't. */
function blockLetter(cp) {
    if (cp >= 0x1F150 && cp <= 0x1F169) return String.fromCharCode(97 + cp - 0x1F150); // negative circled 🅐
    if (cp >= 0x1F170 && cp <= 0x1F189) return String.fromCharCode(97 + cp - 0x1F170); // negative squared 🅰
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return String.fromCharCode(97 + cp - 0x1F1E6); // regional indicator 🇦
    if (cp >= 0x249C && cp <= 0x24B5) return String.fromCharCode(97 + cp - 0x249C);    // parenthesised ⒜
    if (cp >= 0x2474 && cp <= 0x247C) return String(cp - 0x2473);                       // parenthesised ⑴…⑼
    return null;
}

function mapLetters(s) {
    let out = '';
    for (const ch of s) {
        const mapped = CONFUSABLES[ch] ?? blockLetter(ch.codePointAt(0));
        out += mapped ?? ch;
    }
    return out;
}

/**
 * Lookalikes → ASCII, combining marks and invisible characters removed, whitespace collapsed.
 * Lower case unless `keepCase` (case-sensitive filters).
 */
export function foldConfusables(input, { keepCase = false } = {}) {
    let s = String(input ?? '').replace(INVISIBLE_RE, '');
    // Parenthesised and other block letters first: NFKC would turn ⒮ into "(s)".
    s = mapLetters(s);
    s = mapLetters(s.normalize('NFKC'));
    if (!keepCase) s = s.toLowerCase();
    // NFKD splits é into e + ◌́ (and keeps zalgo stacks as marks); dropping every mark leaves the base letters.
    s = s.normalize('NFKD').replace(MARKS_RE, '').normalize('NFC');
    return s.replace(SPACES_RE, ' ').trim();
}

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'l', '€': 'e', '¡': 'i' };
const LEET_WORD_RE = /[a-z0-9@$!|€¡]+/g;
const HAS_LETTER_RE = /[a-z]/;

/**
 * foldConfusables plus leetspeak, applied only to words that contain a letter so plain numbers
 * (dates, discriminators, "2024") are left alone. `one` picks what 1 becomes ('i' or 'l').
 */
export function foldLeet(input, { one = 'i', folded = false } = {}) {
    const s = folded ? String(input ?? '') : foldConfusables(input);
    return s.replace(LEET_WORD_RE, (word) => {
        if (!HAS_LETTER_RE.test(word)) return word;
        let out = '';
        for (const ch of word) out += ch === '1' ? one : (LEET[ch] ?? ch);
        return out;
    });
}

/**
 * The comparison form: leet-folded, then shapes that read alike merged (i/l/1/| → i, rn → m,
 * vv → w). Only meaningful when both sides of a comparison go through it.
 */
export function skeleton(input, { folded = false } = {}) {
    return foldLeet(input, { folded })
        .replace(/[l|]/g, 'i')
        .replace(/rn/g, 'm')
        .replace(/vv/g, 'w');
}

/** Separators gone and runs of one letter cut to one: "s.u.p.p.o.o.r.t" → "suport". Apply to both sides. */
export function collapse(input) {
    return String(input ?? '')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .replace(/(.)\1+/gu, '$1');
}

/**
 * Every form one piece of text is matched in, de-duplicated:
 *   raw       as written (invisibles removed, nothing else)
 *   folded    foldConfusables
 *   leet      foldLeet with 1 → i  (and leetL with 1 → l when that differs)
 *   skeleton  for phrase / exact comparison
 *   collapsed collapse(skeleton), only when `collapseRepeats`
 */
export function textForms(input, { maxLength = 128, collapseRepeats = false } = {}) {
    const raw = String(input ?? '').replace(INVISIBLE_RE, '').slice(0, maxLength);
    const folded = foldConfusables(raw);
    const leet = foldLeet(folded, { folded: true });
    const leetL = foldLeet(folded, { folded: true, one: 'l' });
    const skel = skeleton(folded, { folded: true });
    return {
        raw,
        folded,
        leet,
        leetL: leetL === leet ? null : leetL,
        skeleton: skel,
        collapsed: collapseRepeats ? collapse(skel) : null,
    };
}

export default { foldConfusables, foldLeet, skeleton, collapse, textForms };
