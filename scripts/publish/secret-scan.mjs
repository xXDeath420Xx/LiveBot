#!/usr/bin/env node
// Fail-closed secret and private-data scanner for the public GitHub repo.
//
// It scans a list of files (what would be committed) and exits non-zero on ANY finding.
// It prints only "file:line  rule" for each finding. It never prints a matched value,
// a snippet of the line, or a hash of a value.
//
// usage:
//   node scripts/publish/secret-scan.mjs [--root DIR] [--files-from LIST0] [--env FILE ...]
//        [--env-glob-root DIR] [--allowlist FILE] [--quiet] [--summary-json FILE]
//
//   --root DIR          directory the file paths are relative to (default: cwd)
//   --files-from LIST0  NUL-separated list of relative paths (an entry "stored<TAB>shown" reads stored, reports shown). Default: every file under
//                       --root except .git/ and node_modules/ (what a CI checkout holds).
//   --env FILE          an env file whose values (>= 8 chars) must not appear anywhere (repeatable)
//   --env-glob-root DIR also load every .env / .env.* / *.env / .music-resolver-secret* under DIR
//                       (node_modules and .git skipped; .env.example files ignored)
//   --allowlist FILE    default: scripts/publish/secret-scan-allowlist.txt under --root
//
// Exit codes: 0 clean, 1 findings, 2 usage / internal error (also fail-closed).

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { root: process.cwd(), filesFrom: null, env: [], envGlobRoot: [], allowlist: null, quiet: false, summaryJson: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { if (i + 1 >= args.length) die(`missing value for ${a}`); return args[++i]; };
  if (a === '--root') opt.root = next();
  else if (a === '--files-from') opt.filesFrom = next();
  else if (a === '--env') opt.env.push(next());
  else if (a === '--env-glob-root') opt.envGlobRoot.push(next());
  else if (a === '--allowlist') opt.allowlist = next();
  else if (a === '--summary-json') opt.summaryJson = next();
  else if (a === '--quiet') opt.quiet = true;
  else die(`unknown argument ${a}`);
}
function die(msg) { console.error(`secret-scan: ${msg}`); process.exit(2); }
process.on('uncaughtException', (e) => { console.error(`secret-scan: internal error: ${e && e.message}`); process.exit(2); });

const root = path.resolve(opt.root);
const allowlistPath = opt.allowlist || path.join(root, 'scripts/publish/secret-scan-allowlist.txt');

// ---------------------------------------------------------------- file list
let files;
if (opt.filesFrom) {
  files = fs.readFileSync(opt.filesFrom).toString('utf8').split('\0').filter(Boolean);
} else {
  files = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else files.push(r);
    }
  })(root, '');
}

// ---------------------------------------------------------------- allowlist
// Format, one entry per line ('#' starts a comment):
//   allow <path-glob> <rule|*>   ignore findings of <rule> in files matching <path-glob>
//   env-public <VAR_NAME>        this .env variable holds a public value (URL, port, public id)
//   allow-email <address>        a public contact address (e.g. the site's support mailbox)
// Globs: '*' matches within a path segment, '**' across segments.
const allow = [];
const envPublic = new Set();
const emailOk = new Set();
if (fs.existsSync(allowlistPath)) {
  for (const raw of fs.readFileSync(allowlistPath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'allow' && parts.length === 3) allow.push({ re: globToRe(parts[1]), rule: parts[2] });
    else if (parts[0] === 'env-public' && parts.length === 2) envPublic.add(parts[1]);
    else if (parts[0] === 'allow-email' && parts.length === 2) emailOk.add(parts[1].toLowerCase());
    else die(`bad allowlist line: ${line}`);
  }
}
function globToRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}
// env-value findings can never be allowlisted: a real secret is never an acceptable fixture.
const allowed = (file, rule) => !rule.startsWith('env-value') && allow.some((a) => (a.rule === '*' || a.rule === rule) && a.re.test(file));

// ---------------------------------------------------------------- env values
// Values are held in memory only. Nothing derived from them is ever printed.
const envFiles = new Set(opt.env.map((f) => path.resolve(f)));
for (const dir of opt.envGlobRoot) walkEnv(path.resolve(dir), 0);
function walkEnv(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkEnv(p, depth + 1);
    else if (e.isFile() && isEnvName(e.name)) envFiles.add(p);
  }
}
function isEnvName(n) {
  if (/\.(example|sample|template)$/i.test(n)) return false;
  return n === '.env' || n.startsWith('.env.') || /\.env$/.test(n) || n.startsWith('.music-resolver-secret');
}
const envByValue = new Map(); // value -> variable name (names are safe to print, values are not)
const addEnv = (name, v) => { if (v.length >= 8 && !envByValue.has(v)) envByValue.set(v, name); };
for (const f of envFiles) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (path.basename(f).startsWith('.music-resolver-secret')) { addEnv('MUSIC_RESOLVER_SECRET', text.trim()); continue; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || envPublic.has(m[1])) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    addEnv(m[1], v);
    // comma/space separated lists: each long piece counts on its own too
    for (const piece of v.split(/[,\s]+/)) if (piece.length >= 12 && piece !== v) addEnv(m[1], piece);
  }
}

// ---------------------------------------------------------------- rules
const PLACEHOLDER = /(your[_-]?|example|placeholder|changeme|change_me|dummy|sample|xxxx|\*\*\*|<[^>]*>|\$\{|process\.env|REMOVED|redacted|test[_-]?(token|secret|key)|fake|not[_-]?a[_-]?real)/i;

const tokenRules = [
  ['discord-bot-token', /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g],
  ['discord-webhook-url', /discord(?:app)?\.com\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9_-]{50,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['openai-anthropic-key', /\bsk-(?:proj-|ant-(?:api\d\d-)?|live-)?[A-Za-z0-9_-]{24,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b[rs]k_live_[A-Za-z0-9]{20,}/g],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/g],
  ['twitch-oauth', /\boauth:[a-z0-9]{30}\b/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['bearer-literal', /\bBearer\s+[A-Za-z0-9._~+/-]{30,}={0,2}/g],
  ['url-credentials', /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@'"`<>]{1,64}:[^\s/@'"`<>]{4,128}@[A-Za-z0-9.-]+/g],
];
// key/secret/token/password names next to a long literal. The name is captured with a bounded,
// non-nested pattern and tested separately, so long minified lines cannot cause backtracking blowups.
const assignRule = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{2,64})["']?\s*(?:[:=]|=>|,)\s*["'\x60]([^"'\x60\s]{8,256})["'\x60]/g;
const SECRET_NAME = /(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|[a-z0-9][_-]key$|client[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|signing[_-]?key|encryption[_-]?key)/i;
const passwordShort = /(?:passw(?:or)?d|passwd|pwd)["']?\s*[:=]\s*["'`]([^"'`\s]{6,})["'`]/gi;

function entropy(s) {
  const m = new Map();
  for (const c of s) m.set(c, (m.get(c) || 0) + 1);
  let h = 0;
  for (const n of m.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
function looksSecret(v) {
  if (PLACEHOLDER.test(v)) return false;
  if (/^https?:\/\//.test(v) || v.startsWith('/') || v.startsWith('./')) return false;
  if (/^\d+$/.test(v)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(v)) return false; // ENV_VAR_NAME
  if (/^[a-z]+(?:[._:-][a-z0-9]+)*$/i.test(v) && !/\d.*\d.*\d/.test(v)) return false; // identifiers, i18n keys
  if (/^[0-9a-f]{32,}$/i.test(v)) return true; // long hex
  if (v.length >= 20 && /^[A-Za-z0-9+/_=.-]+$/.test(v) && entropy(v) >= 3.5 && /\d/.test(v) && /[A-Za-z]/.test(v)) return true;
  if (v.length >= 12 && entropy(v) >= 3.8 && /\d/.test(v) && /[A-Za-z]/.test(v) && !/\s/.test(v)) return true;
  return false;
}

const SNOWFLAKE = /(?<![\d.])(\d{17,20})(?![\d.])/g;
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const EMAIL_OK = /@(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|[a-z0-9-]+\.example|test\.com|localhost|users\.noreply\.github\.com|noreply\.github\.com|anthropic\.com|domain\.com|yourdomain\.com|[a-z0-9.-]+\.invalid)$/i;
const IPV4 = /(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])/g;
function publicIp(ip) {
  if (ip.split('.').some((o) => o.length > 1 && o.startsWith('0'))) return false; // '3.03.1.5' is SVG/number data, not an address
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT / tailscale
  if (a === 192 && b === 0) return false;              // TEST-NET-1 / IETF
  if ((a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0)) return false; // benchmarking / TEST-NET
  if (['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'].includes(ip)) return false;      // public resolvers
  return true;
}

const DATA_EXT = /\.(json|jsonl|ndjson|csv|tsv|txt|log|sql|ya?ml|xml|html?|md)$/i;
const LOGISH = /\.(log|jsonl|ndjson|csv|tsv|out|har)$|(^|\/)logs?\//i;
const SNOWFLAKE_DUMP_DATA = 25; // distinct IDs in a data/doc file
const SNOWFLAKE_DUMP_CODE = 60; // distinct IDs in a code file

// File-name rules (fail even when the content is harmless).
const nameRules = [
  ['env-file', (f) => isEnvName(path.basename(f))],
  ['cookie-jar', (f) => /(^|\/)cookies?(\.txt|\.json)?(\.|$)/i.test(f) || /\.cookies$/i.test(f)],
  ['key-material', (f) => /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i.test(f) || /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/.test(f)],
  ['credentials-file', (f) => /(^|\/)(credentials|service[-_]account|client_secret)[^/]*\.json$/i.test(f) || /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/.test(f)],
  ['backup-file', (f) => /\.(bak|orig|rej|swp)(\.|$|-)/i.test(path.basename(f)) || /\.bak[-_]/i.test(path.basename(f)) || /~$/.test(f)],
  ['database-file', (f) => /\.(db|sqlite3?|rdb|dump|sql\.gz|mdb|frm|ibd)$/i.test(f)],
  ['archive-or-binary', (f) => /\.(zip|7z|rar|tar|tgz|gz|bz2|xz|asar|exe|dll|so|dylib|msi|apk|jar|war|class|pyc|node)$/i.test(f)],
  ['session-or-har', (f) => /\.(har|session|sess)$/i.test(f) || /(^|\/)sessions?\//.test(f)],
  ['transcript-or-evidence', (f) => /(^|\/)(transcripts|evidence|backups)\//i.test(f)],
];

// ---------------------------------------------------------------- scan
const findings = [];
const seen = new Set();
const add = (file, line, rule) => {
  const k = `${file}|${line}|${rule}`;
  if (seen.has(k) || allowed(file, rule)) return; // key built from file/line/rule only
  seen.add(k);
  findings.push({ file, line, rule });
};
let scanned = 0, binaryFiles = 0, bytes = 0;

for (const entry of files) {
  // "stored<TAB>logical": read stored (relative to --root), report and match rules on logical (history scans)
  const tab = entry.indexOf("	");
  const rel = tab === -1 ? entry : entry.slice(tab + 1);
  const abs = path.join(root, tab === -1 ? entry : entry.slice(0, tab));
  for (const [rule, test] of nameRules) if (test(rel)) add(rel, 0, rule);
  let st;
  try { st = fs.lstatSync(abs); } catch { continue; } // deleted file: nothing to scan
  if (st.isSymbolicLink()) { add(rel, 0, 'symlink'); continue; }
  if (!st.isFile()) continue;
  const buf = fs.readFileSync(abs);
  bytes += buf.length;
  scanned++;
  const head = buf.subarray(0, 16).toString('latin1');
  if (head.startsWith('SQLite format 3')) add(rel, 0, 'sqlite-database');
  if (head.startsWith('REDIS')) add(rel, 0, 'redis-dump');
  if (head.startsWith('PK\u0003\u0004')) add(rel, 0, 'archive-or-binary');
  const binary = buf.subarray(0, 8192).includes(0);
  const text = buf.toString(binary ? 'latin1' : 'utf8');

  // exact .env values: checked in every file, text or binary
  for (const [value, name] of envByValue) {
    let idx = text.indexOf(value);
    while (idx !== -1) {
      add(rel, binary ? 0 : lineOf(text, idx), `env-value:${name}`);
      idx = text.indexOf(value, idx + value.length);
    }
  }
  if (binary) { binaryFiles++; continue; }

  let m;
  for (const [rule, re] of tokenRules) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if ((rule === 'url-credentials' || rule === 'bearer-literal') && PLACEHOLDER.test(m[0])) continue;
      if (rule === 'url-credentials' && /:\/\/[^:]+:(\$|\{|%s|\*+@|pass(word)?@)/i.test(m[0])) continue;
      add(rel, lineOf(text, m.index), rule);
    }
  }
  assignRule.lastIndex = 0;
  while ((m = assignRule.exec(text))) if (SECRET_NAME.test(m[1]) && looksSecret(m[2])) add(rel, lineOf(text, m.index), 'generic-secret-assignment');
  passwordShort.lastIndex = 0;
  while ((m = passwordShort.exec(text))) {
    const v = m[1];
    if (!PLACEHOLDER.test(v) && !/^(password|passwd|pass|secret|admin|root|123456|hunter2|null|undefined|true|false|string|text|hidden)$/i.test(v) && !/^[A-Z_]+$/.test(v) && !/^[$:{]/.test(v))
      add(rel, lineOf(text, m.index), 'hardcoded-password');
  }

  // SQL dumps
  if (/^-- (MySQL|MariaDB) dump|^-- Dump completed|^-- phpMyAdmin SQL Dump|^-- PostgreSQL database dump/m.test(text)) add(rel, 0, 'sql-dump');
  if ((text.match(/^\s*INSERT INTO\b/gim) || []).length >= 50) add(rel, 0, 'sql-bulk-insert');

  // Discord snowflake dumps (user / guild / channel IDs)
  const ids = new Set();
  SNOWFLAKE.lastIndex = 0;
  while ((m = SNOWFLAKE.exec(text))) if (BigInt(m[1]) > 100000000000000000n) ids.add(m[1]);
  if (ids.size >= (DATA_EXT.test(rel) ? SNOWFLAKE_DUMP_DATA : SNOWFLAKE_DUMP_CODE)) add(rel, 0, 'discord-id-dump');

  // emails
  EMAIL.lastIndex = 0;
  while ((m = EMAIL.exec(text))) {
    const e = m[0];
    if (EMAIL_OK.test(e) || emailOk.has(e.toLowerCase())) continue;
    if (/\.(png|jpe?g|gif|webp|svg|js|mjs|css|ts|json)$/i.test(e)) continue; // icon@2x.png, pkg@x.js
    if (/@\d+(\.\d+)+$/.test(e)) continue;                                   // package@1.2.3
    add(rel, lineOf(text, m.index), 'email-address');
  }
  // public IPv4 addresses (infra addresses and visitor IPs do not belong in a public repo)
  IPV4.lastIndex = 0;
  while ((m = IPV4.exec(text))) {
    if (!publicIp(m[1])) continue;
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:\bv(?:ersion)?\s*[:=]?\s*["']?|[/@]|\b(?:mono|oid|chrome|safari|firefox|edge)\s)$/i.test(before)) continue; // version strings, UA tokens, OIDs
    add(rel, lineOf(text, m.index), LOGISH.test(rel) ? 'ip-in-log' : 'public-ip');
  }
}

function lineOf(text, idx) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// ---------------------------------------------------------------- report
const byRule = {};
for (const f of findings) { const k = f.rule.startsWith('env-value') ? 'env-value' : f.rule; byRule[k] = (byRule[k] || 0) + 1; }
if (!opt.quiet) for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}`);
const summary = { files: files.length, scanned, binary: binaryFiles, mb: Math.round(bytes / 1048576), env_files: envFiles.size, env_values: envByValue.size, allow_rules: allow.length, findings: findings.length, by_rule: byRule };
console.error(`secret-scan: ${JSON.stringify(summary)}`);
if (opt.summaryJson) fs.writeFileSync(opt.summaryJson, JSON.stringify({ ...summary, findings }, null, 1));
process.exit(findings.length ? 1 : 0);
