// Find REAL words missing from the game dictionary and add the verified ones.
//
// Takes candidate words (a file, one per line, or words on argv), checks each against
// the Free Dictionary API (api.dictionaryapi.dev — Wiktionary/Webster-sourced), and
// appends the confirmed-real ones to data/words/english-extra.txt (which word-bank.js
// merges into the game dictionary). Skips words already known. Polite + resumable.
//
//   node scripts/verify-words.mjs --file /tmp/candidates.txt
//   node scripts/verify-words.mjs word1 word2 word3
//   node scripts/verify-words.mjs --file /tmp/candidates.txt --apply   # default is apply; --dry to preview

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDS_DIR = path.join(__dirname, '..', 'data', 'words');
const EXTRA = path.join(WORDS_DIR, 'english-extra.txt');
const DRY = process.argv.includes('--dry');
const CONCURRENCY = 5;

const readSet = (f) => {
  try { return new Set(fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)); }
  catch { return new Set(); }
};

function loadCandidates() {
  const fi = process.argv.indexOf('--file');
  let words = [];
  if (fi !== -1 && process.argv[fi + 1]) {
    words = fs.readFileSync(process.argv[fi + 1], 'utf8').split('\n');
  } else {
    words = process.argv.slice(2).filter(a => !a.startsWith('--'));
  }
  return words.map(w => w.trim().toLowerCase()).filter(w => /^[a-z]+$/.test(w));
}

async function isReal(word) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
        headers: { 'User-Agent': 'CertiFried-WordVerifier/1.0' },
      });
      if (r.status === 200) return true;
      if (r.status === 404) return false;
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (attempt + 1))); continue; }
      return false;
    } catch { await new Promise(s => setTimeout(s, 800)); }
  }
  return false;
}

async function main() {
  const known = new Set([...readSet(path.join(WORDS_DIR, 'english.txt')), ...readSet(EXTRA)]);
  const candidates = [...new Set(loadCandidates())].filter(w => !known.has(w));
  console.log(`Candidates: ${candidates.length} (already-known skipped). Verifying against the dictionary API…`);

  const real = [];
  let done = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async w => ({ w, ok: await isReal(w) })));
    for (const { w, ok } of results) if (ok) real.push(w);
    done += batch.length;
    if (done % 50 === 0 || done === candidates.length) {
      process.stdout.write(`\r  ${done}/${candidates.length} checked, ${real.length} real so far…`);
    }
    await new Promise(s => setTimeout(s, 120)); // be polite
  }
  console.log('');

  if (!real.length) { console.log('No new real words found.'); process.exit(0); }
  console.log(`Found ${real.length} new REAL words. Sample: ${real.slice(0, 15).join(', ')}`);

  if (DRY) { console.log('--dry: not writing.'); process.exit(0); }
  const existing = fs.existsSync(EXTRA) ? fs.readFileSync(EXTRA, 'utf8').replace(/\s+$/, '') + '\n' : '';
  fs.writeFileSync(EXTRA, existing + real.sort().join('\n') + '\n');
  console.log(`Appended ${real.length} words to ${EXTRA} (now ${readSet(EXTRA).size} total extras).`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
