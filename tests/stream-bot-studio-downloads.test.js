import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';

/*
 * /downloads/studio (dashboard/routes/downloads.js): the CertiFried Studio download page and the files behind it,
 * including electron-updater's latest.yml. A temporary STUDIO_DOWNLOADS_DIR stands in for the real folder.
 *   whitelist   only latest.yml, SHA256SUMS.txt and the versioned installer, blockmap and portable names are served;
 *               traversal, other names and look-alikes are 404
 *   headers     content types, no-cache on latest.yml and SHA256SUMS.txt, attachment on the .exe files
 *   page        not published yet (empty folder), version / date / sizes / SHA-256 from SHA256SUMS.txt or computed,
 *               the SmartScreen note, the site frame in Dark, Light and Sand
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-dl-'));
process.env.STUDIO_DOWNLOADS_DIR = dir;
const { default: router, allowedFile, parseLatestYml, parseSums, release } = await import('../dashboard/routes/downloads.js');

let server, base;
const SETUP = Buffer.from('MZ fake installer bytes '.repeat(50));
const PORTABLE = Buffer.from('MZ fake portable bytes '.repeat(40));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const LATEST = `version: 0.2.0
files:
  - url: CertiFried-Studio-Setup-0.2.0.exe
    sha512: abc==
    size: ${SETUP.length}
path: CertiFried-Studio-Setup-0.2.0.exe
sha512: abc==
releaseDate: '2026-11-19T12:00:00.000Z'
`;

test.before(async () => {
    const app = express();
    app.set('views', path.join(root, 'dashboard/views'));
    app.set('view engine', 'ejs');
    app.use((req, res, next) => { res.locals.uiTheme = String(req.query.theme || 'dark'); next(); });
    app.use('/', router);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dir, '..', 'sbt-dl-secret.txt'), 'outside');
});
test.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(dir, '..', 'sbt-dl-secret.txt'), { force: true });
});

test('the whitelist: exact names only', () => {
    for (const ok of ['latest.yml', 'SHA256SUMS.txt', 'CertiFried-Studio-Setup-0.2.0.exe', 'CertiFried-Studio-Setup-0.2.0.exe.blockmap',
        'CertiFried-Studio-Portable-0.2.0.exe', 'CertiFried-Studio-Setup-1.10.300-beta.1.exe']) assert.ok(allowedFile(ok), ok);
    for (const bad of ['../latest.yml', 'latest.yml/..', 'latest.yaml', '.env', 'CertiFried-Studio-Setup-0.2.exe', 'CertiFried-Studio-Setup-0.2.0.exe.exe',
        'certifried-studio-setup-0.2.0.exe', 'CertiFried-Studio-Setup-0.2.0.msi', 'CertiFried-Studio-Setup-../../x.exe', '', null, 'a'.repeat(200)]) {
        assert.equal(allowedFile(bad), null, String(bad));
    }
    assert.deepEqual(parseLatestYml(LATEST), { version: '0.2.0', releaseDate: '2026-11-19T12:00:00.000Z', path: 'CertiFried-Studio-Setup-0.2.0.exe' });
    assert.equal(parseLatestYml('version: ../../x').version, null);
    assert.equal(parseSums(`${'a'.repeat(64)}  CertiFried-Studio-Setup-0.2.0.exe\nnot a line\n${'B'.repeat(64)} *x.exe`).get('x.exe'), 'b'.repeat(64));
});

test('an empty folder: the page says the download is not published yet, files are 404', async () => {
    assert.equal(await release(dir), null);
    const r = await fetch(`${base}/downloads/studio`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /not published yet/);
    assert.match(html, /<title>Download CertiFried Studio · CertiFried<\/title>/);
    assert.equal((await fetch(`${base}/downloads/studio/latest.yml`)).status, 404);
});

test('published: files with the right headers; traversal and other names are 404', async () => {
    fs.writeFileSync(path.join(dir, 'latest.yml'), LATEST);
    fs.writeFileSync(path.join(dir, 'CertiFried-Studio-Setup-0.2.0.exe'), SETUP);
    fs.writeFileSync(path.join(dir, 'CertiFried-Studio-Setup-0.2.0.exe.blockmap'), 'blockmap');
    fs.writeFileSync(path.join(dir, 'CertiFried-Studio-Portable-0.2.0.exe'), PORTABLE);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not served');

    const yml = await fetch(`${base}/downloads/studio/latest.yml?noCache=1abc`);
    assert.equal(yml.status, 200);
    assert.match(yml.headers.get('content-type'), /^text\/yaml/);
    assert.equal(yml.headers.get('cache-control'), 'no-cache');
    assert.equal(await yml.text(), LATEST);
    const exe = await fetch(`${base}/downloads/studio/CertiFried-Studio-Setup-0.2.0.exe`);
    assert.equal(exe.status, 200);
    assert.equal(exe.headers.get('content-disposition'), 'attachment; filename="CertiFried-Studio-Setup-0.2.0.exe"');
    assert.equal(exe.headers.get('content-length'), String(SETUP.length));
    assert.deepEqual(Buffer.from(await exe.arrayBuffer()), SETUP);
    assert.equal((await fetch(`${base}/downloads/studio/CertiFried-Studio-Setup-0.2.0.exe.blockmap`)).status, 200);
    for (const p of ['notes.txt', '..%2Fsbt-dl-secret.txt', '%2e%2e%2fsbt-dl-secret.txt', '..%5Csbt-dl-secret.txt', 'CertiFried-Studio-Setup-9.9.9.exe']) {
        assert.equal((await fetch(`${base}/downloads/studio/${p}`)).status, 404, p);
    }
});

test('the page: version, date, sizes and SHA-256 (computed, then from SHA256SUMS.txt), the SmartScreen note, three themes', async () => {
    let rel = await release(dir);
    assert.equal(rel.version, '0.2.0');
    assert.equal(rel.sums, false);
    assert.deepEqual(rel.builds.map((b) => [b.kind, b.file, b.size, b.sha256]), [
        ['setup', 'CertiFried-Studio-Setup-0.2.0.exe', SETUP.length, sha(SETUP)],
        ['portable', 'CertiFried-Studio-Portable-0.2.0.exe', PORTABLE.length, sha(PORTABLE)],
    ], 'hashed when SHA256SUMS.txt is missing');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${'c'.repeat(64)}  CertiFried-Studio-Setup-0.2.0.exe\n${'d'.repeat(64)}  CertiFried-Studio-Portable-0.2.0.exe\n`);
    rel = await release(dir);
    assert.equal(rel.sums, true);
    assert.deepEqual(rel.builds.map((b) => b.sha256), ['c'.repeat(64), 'd'.repeat(64)], 'the published checksums are shown');
    const sums = await fetch(`${base}/downloads/studio/SHA256SUMS.txt`);
    assert.match(sums.headers.get('content-type'), /^text\/plain/);
    assert.equal(sums.headers.get('cache-control'), 'no-cache');

    for (const theme of ['dark', 'light', 'sand']) {
        const html = await (await fetch(`${base}/downloads/studio?theme=${theme}`)).text();
        assert.match(html, new RegExp(`<html lang="en" data-theme="${theme}"`));
        assert.match(html, /Version 0\.2\.0, released <time datetime="2026-11-19T12:00:00.000Z">2026-11-19<\/time>/);
        assert.ok(html.includes('href="/downloads/studio/CertiFried-Studio-Setup-0.2.0.exe"'));
        assert.ok(html.includes('href="/downloads/studio/CertiFried-Studio-Portable-0.2.0.exe"'));
        assert.ok(html.includes('href="/downloads/studio/SHA256SUMS.txt"'));
        assert.ok(html.includes('c'.repeat(64)) && html.includes('d'.repeat(64)));
        assert.match(html, /Windows protected your PC/);
        assert.match(html, /click More info, then click Run anyway/);
        assert.doesNotMatch(html, /certificate|CSC_LINK|Microsoft Store|Trusted Signing/i, 'no signing plans on the page');
        assert.match(html, /<body class="cfs-body/);
        assert.match(html, /<main[^>]*id="main-content"/);
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
    }
});
