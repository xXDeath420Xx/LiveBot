import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { importPage, IMPORT_PAGE_ID } from '../scripts/site-shots/stream-bot-import-demo.mjs';
import { pageJson } from '../core/stream-bot/import/report.js';

/*
 * The stream bot Import page (/stream/bot/import: dashboard/routes/stream-bot-import.js, views/stream-bot/import.ejs,
 * public/js/stream-bot-import.js).
 *
 *   render   renders in Dark, Light and Sand with its h1, the Stream bot tabs (Import marked), the page scripts, the
 *            upload controls and labelled controls with unique ids; page JSON cannot close its <script>
 *   safety   the client script never builds markup from strings
 *   routes   every route is under /stream/bot, checks the session first, literal paths before /:param paths, no
 *            profile id from a request, the upload is size-limited and rate-limited; the router is mounted and the
 *            tab is in the stream bot nav
 *   browser  the theme audit for this page (scripts/theme-audit/run.mjs). THEME_RENDER_SKIP=1 skips it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const engine = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
const common = (theme) => ({
    user: demo.user, uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable',
    userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' },
    csrfToken: 'stream-bot-test', clientId: demo.BOT_ID,
});
const render = (template, locals, theme = 'dark') => engine.renderFile(path.join(views, `${template}.ejs`), { ...common(theme), ...locals, settings: {}, _locals: {} });

test('the Import page renders in Dark, Light and Sand with its heading, tabs, scripts and controls', async () => {
    const page = await importPage(demo, { root });
    for (const theme of ['dark', 'light', 'sand']) {
        const html = render(page.template, page.locals, theme);
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
        assert.equal(h1[1].trim(), 'Import');
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
        assert.ok(html.includes('<nav class="sb-tabs" aria-label="Stream bot">'));
        assert.match(html, /<a href="\/stream\/bot\/import" aria-current="page">Import<\/a>/, 'the Import tab is current');
        assert.ok(html.includes('src="/js/stream-bot-import.js'), 'page script (the view engine adds a ?v= cache-buster)');
        assert.ok(html.includes('src="/js/csrf.js'));
        assert.ok(html.includes('data-sb-page="import"'));
        assert.ok(html.includes('id="sbi-file"') && html.includes('id="sbi-text"'), 'file and paste controls');
        assert.match(html, /profiles\\Main/, 'says where the Firebot profile is');
        assert.match(html, /data<\/code> folder/, 'says which Streamer.bot folder to zip');
        assert.ok(html.includes('data-recreate="21"'), 'a channel point reward can be recreated');
        assert.equal(html.includes('data-recreate="22"'), false, 'a power-up cannot');
        assert.ok(html.includes('data-apply-words="31"') && html.includes('data-channel-bot="1"'), 'saved banned words can be applied to the Kick channel');
        assert.match(html, /Saved banned words/);
        const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(new Set(all).size, all.length, 'ids are unique');
        for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) assert.ok(all.includes(m[1]), `label for="${m[1]}" has its control`);
    }
});

test('page JSON cannot close its <script>; viewer text is escaped', async () => {
    const page = await importPage(demo, { root });
    const evil = '</script><img src=x onerror=alert(1)>';
    const locals = { ...page.locals, importData: pageJson({ preview: { report: { groups: { as_is: [{ name: evil }] } } } }),
        rewards: [{ ...page.locals.rewards[0], title: evil, prompt: evil }] };
    const html = render(page.template, locals);
    assert.equal(html.includes('<img src=x'), false);
    const data = html.match(/<script type="application\/json" id="sbi-data">([\s\S]*?)<\/script>/);
    assert.equal(JSON.parse(data[1]).preview.report.groups.as_is[0].name, evil);
});

test('the client script builds the DOM with createElement and textContent only', () => {
    const js = read('dashboard/public/js/stream-bot-import.js');
    for (const re of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /\bnew\s+Function\b/]) assert.equal(re.test(js), false, `no ${re}`);
    assert.match(js, /JSON\.parse\(n\.textContent\)/);
    assert.match(js, /window\.confirm\(/, 'recreating a reward asks first');
    assert.equal((js.match(/window\.confirm\(/g) || []).length >= 2, true, 'applying banned words asks first too');
});

const routerSrc = read('dashboard/routes/stream-bot-import.js');
const routes = [...routerSrc.matchAll(/^router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*([A-Za-z]+)/gm)].map((m) => ({ method: m[1], path: m[2], first: m[3] }));
const toRe = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+')}$`);

test('routes: under /stream/bot, session first, literal before param, no profile id from the request, limits', () => {
    assert.ok(routes.length >= 7, `${routes.length} routes`);
    for (const r of routes) {
        assert.ok(r.path.startsWith('/stream/bot'), r.path);
        assert.equal(r.first, r.path.startsWith('/stream/bot/api/') ? 'needApi' : 'needPage', `${r.method} ${r.path}`);
    }
    const problems = [];
    routes.forEach((r, i) => {
        if (!r.path.includes(':')) return;
        for (const later of routes.slice(i + 1)) if (later.method === r.method && !later.path.includes(':') && toRe(r.path).test(later.path)) problems.push(`${r.path} before ${later.path}`);
    });
    assert.deepEqual(problems, []);
    assert.equal(/router\.use\(/.test(routerSrc), false);
    assert.doesNotMatch(routerSrc, /req\.(params|query|body)\??\.profile/i);
    assert.match(routerSrc, /needApi, uploadLimiter,/, 'uploads are rate limited');
    assert.match(routerSrc, /express\.raw\(\{ type: \(\) => true, limit: UPLOAD_MAX_BYTES \+ 1024 \}\)/, 'uploads are size limited');
    // the existing stream bot routes do not shadow these
    const main = read('dashboard/routes/stream-bot.js');
    for (const m of main.matchAll(/^router\.(get|post|put|delete)\(\s*'([^']+)'/gm)) {
        if (!m[2].includes(':')) continue;
        for (const r of routes) assert.equal(m[1] === r.method && toRe(m[2]).test(r.path), false, `${m[2]} would catch ${r.path}`);
    }
});

test('the router is mounted and the Import tab is in the stream bot nav', () => {
    assert.match(read('dashboard/server.js'), /import\('\.\/routes\/stream-bot-import\.js'\)/);
    assert.match(read('dashboard/views/stream-bot/_tabs.ejs'), /\['import', '\/stream\/bot\/import', 'Import'\]/);
});

test('Import page in Dark, Light and Sand: no contrast violation, no wrong-family box, no flash, no script error', { skip: process.env.THEME_RENDER_SKIP === '1', timeout: 600000 }, async () => {
    const { audit } = await import('../scripts/theme-audit/run.mjs');
    const { report } = await audit({ only: [IMPORT_PAGE_ID], concurrency: 1, sheetIds: [], quiet: true });
    const problems = [];
    const p = report.pages[IMPORT_PAGE_ID];
    assert.ok(p, 'the page is in the theme audit (scripts/theme-audit/pages.mjs)');
    for (const t of report.themes) {
        const e = p[t];
        if (e.failed) problems.push(`${t}: failed (${e.failed})`);
        for (const n of e.nodes) problems.push(`${t}: contrast ${n.ratio}:1 (${n.fg} on ${n.bg}, needs ${n.need}) ${n.target}`);
        for (const n of e.islands) problems.push(`${t}: ${n.bg} box ${n.w}x${n.h} ${n.sel}`);
        for (const err of e.errors) problems.push(`${t}: script error ${err}`);
        if (e.firstPaint && !e.firstPaint.ok) problems.push(`${t}: first frame differs`);
    }
    assert.deepEqual(problems, []);
});
