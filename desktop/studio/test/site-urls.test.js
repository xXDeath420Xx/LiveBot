'use strict';
/*
 * Every certifriedmultitool.com address in the app (src/main/site.js) must exist.
 *   1. Shape: https, on the site, and package.json's update feed and homepage are the same strings.
 *   2. Inside the CertiFried repo (desktop/studio/): each path is a route the dashboard registers (with the right
 *      method), the guide slug exists, and the feed serves latest.yml. Skipped outside the repo.
 *   3. CF_STUDIO_LIVE_URLS=1: request each page and the feed on the live site.
 * Written after 0.2.2 shipped a Guide button pointing at /guides/stream-bot ("Cannot GET"); the page is /docs/guides/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SITE, PAGES, SOURCE, FEED, PATHS } = require('../src/main/site');
const pkg = require('../package.json');

test('every address is https on the site, and package.json agrees', () => {
    assert.equal(SITE, 'https://certifriedmultitool.com');
    for (const u of [...Object.values(PAGES), FEED]) {
        const x = new URL(u);
        assert.equal(x.origin, SITE, u);
    }
    assert.equal(PAGES.guide, `${SITE}/docs/guides/stream-bot`, 'the guide lives under /docs/guides');
    for (const u of Object.values(SOURCE)) assert.match(u, /^https:\/\/github\.com\/xXDeath420Xx\/LiveBot(\/|$)/, u);
    assert.equal(pkg.license, 'AGPL-3.0-or-later');
    assert.equal(pkg.build.publish[0].url, FEED, 'electron-builder writes the same feed into app-update.yml');
    assert.equal(pkg.homepage, PAGES.download);
    for (const p of Object.values(PATHS)) assert.match(p, /^\/stream\/bot\//, p);
    // No other hard-coded site paths anywhere in the app's code.
    const src = path.join(__dirname, '..', 'src');
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) files.push(p); } })(src);
    for (const f of files) {
        if (f.endsWith(path.join('main', 'site.js'))) continue;
        const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        assert.doesNotMatch(code, /https?:\/\/certifriedmultitool\.com\/[a-z]/i, `${path.relative(src, f)}: use src/main/site.js`);
        assert.doesNotMatch(code, /['"`]\/(stream\/bot|downloads|docs|guides)\//, `${path.relative(src, f)}: site paths belong in src/main/site.js`);
    }
});

const repo = path.resolve(__dirname, '..', '..', '..');
const inRepo = fs.existsSync(path.join(repo, 'dashboard', 'server.js')) && fs.existsSync(path.join(repo, 'core', 'stream-bot'));

function registeredRoutes() {
    const files = [path.join(repo, 'dashboard', 'server.js'), ...fs.readdirSync(path.join(repo, 'dashboard', 'routes')).filter((f) => f.endsWith('.js')).map((f) => path.join(repo, 'dashboard', 'routes', f))];
    const out = [];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/\.(get|post|put|delete)\(\s*(\[[^\]]*\]|'[^']+'|"[^"]+")/g)) {
            for (const p of m[2].matchAll(/['"]([^'"]+)['"]/g)) out.push({ method: m[1], path: p[1], file: path.basename(f) });
        }
    }
    return out;
}
const matches = (route, p) => new RegExp(`^${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:[A-Za-z_]+/g, '[^/]+')}$`).test(p);

test('inside the repo: each address is a route the dashboard registers', { skip: !inRepo && 'not inside the CertiFried repo' }, () => {
    const routes = registeredRoutes();
    const has = (method, p) => routes.some((r) => r.method === method && matches(r.path, p));
    for (const [name, u] of Object.entries(PAGES)) assert.ok(has('get', new URL(u).pathname), `${name}: GET ${new URL(u).pathname} is registered`);
    assert.ok(has('get', `${new URL(FEED).pathname}latest.yml`), 'the update feed serves latest.yml');
    assert.ok(has('post', PATHS.pair));
    assert.ok(has('post', PATHS.linkRequest));
    assert.ok(has('post', PATHS.linkPoll));
    assert.ok(has('get', PATHS.linkPage));
    assert.ok(has('get', PATHS.deviceSound.replace(':id', 'abc')));
    const realtime = fs.readFileSync(path.join(repo, 'core', 'stream-bot', 'realtime.js'), 'utf8');
    assert.ok(realtime.includes(`WS_PATH = '${PATHS.ws}'`), 'the realtime endpoint');
    const slug = PAGES.guide.split('/').pop();
    assert.match(fs.readFileSync(path.join(repo, 'dashboard', 'content', 'guides', `${slug}.js`), 'utf8'), new RegExp(`slug: '${slug}'`));
    const dl = fs.readFileSync(path.join(repo, 'dashboard', 'routes', 'downloads.js'), 'utf8');
    assert.match(dl, /latest\.yml/);
});

test('live site: each page and the update feed answer', { skip: process.env.CF_STUDIO_LIVE_URLS !== '1' && 'set CF_STUDIO_LIVE_URLS=1 to check the live site', timeout: 60000 }, async () => {
    const get = async (u) => {
        const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'CertiFried-Studio-tests' } });
        return { status: res.status, location: res.headers.get('location'), text: res.status === 200 ? await res.text() : '' };
    };
    const download = await get(PAGES.download);
    assert.equal(download.status, 200, PAGES.download);
    const guide = await get(PAGES.guide);
    assert.equal(guide.status, 200, PAGES.guide);
    assert.doesNotMatch(guide.text, /Cannot GET/);
    assert.match(guide.text, /CertiFried Studio/);
    const devices = await get(PAGES.devices);
    assert.ok(devices.status === 200 || (devices.status === 302 && /\/auth\/discord/.test(devices.location || '')), `${PAGES.devices}: ${devices.status} ${devices.location}`);
    const feed = await get(`${FEED}latest.yml`);
    assert.equal(feed.status, 200);
    assert.match(feed.text, /^version: \d+\.\d+\.\d+/m);
});
