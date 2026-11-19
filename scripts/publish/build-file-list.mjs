#!/usr/bin/env node
// Filters the candidate file list for scripts/publish-github.sh.
//
// stdin : NUL-separated paths relative to --src (non-ignored files, from `git ls-files --others
//         --exclude-standard` run with an empty index, so the working copy's own .git is never used)
// --src DIR          the live working copy
// --tracked LIST0    NUL-separated paths already tracked in the publish clone (for the size rule)
// --out LIST0        where to write the final NUL-separated list
// --report FILE      where to write a JSON summary of what was skipped and why (paths only)
//
// Hard rules here apply even if .gitignore / .publishignore were edited by mistake.

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
for (const k of ['src', 'tracked', 'out', 'report']) if (!args[k]) { console.error(`build-file-list: --${k} is required`); process.exit(2); }

const MB = 1024 * 1024;
const MAX_NEW = 20 * MB;     // larger files are skipped...
const MAX_TRACKED = 100 * MB; // ...unless already tracked in the repo and under this size (GitHub's hard limit)

const input = fs.readFileSync(0).toString('utf8').split('\0').filter(Boolean);
const tracked = new Set(fs.readFileSync(args.tracked).toString('utf8').split('\0').filter(Boolean));

const hard = [
  ['node_modules', (p) => /(^|\/)node_modules\//.test(p)],
  ['logs', (p) => /^(logs|[^/]+\/logs)\//.test(p) || /\.log(\.\d+)?$/i.test(p)],
  ['backups', (p) => /^(backups|deploy-backups|transcripts|archives|uploads|sessions|temp_audio|tmp|temp)\//.test(p)],
  ['env-file', (p) => { const b = path.basename(p); return /^\.env(\.|$)/.test(b) ? !/\.example$/.test(b) : /\.env$/.test(b); }],
  ['cookie-or-secret', (p) => {
    const b = path.basename(p);
    if (p === 'scripts/publish/secret-scan-allowlist.txt') return false;
    if (/^cookies?(\.(txt|json))?(\.|$)/i.test(b) || /\.cookies$/i.test(b)) return true;
    if (!/secret/i.test(b)) return false;
    const ext = b.replace(/^\./, '').includes('.') ? path.extname(b) : '';
    return ext === '' || /^\.(txt|key|json|pem|env)$/i.test(ext) || /^\.music-resolver-secret/.test(b);
  }],
  ['key-material', (p) => /\.(pem|key|p12|pfx|jks|kdbx)$/i.test(p) || /(^|\/)id_(rsa|ed25519|ecdsa)$/.test(p)],
  ['backup-copy', (p) => /\.bak/i.test(path.basename(p)) || /\.(orig|rej|swp)$/i.test(p) || /~$/.test(p)],
  ['database', (p) => /\.(db|sqlite3?|rdb|dump|sql\.gz)$/i.test(p)],
  ['dir-entry', (p) => p.endsWith('/')], // nested repositories show up as "dir/"
];

const out = [];
const skipped = {};
const warnings = [];
const note = (why, p) => { (skipped[why] ||= []).push(p); };

for (const rel of input) {
  const rule = hard.find(([, t]) => t(rel));
  if (rule) { note(rule[0], rel); continue; }
  let st;
  try { st = fs.lstatSync(path.join(args.src, rel)); } catch { note('vanished', rel); continue; }
  if (st.isSymbolicLink()) { note('symlink', rel); warnings.push(`symlink skipped: ${rel}`); continue; }
  if (!st.isFile()) { note('not-a-file', rel); continue; }
  if (st.size > MAX_NEW) {
    if (tracked.has(rel) && st.size < MAX_TRACKED) warnings.push(`large file kept (already tracked, ${Math.round(st.size / MB)} MB): ${rel}`);
    else { note('too-large', rel); warnings.push(`large file skipped (${Math.round(st.size / MB)} MB): ${rel}`); continue; }
  }
  out.push(rel);
}

fs.writeFileSync(args.out, out.join('\0') + (out.length ? '\0' : ''));
const counts = Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length]));
fs.writeFileSync(args.report, JSON.stringify({ candidates: input.length, kept: out.length, skipped: counts, skipped_paths: skipped, warnings }, null, 1));
for (const w of warnings) console.error(`WARN ${w}`);
console.error(`build-file-list: ${input.length} candidates, ${out.length} kept, skipped ${JSON.stringify(counts)}`);
