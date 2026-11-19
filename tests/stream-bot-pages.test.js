import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { streamBotPages, STREAM_BOT_IDS } from '../scripts/site-shots/stream-bot-demo.mjs';
import { scopeRows, connectionNotice, managedGuilds, pageJson, catalog } from '../dashboard/services/stream-bot-view.js';
import { STREAM_BOT_SCOPES } from '../core/stream-bot/scopes.js';

/*
 * The stream bot dashboard (/stream/bot: dashboard/routes/stream-bot.js, views/stream-bot/, public/js/stream-bot.js).
 *
 *   render   every page renders through the dashboard's view engine in Dark, Light and Sand with the invented
 *            Maple Hollow data (scripts/site-shots/stream-bot-demo.mjs), with its h1 and the Stream bot tabs
 *   safety   the client script never builds markup from strings; page JSON cannot close its <script>;
 *            the OAuth result codes map to fixed text (a code is never echoed)
 *   routes   literal paths are registered before /:param paths; every page and API route checks the session
 *            (the pairing route is the only one without, and it is rate limited); no profile id from a request
 *   menu     the account menu and the phone menu link to the stream bot
 *   browser  the full theme audit for the eight pages (scripts/theme-audit/run.mjs): no contrast violation,
 *            no box in the other theme family's colours, first frame already in the final theme, no script
 *            error. THEME_RENDER_SKIP=1 skips this part.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const engine = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
const H1 = {
    'stream-bot-overview': 'Stream bot', 'stream-bot-events': 'Events', 'stream-bot-automations': 'Automations',
    'stream-bot-automation-edit': 'Big cheers', 'stream-bot-runs': 'Run history', 'stream-bot-run': 'Run 902: Big cheers',
    'stream-bot-connections': 'Connections', 'stream-bot-devices': 'Devices',
    'stream-bot-automation-edit-flow': 'Scene audio and clips', 'stream-bot-timers': 'Timers',
};
const common = (theme) => ({
    user: demo.user, uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable',
    userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' },
    csrfToken: 'stream-bot-test', clientId: demo.BOT_ID,
});
const render = (template, locals, theme = 'dark') => engine.renderFile(path.join(views, `${template}.ejs`), { ...common(theme), ...locals, settings: {}, _locals: {} });

test('every stream bot page renders in Dark, Light and Sand with its heading and the tabs', async () => {
    const pages = await streamBotPages(demo, { root });
    assert.deepEqual(Object.keys(pages).sort(), [...STREAM_BOT_IDS].sort());
    for (const id of STREAM_BOT_IDS) {
        for (const theme of ['dark', 'light', 'sand']) {
            const html = render(pages[id].template, pages[id].locals, theme);
            assert.match(html, new RegExp(`<html data-theme="${theme}"`), `${id} ${theme}: theme on <html>`);
            const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
            assert.ok(h1, `${id}: has an h1`);
            assert.equal(h1[1].trim(), H1[id], `${id}: h1`);
            assert.equal((html.match(/<h1\b/g) || []).length, 1, `${id}: one h1`);
            assert.ok(html.includes('<nav class="sb-tabs" aria-label="Stream bot">'), `${id}: tab nav`);
            assert.ok(html.includes('href="/stream">Multicast</a>'), `${id}: link to Multicast`);
            assert.match(html, /aria-current="page">[A-Z]/, `${id}: the current tab is marked`);
            assert.ok(html.includes('src="/js/stream-bot.js'), `${id}: page script`);
            assert.ok(html.includes('src="/js/csrf.js'), `${id}: CSRF script`);
            assert.ok(html.includes('data-sb-page="'), `${id}: page key for the script`);
        }
    }
});

test('labels point at real controls on the server-rendered pages, and ids are unique', async () => {
    const pages = await streamBotPages(demo, { root });
    for (const id of STREAM_BOT_IDS) {
        const html = render(pages[id].template, pages[id].locals);
        const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        const ids = new Set(all);
        for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) assert.ok(ids.has(m[1]), `${id}: label for="${m[1]}" has its control`);
        assert.equal(ids.size, all.length, `${id}: ids are unique`);
    }
});

test('page JSON cannot close its <script>, and viewer text is escaped on the pages', async () => {
    const pages = await streamBotPages(demo, { root });
    const edit = pages['stream-bot-automation-edit'];
    const evil = '</script><img src=x onerror=alert(1)>';
    const locals = { ...edit.locals, automation: { ...edit.locals.automation, name: evil },
        editorData: { ...edit.locals.editorData, automation: { ...edit.locals.editorData.automation, name: evil } } };
    const html = render(edit.template, locals);
    assert.equal(html.includes('<img src=x'), false, 'the name never becomes markup');
    const data = html.match(/<script type="application\/json" id="sb-data">([\s\S]*?)<\/script>/);
    assert.ok(data, 'editor data block');
    assert.equal(JSON.parse(data[1]).automation.name, evil, 'the JSON still parses to the same text');
    assert.equal(pageJson('<b>'), '"\\u003cb>"');

    const ov = pages['stream-bot-overview'];
    const html2 = render(ov.template, { ...ov.locals, events: [{ ...ov.locals.events[0], text: '<b>hi</b>' }] });
    assert.ok(html2.includes('&lt;b&gt;hi&lt;/b&gt;') && !html2.includes('<b>hi</b>'), 'event text is escaped');
});

test('the client script builds the DOM with createElement and textContent only', () => {
    const js = read('dashboard/public/js/stream-bot.js');
    const banned = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /\bnew\s+Function\b/];
    for (const re of banned) assert.equal(re.test(js), false, `no ${re}`);
    assert.match(js, /new EventSource\('\/stream\/bot\/api\/feed'\)/, 'live feed over SSE');
    assert.match(js, /JSON\.parse\(n\.textContent\)/, 'page data read as text');
});

test('the OAuth result codes become fixed text; unknown codes show nothing', () => {
    assert.match(connectionNotice({ ok: 'twitch_grant' }).text, /Twitch is connected/);
    assert.equal(connectionNotice({ error: 'twitch_declined' }).tone, 'error');
    assert.equal(connectionNotice({ warn: 'channel_taken' }).tone, 'warn');
    assert.equal(connectionNotice({ ok: '<script>' }), null);
    assert.equal(connectionNotice({ ok: 'constructor' }), null);
    assert.equal(connectionNotice({ ok: ['twitch_grant'] }), null);
    // Every code the two OAuth routes send back to the Connections page has a message.
    const sent = new Set(['ok:linked_twitch', 'ok:linked_kick']);
    for (const m of read('dashboard/routes/auth-twitch-streambot.js').matchAll(/[?&](ok|warn|error)=([a-z_]+)/g)) sent.add(`${m[1]}:${m[2]}`);
    // stream-connect.js: only the redirects to `back`, the Connections page when ?for=bot started the flow.
    for (const m of read('dashboard/routes/stream-connect.js').matchAll(/back \+ '\?(ok|error)=([a-z_]+)'(?!\s*\+)/g)) sent.add(`${m[1]}:${m[2]}`);
    assert.ok(sent.size >= 12, `${sent.size} codes read`);
    for (const k of sent) {
        const [tone, code] = k.split(':');
        assert.ok(connectionNotice({ [tone]: code }), `message for ${k}`);
    }
});

test('the scope table covers every Stream bot scope and marks the Phase 4 ones', () => {
    const rows = scopeRows();
    assert.deepEqual(rows.map((r) => r.scope), [...STREAM_BOT_SCOPES]);
    for (const r of rows) assert.ok(r.enables.length > 3, `${r.scope}: says what it is for`);
    const later = rows.filter((r) => r.later).map((r) => r.scope).sort();
    // The stream actions use the manage scopes now (2026-11-19); only redemption management is still to come.
    assert.deepEqual(later, ['channel:manage:redemptions']);
    assert.equal(rows.find((r) => r.scope === 'user:read:chat').enables, 'Chat messages');
});

test('managed servers: Manage Server or owner only, from the session', () => {
    const user = { guilds: [
        { id: '100000000000000001', name: 'A', permissions: '32' },
        { id: '100000000000000002', name: 'B', permissions: '8' },
        { id: '100000000000000003', name: 'C', permissions: '0', owner: true },
        { id: '100000000000000004', name: 'D', permissions: '2251799813685247' },
        { id: 'x', name: 'bad', permissions: '32' },
        { id: '100000000000000005', name: 'E', permissions: 'junk' },
    ] };
    assert.deepEqual(managedGuilds(user).map((g) => g.name), ['A', 'C', 'D']);
    assert.deepEqual(managedGuilds(null), []);
    assert.deepEqual(catalog().devicesOnline, { studio: false, overlay: false });
});

// ── routes ──────────────────────────────────────────────────────────────────────────────────
const routerSrc = read('dashboard/routes/stream-bot.js');
const routes = [...routerSrc.matchAll(/^router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*([A-Za-z]+)/gm)]
    .map((m) => ({ method: m[1], path: m[2], first: m[3] }));
const toRe = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+')}$`);

test('route order: no /:param route shadows a literal path registered after it', () => {
    assert.ok(routes.length >= 30, `${routes.length} routes read`);
    const problems = [];
    routes.forEach((r, i) => {
        if (!r.path.includes(':')) return;
        const re = toRe(r.path);
        for (const later of routes.slice(i + 1)) {
            if (later.method === r.method && !later.path.includes(':') && re.test(later.path)) problems.push(`${r.method} ${r.path} before ${later.path}`);
        }
    });
    assert.deepEqual(problems, []);
    assert.equal(/router\.use\(/.test(routerSrc), false, 'no router.use (it would run for every request reaching the router)');
});

test('every page and API route checks the session; only pairing and the device sound download are session-less, and rate limited', () => {
    for (const r of routes) {
        assert.ok(r.path.startsWith('/stream/bot'), `${r.path}: under /stream/bot`);
        if (r.path === '/stream/bot/api/pair') {
            assert.equal(r.method, 'post');
            assert.equal(r.first, 'pairLimiter', 'pairing is rate limited per IP');
            continue;
        }
        if (r.path === '/stream/bot/api/device/sounds/:id') {
            // Phase 2: CertiFried Studio downloads library sounds with its device token (tests/stream-bot-studio.test.js).
            assert.equal(r.method, 'get');
            assert.equal(r.first, 'deviceLimiter', 'device downloads are rate limited per IP');
            continue;
        }
        if (r.path.startsWith('/stream/bot/api/')) assert.equal(r.first, 'needApi', `${r.method} ${r.path}: needApi`);
        else assert.equal(r.first, 'needPage', `${r.method} ${r.path}: needPage`);
    }
    assert.match(routerSrc, /function needApi\(req, res, next\) \{\s*if \(signedIn\(req\)\) return next\(\);\s*return res\.status\(401\)\.json/);
    assert.match(routerSrc, /pairFailures\.length >= PAIR_FAIL_MAX/, 'a global cap on failed pairing tries');
    assert.doesNotMatch(routerSrc, /req\.(params|query|body)\??\.profile/i, 'no profile id from a request');
    for (const m of routerSrc.matchAll(/logger\.\w+\(([^;]*)\);/g)) {
        assert.doesNotMatch(m[1], /\b(token|code)\b(?!Hash)\s*[,}]/, `codes and tokens are never logged: ${m[1].slice(0, 80)}`);
    }
    // The pages the guide, the menu and the docs link to.
    for (const p of ['/stream/bot', '/stream/bot/events', '/stream/bot/automations', '/stream/bot/automations/new', '/stream/bot/runs', '/stream/bot/connections', '/stream/bot/devices', '/stream/bot/sounds']) {
        assert.ok(routes.some((r) => r.method === 'get' && r.path === p), `GET ${p}`);
    }
});

test('the account menu and the phone menu link to the stream bot, after Settings', () => {
    const header = read('dashboard/views/partials/site-header.ejs');
    assert.equal((header.match(/<a href="\/settings">Settings<\/a>\r?\n\s*<a href="\/stream\/bot">Stream bot<\/a>/g) || []).length, 2);
});

// ── browser ─────────────────────────────────────────────────────────────────────────────────
test('stream bot pages in Dark, Light and Sand: no contrast violation, no wrong-family box, no flash, no script error', { skip: process.env.THEME_RENDER_SKIP === '1', timeout: 600000 }, async () => {
    const { audit } = await import('../scripts/theme-audit/run.mjs');
    const { report } = await audit({ only: [...STREAM_BOT_IDS], concurrency: 3, sheetIds: [], quiet: true });
    const problems = [];
    for (const id of STREAM_BOT_IDS) {
        const p = report.pages[id];
        if (!p) { problems.push(`${id}: not rendered`); continue; }
        for (const t of report.themes) {
            const e = p[t];
            if (e.failed) problems.push(`${id} ${t}: failed (${e.failed})`);
            for (const n of e.nodes) problems.push(`${id} ${t}: contrast ${n.ratio}:1 (${n.fg} on ${n.bg}, needs ${n.need}) ${n.target}`);
            for (const n of e.islands) problems.push(`${id} ${t}: ${n.bg} box ${n.w}x${n.h} ${n.sel}`);
            for (const err of e.errors) problems.push(`${id} ${t}: script error ${err}`);
            if (e.firstPaint && !e.firstPaint.ok) problems.push(`${id} ${t}: first frame ${JSON.stringify(e.firstPaint.first)} != ${JSON.stringify(e.firstPaint.final)}`);
            if ((e.firstPaint?.final?.theme ?? null) !== t) problems.push(`${id} ${t}: ended as ${e.firstPaint?.final?.theme}`);
        }
    }
    assert.deepEqual(problems, []);
});
