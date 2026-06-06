/**
 * Last Letter rules (pure). state = { lastLetter: string|null, count: number, used: string[] }.
 * Each new word must be a real word, start with the previous word's last letter,
 * and not repeat a recently-used word. Dictionary check can be disabled (degraded mode).
 */
import * as wordBank from '../word-bank.js';

const USED_CAP = 500;

export function initState() { return { lastLetter: null, count: 0, used: [] }; }

export function normalize(content) {
  const tok = String(content ?? '').trim().split(/\s+/)[0] || '';
  return tok.toLowerCase().replace(/[^a-z]/g, '');
}

export function validateMove(content, state, opts = {}) {
  const requireDictionary = opts.requireDictionary !== false;
  const word = normalize(content);
  if (!word) return { ok: false, reason: 'empty' };
  if (requireDictionary && !wordBank.isWord(word)) return { ok: false, reason: 'not_a_word' };
  if (state.lastLetter && word[0] !== state.lastLetter) {
    return { ok: false, reason: 'wrong_letter', expected: state.lastLetter };
  }
  if (state.used.includes(word)) return { ok: false, reason: 'repeat' };
  const used = [...state.used, word].slice(-USED_CAP);
  const nextState = { lastLetter: word[word.length - 1], count: state.count + 1, used };
  return { ok: true, word, nextState };
}
