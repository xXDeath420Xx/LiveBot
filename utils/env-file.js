/**
 * Safe, text-based editor for the repo-root .env file.
 *
 * WHY TEXT, NEVER `source`: a prior incident — line 104 (META_APP_TOKEN) is unquoted and sourcing
 * .env in a shell expanded/leaked a value. So this module parses and rewrites .env as plain UTF-8
 * text: it never executes it, never requires dotenv, and preserves every other line (comments,
 * blank lines, spacing, the existing quoting of untouched keys) byte-for-byte.
 *
 * It is used by the super-admin "Service keys" page (dashboard/routes/service-keys.js) to set or
 * clear a small allow-list of secrets from the dashboard. Guarantees:
 *   - A thrown error NEVER contains the value (only the key name and a reason).
 *   - Before each write, .env is copied to backups/env/.env.<UTC timestamp> (dir 700, file 600);
 *     only the newest 20 backups are kept.
 *   - The write is atomic: a temp file in the same directory is fchmod'd to 600, then renamed over
 *     .env. The replacement's mode and owner are set to match the original .env.
 *
 * The value itself is written verbatim (quoted only when it needs quoting); callers are expected to
 * have trimmed trailing whitespace/newline and validated shape before calling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ENV_PATH = path.join(REPO_ROOT, '.env');
const DEFAULT_BACKUP_DIR = path.join(REPO_ROOT, 'backups', 'env');
const KEEP_BACKUPS = 20;

/** Allowed env key shape. Rejecting odd keys keeps the anchored line-match unambiguous. */
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** A value safe to write bare (no quoting). Everything dotenv would mis-split forces quoting. */
const BARE_RE = /^[A-Za-z0-9_.@/:+=~-]+$/;

function assertKey(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
        throw new Error(`Invalid env key name: ${JSON.stringify(key)}`);
    }
}

/**
 * Render a value for the right-hand side of KEY=.
 * Bare when it is non-empty and contains only safe characters; otherwise double-quoted with
 * backslash, double-quote, newline, carriage-return and tab escaped (dotenv double-quote semantics).
 * NOTE: deliberately contains no reference to the value in any error it could raise.
 */
export function renderEnvValue(value) {
    const s = String(value ?? '');
    if (s.length > 0 && BARE_RE.test(s)) return s;
    const escaped = s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}

/** Dominant line ending of a file's text (so appended lines match what's already there). */
function newlineOf(text) {
    return /\r\n/.test(text) ? '\r\n' : '\n';
}

function readEnv(envPath) {
    return fs.readFileSync(envPath, 'utf8');
}

/** True when a line `^KEY=` exists in the text. */
export function hasKey(text, key) {
    assertKey(key);
    return new RegExp(`^${key}=.*$`, 'm').test(text);
}

/**
 * Return new text with KEY set to `value` (replacing an existing `^KEY=` line in place, or appending
 * `KEY=value` with a trailing newline when absent). Pure string function — no I/O.
 */
export function applySet(text, key, value) {
    assertKey(key);
    const rendered = renderEnvValue(value);
    const line = `${key}=${rendered}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
        return text.replace(re, () => line);
    }
    const nl = newlineOf(text);
    const sep = text.length === 0 || text.endsWith('\n') || text.endsWith('\r') ? '' : nl;
    return `${text}${sep}${line}${nl}`;
}

/**
 * Return new text with the `^KEY=` line removed entirely (including its trailing newline). If the
 * key is absent, the text is returned unchanged. Pure string function — no I/O.
 */
export function applyClear(text, key) {
    assertKey(key);
    const re = new RegExp(`^${key}=.*(?:\\r\\n|\\n|\\r)?`, 'm');
    return text.replace(re, '');
}

function ensureBackupDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on existing dir */ }
}

function pruneBackups(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const backups = names.filter(n => n.startsWith('.env.')).sort(); // timestamp names sort chronologically
    const excess = backups.length - KEEP_BACKUPS;
    for (let i = 0; i < excess; i++) {
        try { fs.unlinkSync(path.join(dir, backups[i])); } catch { /* best effort */ }
    }
}

/** Copy the current .env to backups/env/.env.<UTC timestamp> (dir 700, file 600). Returns the path. */
export function backupEnv(envPath = DEFAULT_ENV_PATH, backupDir = DEFAULT_BACKUP_DIR) {
    ensureBackupDir(backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const data = fs.readFileSync(envPath);
    // Two writes in the same millisecond used to share one name, so the second backup overwrote the first
    // (flaky tests/env-file.test.js). "-1", "-2"... keep them apart and still sort after the plain name.
    let dest = path.join(backupDir, `.env.${stamp}`);
    for (let n = 1; fs.existsSync(dest); n++) dest = path.join(backupDir, `.env.${stamp}-${n}`);
    fs.writeFileSync(dest, data, { mode: 0o600, flag: "wx" });
    try { fs.chmodSync(dest, 0o600); } catch { /* best effort */ }
    pruneBackups(backupDir);
    return dest;
}

/**
 * Atomically replace .env with `newText`, matching the original's mode and owner.
 * The temp file is created in the same directory and fchmod'd to 600 before the rename.
 */
function atomicWrite(envPath, newText) {
    // .env may be a symlink (production: .env -> .secrets/.env, so the app user needs write access only to
    // .secrets/, not to the repo root). Write next to the real file and rename over it, keeping the link.
    try { envPath = fs.realpathSync(envPath); } catch { /* no file yet: write where asked */ }
    const dir = path.dirname(envPath);
    let origMode = 0o600;
    let origUid = null;
    let origGid = null;
    try {
        const st = fs.statSync(envPath);
        origMode = st.mode & 0o777;
        origUid = st.uid;
        origGid = st.gid;
    } catch { /* no original stat: fall back to 600 */ }

    const tmp = path.join(dir, `.env.tmp-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, newText, 0, 'utf8');
        fs.fsyncSync(fd);
        fs.fchmodSync(fd, 0o600);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, envPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* best effort cleanup */ }
        throw err;
    }
    // Match the original .env's mode and owner on the replacement.
    try { fs.chmodSync(envPath, origMode); } catch { /* best effort */ }
    if (origUid != null && origGid != null) {
        try { fs.chownSync(envPath, origUid, origGid); } catch { /* not permitted / same owner: fine */ }
    }
}

/**
 * Set KEY=value in .env: back up, rewrite atomically, preserve every other line.
 * Throws (without the value) on a bad key or I/O failure. Returns { key, backup }.
 */
export function setEnvValue(key, value, { envPath = DEFAULT_ENV_PATH, backupDir = DEFAULT_BACKUP_DIR } = {}) {
    assertKey(key);
    try {
        const text = readEnv(envPath);
        const next = applySet(text, key, value);
        const backup = backupEnv(envPath, backupDir);
        atomicWrite(envPath, next);
        return { key, backup };
    } catch (err) {
        // Re-wrap so nothing downstream can accidentally serialise a value the original error touched.
        const e = new Error(`Failed to set ${key}: ${err.code || err.message || 'write error'}`);
        e.code = err.code;
        throw e;
    }
}

/**
 * Remove the KEY= line from .env: back up, rewrite atomically, preserve every other line.
 * Returns { key, backup, removed } where removed is false if the key was absent.
 */
export function clearEnvValue(key, { envPath = DEFAULT_ENV_PATH, backupDir = DEFAULT_BACKUP_DIR } = {}) {
    assertKey(key);
    try {
        const text = readEnv(envPath);
        const present = hasKey(text, key);
        const next = present ? applyClear(text, key) : text;
        const backup = backupEnv(envPath, backupDir);
        if (present) atomicWrite(envPath, next);
        return { key, backup, removed: present };
    } catch (err) {
        const e = new Error(`Failed to clear ${key}: ${err.code || err.message || 'write error'}`);
        e.code = err.code;
        throw e;
    }
}

/** Whether KEY currently has a non-empty value in .env (boolean only — never reads the value out). */
export function isKeySet(key, { envPath = DEFAULT_ENV_PATH } = {}) {
    assertKey(key);
    let text;
    try { text = readEnv(envPath); } catch { return false; }
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (!m) return false;
    return m[1].trim().replace(/^["']|["']$/g, '').length > 0;
}

export default { setEnvValue, clearEnvValue, isKeySet, hasKey, applySet, applyClear, renderEnvValue, backupEnv, DEFAULT_ENV_PATH };
