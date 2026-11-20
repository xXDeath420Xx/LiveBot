import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { viewersDemo } from '../scripts/site-shots/stream-bot-viewers-demo.mjs';
import { listQuery, listHref, csvCell, csvLine, CSV_HEADER, actorLabel } from '../dashboard/services/stream-bot-viewers-view.js';
import { withDefaults } from '../core/stream-bot/viewers/settings.js';

/*
 * The Viewers tab (dashboard/routes/stream-bot-viewers.js, views/stream-bot/viewers.ejs, viewer.ejs, viewers-settings.ejs,
 * public/js/stream-bot-viewers.js):
 *   render   Dark, Light and Sand with invented Maple Hollow data: the table, one viewer, the settings; one h1; the Stream bot
 *            tabs with Viewers current; every label points at a control; ids unique; empty and not-migrated states
 *   safety   page JSON cannot close its <script>; the script never builds markup from strings; CSV cells cannot start a formula
 *   routes   pages and API need a session, literal paths before /:id, server.js mounts the router, the tab is listed
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
const render = (template, locals, theme = 'dark') => engine.renderFile(path.join(views, `${template}.ejs`), { ...common(theme), ...locals, settings: locals.settings ?? {}, _locals: {} });
let D;
test.before(async () => { D = await viewersDemo({ root }); });

function checkPage(html, label) {
    const h1 = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g) || [];
    assert.equal(h1.length, 1, `${label}: one h1`);
    assert.ok(html.includes('<nav class="sb-tabs" aria-label="Stream bot">'), `${label}: tabs`);
    assert.match(html, /href="\/stream\/bot\/viewers" aria-current="page">Viewers</, `${label}: Viewers is the current tab`);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    assert.deepEqual(dup, [], `${label}: ids are unique`);
    for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${label}: label for="${m[1]}" has a control`);
}

test('the Viewers table renders in Dark, Light and Sand: KPIs, the last count, filters, sortable headers, rows and paging', () => {
    for (const theme of ['dark', 'light', 'sand']) {
        const html = render(D.list.template, D.list.locals, theme);
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        checkPage(html, `list/${theme}`);
        assert.match(html, /Viewers recorded<\/dt><dd class="cf-kpi-value">1,223</);
        assert.match(html, /Twitch \(maplehollow_tv\), Live: 214 counted \(everyone in chat\)/);
        assert.match(html, /aria-sort="descending"><a href="[^"]*">Leaves</);
        assert.match(html, /<a href="\/stream\/bot\/viewers\/40">MapleFan_88<\/a>/);
        assert.match(html, /Old growth/);
        assert.match(html, /href="\/stream\/bot\/viewers\?page=2">Next</);
        assert.match(html, /href="\/stream\/bot\/viewers\/export\.csv" download>Export CSV</);
    }
    const empty = render(D.empty.template, D.empty.locals);
    assert.match(empty, /No viewers yet\./);
    assert.match(empty, /Re-approve on Connections/);
    const off = render(D.notReady.template, D.notReady.locals);
    assert.match(off, /Viewer records start after the next CertiFried update/);
    const tracking = render(D.list.template, { ...D.list.locals, settings: withDefaults({ tracking: false }) });
    assert.match(tracking, /Tracking is off/);
});

test('one viewer and the settings render in every theme', () => {
    for (const theme of ['dark', 'light', 'sand']) {
        const v = render(D.viewer.template, D.viewer.locals, theme);
        checkPage(v, `viewer/${theme}`);
        assert.match(v, /<h1 class="cf-page-title">MapleFan_88<\/h1>/);
        assert.match(v, /Twitch \(maplefan_88\)|Twitch and Kick/);
        assert.match(v, /id="sbv-points">18,420</);
        assert.match(v, /Gift bonus \(3 subs\)/);
        assert.match(v, /maplefan_88 in chat/);
        assert.match(v, /15 subs in 3 gifts/);
        assert.match(v, /Unlink the accounts/);
        assert.match(v, /Firebot, Streamer\.bot/);
        const s = render(D.settings.template, D.settings.locals, theme);
        checkPage(s, `settings/${theme}`);
        assert.match(s, /id="sbv-currency"[^>]*value="Leaves"/);
        assert.equal((s.match(/data-rank-name/g) || []).length, 4);
        assert.match(s, /id="sbv-rank-min-1"[^>]*value="10"/, 'watch-time ranks shown in hours');
        assert.match(s, /<option value="10" selected>every 10 minutes</);
        assert.match(s, /<code>!points, !leaves<\/code>/);
        assert.doesNotMatch(s, /id="sbv-gamble"[^>]*checked/, 'gambling stays off');
    }
});

test('safety: page JSON cannot close its script; the script builds no markup from strings; CSV cells are safe', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const v = render(D.viewer.template, { ...D.viewer.locals, viewer: { ...D.viewer.locals.viewer, name: evil } });
    assert.ok(!v.includes(evil), 'escaped in the page and in the JSON');
    const js = read('dashboard/public/js/stream-bot-viewers.js');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('@sum'), "'@sum");
    assert.equal(csvCell('plain'), 'plain');
    const line = csvLine({ platform: 'twitch', platformUserId: '1', login: 'a', name: '-1+1', points: 5, watchMinutes: 10, messages: 2, tipAmounts: { USD: 5 }, personId: null }, withDefaults({}));
    assert.equal(line.split(',')[3], "'-1+1");
    assert.equal(CSV_HEADER.length, 22);
    assert.equal(actorLabel('dashboard:123'), 'You, on the dashboard');
});

test('query helpers: filters are cleaned and links keep them', () => {
    const f = listQuery({ q: '  @maple ', platform: 'trovo', seen: '30', sort: 'name', page: '0' });
    assert.deepEqual(f, { q: '@maple', platform: '', seen: 30, sort: 'name', dir: 'asc', page: 1 });
    assert.equal(listQuery({ platform: 'youtube' }).platform, 'youtube', 'YouTube viewers since H-741');
    assert.equal(listHref(f, { page: 3 }), '/stream/bot/viewers?q=%40maple&seen=30&sort=name&page=3');
    assert.equal(listHref(listQuery({})), '/stream/bot/viewers');
});

test('routes: sessions, literal paths before /:id, the mount and the tab', () => {
    const src = read('dashboard/routes/stream-bot-viewers.js');
    const routes = [...src.matchAll(/router\.(get|post|put|delete)\('([^']+)', (need\w+)/g)].map((m) => ({ method: m[1], path: m[2], guard: m[3] }));
    assert.ok(routes.length >= 11, `${routes.length} routes`);
    for (const r of routes) assert.equal(r.guard, r.path.startsWith('/stream/bot/api/') ? 'needApi' : 'needPage', `${r.method} ${r.path}`);
    const order = routes.filter((r) => r.method === 'get').map((r) => r.path);
    assert.ok(order.indexOf('/stream/bot/viewers/export.csv') < order.indexOf('/stream/bot/viewers/:id'));
    assert.ok(order.indexOf('/stream/bot/viewers/settings') < order.indexOf('/stream/bot/viewers/:id'));
    assert.match(read('dashboard/server.js'), /import\('\.\/routes\/stream-bot-viewers\.js'\)/);
    assert.match(read('dashboard/views/stream-bot/_tabs.ejs'), /\['viewers', '\/stream\/bot\/viewers', 'Viewers'\]/);
    assert.match(read('dashboard/public/js/stream-bot.js'), /Registered conditions/, 'the automation editor draws registered condition fields');
});
