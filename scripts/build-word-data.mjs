// Build-time generator for data/words/*.txt. Run once; commit the output.
// english.txt  : all lowercase a-z words from an-array-of-english-words
// coordle-answers.txt : common 5-letter answers (fetched; falls back to 5-letter english subset)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const english = require('an-array-of-english-words'); // package main is index.json (a plain array)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'words');
fs.mkdirSync(OUT, { recursive: true });

const clean = english
  .map(w => String(w).trim().toLowerCase())
  .filter(w => /^[a-z]+$/.test(w));
const uniq = [...new Set(clean)].sort();
fs.writeFileSync(path.join(OUT, 'english.txt'), uniq.join('\n') + '\n');
console.log(`english.txt: ${uniq.length} words`);

const fiveSet = new Set(uniq.filter(w => w.length === 5));
let answers = [];
try {
  const res = await fetch('https://gist.githubusercontent.com/cfreshman/a03ef2cba789d8cf00c08f767e0fad7b/raw/wordle-answers-alphabetical.txt');
  if (res.ok) {
    const list = (await res.text()).split('\n').map(s => s.trim().toLowerCase())
      .filter(w => /^[a-z]{5}$/.test(w) && fiveSet.has(w));
    answers = [...new Set(list)].sort();
  }
} catch (err) {
  console.warn('answer fetch failed, falling back to 5-letter english subset:', err.message);
}
if (answers.length < 500) {
  console.warn('using 5-letter english subset as answers');
  answers = [...fiveSet].sort();
}
fs.writeFileSync(path.join(OUT, 'coordle-answers.txt'), answers.join('\n') + '\n');
console.log(`coordle-answers.txt: ${answers.length} words`);

// wordseek-words.txt: the most-common English words (frequency-ranked), filtered
// to 4-7 letter REAL dictionary words — so WordSeek grids are common AND findable.
const dictSet = new Set(uniq);
const seenWs = new Set();
const wordseek = [];
for (const url of [
  'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt',
  'https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt',
]) {
  try {
    const res = await fetch(url);
    if (!res.ok) continue;
    for (const raw of (await res.text()).split('\n')) {
      const w = raw.trim().toLowerCase();
      if (/^[a-z]{4,7}$/.test(w) && dictSet.has(w) && !seenWs.has(w)) { seenWs.add(w); wordseek.push(w); }
    }
  } catch (err) { console.warn('wordseek list fetch failed:', url, err.message); }
}
if (wordseek.length < 500) {
  console.warn('common-word fetch failed; falling back to 4-7 letter english subset');
  for (const w of uniq) if (w.length >= 4 && w.length <= 7 && !seenWs.has(w)) { seenWs.add(w); wordseek.push(w); }
}
fs.writeFileSync(path.join(OUT, 'wordseek-words.txt'), wordseek.join('\n') + '\n');
console.log(`wordseek-words.txt: ${wordseek.length} words`);
