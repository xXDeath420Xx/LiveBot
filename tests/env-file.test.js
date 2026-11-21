import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    setEnvValue, clearEnvValue, isKeySet, hasKey, applySet, applyClear, renderEnvValue, backupEnv,
} from '../utils/env-file.js';

/*
 * utils/env-file.js edits the repo-root .env as text (never `source`d, after an unquoted line once
 * leaked a value). These tests drive a throwaway temp .env: set/replace/append/clear, quoting, that a
 * backup is made, that every other line (comments, an unquoted key) survives, and that a thrown error
 * never contains the value.
 */

// A .env that mirrors the real one's shape: comments, blanks, quoted and UNQUOTED values.
const SAMPLE = [
    '# CertiFried env',
    '',
    'DB_HOST=127.0.0.1',
    'GIPHY_API_KEY=oldgiphyvalue1234567890ab',
    '# meta',
    'META_APP_TOKEN=rawunquoted|value&with#specials',  // the line-104-style unquoted value
    'LASTFM_API_KEY="0123456789abcdef0123456789abcdef"',
    '',
].join('\n');

function tmpEnv(contents = SAMPLE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, contents, { mode: 0o600 }); // mirror the real .env (600)
    fs.chmodSync(envPath, 0o600);
    return { dir, envPath, backupDir: path.join(dir, 'backups', 'env') };
}

test('renderEnvValue: bare when safe, quoted and escaped otherwise', () => {
    assert.equal(renderEnvValue('abc123'), 'abc123');
    assert.equal(renderEnvValue('GOCSPX-abc_DEF-123'), 'GOCSPX-abc_DEF-123');
    assert.equal(renderEnvValue('x.apps.googleusercontent.com'), 'x.apps.googleusercontent.com');
    assert.equal(renderEnvValue('has space'), '"has space"');
    assert.equal(renderEnvValue('has#hash'), '"has#hash"');
    assert.equal(renderEnvValue(''), '""');
    assert.equal(renderEnvValue('a"b\\c'), '"a\\"b\\\\c"');
});

test('applySet replaces an existing line in place, leaving every other line byte-for-byte', () => {
    const next = applySet(SAMPLE, 'GIPHY_API_KEY', 'newvalue0000000000000000ab');
    assert.match(next, /^GIPHY_API_KEY=newvalue0000000000000000ab$/m);
    assert.ok(!next.includes('oldgiphyvalue'));
    // The unquoted META line and the quoted LASTFM line are untouched.
    assert.ok(next.includes('META_APP_TOKEN=rawunquoted|value&with#specials'));
    assert.ok(next.includes('LASTFM_API_KEY="0123456789abcdef0123456789abcdef"'));
    assert.ok(next.includes('# CertiFried env'));
    // Same number of lines (replace, not append).
    assert.equal(next.split('\n').length, SAMPLE.split('\n').length);
});

test('applySet appends with a trailing newline when the key is absent', () => {
    const next = applySet(SAMPLE, 'STEAM_API_KEY', '00112233445566778899AABBCCDDEEFF');
    assert.match(next, /\nSTEAM_API_KEY=00112233445566778899AABBCCDDEEFF\n$/);
    assert.ok(next.startsWith(SAMPLE.trimEnd()) || next.startsWith(SAMPLE));
});

test('applyClear removes only the target line and keeps the rest', () => {
    const next = applyClear(SAMPLE, 'META_APP_TOKEN');
    assert.ok(!next.includes('META_APP_TOKEN'));
    assert.ok(next.includes('GIPHY_API_KEY=oldgiphyvalue1234567890ab'));
    assert.ok(next.includes('# meta'));
});

test('setEnvValue writes the file, backs up the ORIGINAL first, and preserves other lines', () => {
    const { envPath, backupDir } = tmpEnv();
    const original = fs.readFileSync(envPath, 'utf8');
    const res = setEnvValue('GIPHY_API_KEY', 'brandnewgiphykey0123456789', { envPath, backupDir });

    const after = fs.readFileSync(envPath, 'utf8');
    assert.match(after, /^GIPHY_API_KEY=brandnewgiphykey0123456789$/m);
    assert.ok(after.includes('META_APP_TOKEN=rawunquoted|value&with#specials'));

    // A backup exists and holds the PRE-write content.
    const backups = fs.readdirSync(backupDir).filter(n => n.startsWith('.env.'));
    assert.equal(backups.length, 1);
    assert.equal(res.backup, path.join(backupDir, backups[0]));
    assert.equal(fs.readFileSync(res.backup, 'utf8'), original);
    assert.equal(fs.statSync(res.backup).mode & 0o777, 0o600);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('setEnvValue appends a new key and isKeySet reflects it', () => {
    const { envPath, backupDir } = tmpEnv();
    assert.equal(isKeySet('STEAM_API_KEY', { envPath }), false);
    setEnvValue('STEAM_API_KEY', '00112233445566778899AABBCCDDEEFF', { envPath, backupDir });
    assert.equal(isKeySet('STEAM_API_KEY', { envPath }), true);
    assert.equal(hasKey(fs.readFileSync(envPath, 'utf8'), 'STEAM_API_KEY'), true);
});

test('clearEnvValue removes the line, reports removed, and keeps a backup; absent key is a no-op write', () => {
    const { envPath, backupDir } = tmpEnv();
    const r1 = clearEnvValue('GIPHY_API_KEY', { envPath, backupDir });
    assert.equal(r1.removed, true);
    assert.equal(isKeySet('GIPHY_API_KEY', { envPath }), false);
    assert.ok(fs.readFileSync(envPath, 'utf8').includes('META_APP_TOKEN='));

    const r2 = clearEnvValue('STEAM_API_KEY', { envPath, backupDir }); // absent
    assert.equal(r2.removed, false);
    // Still backed up both times.
    assert.ok(fs.readdirSync(backupDir).filter(n => n.startsWith('.env.')).length >= 2);
});

test('backupEnv keeps only the newest 20 backups', () => {
    const { envPath, backupDir } = tmpEnv();
    for (let i = 0; i < 25; i++) backupEnv(envPath, backupDir);
    const backups = fs.readdirSync(backupDir).filter(n => n.startsWith('.env.'));
    assert.ok(backups.length <= 20, `expected <= 20 backups, got ${backups.length}`);
});

test('a thrown error NEVER contains the value', () => {
    const SECRET = 'TOPSECRET-SHOULD-NOT-APPEAR-9f8e7d';
    const missing = path.join(os.tmpdir(), 'no-such-dir-' + Date.now(), '.env');
    try {
        setEnvValue('GIPHY_API_KEY', SECRET, { envPath: missing, backupDir: path.dirname(missing) });
        assert.fail('expected a throw');
    } catch (err) {
        assert.ok(!String(err.message).includes(SECRET));
        assert.ok(!String(err.stack || '').includes(SECRET));
    }
});

test('an invalid key is rejected and the error names no value', () => {
    assert.throws(() => setEnvValue('bad key', 'whatever', { envPath: '/tmp/x' }), /Invalid env key/);
});

test("setEnvValue follows a .env symlink: the link stays, the real file is replaced in its own directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envfile-link-"));
    const secrets = path.join(dir, ".secrets");
    fs.mkdirSync(secrets);
    const real = path.join(secrets, ".env");
    fs.writeFileSync(real, "A=1\nGIPHY_API_KEY=old-dummy-value\n", { mode: 0o640 });
    const link = path.join(dir, ".env");
    fs.symlinkSync(".secrets/.env", link);
    setEnvValue("GIPHY_API_KEY", "dummy-new-value-0123", { envPath: link, backupDir: path.join(dir, "bk") });
    assert.ok(fs.lstatSync(link).isSymbolicLink(), ".env is still a symlink");
    assert.match(fs.readFileSync(real, "utf8"), /GIPHY_API_KEY=dummy-new-value-0123/);
    assert.equal(fs.statSync(real).mode & 0o777, 0o640, "mode kept");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".env.tmp")), [], "no temp file left in the link dir");
    fs.rmSync(dir, { recursive: true, force: true });
});
