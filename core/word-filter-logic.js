/*
 * Filtered words: the matching rules behind core/word-filter.js. Pure; tested in tests/word-filter.test.js.
 *
 * Entries use Discord AutoMod's wildcard syntax, so one list drives both the bot and the native rule:
 *   word     the whole word only      ("spic" does not hit "spicy")
 *   word*    words starting with it
 *   *word    words ending with it
 *   *word*   anywhere
 * Exceptions are the same syntax with the wildcards ignored: the text they name is taken out before matching.
 *
 * Every entry is tried against the text after folding (utils/text-fold.js: Unicode lookalikes, zalgo,
 * invisible characters, leetspeak), with Discord markdown removed and spaced-out letters closed up, and it
 * tolerates stretched letters. A filter that only reads the text as typed is beaten by one substitution.
 *
 * Separators are NOT allowed inside a word in general, however tempting: that turns innocent pairs of words
 * into hits ("wet back", "towel head"). Only a run of single characters is closed up.
 */
import { foldConfusables, foldLeet, skeleton } from '../utils/text-fold.js';

export const MAX_ENTRIES = 1000;      // Discord: keyword_filter
export const MAX_EXCEPTIONS = 100;    // Discord: allow_list on a KEYWORD rule
export const MAX_ENTRY_LENGTH = 60;   // Discord: per keyword
export const NATIVE_RULE_NAME = 'Filtered words';
export const NATIVE_BLOCK_MESSAGE = 'That message was blocked: it contains a word this server does not allow. The moderators have been told.';
const MAX_TEXT = 4000;

const SPREAD_CHAR = '[a-z0-9@$!|]';
const SPREAD_SEP = "[\\s.,'+/-]+";
const SPREAD_RE = new RegExp(`(?<!${SPREAD_CHAR})${SPREAD_CHAR}(?:${SPREAD_SEP}${SPREAD_CHAR}){2,}(?!${SPREAD_CHAR})`, 'g');
const SPREAD_SEP_RE = new RegExp(SPREAD_SEP, 'g');
const MARKDOWN_RE = /\|\||[*_~`\\]/g;
// A trailing "!" is punctuation, not the letter i ("word!" would otherwise fold to "wordi").
const TRAILING_LEET_RE = /[!|]+(?=[\s.,?]|$)/g;

const rot13 = (s) => s.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/*
 * Native regexes for the two words people split with separators most ("xx yy"), which keywords cannot
 * express. Each is switched on by its entry being in the list, so removing the word removes the regex.
 */
const NATIVE_REGEX = new Map([
    [rot13('avtt*'), '(?i)\\bn+[\\W_]*[i1!|l]+[\\W_]*[g9]+[\\W_]*[g9]+[\\W_]*[ae34@uo0]'],
    [rot13('snttbg*'), '(?i)\\bf+[\\W_]*[a4@]+[\\W_]*[g9]+[\\W_]*[g9]+[\\W_]*[o0]+[\\W_]*t'],
]);

/** One entry per line or comma: lower case, trimmed, no duplicates, nothing Discord would refuse. */
export function parseEntries(raw, max = MAX_ENTRIES) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]+/);
    const out = new Set();
    for (const item of list) {
        const entry = String(item).toLowerCase().trim().replace(/\s+/g, ' ');
        if (!entry.replace(/\*/g, '') || entry.length > MAX_ENTRY_LENGTH) continue;
        out.add(entry);
        if (out.size >= max) break;
    }
    return [...out];
}

/** Stretched letters match ("aaa" for "a"), but a double letter in the entry stays at least double. */
function boundedRegex(stem, start, end) {
    const body = (stem.match(/(.)\1*/gsu) || [])
        .map(run => (/\s/.test(run[0]) ? '\\s+' : `${esc([...run][0])}{${[...run].length},}`))
        .join('');
    return new RegExp(`${start ? '(?<![a-z0-9])' : ''}${body}${end ? '(?![a-z0-9])' : ''}`);
}

function compileEntry(entry) {
    const start = !entry.startsWith('*');
    const end = !entry.endsWith('*');
    const stem = entry.replace(/^\*+|\*+$/g, '');
    const plain = foldLeet(stem);
    if (!plain) return null;
    return { entry, plain: boundedRegex(plain, start, end), skeleton: boundedRegex(skeleton(stem), start, end) };
}

export function compileFilter(words = [], exceptions = []) {
    const stems = exceptions.map(a => foldLeet(a.replace(/\*/g, ''))).filter(Boolean);
    return {
        entries: words.map(compileEntry).filter(Boolean),
        allow: stems,
        allowSkeleton: exceptions.map(a => skeleton(a.replace(/\*/g, ''))).filter(Boolean),
    };
}

/** The forms a message is matched in. */
export function matchForms(text) {
    const folded = foldConfusables(String(text ?? '').slice(0, MAX_TEXT));
    const unmarked = folded.replace(MARKDOWN_RE, '').replace(TRAILING_LEET_RE, '');
    const closed = unmarked.replace(SPREAD_RE, run => run.replace(SPREAD_SEP_RE, ''));
    return {
        leet: [...new Set([unmarked, foldLeet(unmarked, { folded: true }), foldLeet(closed, { folded: true })])],
        skeleton: skeleton(closed, { folded: true }),
    };
}

const without = (form, stems) => stems.reduce((text, stem) => text.split(stem).join(' '), form);

/** The list entry this text trips, or null. */
export function findEntry(text, filter) {
    if (!filter?.entries?.length) return null;
    const forms = matchForms(text);
    const leet = forms.leet.map(form => without(form, filter.allow));
    const skel = without(forms.skeleton, filter.allowSkeleton);
    for (const e of filter.entries) {
        if (leet.some(form => e.plain.test(form)) || e.skeleton.test(skel)) return e.entry;
    }
    return null;
}

/** The discord.js options for the native rule. It only blocks: the card in core/word-filter.js is the alert. */
export function nativeRuleSpec({ words, exceptions, flagChannelId, enabled }) {
    return {
        name: NATIVE_RULE_NAME,
        eventType: 1,
        triggerType: 1,
        enabled,
        triggerMetadata: {
            keywordFilter: words.slice(0, MAX_ENTRIES),
            regexPatterns: words.filter(w => NATIVE_REGEX.has(w)).map(w => NATIVE_REGEX.get(w)),
            allowList: exceptions.slice(0, MAX_EXCEPTIONS),
        },
        actions: [{ type: 1, metadata: { customMessage: NATIVE_BLOCK_MESSAGE } }],
        exemptChannels: flagChannelId ? [flagChannelId] : [],
        reason: 'Filtered words saved on the dashboard',
    };
}

export default { parseEntries, compileFilter, matchForms, findEntry, nativeRuleSpec };
