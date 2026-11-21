import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { overlayDemo } from '../scripts/site-shots/stream-bot-overlays-demo.mjs';
import { OVERLAY_TYPES } from '../core/stream-bot/overlays/config.js';

/*
 * The Overlays tab and the OBS overlay page (dashboard/routes/stream-bot-overlays.js, views/stream-bot/overlays.ejs,
 * overlay-edit.ejs and overlay.ejs, public/js/stream-bot-overlay*.js, public/css/stream-bot-overlay*.css):
 *   render   Dark, Light and Sand with invented Maple Hollow data for the list and every overlay type's settings page; one h1;
 *            the Stream bot tabs with Overlays current; every label points at a control; ids unique
 *   safety   page JSON cannot close its <script>; the scripts never build markup from strings; the overlay page, its script and
 *            its CSS load nothing from another site
 *   routes   API routes need a session, overlay routes are rate limited and need none, literal paths before /:param paths,
 *            /stream/bot/overlay/music/<key> is left to the music routes; server.js mounts the router with a CSRF exemption per
 *            overlay type; the automation editor knows the overlay picker
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
test.before(async () => { D = await overlayDemo({ root }); });

function checkPage(html, label) {
    const h1 = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g) || [];
    assert.equal(h1.length, 1, `${label}: one h1`);
    assert.ok(html.includes('<nav class="sb-tabs" aria-label="Stream bot">'), `${label}: tabs`);
    assert.match(html, /href="\/stream\/bot\/overlays" aria-current="page">Overlays</, `${label}: Overlays is the current tab`);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    assert.deepEqual(dup, [], `${label}: ids are unique`);
    for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${label}: label for="${m[1]}" has a control`);
    assert.ok(html.includes('/css/stream-bot-overlays.css'));
}

test('the Overlays list renders in Dark, Light and Sand: overlays with their state, the kind picker, OBS steps and the media library', () => {
    for (const theme of ['dark', 'light', 'sand']) {
        const html = render(D.list.template, D.list.locals, theme);
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        checkPage(html, `list/${theme}`);
        assert.match(html, />Overlays</);
        for (const t of OVERLAY_TYPES) assert.ok(html.includes(`value="${t.type}"`), `kind ${t.type}`);
        assert.match(html, /Follower goal: 64 of 100/);
        assert.match(html, /Open in OBS now/);
        assert.match(html, /CertiFried Alerts, CertiFried Chat, CertiFried Goal/);
        assert.match(html, /Maple leaf burst/);
        assert.match(html, /Control audio via OBS/);
    }
    const empty = render(D.list.template, { ...D.list.locals, overlays: [], media: [] });
    assert.match(empty, /No overlays yet/);
    const off = render(D.list.template, { ...D.list.locals, ready: false });
    assert.match(off, /Overlays start after the next CertiFried restart/);
});

test('every overlay type has a settings page in every theme; the alert box has all 16 alerts with Test, variations and read aloud', () => {
    for (const t of OVERLAY_TYPES) {
        for (const theme of ['dark', 'light', 'sand']) {
            const e = D.edit(t.type);
            const html = render(e.template, e.locals, theme);
            checkPage(html, `${t.type}/${theme}`);
            assert.match(html, /id="sbo-url"[^>]*value="https:\/\/certifriedmultitool\.com\/stream\/bot\/overlay\//);
            assert.match(html, new RegExp(`browser source <strong>${t.sourceName}</strong>, 1920 × 1080`));
            assert.match(html, /<iframe id="sbo-frame" title="Overlay preview" data-src="[^"]+\?preview=1"/);
        }
    }
    const a = render(D.edit('alerts').template, D.edit('alerts').locals);
    assert.equal((a.match(/data-alert="/g) || []).length, 16);
    assert.equal((a.match(/data-test-alert="/g) || []).length, 32, 'a Test button in the list and in each alert');
    assert.match(a, /data-cfg="alerts\.cheer\.tts"/);
    assert.doesNotMatch(a, /data-cfg="alerts\.follow\.tts"/, 'read aloud only for Bits and tips');
    assert.match(a, /threw \{amount\} Bits!/);
    assert.match(a, /Variation 2/);
    assert.match(a, /<option value="0f1e2d3c4b5a6978" selected>Maple leaf burst \(image\)<\/option>/);
    assert.match(a, /<template id="sbo-media-options">/);
    const g = render(D.edit('goal').template, D.edit('goal').locals);
    assert.match(g, /id="sbo-goal-value"[^>]*value="64"/);
    const c = render(D.edit('counter').template, D.edit('counter').locals);
    assert.match(c, /\{sdb:incr:deaths\}/);
});

test('page JSON and viewer-chosen names cannot break out of their place', () => {
    const e = D.edit('alerts');
    const evil = '</script><img src=x onerror=alert(1)>';
    const cfg = JSON.parse(JSON.stringify(e.locals.config));
    cfg.alerts.follow.message = evil;
    const html = render(e.template, { ...e.locals, overlay: { ...e.locals.overlay, name: evil }, config: cfg, editData: JSON.stringify({ id: 1, type: 'alerts', config: cfg }).replace(/</g, '\\u003c') });
    assert.doesNotMatch(html, /<img src=x onerror/);
    const data = html.match(/<script type="application\/json" id="sbo-edit-data">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(data).config.alerts.follow.message, evil);
    const p = D.page('alerts');
    const page = render(p.template, { ...p.locals, pageData: JSON.stringify({ base: evil }).replace(/</g, '\\u003c') });
    assert.doesNotMatch(page, /<img src=x/);
});

test('the OBS page: transparent, no site chrome, nothing from another site; an invalid link says so', () => {
    for (const t of OVERLAY_TYPES) {
        const p = D.page(t.type);
        const html = render(p.template, p.locals);
        assert.match(html, /<link rel="stylesheet" href="\/css\/stream-bot-overlay\.css(\?v=[0-9a-f]+)?">/);
        assert.match(html, /<script src="\/js\/stream-bot-overlay\.js(\?v=[0-9a-f]+)?" defer>/);
        assert.doesNotMatch(html, /https?:\/\//, `${t.type}: no address outside this site`);
        assert.doesNotMatch(html, /site-header|cf-site/);
        if (t.type === 'nowplaying') assert.match(html, /stream-bot-music-overlay\.css/, 'the music player card is reused');
    }
    const gone = render('stream-bot/overlay', { ok: false, type: 'alerts', pageData: null });
    assert.match(gone, /This overlay link is not valid any more/);
    assert.doesNotMatch(gone, /stream-bot-overlay\.js/);
    const css = read('dashboard/public/css/stream-bot-overlay.css');
    assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/);
    assert.match(css, /background: transparent/);
    const js = read('dashboard/public/js/stream-bot-overlay.js');
    assert.deepEqual([...js.matchAll(/https?:\/\/[^\s'"]+/g)].map((m) => m[0]), ['http://www.w3.org/2000/svg'], 'only the SVG namespace');
});

test('the scripts never build markup from strings', () => {
    for (const f of ['dashboard/public/js/stream-bot-overlay.js', 'dashboard/public/js/stream-bot-overlays.js']) {
        const src = read(f);
        assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write\(/, f);
        assert.match(src, /textContent/);
    }
});

test('routes: sessions on the API, keys on the overlay pages, rate limits, literal paths first, music left alone', () => {
    const src = read('dashboard/routes/stream-bot-overlays.js');
    const routes = [...src.matchAll(/router\.(get|post|put|delete)\('([^']+)',\s*([^\n]*)/g)].map((m) => ({ method: m[1], path: m[2], rest: m[3] }));
    assert.ok(routes.length >= 20, `${routes.length} routes`);
    for (const r of routes) {
        if (r.path.startsWith('/stream/bot/api/')) assert.match(r.rest, /^needApi\b/, `${r.method} ${r.path} needs a session`);
        else if (r.path.startsWith('/stream/bot/overlays')) assert.match(r.rest, /^needPage\b/, `${r.method} ${r.path} needs a session`);
        else {
            assert.match(r.path, /^\/stream\/bot\/overlay\/:type\/:key/);
            assert.match(r.rest, /^skipOther, \w+Limiter\b/, `${r.method} ${r.path}: other types pass on, then a rate limit`);
            assert.doesNotMatch(r.rest, /need(Api|Page)/);
        }
    }
    const order = (a, b) => routes.findIndex((r) => r.path === a) < routes.findIndex((r) => r.path === b);
    assert.ok(order('/stream/bot/api/overlays/choices', '/stream/bot/api/overlays/:id'));
    assert.ok(order('/stream/bot/api/overlays/media', '/stream/bot/api/overlays/:id'));
    assert.ok(order('/stream/bot/api/overlays/media/:fileId', '/stream/bot/api/overlays/:id'));
    assert.match(src, /const skipOther = \(req, res, next\) => \(isOverlayType\(req\.params\.type\) \? next\(\) : next\('route'\)\)/);
    const server = read('dashboard/server.js');
    assert.match(server, /import\('\.\/routes\/stream-bot-overlays\.js'\)/);
    for (const t of OVERLAY_TYPES) assert.ok(server.includes(`'/stream/bot/overlay/${t.type}/',`), `CSRF exemption for ${t.type}`);
    assert.ok(server.includes("'/stream/bot/overlay/music/',"), 'the music one is still there');
    assert.doesNotMatch(server, /'\/stream\/bot\/overlay\/',/, 'no blanket exemption for every overlay path');
    assert.match(read('dashboard/views/stream-bot/_tabs.ejs'), /\['overlays', '\/stream\/bot\/overlays', 'Overlays'\]/);
    const editor = read('dashboard/public/js/stream-bot.js');
    assert.match(editor, /case 'overlay': \{/);
    assert.match(editor, /\/stream\/bot\/api\/overlays\/choices/);
    assert.match(editor, /if \(kind === 'media'\)/);
});

test('core/stream-bot/index.js attaches overlays inside build(), after song requests, and keeps going if they fail', () => {
    const src = read('core/stream-bot/index.js');
    const music = src.indexOf('box.musicRef.current = box.music;');
    const ov = src.indexOf("await import('./overlays/index.js')");
    assert.ok(music > 0 && ov > music, 'after the music block');
    assert.ok(ov < src.indexOf('export function getStreamBot'), 'inside build()');
    assert.match(src, /box\.overlays = await attachOverlays\(box, \{ onRequest \}\);/);
    assert.match(src, /overlays did not load/);
});
