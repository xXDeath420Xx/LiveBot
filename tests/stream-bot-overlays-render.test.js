import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { overlayDemo } from '../scripts/site-shots/stream-bot-overlays-demo.mjs';
import { OVERLAY_TYPES } from '../core/stream-bot/overlays/config.js';

/*
 * Every overlay type rendered in headless Chrome with invented events, through the real page script and a real EventSource:
 * a throwaway server on 127.0.0.1 renders views/stream-bot/overlay.ejs, streams the demo frames over SSE (the frames the service
 * sends: hello, alert, chat, chat_remove, event, goal, counter, nowplaying, action), answers the page's reports, and serves
 * stand-in images and sounds. No console error or page error is allowed. Also: a dropped stream and a 503 reconnect, and the
 * Overlays settings page (preview frame, a variation added, Save collecting every setting). Nothing outside 127.0.0.1 is reached.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const pub = path.join(root, 'dashboard/public');
const engine = createViewEngine({ viewsDir: views, publicDir: pub, cache: false });
const common = { user: demo.user, uiTheme: 'dark', uiStyle: 'cards', uiDensity: 'comfortable', userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme: 'dark', dashboardLayout: 'grid', density: 'comfortable' }, csrfToken: 'stream-bot-test', clientId: demo.BOT_ID };
const render = (template, locals) => engine.renderFile(path.join(views, `${template}.ejs`), { ...common, ...locals, settings: {}, _locals: {} });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WAV = (() => { const n = 800; const b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44); return b; })();
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp' };

let D, server, base, browser, tmp;
const reports = [];
const puts = [];
const conns = { counter: 0 };

test.before(async () => {
    D = await overlayDemo({ root });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-ovr-'));
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const m = url.pathname.match(/^\/stream\/bot\/overlay\/([a-z]+)\/(sbo_[A-Za-z0-9_-]{32})(\/.*)?$/);
        try {
            if (m && !m[3]) {
                const p = D.page(m[1], { preview: url.searchParams.get('preview') === '1' });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(render(p.template, p.locals));
            }
            if (m && m[3] === '/events') {
                const type = m[1];
                if (type === 'counter') {
                    conns.counter++;
                    if (conns.counter === 2) { res.writeHead(503); return res.end(); }   // a restart behind LiteSpeed: EventSource gives up, the page retries
                }
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
                res.write('retry: 500\n\n');
                let frames = D.frames(type);
                if (type === 'counter' && conns.counter === 1) frames = frames.slice(0, 1);
                if (type === 'chat') frames = [...frames, ['chat_remove', { id: 'kk:2' }]];
                frames.forEach(([e, d], i) => setTimeout(() => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`), 60 * (i + 1)));
                if (type === 'counter' && conns.counter === 1) setTimeout(() => res.end(), 300);   // the stream drops
                return undefined;
            }
            if (m && m[3] === '/report' && req.method === 'POST') {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => { reports.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
                return undefined;
            }
            if (m && /^\/(img|media)\//.test(m[3])) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
            if (m && /^\/(sound|tts)\//.test(m[3])) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(WAV); }
            if (url.pathname === '/__demo/alerts') {
                const p = D.page('alerts', { demo: true });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(render(p.template, p.locals));
            }
            if (url.pathname === '/__demo/widgets' || url.pathname === '/__demo/label') {
                const isLabel = url.pathname === '/__demo/label';
                const p = D.page(isLabel ? 'labels' : 'poll', { demo: true });
                const pd = JSON.parse(p.locals.pageData);
                if (isLabel) pd.only = 'latest_tip';
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(render(p.template, { ...p.locals, pageData: JSON.stringify(pd) }));
            }
            if (url.pathname === '/__dash/list') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(render(D.list.template, D.list.locals)); }
            if (url.pathname === '/__dash/edit') {
                const e = D.edit('alerts', { previewSrc: `/stream/bot/overlay/alerts/sbo_${'C'.repeat(32)}?preview=1` });
                res.writeHead(200, { 'content-type': 'text/html' });
                return res.end(render(e.template, e.locals));
            }
            if (url.pathname === '/stream/bot/api/overlays/11' && req.method === 'PUT') {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => { puts.push({ body: JSON.parse(body), csrf: req.headers['x-csrf-token'] }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
                return undefined;
            }
            const file = path.resolve(pub, '.' + decodeURIComponent(url.pathname));
            if (file.startsWith(pub + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
                return fs.createReadStream(file).pipe(res);
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end('{"ok":false}');
        } catch (err) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            return res.end(String(err.stack || err));
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ headless: true, userDataDir: path.join(tmp, 'profile'),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
});
test.after(async () => {
    await browser?.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(url, { width = 1920, height = 1080 } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(base, '')}`); });
    await page.setRequestInterception(true);
    page.on('request', (r) => {
        const u = r.url();
        if (u.startsWith(base) || u.startsWith('data:')) return r.continue();
        // The dashboard pages link the site's web fonts; answer them empty so nothing outside this machine is fetched.
        return r.respond({ status: 200, contentType: /\.css|fonts\.googleapis/.test(u) ? 'text/css' : 'text/plain', body: '' });
    });
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { page, errors };
}
const key = 'sbo_' + 'B'.repeat(32);

for (const t of OVERLAY_TYPES) {
    test(`overlay "${t.type}" renders its demo frames in Chrome with no console errors`, async () => {
        const { page, errors } = await open(`${base}/stream/bot/overlay/${t.type}/${key}`);
        try {
            const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
            assert.equal(bg, 'rgba(0, 0, 0, 0)', 'transparent');
            switch (t.type) {
                case 'alerts': {
                    await page.waitForSelector('.sbo-alert-title', { timeout: 5000 });
                    const r = await page.evaluate(() => ({
                        title: document.querySelector('.sbo-alert-title').textContent, name: document.querySelector('.sbo-alert-title .sbo-name')?.textContent,
                        message: document.querySelector('.sbo-alert-message')?.textContent, img: !!document.querySelector('.sbo-alert-media img'),
                        slot: document.querySelector('.sbo-alert-slot').className, font: getComputedStyle(document.body).getPropertyValue('--sbo-font'),
                    }));
                    assert.equal(r.title, 'MapleFan_88 threw 1,000 Bits!');
                    assert.equal(r.name, 'MapleFan_88', 'the name in the accent colour');
                    assert.equal(r.message, 'Good luck on the boss, you have got this');
                    assert.ok(r.img);
                    assert.match(r.slot, /sbo-alert-slot--center/);
                    assert.match(r.font, /Segoe UI/);
                    break;
                }
                case 'chat': {
                    await page.waitForFunction(() => document.querySelectorAll('.sbo-line').length === 3 && !document.querySelector('[data-id="kk:2"]'), { timeout: 5000 });
                    const r = await page.evaluate(() => ({
                        ids: [...document.querySelectorAll('.sbo-line')].map((l) => l.getAttribute('data-id')),
                        emote: document.querySelector('.sbo-emote')?.getAttribute('src'), badge: !!document.querySelector('.sbo-badge img'), marks: document.querySelectorAll('svg.sbo-badge').length,
                        text: document.querySelector('[data-id="tw:4"]').textContent,
                    }));
                    assert.deepEqual(r.ids, ['tw:1', 'tw:3', 'tw:4'], 'the deleted Kick line is gone');
                    assert.match(r.emote, /\/img\/tw-emote\/25$/);
                    assert.ok(r.badge && r.marks >= 3, 'badges and Twitch/Kick marks');
                    assert.match(r.text, /Juniper:first time here/);
                    break;
                }
                case 'events': {
                    await page.waitForFunction(() => document.querySelectorAll('.sbo-event').length === 4, { timeout: 5000 });
                    const first = await page.evaluate(() => document.querySelector('.sbo-event-text').textContent);
                    assert.equal(first, 'BrambleByte_Live raided with 42 viewers', 'newest on top');
                    break;
                }
                case 'goal': {
                    await page.waitForFunction(() => document.querySelector('.sbo-goal-nums')?.textContent === '65 / 100', { timeout: 5000 });
                    assert.equal(await page.evaluate(() => document.querySelector('.sbo-goal-fill').style.width), '65%');
                    break;
                }
                case 'counter': {
                    // First stream drops after hello, the reconnect gets a 503 (EventSource stops), the page opens a new one.
                    await page.waitForFunction(() => document.querySelector('.sbo-counter-value')?.textContent === '13', { timeout: 15000 });
                    assert.equal(await page.evaluate(() => document.querySelector('.sbo-counter-label').textContent), 'Deaths');
                    assert.ok(conns.counter >= 3, `reconnected (${conns.counter} connections)`);
                    break;
                }
                case 'nowplaying': {
                    await page.waitForFunction(() => document.querySelector('.sbmo-card') && !document.querySelector('.sbmo-card').hidden, { timeout: 5000 });
                    const r = await page.evaluate(() => ({ title: document.querySelector('.sbmo-title').textContent, by: document.querySelector('.sbmo-by').textContent, pos: getComputedStyle(document.querySelector('.sbmo-card')).position }));
                    assert.deepEqual(r, { title: 'Golden Hour', by: 'Requested by Juniper', pos: 'static' }, 'the music player card, placed by the widget');
                    const look = await page.evaluate(() => ({ cover: document.querySelector('.sbmo-card').classList.contains('sbo-np--cover'), times: [...document.querySelectorAll('.sbo-np-time')].map((n) => n.textContent),
                        width: document.querySelector('.sbmo-card').parentElement.style.width, size: getComputedStyle(document.querySelector('.sbmo-title')).fontSize }));
                    assert.equal(look.cover, true);
                    assert.equal(look.times.length, 2);
                    assert.equal(look.times[1], '3:20', 'the length beside the bar');
                    assert.deepEqual([look.width, look.size], ['450px', '19px']);
                    break;
                }
                case 'canvas': {
                    await page.waitForSelector('.sbo-show-text', { timeout: 5000 });
                    await page.waitForSelector('img.sbo-show-media', { timeout: 5000 });
                    assert.equal(await page.evaluate(() => document.querySelector('.sbo-show-text').textContent), 'Deaths: 13');
                    assert.equal(await page.evaluate(() => document.querySelector('.sbo-show-text').parentElement.className), 'sbo-at sbo-at--top-right');
                    await page.waitForFunction(() => true);
                    await new Promise((r) => setTimeout(r, 300));
                    const acked = reports.map((x) => x.dispatchId);
                    assert.ok(acked.includes('d_000000000000000000000000') && acked.includes('d_111111111111111111111111'), 'both actions acknowledged');
                    break;
                }
                case 'scene': {
                    await page.waitForSelector('.sbs-title', { timeout: 5000 });
                    await page.waitForFunction(() => document.querySelector('.sbs-bg')?.complete, { timeout: 5000 });
                    const r = await page.evaluate(() => ({
                        title: document.querySelector('.sbs-title').textContent, shimmer: document.querySelector('.sbs-title').classList.contains('sbs-title--shimmer'),
                        sub: document.querySelector('.sbs-marquee .sbs-sub')?.textContent, count: document.querySelector('.sbs-count')?.textContent,
                        socials: document.querySelector('.sbs-socials')?.textContent, fx: document.querySelectorAll('canvas.sbs-fx').length,
                        glow: document.querySelectorAll('.sbs-glow--lantern').length, bg: document.querySelector('.sbs-bg').getAttribute('src'),
                        grain: /^url\("data:image\/png/.test(document.querySelector('.sbs-grain')?.style.backgroundImage || ''),
                    }));
                    assert.equal(r.title, 'Starting soon');
                    assert.ok(r.shimmer);
                    assert.equal(r.sub, 'Grab a drink, the stream starts shortly');
                    assert.match(r.count, /^Starting in [45]:\d\d$/, 'the countdown runs from when the scene opens');
                    assert.equal(r.socials, 'twitch.tv/maplehollow · kick.com/maplehollow');
                    assert.equal(r.fx, 2, 'embers and rain');
                    assert.equal(r.glow, 1);
                    assert.match(r.bg, /\/media\/0f1e2d3c4b5a6978$/, 'the artwork comes from this server');
                    assert.ok(r.grain, 'grain is drawn locally, not fetched');
                    break;
                }
                case 'train': {
                    await page.waitForFunction(() => document.querySelector('.sbo-train--sub') && !document.querySelector('.sbo-train--sub').hidden, { timeout: 5000 });
                    const r = await page.evaluate(() => ({
                        level: document.querySelector('.sbo-train--hype .sbo-train-count').textContent, hypeFill: document.querySelector('.sbo-train--hype .sbo-goal-fill').style.width,
                        subs: document.querySelector('.sbo-train--sub .sbo-train-count').textContent, last: document.querySelector('.sbo-train--sub .sbo-train-foot').textContent,
                        left: document.querySelector('.sbo-train--hype .sbo-train-left').textContent,
                    }));
                    assert.deepEqual([r.level, r.hypeFill, r.subs, r.last], ['Level 2', '65%', '3 subs', 'Last: MapleFan_88']);
                    assert.match(r.left, /^[34]:\d\d$/, 'the hype train counts down');
                    break;
                }
                case 'tipjar': {
                    await page.waitForFunction(() => document.querySelector('.sbo-jar-total')?.textContent === '$45 of $100', { timeout: 5000 });
                    const r = await page.evaluate(() => ({ h: document.querySelector('.sbo-jar-fill').getAttribute('height'), coin: !!document.querySelector('.sbo-coin'), tag: document.querySelector('.sbo-coin-tag')?.textContent }));
                    assert.equal(Number(r.h).toFixed(1), '42.3', '45% of the jar');
                    assert.ok(r.coin);
                    assert.equal(r.tag, 'Hazel $5');
                    break;
                }
                case 'credits': {
                    await page.waitForSelector('.sbo-credits-title', { timeout: 5000 });
                    const r = await page.evaluate(() => { const s = document.querySelector('.sbo-credits-roll').style; return { heads: [...document.querySelectorAll('.sbo-credits-head')].map((n) => n.textContent),
                        anim: [s.animationName, s.animationDuration, s.animationIterationCount].join(' '), note: document.querySelector('.sbo-credits-note')?.textContent }; });
                    assert.deepEqual(r.heads, ['New followers', 'Gifted subs', 'Raiders', 'Moderators']);
                    assert.equal(r.anim, 'sbo-roll 45s 1', 'rolls once over the set time');
                    assert.equal(r.note, '5 gifts');
                    break;
                }
                case 'emotewall': {
                    await page.waitForFunction(() => document.querySelectorAll('.sbo-wall-emote').length === 3, { timeout: 5000 });
                    const srcs = await page.evaluate(() => [...document.querySelectorAll('.sbo-wall-emote')].map((n) => n.getAttribute('src')));
                    assert.ok(srcs.every((s) => /^\/stream\/bot\/overlay\/emotewall\/sbo_B+\/img\/(tw|7tv|bttv)-emote\//.test(s)), 'emotes come from this server');
                    break;
                }
                case 'poll': {
                    await page.waitForFunction(() => document.querySelector('.sbo-poll') && !document.querySelector('.sbo-poll').hidden, { timeout: 5000 });
                    const r = await page.evaluate(() => ({ title: document.querySelector('.sbo-poll-title').textContent, nums: [...document.querySelectorAll('.sbo-poll-num')].map((n) => n.textContent),
                        opt: document.querySelector('.sbo-poll-opt').textContent, foot: document.querySelector('.sbo-poll-foot').textContent }));
                    assert.deepEqual(r, { title: 'Which boss next?', nums: ['75%', '25%'], opt: '1. The Lantern Witch', foot: 'Type !vote and a number in chat' });
                    break;
                }
                case 'labels': {
                    await page.waitForFunction(() => document.querySelectorAll('.sbo-label').length === 4 && /1,000 Bits/.test(document.querySelector('.sbo-labels').textContent), { timeout: 5000 });
                    const r = await page.evaluate(() => [...document.querySelectorAll('.sbo-label')].map((n) => n.textContent));
                    assert.deepEqual(r, ['Latest followerWren', 'Latest subMapleFan_88', 'Latest tipHazel5.00 USD', 'Top cheerMapleFan_881,000 Bits']);
                    break;
                }
                case 'viewers': {
                    await page.waitForFunction(() => document.querySelector('.sbo-viewers-num')?.textContent === '99', { timeout: 5000 });
                    const r = await page.evaluate(() => ({ nums: [...document.querySelectorAll('.sbo-viewers-num')].map((n) => n.textContent), marks: document.querySelectorAll('.sbo-viewers svg.sbo-badge').length }));
                    assert.deepEqual(r, { nums: ['99', '32'], marks: 2 }, 'each platform with its sign');
                    break;
                }
                case 'heartrate': {
                    // Studio 0.2.14: the number, a heart beating once per beat (60 / 124 s), the graph and this stream's figures
                    await page.waitForFunction(() => document.querySelector('.sbo-heart-num')?.textContent === '124', { timeout: 5000 });
                    const r = await page.evaluate(() => {
                        const icon = document.querySelector('.sbo-heart-icon');
                        return { beating: icon.classList.contains('is-beating'), dur: icon.style.animationDuration, anim: getComputedStyle(icon).animationName,
                            points: (document.querySelector('.sbo-heart-graph polyline').getAttribute('points') || '').split(' ').length,
                            stats: [...document.querySelectorAll('.sbo-heart-stat-num')].map((n) => n.textContent), hidden: document.querySelector('.sbo-heart').hidden,
                            color: document.querySelector('.sbo-heart-num').style.color, unit: document.querySelector('.sbo-heart-unit').textContent };
                    });
                    assert.deepEqual(r, { beating: true, dur: '0.484s', anim: 'sbo-beat', points: 60, stats: ['84', '104', '131'], hidden: false, color: 'rgb(242, 201, 76)', unit: 'BPM' },
                        'beat synced to BPM, amber zone from 120, a 60-second graph, low / avg / high');
                    break;
                }
                default: break;
            }
            await new Promise((r) => setTimeout(r, 400));
            // The counter's deliberate 503 makes Chrome log that the event stream was refused; that one is expected.
            const real = t.type === 'counter' ? errors.filter((e) => !/EventSource|503/.test(e)) : errors;
            assert.deepEqual(real, [], `${t.type}: console errors`);
        } finally {
            await page.close();
        }
    });
}

test('widgets: a Twitch part without its scope says "Reconnect Twitch to enable"; a single label from ?label=', async () => {
    const { page, errors } = await open(`${base}/__demo/widgets`, { width: 800, height: 600 });
    try {
        await page.waitForFunction(() => typeof window.__sboFeed === 'function', { timeout: 5000 });
        const [hello] = D.frames('poll');
        await page.evaluate((h) => { window.__sboFeed('hello', { ...h, state: { twitch: null, prediction: null, chat: null, blocked: 'Reconnect Twitch to enable' } }); }, hello[1]);
        await page.waitForSelector('.sbo-blocked', { timeout: 3000 });
        assert.equal(await page.evaluate(() => document.querySelector('.sbo-blocked').textContent), 'Reconnect Twitch to enable');
        assert.equal(await page.evaluate(() => document.querySelector('.sbo-poll').hidden), true, 'in place of the widget');
        await page.evaluate(() => window.__sboFeed('poll', { chat: { kind: 'chat', id: 'x', title: 'Q', options: [{ title: 'A', votes: 1 }, { title: 'B', votes: 0 }], endsAt: new Date(Date.now() + 30000).toISOString(), status: 'active', winner: null } }));
        await page.waitForFunction(() => document.querySelector('.sbo-blocked').hidden && !document.querySelector('.sbo-poll').hidden, { timeout: 3000 });
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
    const one = await open(`${base}/__demo/label`, { width: 800, height: 600 });
    try {
        await one.page.waitForFunction(() => typeof window.__sboFeed === 'function', { timeout: 5000 });
        const [hello] = D.frames('labels');
        await one.page.evaluate((h) => window.__sboFeed('hello', h), hello[1]);
        await one.page.waitForSelector('.sbo-label', { timeout: 3000 });
        assert.deepEqual(await one.page.evaluate(() => [...document.querySelectorAll('.sbo-label')].map((n) => n.textContent)), ['Latest tipHazel5.00 USD']);
        assert.deepEqual(one.errors, []);
    } finally { await one.page.close(); }
});

test('alert box: text over the image, the image at a share of its size, and the text waiting for the image', async () => {
    const { page, errors } = await open(`${base}/__demo/alerts`, { width: 800, height: 600 });
    try {
        await page.waitForFunction(() => typeof window.__sboFeed === 'function', { timeout: 5000 });
        const [hello] = D.frames('alerts');
        await page.evaluate((h) => {
            window.__sboFeed('hello', h);
            window.__sboFeed('alert', { id: 'over1', key: 'follow', label: 'Follow (Twitch)', layout: 'over', animation: 'fade', durationMs: 8000, title: 'MapleFan_88', name: 'MapleFan_88',
                detail: '', message: '', media: { kind: 'image', src: 'media/0f1e2d3c4b5a6978' }, sound: null, tts: null, mediaScale: 200, textDelayMs: 400, variation: null });
        }, hello[1]);
        await page.waitForSelector('.sbo-alert--over .sbo-alert-media > .sbo-alert-text', { timeout: 5000 });
        assert.equal(await page.evaluate(() => document.querySelector('.sbo-alert-text').classList.contains('sbo-text-wait')), true, 'the text waits');
        await page.waitForFunction(() => !document.querySelector('.sbo-alert-text').classList.contains('sbo-text-wait'), { timeout: 3000 });
        await page.waitForFunction(() => document.querySelector('.sbo-alert-media img').style.width === '2px', { timeout: 3000 });
        const pos = await page.evaluate(() => getComputedStyle(document.querySelector('.sbo-alert-text')).position);
        assert.equal(pos, 'absolute', 'the text sits on the picture');
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('the settings page in Chrome: the preview frame scales the real overlay, a variation can be added, Save sends every setting', async () => {
    const list = await open(`${base}/__dash/list`, { width: 1280, height: 900 });
    try {
        await list.page.waitForSelector('#sbo-add-form');
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(list.errors, [], 'list page: console errors');
    } finally { await list.page.close(); }

    const { page, errors } = await open(`${base}/__dash/edit`, { width: 1280, height: 900 });
    try {
        await page.waitForSelector('#sbo-frame');
        await page.waitForFunction(() => /scale\(0\.\d+\)/.test(document.getElementById('sbo-frame').style.transform), { timeout: 5000 });
        await page.waitForFunction(() => document.getElementById('sbo-frame').contentDocument?.querySelector('.sbo-alert-title'), { timeout: 8000 });
        await page.evaluate(() => { document.querySelector('[data-variations="cheer"]').closest('details').open = true; });
        await page.click('[data-add-variation="cheer"]');
        await page.type('[data-variations="cheer"] .sbo-var:last-child input[data-var="min"]', '25000');
        await page.type('[data-variations="cheer"] .sbo-var:last-child input[data-var="message"]', 'Enormous');
        await page.evaluate(() => { document.getElementById('sbo-size').value = '52'; document.getElementById('sbo-giftees').checked = true; });
        await page.click('#sbo-form button[type="submit"]');
        await page.waitForFunction(() => /Saved/.test(document.getElementById('sbo-save-status').textContent), { timeout: 5000 });
        const body = puts.at(-1).body;
        assert.equal(puts.at(-1).csrf, 'stream-bot-test', 'the CSRF token goes with the save');
        assert.equal(body.name, 'Alerts');
        assert.equal(body.config.general.fontSize, 52);
        assert.equal(body.config.general.showGiftedSubs, true);
        assert.deepEqual(body.config.alerts.cheer.variations.map((v) => v.min), [1000, 10000, 25000]);
        assert.equal(body.config.alerts.cheer.variations[2].message, 'Enormous');
        assert.equal(body.config.alerts.cheer.tts, true);
        assert.equal(Object.keys(body.config.alerts).length, 22, "every alert, the YouTube ones too (kept while the editor hides them)");
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(errors, [], 'settings page: console errors');
    } finally { await page.close(); }
});
