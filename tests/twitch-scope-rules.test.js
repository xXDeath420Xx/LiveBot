import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES } from '../core/stream-bot/scopes.js';
import { createTokenSources } from '../core/twitch-token-validator.js';

/*
 * Owner rule (2026-11-19): CertiFried never asks Twitch for user:read:follows or any revenue scope (H-726). This
 * reuses the stream bot grant's test (tests/stream-bot-events.test.js: FORBIDDEN_SCOPES plus no analytics:/revenue/
 * payout scope) and applies it to every Twitch scope list in the repo: each source file is read with its comments
 * removed, and any forbidden scope left in the code (a string in a scope list, an authorize URL) fails the test.
 * channel:read:subscriptions and bits:read stay allowed (sub and Bits tracking). user:read:email is forbidden for the
 * stream bot grant only; the sign-in flows need it, so it is not part of the repo-wide rule.
 *
 * Also here: the schedule sign-in keeps identity only (H-759), and the hourly token validator never reads schedule_users.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_FORBIDDEN = FORBIDDEN_SCOPES.filter((s) => s !== 'user:read:email');
const FORBIDDEN_RE = /^analytics:|revenue|payout/;
// Not source in use: dependencies, backups and archives, tests and docs (which name the scopes to forbid them), logs and data.
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'backups', 'archives', 'scratchpad', 'docs', 'tests', 'test', 'logs', 'data', 'uploads',
    'temp_audio', 'transcripts', 'sounds', 'piper_models', 'dist', 'build', 'out', 'release', 'vendor', 'coverage']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.ejs', '.json']);

/** Source text with JS comments removed (strings, template literals and regex literals kept). `strings` collects the string literals. */
export function stripJsComments(src, strings = null) {
    let out = '';
    let i = 0;
    let lastSig = '';
    const n = src.length;
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < n && src[j] !== c) { if (src[j] === '\\') j++; else if (c !== '`' && src[j] === '\n') break; j++; }
            out += src.slice(i, j + 1); if (strings) strings.push(src.slice(i, j + 1)); i = j + 1; lastSig = c; continue;
        }
        if (c === '/' && (lastSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(return|typeof|case|in|of)$/.test(out.slice(-40).trimEnd()))) {
            let j = i + 1, cls = false;
            while (j < n && src[j] !== '\n') {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
                j++;
            }
            out += src.slice(i, j + 1); i = j + 1; lastSig = '/'; continue;
        }
        out += c;
        if (!/\s/.test(c)) lastSig = c;
        i++;
    }
    return out;
}

/** What of a file can request scopes: JS without comments; EJS without EJS/HTML/JS comments; JSON as it is. */
export function codeOf(file, src) {
    const ext = path.extname(file);
    if (ext === '.json') return src;
    if (ext === '.ejs') return src.replace(/<%#[\s\S]*?%>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}])\/\/[^\n]*/g, '$1');
    return stripJsComments(src);
}

/** Forbidden Twitch scopes named in code. The lists that forbid them (FORBIDDEN_*) are not requests. */
export function forbiddenIn(code) {
    const cleaned = code.replace(/FORBIDDEN[A-Z_]*\s*=\s*(Object\.freeze\()?\[[^\]]*\]/g, ' ');
    const hits = new Set();
    for (const m of cleaned.matchAll(/(?<![\w:])([a-z_]+(?::[a-z_]+)+)(?![\w:])/g)) {
        const s = m[1];
        if (REPO_FORBIDDEN.includes(s) || (s.split(':').length >= 2 && FORBIDDEN_RE.test(s) && /:(read|manage|write|edit)\b|^analytics:/.test(s))) hits.add(s);
    }
    return [...hits];
}

function* sourceFiles(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* sourceFiles(path.join(dir, e.name)); continue; }
        if (!e.isFile() || !EXT.has(path.extname(e.name)) || /\.min\.js$|package-lock\.json$/.test(e.name)) continue;
        const p = path.join(dir, e.name);
        if (fs.statSync(p).size > 1_500_000) continue;
        yield p;
    }
}

test('the comment stripper keeps code and strings and drops comments', () => {
    const src = "const a = 'user:read:follows'; // user:read:follows\n/* bits:read user:read:follows */ const r = /\\//g; const u = 'https://x.tv/a'; // tail";
    const code = stripJsComments(src);
    assert.equal(forbiddenIn(code).length, 1, 'the string counts, the comments do not');
    assert.match(code, /https:\/\/x\.tv\/a/);
    assert.deepEqual(forbiddenIn(stripJsComments('// user:read:follows\nconst s = "channel:read:subscriptions bits:read";')), []);
    assert.deepEqual(forbiddenIn("const FORBIDDEN_SCOPES = Object.freeze(['user:read:follows', 'analytics:read:games']);"), []);
    assert.deepEqual(forbiddenIn("scope: ['channel:read:revenue', 'analytics:read:extensions'].join(' ')").sort(), ['analytics:read:extensions', 'channel:read:revenue']);
    assert.deepEqual(forbiddenIn("<a href=\"https://id.twitch.tv/oauth2/authorize?scope=user:read:follows\">"), ['user:read:follows']);
});

test('no Twitch scope list anywhere in the repo asks for user:read:follows or a revenue scope (H-726)', () => {
    const offenders = [];
    let scanned = 0;
    const seen = new Set();
    for (const file of sourceFiles(ROOT)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        const code = codeOf(file, fs.readFileSync(file, 'utf8'));
        scanned++;
        if (/moderator:read:followers|channel:read:subscriptions/.test(code)) seen.add(rel);
        for (const s of forbiddenIn(code)) offenders.push(`${rel}: ${s}`);
    }
    assert.ok(scanned > 200, `scanned ${scanned} files`);
    // The scan reaches the real scope lists (otherwise passing would prove nothing).
    for (const f of ['dashboard/routes/auth-twitch-broadcaster.js', 'core/stream-bot/scopes.js']) assert.ok(seen.has(f), `${f} was scanned`);
    assert.deepEqual(offenders, [], `forbidden Twitch scopes requested:\n${offenders.join('\n')}`);
});

test('the stream bot grant itself: no forbidden scope (same rule, imported list)', () => {
    for (const s of STREAM_BOT_SCOPES) assert.equal(REPO_FORBIDDEN.includes(s) || FORBIDDEN_RE.test(s), false, s);
});

test('the schedule sign-in stores who signed in, not their Twitch tokens (H-759)', () => {
    const strings = [];
    stripJsComments(fs.readFileSync(path.join(ROOT, 'dashboard/routes/auth-twitch.js'), 'utf8'), strings);
    const sql = strings.filter((s) => s.includes('schedule_users'));
    assert.ok(sql.some((s) => /INSERT INTO schedule_users/.test(s)) && sql.some((s) => /UPDATE schedule_users/.test(s)), 'found the sign-in SQL');
    for (const s of sql) assert.doesNotMatch(s, /twitch_access_token|twitch_refresh_token|SELECT \*/, s.replace(/\s+/g, ' '));
});

test('the hourly token validator never reads or writes schedule_users (H-759)', async () => {
    const enc = { encrypt: (s) => ({ s }), decrypt: (o) => o.s };
    const sources = createTokenSources({ encryption: enc, tokenEncryption: { encryptToken: (s) => s, decryptToken: (s) => s }, env: {} });
    const sqls = [];
    const db = { async query(sql) { sqls.push(sql); return [[]]; } };
    for (const src of sources) {
        assert.doesNotMatch(src.key, /schedule/);
        await src.list(db);
        if (src.save) await src.save(db, '1', { access: 'a', refresh: 'r', expiresAt: new Date() });
        if (src.mark) await src.mark(db, '1');
    }
    assert.ok(sqls.length > 5);
    for (const s of sqls) assert.doesNotMatch(s, /schedule_users/);
});
