/*
 * A fixed, bot-wide floor under text the bot posts on someone else's behalf: an API reply in a custom
 * command, a line from the Evil Insult API, a generated insult. Slurs, hate slogans and self-harm
 * taunts are refused here whatever a server's own word filter says; each server's automod banned
 * words and message patterns are checked on top of this (commands/fun/fun-insult-handler.js).
 *
 * The terms are stored ROT13 so the source file is not itself a list of slurs. Matching runs on the
 * leet-folded form from utils/text-fold.js (so "n1gg…", Cyrillic lookalikes and zalgo are caught):
 *   EXACT   whole words only ("jap" must not hit "japan")
 *   PREFIX  at the start of a word, any ending ("retard" → "retarded")
 *   PHRASE  anywhere once separators and repeated letters are removed ("kill your self")
 * A false positive only costs a re-roll or an "(API response blocked)", so the lists lean strict.
 * serverFilterHit() applies one server's own automod word lists and message patterns the way automod
 * does, to the text as written and to its leet-folded form.
 * Pure; tested in tests/insult.test.js.
 */
import { foldLeet, collapse } from '../utils/text-fold.js';
import { matchPattern } from './automod-patterns.js';

const rot13 = (s) => s.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const words = (s) => s.split(' ').map(rot13);

const EXACT = new Set(words('wnc wncf snt sntf xlf jbc jbcf qntb qntbf pbba pbbaf fcvp fcvpf fcvpx cnxv cnxvf tbbx tbbxf xvxr xvxrf xlxr fcnm anmv anmvf qlxr qlxrf encr encrq encrf encvat encvfg encvfgf fdhnj vawha arteb artebrf genaal genaavrf puvax puvaxf crqb crqbf cnrqb ubzb ubzbf tlccb'));
const PREFIX = words('avtt avttn avtyrg snttbg sntbg ergneq fcnfgvp zbatbybvq wvtnobb jrgonpx ornare enturnq gbjryurnq fnaqavtt mvccreurnq fynagrlr furznyr crqbcuvy cnrqbcuvy zbyrfg uvgyre ubybpnhfg ylapu cbepuzbaxrl whatyrohaal tbyyvjbt pnzrywbpxrl unysoerrq erqfxva puvanzna pevccyr urvy');
const PHRASE = words('xvyylbhefrys arpxlbhefrys unatlbhefrys qevaxoyrnpu juvgrcbjre urvyuvgyre fvrturvy tnfgurwrjf fnaqavttre').map(collapse);

const PREFIX_RE = new RegExp(`(?:^|[^a-z])(?:${PREFIX.join('|')})`);

/** The first hateful term found in the text (decoded), or null. */
export function findHateTerm(text) {
    const leet = foldLeet(String(text ?? '').slice(0, 4000));
    for (const word of leet.split(/[^a-z]+/)) if (word && EXACT.has(word)) return word;
    const m = leet.match(PREFIX_RE);
    if (m) return m[0].replace(/^[^a-z]/, '');
    const squashed = collapse(leet);
    return PHRASE.find(p => squashed.includes(p)) || null;
}

export const containsHateTerm = (text) => findHateTerm(text) !== null;

/**
 * First entry of a server's own filter that the text trips, or null.
 * @param {{ words?: Array<{ word: string, byWord?: boolean }>, patterns?: Array<object> }} filter
 *   words: automod banned words (`byWord` = the rule's match_type 'word'); patterns: enabled
 *   `automod_patterns` rows with target 'message' ({ pattern_type, pattern, compiled? }).
 */
export function serverFilterHit(text, { words = [], patterns = [] } = {}) {
    const raw = String(text ?? '').slice(0, 4000);
    const forms = [...new Set([raw.toLowerCase(), foldLeet(raw)])];
    for (const { word, byWord } of words) {
        const w = String(word || '').toLowerCase().trim();
        if (!w) continue;
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = byWord ? new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i') : null;
        if (forms.some(f => (re ? re.test(f) : f.includes(w)))) return `word: ${w}`;
    }
    for (const p of patterns) {
        if (p.pattern_type === 'domain') continue;
        if (forms.some(f => matchPattern(p, f, p.compiled).matched)) return `pattern #${p.id ?? '?'}`;
    }
    return null;
}

/** Why a line may not be posted (bot-wide floor first, then the server's own filter), or null. */
export function rejectReason(text, filter = {}) {
    if (findHateTerm(text)) return 'built-in slur list';
    const own = serverFilterHit(text, filter);
    return own ? `server filter (${own})` : null;
}

export default { findHateTerm, containsHateTerm, serverFilterHit, rejectReason };
