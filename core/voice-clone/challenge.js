/*
 * The live check (consent): three random sentences, each ending in four spoken digits, read aloud in the browser.
 * A replayed or pre-made recording cannot know the sentences, which are new for every attempt and valid for 120 s.
 *
 *   makeChallenge(rng?) → { sentences: [{ text, words, digits }] }   text is what the page shows
 *   normaliseWords(text) → string[]          lowercase words, digits spelled out one by one, punctuation gone
 *   digitsSpoken(text) → string              every digit the transcript contains, in order ("four seven one nine",
 *                                            "4719", "47 19" and "forty seven nineteen" all give "4719")
 *   wer(refWords, hypWords) → number         word error rate (Levenshtein over words / reference length)
 *   checkReading(sentence, transcript) → { ok, wer, digitsOk, heard }   WER of the words (number left out) <= 0.20 and the
 *                                            four digits heard exactly, in order
 * Pure; tested in tests/voice-clone.test.js.
 */
import crypto from 'node:crypto';
import { LIMITS } from './constants.js';

const ADJ = ['purple', 'quiet', 'golden', 'silver', 'gentle', 'bright', 'sleepy', 'windy', 'early', 'distant', 'tiny', 'heavy', 'velvet', 'crimson', 'frozen', 'hollow',
    'patient', 'rusty', 'shiny', 'wooden', 'narrow', 'cheerful', 'careful', 'sudden'];
const NOUN = ['lanterns', 'rivers', 'kettles', 'pebbles', 'gardens', 'ladders', 'meadows', 'teacups', 'harbours', 'bicycles', 'pillows', 'chimneys', 'windmills',
    'orchards', 'feathers', 'trumpets', 'blankets', 'canyons', 'pianos', 'marbles', 'islands', 'mirrors', 'bridges', 'tunnels'];
const VERB = ['drift past', 'roll under', 'wait beside', 'shine over', 'lean against', 'hide behind', 'float above', 'circle around', 'rest near', 'sing to',
    'tumble past', 'glow under'];
const PLACE = ['the old station', 'the morning market', 'the green hill', 'the stone wall', 'the sleepy town', 'the open field', 'the busy kitchen', 'the north road',
    'the little library', 'the empty beach', 'the winter forest', 'the corner shop'];
export const DIGIT_WORDS = Object.freeze(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const TEENS = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS = { twenty: '2', thirty: '3', forty: '4', fourty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };
const UNIT = Object.fromEntries(DIGIT_WORDS.map((w, i) => [w, String(i)]));
UNIT.oh = '0';
UNIT.o = '0';
UNIT.won = '1'; UNIT.to = null; UNIT.too = '2'; UNIT.for = null; UNIT.ate = '8';   // homophones Whisper writes now and then ("to"/"for" are too common to count)

function pick(list, rng) { return list[Math.floor(rng() * list.length) % list.length]; }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const defaultRng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

export function makeChallenge(rng = defaultRng) {
    const sentences = [];
    const used = new Set();
    while (sentences.length < 3) {
        const words = `${pick(ADJ, rng)} ${pick(NOUN, rng)} ${pick(VERB, rng)} ${pick(PLACE, rng)}`;
        if (used.has(words)) continue;
        used.add(words);
        let digits = '';
        for (let i = 0; i < 4; i++) digits += String(Math.floor(rng() * 10) % 10);
        const spoken = digits.split('').map((d) => DIGIT_WORDS[Number(d)]).join(' ');
        sentences.push({ text: `${cap(words)}, ${spoken}.`, words, digits });
    }
    return { sentences };
}

export function normaliseWords(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')          // whisper's [BLANK_AUDIO], (laughs)
        .replace(/(\d)/g, ' $1 ')
        .replace(/[^a-z0-9' ]+/g, ' ')
        .replace(/'/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => (/^\d$/.test(w) ? DIGIT_WORDS[Number(w)] : w));
}

/** Every digit spoken in the text, in order. */
export function digitsSpoken(text) {
    const words = normaliseWords(text);
    let out = '';
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (TEENS[w]) { out += TEENS[w]; continue; }
        if (TENS[w]) {
            const next = words[i + 1];
            if (next && UNIT[next] && next !== 'zero' && next !== 'oh' && next !== 'o') { out += TENS[w] + UNIT[next]; i++; } else out += `${TENS[w]}0`;
            continue;
        }
        if (UNIT[w]) out += UNIT[w];
    }
    return out;
}

export function wer(ref, hyp) {
    const r = ref || [];
    const h = hyp || [];
    if (!r.length) return h.length ? 1 : 0;
    let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
    for (let i = 1; i <= r.length; i++) {
        const cur = [i];
        for (let j = 1; j <= h.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[h.length] / r.length;
}

const NUMBER_WORDS = new Set([...DIGIT_WORDS, ...Object.keys(TEENS), ...Object.keys(TENS), 'oh', 'o', 'won', 'too', 'ate']);

/** Score one consent reading against its sentence. */
export function checkReading(sentence, transcript, maxWer = LIMITS.maxWer) {
    const heard = normaliseWords(transcript);
    const ref = normaliseWords(sentence.words);
    const hypWords = heard.filter((w) => !NUMBER_WORDS.has(w));
    const w = wer(ref, hypWords);
    const digitsOk = digitsSpoken(transcript).includes(String(sentence.digits));
    return { ok: w <= maxWer && digitsOk, wer: Math.round(w * 1000) / 1000, digitsOk, heard: heard.join(' ').slice(0, 300) };
}

/** WER of a script take (no number in it). */
export function checkScriptTake(prompt, transcript, maxWer = LIMITS.maxSampleWer) {
    const w = wer(normaliseWords(prompt), normaliseWords(transcript));
    return { ok: w <= maxWer, wer: Math.round(w * 1000) / 1000 };
}

export default { makeChallenge, normaliseWords, digitsSpoken, wer, checkReading, checkScriptTake, DIGIT_WORDS };
