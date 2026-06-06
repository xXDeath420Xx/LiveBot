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
