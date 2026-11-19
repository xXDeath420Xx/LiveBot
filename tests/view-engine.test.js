import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine, versionAssetRefs, fileHash } from '../dashboard/services/view-engine.js';
import { makeRequest, parseRequest, watchReloadRequests, writeJsonAtomic } from '../dashboard/services/dashboard-reload.js';

/*
 * No-restart dashboard reloads (dashboard/services/view-engine.js + dashboard-reload.js,
 * scripts/reload-dashboard.mjs). What has to stay true:
 *   - include() resolves caller-relative first, then from views/, as it always has
 *   - compiled templates are cached until reload(); after it, edits show
 *   - the Classic CSS restore never leaks into the cards/compact render of the same partial
 *   - local css/js links get ?v=<content hash>; the hash follows the file after a reload
 *   - a reload request is acknowledged with its id; junk and other users' files are ignored
 *   - npm test keeps a per-test timeout (a runaway regex must not hang the suite)
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-views-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture() {
    const dir = fs.mkdtempSync(path.join(tmp, 'v-'));
    const views = path.join(dir, 'views');
    const pub = path.join(dir, 'public');
    fs.mkdirSync(path.join(views, 'partials/manage'), { recursive: true });
    fs.mkdirSync(path.join(pub, 'css'), { recursive: true });
    fs.mkdirSync(path.join(pub, 'js'), { recursive: true });
    fs.writeFileSync(path.join(pub, 'css/site.css'), 'body { color: red }');
    fs.writeFileSync(path.join(pub, 'js/app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(views, 'page.ejs'),
        '<link rel="stylesheet" href="/css/site.css"><script src="/js/app.js" defer></script>'
        + '<link href="/css/missing.css"><link href="/css/site.css?v=7">'
        + '[<%- include("partials/manage/box", { label: "x" }) %>]');
    fs.writeFileSync(path.join(views, 'partials/manage/box.ejs'), '<style>.box{color:red}</style><b><%= label %>:<%= who %></b><%- include("inner") %>');
    // caller-relative include wins over a same-named file at the views root
    fs.writeFileSync(path.join(views, 'partials/manage/inner.ejs'), '<i>near</i>');
    fs.writeFileSync(path.join(views, 'inner.ejs'), '<i>root</i>');
    return { dir, views, pub };
}

test('renders with includes resolved caller-relative first; locals flow into partials', () => {
    const { views } = fixture();
    const engine = createViewEngine({ viewsDir: views, cache: true });
    const html = engine.renderFile(path.join(views, 'page.ejs'), { who: 'tester' });
    assert.match(html, /\[<style>\.box\{color:red\}<\/style><b>x:tester<\/b><i>near<\/i>\]/);
});

test('cached until reload(): an edited template shows only after the reload', () => {
    const { views } = fixture();
    const engine = createViewEngine({ viewsDir: views, cache: true });
    const file = path.join(views, 'page.ejs');
    const before = engine.renderFile(file, { who: 'a' });
    fs.writeFileSync(path.join(views, 'partials/manage/box.ejs'), '<b>NEW <%= who %></b>');
    assert.equal(engine.renderFile(file, { who: 'a' }), before, 'still the compiled original');
    const r = engine.reload();
    assert.equal(r.generation, 2);
    assert.ok(r.cleared >= 3, `cleared ${r.cleared}`);
    assert.match(engine.renderFile(file, { who: 'a' }), /\[<b>NEW a<\/b>\]/);
    assert.equal(engine.stats().compiled, 2, 'page + the new box (which no longer includes inner)');

    const uncached = createViewEngine({ viewsDir: views, cache: false });
    fs.writeFileSync(path.join(views, 'partials/manage/box.ejs'), '<b>NEWER</b>');
    assert.match(uncached.renderFile(file, { who: 'a' }), /NEWER/, 'DASHBOARD_VIEW_CACHE=0: every render reads the file');
});

test('the Classic CSS variant is cached separately from the cards/compact render', () => {
    // A synthetic partial at a path the Classic map knows, holding one of that entry's rules as the
    // redesign left it, so this does not depend on any real page staying un-rebuilt.
    const map = JSON.parse(fs.readFileSync(path.join(root, 'dashboard/services/classic-style-map.json'), 'utf8')).files;
    const [key, entry] = Object.entries(map).find(([, e]) => Object.keys(e.rules || {}).length);
    const [today, [original]] = Object.entries(entry.rules)[0];
    const viewsDir = path.join(fs.mkdtempSync(path.join(tmp, 'cv-')), 'views');
    fs.mkdirSync(path.dirname(path.join(viewsDir, key)), { recursive: true });
    fs.writeFileSync(path.join(viewsDir, key), `<style>.x {${today}}</style><b><%= guild.name %></b>`);
    const engine = createViewEngine({ viewsDir, cache: true });
    // A throwaway top-level page (outside views/) including the partial by absolute path;
    // classicCss only ever changes includes.
    const page = path.join(fs.mkdtempSync(path.join(tmp, 'c-')), 'p.ejs');
    fs.writeFileSync(page, `<%- include(${JSON.stringify(path.join(viewsDir, key.replace(/\.ejs$/, '')))}) %>`);
    const locals = (classicCss) => ({ classicCss, guild: { id: '1', name: 'G' } });
    const classic = engine.renderFile(page, locals(true));
    const modern = engine.renderFile(page, locals(false));
    assert.notEqual(classic, modern, 'classic render differs');
    assert.ok(classic.includes(`{${original}}`) && modern.includes(`{${today}}`), "classic has the original rule, cards keep today's");
    assert.equal(engine.renderFile(page, locals(false)), modern, 'cards render unaffected by the classic one before it');
    assert.equal(engine.renderFile(page, locals(true)), classic);
});

test('local css/js links get ?v=<content hash>, which follows the file after a reload', () => {
    const { views, pub } = fixture();
    const engine = createViewEngine({ viewsDir: views, publicDir: pub, cache: true });
    const file = path.join(views, 'page.ejs');
    const h1 = fileHash(pub, '/css/site.css');
    assert.match(h1, /^[0-9a-f]{10}$/);
    const html = engine.renderFile(file, { who: 'a' });
    assert.ok(html.includes(`href="/css/site.css?v=${h1}"`), html);
    assert.ok(html.includes(`src="/js/app.js?v=${fileHash(pub, '/js/app.js')}" defer`));
    assert.ok(html.includes('href="/css/missing.css"'), 'a missing file is left alone');
    assert.ok(html.includes('href="/css/site.css?v=7"'), 'an existing query string is left alone');

    fs.writeFileSync(path.join(pub, 'css/site.css'), 'body { color: blue }');
    assert.ok(engine.renderFile(file, { who: 'a' }).includes(`?v=${h1}`), 'unchanged until the reload');
    engine.reload();
    const h2 = fileHash(pub, '/css/site.css');
    assert.notEqual(h2, h1);
    assert.ok(engine.renderFile(file, { who: 'a' }).includes(`href="/css/site.css?v=${h2}"`));

    assert.equal(fileHash(pub, '/../../etc/passwd'), null, 'never outside public/');
    assert.equal(versionAssetRefs('<a href="/css/<%= x %>.css">', () => 'h'), '<a href="/css/<%= x %>.css">', 'dynamic URLs untouched');
    assert.equal(versionAssetRefs('s.src="/js/a.js"', () => 'h'), 's.src="/js/a.js"', 'only attributes, not script strings');
});

test('the real templates still compile through the engine (spot check)', () => {
    const viewsDir = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir, publicDir: path.join(root, 'dashboard/public'), cache: true });
    const html = engine.renderFile(path.join(viewsDir, 'reconnecting.ejs'), {
        reason: 'starting', realError: 'The bot is not in this server.', retrySeconds: 5, maxRetries: 24, uiTheme: 'forest', uiStyle: 'compact',
    });
    assert.match(html, /<html data-theme="forest"[^>]*data-style="compact"/);
    assert.match(html, /href="\/css\/cf-ui\.css\?v=[0-9a-f]{10}"/);
    assert.match(html, /Reconnecting to Discord/);
    assert.match(html, /The bot is not in this server\./);
    assert.match(html, /var RETRY = 5, MAX = 24;/);
});

test('reload requests: shape, ids and reasons are checked', () => {
    const r = makeRequest('deploy views\u0007 é', 1_700_000_000_000);
    assert.match(r.id, /^[a-z0-9-]{8,64}$/);
    assert.equal(r.reason, 'deploy views ', 'non-printable / non-ASCII dropped');
    assert.deepEqual(parseRequest(JSON.stringify(r)), { id: r.id, reason: r.reason, at: r.at });
    for (const junk of ['', 'nope', '{}', '{"id":"short"}', '{"id":"BAD ID with spaces"}', 'null', '[]']) {
        assert.equal(parseRequest(junk), null, junk);
    }
    assert.equal(parseRequest(JSON.stringify({ id: 'abcdefgh-1', reason: 'x'.repeat(500) })).reason.length, 200);
});

test('watcher: a request is acknowledged with its id; a foreign-owned file is ignored', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
    const requestFile = path.join(dir, '.reload-request');
    const ackFile = path.join(dir, '.reload-ack');
    const quiet = { info() {}, warn() {}, error() {} };
    let reloads = 0;
    // Exists before the watcher starts: its first stat is the baseline, so only later writes count
    // (a request that is already there when the dashboard starts is not acted on).
    writeJsonAtomic(requestFile, makeRequest('stale, from before the start'));
    const waitFor = async (pred, what) => {
        const deadline = Date.now() + 15000;   // generous: fs.watchFile polls, the machine may be loaded
        while (Date.now() < deadline) {
            const v = pred();
            if (v) return v;
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.fail(`timed out waiting for ${what}`);
    };
    const readAck = () => { try { return JSON.parse(fs.readFileSync(ackFile, 'utf8')); } catch { return null; } };

    const stop = watchReloadRequests({
        requestFile, ackFile, logger: quiet, intervalMs: 25, debounceMs: 10,
        onReload: () => ({ generation: ++reloads + 1, cleared: 7 }),
    });
    try {
        await new Promise((r) => setTimeout(r, 100));   // let the watcher take its baseline stat
        assert.equal(reloads, 0, 'the stale request was not acted on');
        const req = makeRequest('test');
        writeJsonAtomic(requestFile, req);
        const ack = await waitFor(() => { const a = readAck(); return a?.id === req.id && a; }, 'the ack');
        assert.deepEqual({ ok: ack.ok, generation: ack.generation, cleared: ack.cleared }, { ok: true, generation: 2, cleared: 7 });
        assert.equal(fs.statSync(ackFile).mode & 0o777, 0o600, 'ack written owner-only');

        const req2 = makeRequest('again');
        writeJsonAtomic(requestFile, req2);
        await waitFor(() => readAck()?.id === req2.id, 'the second ack');
        assert.equal(reloads, 2);
    } finally {
        stop();
    }

    // A file owned by someone else (simulated by watching as a different uid) is never acted on.
    let foreign = 0;
    const warned = [];
    const stop2 = watchReloadRequests({
        requestFile, ackFile, intervalMs: 25, debounceMs: 10, uid: 123456,
        logger: { info() {}, error() {}, warn: (m) => warned.push(m) },
        onReload: () => { foreign++; return {}; },
    });
    try {
        await new Promise((r) => setTimeout(r, 100));
        writeJsonAtomic(requestFile, makeRequest('foreign'));
        await waitFor(() => warned.length > 0, 'the ignore warning');
        assert.equal(foreign, 0);
        assert.match(warned[0], /owned by uid/);
    } finally {
        stop2();
    }
});

test('npm test keeps a per-test timeout and the same file set', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const cmd = pkg.scripts.test;
    assert.match(cmd, /--test-timeout=\d+/, 'a runaway test (e.g. a backtracking regex) is cancelled, not waited on forever');
    assert.match(cmd, /--test-force-exit/);
    for (const glob of ['tests/*.test.js', 'tests/defender/*.test.js', 'tests/kick/*.test.js']) assert.ok(cmd.includes(glob), glob);
});
