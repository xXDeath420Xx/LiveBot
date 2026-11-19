/*
 * Obfuscated-URL "fake support" scam detector — pure (no Discord or DB access; unit-tested in
 * tests/message-threats.test.js). The live side is core/message-threats.js, which runs it as a stage
 * of the phishing pipeline (core/phishing-detection-manager.js) and on Discord AutoMod hits
 * (events/autoModerationActionExecution.js).
 *
 * The scam this exists for is a copypasta: "your account was flagged, open a ticket with our support
 * team here" followed by a Discord invite to a fake support server, written so that link filters (and
 * Discord's own invite detection) do not see it:
 *
 *   https://disc            the link chopped across lines
 *   ord.gg/abc
 *   https:////discord.gg/x  extra slashes            https:\\discord.gg/x   backslashes
 *   https://@discord.gg/x   junk before the host     discord。gg/x          full-width full stop
 *   dis cord.gg/x           a split inside the name  %64iscord.gg/x         percent-encoded host
 *   dіscord.gg/x            a Cyrillic і             disc​ord.gg/x          a zero-width space
 *
 * How it decides. The message is canonicalised in stages (code blocks removed first: a link in a code
 * block is not clickable and is how people quote things). A link that is only visible AFTER a stage
 * was hidden by that stage's technique; malformed URL syntax (slashes, backslashes, userinfo) is
 * detected on the URL token itself, because there the invite text is visible but the URL is broken on
 * purpose. Then the lure words are scored ("support", "ticket", "appeal", "mod", "help desk"…).
 *
 *   confirmed   an obfuscated Discord invite (or a deceptively-built link to any host) AND at least
 *               LURE_MIN distinct lure groups — the copypasta. Acted on with the server's action.
 *   suspicious  obfuscation without the lure, or a lure around an obfuscated non-Discord link.
 *               Review alerts only, never an automatic punishment.
 *   none
 *
 * Defanged links ("discord[.]gg", "hxxps://", "example(dot)com") are deliberately NOT obfuscation:
 * that is how people quote a bad link safely, and Hashbot draws the same line. A link that is visible
 * only once defanging is undone is reported as `defanged` and never makes a message confirmed.
 * (core/link-policy.js treats defanging as an evasion signal for BLOCKING a link, which is fine there;
 * this module decides bans.)
 */
import { foldConfusables, foldLeet } from '../utils/text-fold.js';

export const LURE_MIN = 2;
const MAX_INPUT = 4000;

// Invisible format characters (zero-width space/joiner, bidi controls, soft hyphen, word joiner…).
const INVISIBLE_RE = /[\p{Cf}᠎ㅤﾠᅟᅠ⠀]/gu;
// Full stops that are not "." — ideographic, halfwidth ideographic, fullwidth, vertical/small forms.
const ODD_DOTS_RE = /[。｡．︒﹒․·⸳・]/g;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

// Undoing defanging: the forms people use to quote a link without making it live.
const DEFANG = [
    [/\bhxxp(s?)/gi, 'http$1'],
    [/\bh\*\*p(s?)/gi, 'http$1'],
    [/\s*\[\s*(?:\.|dot)\s*\]\s*/gi, '.'],
    [/\s*\(\s*(?:\.|dot)\s*\)\s*/gi, '.'],
    [/\s*\{\s*(?:\.|dot)\s*\}\s*/gi, '.'],
    [/\[\s*:\s*\]/g, ':'],
    [/\[\s*\/\s*\]/g, '/'],
    [/\s+dot\s+(?=[a-z]{2,})/gi, '.'],
];

// A Discord invite (the target of the scam), after canonicalisation. Lower case only.
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|discord\.io|discord\.li|dsc\.gg|invite\.gg)\/([a-z0-9-]{2,32})/g;
// A URL with a scheme, after canonicalisation: the host is what we want.
const SCHEME_URL_RE = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/g;
// A URL token as written (possibly broken): scheme, the separator run, and the rest of the token.
const URL_TOKEN_RE = /h\s*t\s*t\s*p\s*(s?)\s*:\s*([/\\\s]*)([^\s<>"'`]*)/g;
const DISCORD_HOST_RE = /^(?:discord(?:app)?\.(?:gg|com|me|io|li)|dsc\.gg|invite\.gg)$/;

const TECHNIQUE_LABEL = Object.freeze({
    zero_width: 'zero-width characters inside the link',
    lookalike: 'look-alike or full-width letters',
    odd_dot: 'a full-width or ideographic full stop',
    percent: 'percent-encoded characters',
    line_split: 'the link chopped across lines',
    spacing: 'spaces inside the link',
    slashes: 'extra or missing slashes after the scheme',
    backslash: 'backslashes instead of slashes',
    userinfo: 'junk before the host (user@host trick)',
});
export const TECHNIQUES = Object.freeze(Object.keys(TECHNIQUE_LABEL));
export const techniqueLabel = (t) => TECHNIQUE_LABEL[t] ?? t;

// ── canonicalisation stages ──────────────────────────────────────────────────

/** Lower-case, line-preserving fold of look-alike letters (foldConfusables collapses newlines). */
function foldLines(s) {
    return s.split('\n').map(line => foldConfusables(line)).join('\n');
}
const plainLower = (s) => s.split('\n').map(l => l.toLowerCase().replace(/\s+/g, ' ').trim()).join('\n');

function decodePercent(s) {
    // Only characters a host or path is made of; "%20" and friends are left alone so a decoded space
    // cannot glue two words together.
    return s.replace(/%([0-9a-f]{2})/gi, (m, hex) => {
        const ch = String.fromCharCode(parseInt(hex, 16));
        return /[a-z0-9.\-/:@_~]/i.test(ch) ? ch.toLowerCase() : m;
    });
}

/**
 * Join line breaks that cut a link in two — and only those. A blanket join would glue every
 * "see https://example.com" line to the "thanks" under it and invent a host.
 */
function joinSplitLines(s) {
    const lines = s.split('\n');
    if (lines.length < 2) return s;
    let out = lines[0];
    let prevLine = lines[0];
    for (let i = 1; i < lines.length; i++) {
        const next = lines[i];
        const prevTrim = out.replace(/\s+$/, '');
        const nextTrim = next.replace(/^\s+/, '');
        const lastToken = prevTrim.slice(-300).split(/\s+/).pop() || '';   // the tail only: `out` keeps growing
        const firstToken = nextTrim.split(/\s+/)[0] || '';
        let join = false;
        if (!lastToken || !firstToken) join = false;
        else if (/^h\s*t\s*t\s*p/i.test(firstToken)) join = false;                         // a new link starts
        else if (/[./:@\\]$/.test(lastToken) || /^[./:@\\]/.test(firstToken)) join = true;  // "discord" / ".gg/x"
        else if (/:\/\//.test(lastToken) && !/^[^/]*\.[a-z]{2,}(?:[/:?#]|$)/i.test(lastToken.replace(/^[a-z]+:\/+/i, ''))
            && /[./]/.test(firstToken)) join = true;                                         // "https://disc" / "ord.gg/x"
        else if (prevLine.replace(/\s/g, '').length <= 3 && nextTrim.replace(/\s/g, '').length <= 3) join = true; // one letter per line
        out = join ? prevTrim + nextTrim : `${out}\n${next}`;
        prevLine = next;
    }
    return out;
}

/** Spaces that split a link: around . / :, letter-spaced runs, and splits inside "discord". */
function removeLinkSpaces(s) {
    return s
        .replace(/\b(?:[a-z0-9] )+[a-z0-9]\b/g, (run) => run.replace(/ /g, ''))
        .replace(/d\s*i\s*s\s*c\s*o\s*r\s*d/g, (m) => m.replace(/\s+/g, ''))
        .replace(/[ \t]*([./:])[ \t]*/g, '$1');
}

function fixUrlSyntax(s) {
    return s
        .replace(/(https?)\s*:\s*[/\\][/\\\s]*/g, '$1://')
        .replace(/(https?:\/\/)[^\s/@]*@+/g, '$1');
}

/**
 * The canonical forms of a message, stage by stage. Each entry is { name, text, technique, changed }:
 * `technique` is false for the bookkeeping stages (raw, defang, url_syntax).
 */
export function canonicalStages(content, { defang = true } = {}) {
    const raw = String(content ?? '').slice(0, MAX_INPUT).replace(CODE_FENCE_RE, ' ').replace(INLINE_CODE_RE, ' ').replace(/\r\n?/g, '\n');
    const stages = [];
    let text = plainLower(raw);
    stages.push({ name: 'raw', text, technique: false, changed: false });
    const push = (name, next, technique = true) => { stages.push({ name, text: next, technique, changed: next !== text }); text = next; };

    const visible = raw.replace(INVISIBLE_RE, '');
    push('zero_width', plainLower(visible));
    push('odd_dot', plainLower(visible.replace(ODD_DOTS_RE, '.')));
    push('lookalike', foldLines(visible.replace(ODD_DOTS_RE, '.')));
    if (defang) {
        let d = text;
        for (const [re, rep] of DEFANG) d = d.replace(re, rep);
        push('defang', d, false);
    }
    push('percent', decodePercent(text));
    push('line_split', joinSplitLines(text));
    push('spacing', removeLinkSpaces(text));
    push('url_syntax', fixUrlSyntax(text), false);
    return stages;
}

// ── targets ──────────────────────────────────────────────────────────────────

const invitesIn = (text) => [...String(text).matchAll(INVITE_RE)].map(m => ({ code: m[1], text: m[0] }));

function hostsIn(text) {
    const out = new Set();
    for (const m of String(text).matchAll(SCHEME_URL_RE)) {
        const host = m[1].replace(/\.+$/, '').replace(/^www\./, '');
        const tld = host.slice(host.lastIndexOf('.') + 1);
        if (/^[a-z]{2,24}$/.test(tld)) out.add(host);
    }
    return out;
}

/** Same invite if one code is a prefix of the other (a later stage may glue the next word on). */
const sameInvite = (a, b) => a.code.startsWith(b.code) || b.code.startsWith(a.code);

/**
 * Broken URL tokens: the invite text is visible but the URL around it is malformed on purpose.
 * Run on the text after look-alikes, odd dots, percent-encoding, line splits and spaces are undone.
 * @returns {Array<{ tricks:string[], token:string, fixed:string }>}
 */
function brokenUrlTokens(text) {
    const out = [];
    for (const m of String(text).matchAll(URL_TOKEN_RE)) {
        const sep = m[2].replace(/\s+/g, '');
        const rest = m[3];
        const tricks = [];
        if (sep.includes('\\')) tricks.push('backslash');
        if (sep.replace(/\\/g, '/') !== '//') tricks.push('slashes');
        if (rest.split('/')[0].includes('@')) tricks.push('userinfo');
        if (!tricks.length) continue;
        out.push({ tricks: [...new Set(tricks)], token: m[0], fixed: `http${m[1]}://${rest.replace(/^[^/@]*@+/, '')}` });
    }
    return out;
}

// ── lure words ───────────────────────────────────────────────────────────────

export const LURE_GROUPS = Object.freeze({
    support: [/\bsupport\b/, /\bhelp\s*desk\b/, /\bhelpdesk\b/, /\bcustomer\s*(?:service|care|support)\b/, /\bassistance\b/, /\btech(?:nical)?\s*team\b/],
    ticket: [/\btickets?\b/, /\bopen\s+(?:a\s+)?(?:case|request|claim)\b/, /\bsupport\s*server\b/],
    appeal: [/\bappeals?\b/, /\bunban\b/, /\bwrongly\s+(?:banned|flagged|reported)\b/, /\bdispute\b/],
    staff: [/\bmod(?:s|erators?|eration)?\b/, /\badmins?\b/, /\bstaff\b/, /\btrust\s*(?:&|and)\s*safety\b/, /\bdiscord\s*(?:team|employee|official)\b/, /\bofficial\b/],
    account: [/\b(?:account|acc)\b[^.\n]{0,30}\b(?:flagged|banned|suspended|disabled|terminated|locked|reported|compromised|deleted|limited)\b/,
        /\b(?:flagged|suspended|terminated)\b/, /\bverif(?:y|ication)\b/, /\bfalse(?:ly)?\s+reported\b/],
    help: [/\bhelp\b/, /\bissues?\b/, /\bproblems?\b/, /\bresolve[ds]?\b/, /\bcontact\b/, /\breach\s+out\b/],
});

/** Lure groups present in a message: matched on the look-alike + leet folded text and on a de-spaced copy. */
export function scoreLure(content) {
    const raw = String(content ?? '').slice(0, MAX_INPUT).replace(CODE_FENCE_RE, ' ');
    const folded = foldLeet(raw);
    const despaced = folded.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
    const groups = [];
    for (const [name, patterns] of Object.entries(LURE_GROUPS)) {
        if (patterns.some(re => re.test(folded) || re.test(despaced))) groups.push(name);
    }
    return { score: groups.length, groups };
}

const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
/** Emoji as people see them (one grapheme each) plus custom emoji. */
export function countEmoji(content) {
    const s = String(content ?? '').slice(0, MAX_INPUT);
    const custom = (s.match(/<a?:\w+:\d+>/g) || []).length;
    const rest = s.replace(/<a?:\w+:\d+>/g, '');
    let n = 0;
    if (graphemes) { for (const { segment } of graphemes.segment(rest)) if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) n++; }
    else n = (rest.match(/\p{Extended_Pictographic}/gu) || []).length;
    return custom + n;
}

/** Cheap pre-filter: could this message contain an obfuscated link at all? */
export function mightContainLink(content) {
    const s = String(content ?? '');
    if (!s) return false;
    return /h\W{0,3}t\W{0,3}t\W{0,3}p|d\W{0,3}[i1lі]\W{0,3}s\W{0,3}c|dsc|%[0-9a-f]{2}|[。｡．︒﹒]|\.\s*g\s*g\b|invite/i.test(s)
        || /[\p{Cf}]/u.test(s);
}

// ── the analysis ─────────────────────────────────────────────────────────────

/**
 * @param {string} content
 * @returns {{
 *   verdict: 'confirmed'|'suspicious'|'none',
 *   obfuscated: boolean, discordTarget: boolean, defanged: boolean,
 *   techniques: string[], invites: string[], hiddenInvites: string[], hosts: string[], hiddenHosts: string[],
 *   lure: { score:number, groups:string[] }, emoji: number, reasons: string[],
 * }}
 */
export function analyzeMessage(content) {
    const empty = {
        verdict: 'none', obfuscated: false, discordTarget: false, defanged: false, techniques: [], invites: [],
        hiddenInvites: [], hosts: [], hiddenHosts: [], lure: { score: 0, groups: [] }, emoji: 0, reasons: [],
    };
    const text = String(content ?? '');
    if (!text.trim()) return empty;

    // Two passes: without undoing defanging (what counts as obfuscation) and with it (so a quoted
    // "discord[.]gg/x" is still recognised, reported as defanged, and its host still checked).
    const strict = canonicalStages(text, { defang: false });
    const loose = canonicalStages(text, { defang: true });
    const stage = (list, name) => list.find(s => s.name === name).text;
    const raw = strict[0].text;

    const rawInvites = invitesIn(raw);
    const strictInvites = invitesIn(stage(strict, 'spacing'));
    const looseInvites = invitesIn(loose[loose.length - 1].text);

    const techniques = new Set();
    const hiddenInvites = [];
    for (const inv of strictInvites) {
        if (rawInvites.some(r => sameInvite(r, inv))) continue;
        // Which stage revealed it, and every technique stage up to it that changed the text.
        let revealed = null;
        for (const st of strict) {
            if (invitesIn(st.text).some(r => sameInvite(r, inv))) { revealed = st; break; }
        }
        if (!revealed?.technique) continue;
        hiddenInvites.push(inv.text);
        for (const st of strict) {
            if (st.technique && st.changed) techniques.add(st.name);
            if (st === revealed) break;
        }
    }

    // Broken URL tokens around otherwise-visible links.
    let brokenDiscord = false;
    let brokenOther = false;
    for (const b of brokenUrlTokens(stage(strict, 'spacing'))) {
        const fixedInvites = invitesIn(b.fixed);
        if (fixedInvites.length) {
            brokenDiscord = true;
            for (const i of fixedInvites) if (!hiddenInvites.includes(i.text)) hiddenInvites.push(i.text);
        } else if (hostsIn(b.fixed).size) brokenOther = true;
        else continue;
        for (const t of b.tricks) techniques.add(t);
        if (/%[0-9a-f]{2}/i.test(stage(strict, 'lookalike'))) techniques.add('percent');
    }

    // Hosts: everything visible once canonicalised (defang undone) is returned for the phishing lookups;
    // hosts only visible after a technique stage (defang NOT undone) and not in the raw text are hidden.
    const rawHosts = hostsIn(raw);
    const hostsOf = (list) => new Set([...hostsIn(stage(list, 'line_split')), ...hostsIn(list[list.length - 1].text)]);
    const strictHosts = hostsOf(strict);
    const looseHosts = hostsOf(loose);
    const hiddenHosts = [...strictHosts].filter(h => !rawHosts.has(h) && !DISCORD_HOST_RE.test(h));
    if (hiddenHosts.length) {
        for (const st of strict) if (st.technique && st.changed) techniques.add(st.name);
    }

    const defanged = loose.some(s => s.name === 'defang' && s.changed)
        && (looseInvites.some(l => !strictInvites.some(s => sameInvite(s, l)) && !rawInvites.some(r => sameInvite(r, l)))
            || [...looseHosts].some(h => !strictHosts.has(h)));

    const discordTarget = hiddenInvites.length > 0 || brokenDiscord;
    const deceptive = techniques.has('userinfo') || techniques.has('percent');
    const obfuscated = discordTarget || hiddenHosts.length > 0 || brokenOther;
    const lure = scoreLure(text);
    const emoji = countEmoji(text);

    let verdict = 'none';
    if (obfuscated && lure.score >= LURE_MIN && (discordTarget || deceptive)) verdict = 'confirmed';
    else if (obfuscated) verdict = 'suspicious';

    const how = [...techniques].map(techniqueLabel).join(', ') || 'disguised';
    const reasons = [];
    if (discordTarget) reasons.push(`obfuscated Discord invite (${how})`);
    else if (obfuscated) reasons.push(`obfuscated link (${how})`);
    if (lure.score) reasons.push(`lure words: ${lure.groups.join(', ')}`);
    if (defanged && !obfuscated) reasons.push('defanged link (quoted safely; not treated as obfuscation)');

    return {
        verdict,
        obfuscated,
        discordTarget,
        defanged,
        techniques: [...techniques],
        invites: [...new Set([...rawInvites, ...strictInvites, ...looseInvites].map(i => i.text))],
        hiddenInvites,
        hosts: [...new Set([...rawHosts, ...strictHosts, ...looseHosts])],
        hiddenHosts,
        lure,
        emoji,
        reasons,
    };
}

export default { analyzeMessage, scoreLure, countEmoji, canonicalStages, mightContainLink, techniqueLabel, TECHNIQUES, LURE_GROUPS, LURE_MIN };
