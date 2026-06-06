/**
 * Word bank: loads committed dictionaries (data/words/*.txt) into memory once.
 * Offline + deterministic. Fails soft: on load error, lookups return false and
 * isLoaded() stays false so callers can degrade.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'words');

let english = null;       // Set<string>
let answers = null;       // string[]  (5-letter)
let byLength = null;      // Map<number, string[]>
let loadError = null;

function readLines(file) {
  return fs.readFileSync(path.join(DATA_DIR, file), 'utf8')
    .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function load() {
  if (english) return true;
  if (loadError) return false;
  try {
    const words = readLines('english.txt').filter(w => /^[a-z]+$/.test(w));
    english = new Set(words);
    byLength = new Map();
    for (const w of words) {
      const L = w.length;
      if (!byLength.has(L)) byLength.set(L, []);
      byLength.get(L).push(w);
    }
    answers = readLines('coordle-answers.txt').filter(w => /^[a-z]{5}$/.test(w));
    logger.info('[WordBank] loaded', { english: english.size, answers: answers.length });
    return true;
  } catch (err) {
    loadError = err;
    logger.error('[WordBank] failed to load word data', { error: err.message });
    return false;
  }
}

export function isLoaded() { return Boolean(english) && !loadError; }

export function isWord(word) {
  if (!english && !load()) return false;
  const w = String(word ?? '').trim().toLowerCase();
  return w.length > 0 && english.has(w);
}

export function isValidGuess(word, length = 5) {
  const w = String(word ?? '').trim().toLowerCase();
  if (w.length !== length || !/^[a-z]+$/.test(w)) return false;
  return isWord(w);
}

export function randomAnswer(length = 5, rng = Math.random) {
  if (!english && !load()) return null;
  const pool = (length === 5 && answers && answers.length) ? answers : (byLength.get(length) || []);
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

export function wordsByLength(min, max) {
  if (!english && !load()) return [];
  const out = [];
  for (let L = min; L <= max; L++) if (byLength.has(L)) out.push(...byLength.get(L));
  return out;
}

/** Up to `count` distinct random words with length in [minLen, maxLen]. */
export function randomWords(count, minLen, maxLen, rng = Math.random) {
  const pool = wordsByLength(minLen, maxLen);
  if (!pool.length) return [];
  const out = new Set();
  for (let attempts = 0; out.size < count && attempts < count * 50; attempts++) {
    out.add(pool[Math.floor(rng() * pool.length)]);
  }
  return [...out];
}
