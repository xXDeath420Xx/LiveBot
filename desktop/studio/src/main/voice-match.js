'use strict';
/*
 * Voice commands (0.2.12; learning in 0.2.13): matching what Whisper wrote down against the enabled phrases.
 *
 *   normalise(text)                  lower case, apostrophes dropped ("let's" -> "lets"), everything that is not a letter or
 *                                    digit becomes a space, filler words (uh, um, erm, hmm) removed
 *   similarity(a, b)                 0..1 from the edit distance of two strings (1 = the same)
 *   scorePhrase(transcript, phrase)  { score, how } how well one phrase matches what was heard:
 *                                      whole     the whole transcript compared with the phrase, both with and without
 *                                                spaces (so "pokey check" matches "Pokeycheck"), and word by word
 *                                      contains  the best run of words inside a longer transcript ("ok time for a break
 *                                                now"); a little lower for every extra word beyond four, so a phrase said
 *                                                on its own wins over one buried in a long sentence
 *   matchCommands(transcript, cmds)  { best: { cmd, ...scoreCommand } | null, second } over the commands (objects with .text)
 *   stripWake(transcript, wake)      { found, rest } whether the transcript starts with the wake phrase ("hey studio"),
 *                                    allowing one word before it, and what was said after it
 *   biasPrompt(phrases, aliases)     Whisper's initial prompt: the phrases as written, so it spells them that way, then
 *                                    (0.2.13) the most frequent "heard as" aliases while there is room (PROMPT_MAX)
 *
 * 0.2.13, learning how the streamer says each command:
 *   scoreCommand(transcript, cmd)    { score, how, via, alias, phraseScore, negScore, penalty } for one command with
 *                                    cmd.aliases (how Whisper wrote it when they said it: [{ text }]) and cmd.negatives
 *                                    (things they said that were not this command: [{ text }]):
 *                                      score    max(phrase score, every alias score), less the penalty
 *                                      via      'phrase' or 'alias' (alias: the alias that scored best)
 *                                      penalty  when the words are at least NEG_MIN alike to a "not a command" example:
 *                                               NEG_WEIGHT x (how much closer they are to it than to the command, plus
 *                                               NEG_MARGIN); 0 when the command is clearly closer
 *   calibrate({ cmd, takes, negatives })  the threshold for a command from its training takes: each take scored against
 *                                    the phrase, the aliases and the other takes (leave one out); CAL_MARGIN below the
 *                                    lowest, never under CAL_FLOOR or over CAL_MAX; then checked against ordinary speech
 *                                    (`negatives`): raised above it when every take still passes, otherwise `overlaps`
 *   sameText(a, b)                   whether two texts normalise to the same words
 *
 * Nothing here knows about audio; it only compares text.
 */

const FILLERS = new Set(['uh', 'um', 'umm', 'erm', 'er', 'hmm', 'mm', 'ah']);
const MAX_LEN = 200;

function normalise(text) {
    return String(text ?? '')
        .slice(0, MAX_LEN * 2)
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[‘’ʼ'`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w && !FILLERS.has(w))
        .join(' ')
        .slice(0, MAX_LEN);
}

const tokens = (s) => (s ? s.split(' ') : []);

function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[b.length];
}

function similarity(a, b) {
    const x = String(a ?? '');
    const y = String(b ?? '');
    if (!x.length && !y.length) return 1;
    return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/**
 * Word by word: each phrase word paired with its best heard word, each heard word used once, weighted by length. Recall is
 * how much of the phrase was heard, precision how much of what was heard belongs to the phrase; the score is both (F1).
 */
function wordScore(heardWords, phraseWords) {
    if (!heardWords.length || !phraseWords.length) return 0;
    const used = new Array(heardWords.length).fill(false);
    let gotP = 0;
    let gotH = 0;
    for (const p of phraseWords) {
        let best = 0;
        let at = -1;
        for (let i = 0; i < heardWords.length; i++) {
            if (used[i]) continue;
            const s = similarity(heardWords[i], p);
            if (s > best) { best = s; at = i; }
        }
        if (at < 0) continue;
        used[at] = true;
        gotP += best * p.length;
        gotH += best * heardWords[at].length;
    }
    const recall = gotP / phraseWords.join('').length;
    const precision = gotH / heardWords.join('').length;
    return recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
}

function compare(heardWords, phraseWords) {
    const joined = similarity(heardWords.join(''), phraseWords.join(''));
    const spaced = similarity(heardWords.join(' '), phraseWords.join(' '));
    return Math.max(joined, spaced, wordScore(heardWords, phraseWords));
}

function scorePhrase(transcript, phrase) {
    const h = tokens(normalise(transcript));
    const p = tokens(normalise(phrase));
    if (!h.length || !p.length) return { score: 0, how: 'whole' };
    const whole = compare(h, p);
    let contains = 0;
    if (h.length > p.length) {
        // runs of words about as long as the phrase (one word shorter or longer, for words Whisper split or joined)
        for (let n = Math.max(1, p.length - 1); n <= Math.min(h.length - 1, p.length + 1); n++) {
            for (let i = 0; i + n <= h.length; i++) contains = Math.max(contains, compare(h.slice(i, i + n), p));
        }
        const extra = h.length - p.length;
        contains -= Math.min(0.08, Math.max(0, extra - 4) * 0.01);
    }
    return contains > whole ? { score: round(contains), how: 'contains' } : { score: round(whole), how: 'whole' };
}

const round = (n) => Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));

const WAKE_DEFAULT = 'hey studio';
const WAKE_MIN = 0.75;
const LEAD_INS = new Set(['ok', 'okay', 'oh', 'so', 'and', 'hi', 'yo', 'right', 'alright', 'hey']);

function stripWake(transcript, wake = WAKE_DEFAULT) {
    const h = tokens(normalise(transcript));
    const w = tokens(normalise(wake) || WAKE_DEFAULT);
    // the wake phrase at the start, perhaps after a lead-in word ("ok hey studio"), perhaps with its words run together;
    // never in the middle of a sentence ("I said hey studio earlier")
    for (let start = 0; start <= (h.length > 1 && LEAD_INS.has(h[0]) ? 1 : 0); start++) {
        for (let n = Math.max(1, w.length - 1); n <= w.length + 1 && start + n <= h.length; n++) {
            if (compare(h.slice(start, start + n), w) >= WAKE_MIN) return { found: true, rest: h.slice(start + n).join(' ') };
        }
    }
    return { found: false, rest: h.join(' ') };
}

// Whisper keeps at most 224 prompt tokens (half its text context); 600 characters of plain words stay well under that.
const PROMPT_MAX = 600;

function biasPrompt(phrases, aliases = []) {
    const list = [];
    const seen = new Set();
    let len = 0;
    const add = (p) => {
        const s = String(p ?? '').replace(/\s+/g, ' ').trim();
        const k = normalise(s);
        if (!s || !k || seen.has(k)) return true;
        if (len + s.length > PROMPT_MAX) return false;
        seen.add(k);
        list.push(/[.!?]$/.test(s) ? s : `${s}.`);
        len += s.length + 2;
        return true;
    };
    for (const p of Array.isArray(phrases) ? phrases : []) if (!add(p)) break;
    // then the aliases, most frequent first (the caller sorts them), while there is room
    for (const a of Array.isArray(aliases) ? aliases : []) if (!add(typeof a === 'string' ? a : a?.text)) break;
    return list.join(' ');
}

// ── 0.2.13: aliases, negatives and calibration ──
const NEG_MIN = 0.6;
const NEG_MARGIN = 0.1;
const NEG_WEIGHT = 2;
const CAL_MARGIN = 0.05;
const CAL_FLOOR = 0.6;
const CAL_MAX = 0.95;

const textOf = (x) => (typeof x === 'string' ? x : x?.text);
function sameText(a, b) { const x = normalise(a); return !!x && x === normalise(b); }

/** Whole-utterance closeness, without the "contains" window: "not a command" examples are whole things that were said. */
function scoreWhole(transcript, text) {
    const h = tokens(normalise(transcript));
    const p = tokens(normalise(text));
    if (!h.length || !p.length) return 0;
    return round(compare(h, p));
}

function scoreCommand(transcript, cmd) {
    const phrase = scorePhrase(transcript, cmd?.text);
    let best = { score: phrase.score, how: phrase.how, via: 'phrase', alias: null };
    for (const a of Array.isArray(cmd?.aliases) ? cmd.aliases : []) {
        const t = textOf(a);
        if (!t) continue;
        const r = scorePhrase(transcript, t);
        if (r.score > best.score) best = { score: r.score, how: r.how, via: 'alias', alias: t };
    }
    let negScore = 0;
    for (const n of Array.isArray(cmd?.negatives) ? cmd.negatives : []) {
        const t = textOf(n);
        if (t) negScore = Math.max(negScore, scoreWhole(transcript, t));
    }
    const penalty = negScore >= NEG_MIN ? NEG_WEIGHT * Math.max(0, negScore - best.score + NEG_MARGIN) : 0;
    return { ...best, score: round(best.score - penalty), phraseScore: phrase.score, negScore: round(negScore), penalty: round(penalty) };
}

function matchCommands(transcript, commands) {
    let best = null;
    let second = null;
    for (const cmd of Array.isArray(commands) ? commands : []) {
        if (!cmd || !cmd.text) continue;
        const r = { cmd, ...scoreCommand(transcript, cmd) };
        if (!best || r.score > best.score) { second = best; best = r; } else if (!second || r.score > second.score) second = r;
    }
    return { best, second };
}

const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;
const ceil2 = (n) => Math.ceil(n * 100 - 1e-9) / 100;

/**
 * The threshold for one command from its training takes.
 *   cmd        { text, aliases, negatives } as it is now (aliases learned before count too)
 *   takes      the good takes' transcripts
 *   negatives  things said that were not this command (the voice log's "not a command" lines, other commands' lines)
 * → { threshold, lowest, perTake: [{ text, phraseScore, score }], negMax, overlaps: [{ text, score }], raised }
 */
function calibrate({ cmd, takes, negatives = [] }) {
    const list = (Array.isArray(takes) ? takes : []).map((t) => String(t ?? '')).filter((t) => normalise(t));
    const known = (Array.isArray(cmd?.aliases) ? cmd.aliases : []).map(textOf).filter(Boolean);
    const perTake = list.map((t, i) => {
        // leave this take out (and an alias that is only there because of it): how a new try like it scores against the
        // phrase, the other takes and the aliases learned before
        const twin = list.some((x, j) => j !== i && sameText(x, t));
        const others = [...known.filter((a) => twin || !sameText(a, t)), ...list.filter((_, j) => j !== i)];
        const r = scoreCommand(t, { text: cmd?.text, aliases: others, negatives: cmd?.negatives });
        return { text: t, phraseScore: scorePhrase(t, cmd?.text).score, score: r.score };
    });
    if (!perTake.length) return { threshold: null, lowest: null, perTake, negMax: 0, overlaps: [], raised: false };
    const lowest = Math.min(...perTake.map((p) => p.score));
    let threshold = Math.min(CAL_MAX, Math.max(CAL_FLOOR, floor2(lowest - CAL_MARGIN)));
    const withTakes = { text: cmd?.text, aliases: [...known, ...list], negatives: cmd?.negatives };
    const scored = (Array.isArray(negatives) ? negatives : []).map(textOf)
        .filter((t, i, all) => t && normalise(t) && !list.some((x) => sameText(x, t)) && !known.some((x) => sameText(x, t)) && all.findIndex((y) => sameText(y, t)) === i)
        .map((t) => ({ text: t, score: scoreCommand(t, withTakes).score }));
    const negMax = scored.reduce((m, x) => Math.max(m, x.score), 0);
    let raised = false;
    let overlaps = scored.filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score);
    if (overlaps.length) {
        const above = ceil2(negMax + 0.02);
        if (above <= lowest && above <= CAL_MAX) { threshold = Math.max(threshold, above); raised = true; overlaps = []; }
    }
    return { threshold, lowest, perTake, negMax: round(negMax), overlaps: overlaps.slice(0, 10), raised };
}

module.exports = { normalise, similarity, editDistance, scorePhrase, scoreWhole, scoreCommand, matchCommands, stripWake, biasPrompt, calibrate, sameText, WAKE_DEFAULT,
    NEG_MIN, NEG_MARGIN, NEG_WEIGHT, CAL_MARGIN, CAL_FLOOR, CAL_MAX, PROMPT_MAX };
