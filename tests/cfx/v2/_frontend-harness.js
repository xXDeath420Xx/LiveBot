// Greenhouse Tycoon (phase 3) browser-test harness: one throwaway server on 127.0.0.1:<free port> that is
// the whole site as the browser sees it:
//   /gh-api/*                    the real v2 app (services/cfx/http/app.js) on isolated ghtest_ tables, with
//                                the dev sign-in on, a fake game clock and a TEST Twitch extension secret
//   /gh-api/ws                   the real WebSocket hint hub
//   /greenhouse, /greenhouse/*   the real dashboard router (dashboard/routes/greenhouse.js) serving a fresh
//                                web build; req.user is whatever the test sets (the Discord login)
//   /panel/*                     a fresh panel build (what goes into the zip)
// and a headless Chrome (puppeteer, already in the repo) with the Twitch helper replaced by a stub that hands
// out extension JWTs signed with the test secret. Everything is closed by its own handle (server.close,
// browser.close, then the browser PID if it is still alive); the ghtest_ tables are dropped.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { setupTestDb, quietLogger } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createApp } from '../../../services/cfx/http/app.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { createHints } from '../../../services/cfx/realtime/hints.js';
import { createWsHub } from '../../../services/cfx/realtime/ws.js';
import { allowedOrigins } from '../../../services/cfx/http/security.js';
import { xpForLevel } from '../../../services/cfx/domain/economy.js';
import greenhouseRouter from '../../../dashboard/routes/greenhouse.js';
import { buildWeb, buildPanel, HELPER_URL } from '../../../frontend/greenhouse/build.mjs';

export const EXT_CLIENT_ID = 'ghtestclient';

export async function startHarness({ rateLimits = false } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh3-build-'));
    const web = await buildWeb({ outDir: path.join(tmp, 'web') });
    const panel = await buildPanel({ outDir: path.join(tmp, 'panel'), zipPath: path.join(tmp, 'panel.zip') });

    const clock = { offset: 0, now: () => Date.now() + clock.offset };
    const hints = createHints();
    const ctx = await setupTestDb({ now: () => clock.now(), onLedgerCommit: (accountId, r) => hints.publish(accountId, r.stateVersion) });
    const store = ctx.store;
    const extSecret = crypto.randomBytes(32);
    const dashSecret = crypto.randomBytes(32).toString('hex');
    process.env.CFX2_DASHBOARD_SECRET = dashSecret; // read by the dashboard route; this test process only
    const auth = createAuth({ secret: crypto.randomBytes(32).toString('hex'), store });
    const game = createGame({ store, onChange: (a, v) => hints.publish(a, v) });

    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = {
        publicUrl: origin, publicOrigin: origin, publicPrefix: '/gh-api', gamePath: '/greenhouse', allowDevPlatform: true,
        twitchExt: { clientId: EXT_CLIENT_ID, secret: extSecret }, twitchOAuth: {}, kickOAuth: {}, dashboardSecret: dashSecret
    };
    const errorsLogged = [];
    const logger = { ...quietLogger, error: (msg, meta) => errorsLogged.push({ msg, meta }) };
    const v2 = createApp({ store, auth, game, config, logger, rateLimits: rateLimits ? undefined : false });

    const h = { discordUser: null };
    const dash = express();
    dash.use((req, res, next) => { req.user = h.discordUser; next(); });
    dash.use(greenhouseRouter({ dist: web.outDir }));
    dash.use('/panel', express.static(panel.outDir, { index: false }));
    // axe-core for the accessibility checks, served from this origin so the page's CSP allows it.
    if (process.env.GH_AXE_PATH && fs.existsSync(process.env.GH_AXE_PATH)) {
        dash.get('/__test/axe.js', (req, res) => res.type('application/javascript').sendFile(path.resolve(process.env.GH_AXE_PATH)));
    }
    server.on('request', (req, res) => (req.url.startsWith('/gh-api') ? v2(req, res) : dash(req, res)));
    const hub = createWsHub({ server, auth, hints, origins: allowedOrigins({ publicOrigin: origin, twitchExtClientId: EXT_CLIENT_ID }), logger: { debug() {} } });

    async function api(method, p, { token, body } = {}) {
        const headers = { 'content-type': 'application/json' };
        if (token) headers.authorization = `Bearer ${token}`;
        if (method === 'POST') headers['idempotency-key'] = `t-${crypto.randomBytes(8).toString('hex')}`;
        const res = await fetch(`${origin}/gh-api/api/v2${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json };
    }

    return Object.assign(h, {
        origin, clock, store, t: store.t, web, panel, tmp, extSecret, errorsLogged, api, HELPER_URL,

        /** A dev sign-in (the route only works on loopback with the dev platform on). */
        async devSignIn(userId, name) {
            const r = await api('POST', '/auth/dev', { body: { userId, ...(name ? { name } : {}) } });
            if (r.status !== 200) throw new Error(`dev sign-in failed: ${r.status} ${JSON.stringify(r.json)}`);
            return r.json;
        },

        /** Give an account cash (ledger, reason 'test') and set its level. */
        async boost(accountId, { cash = 0, level = null } = {}) {
            if (cash) await store.ledger.apply({ accountId, key: `boost:${accountId}:${crypto.randomBytes(4).toString('hex')}`, reason: 'test', cash });
            if (level) await store.db.query(`UPDATE ${store.t.accounts} SET level = ?, xp = ?, state_version = state_version + 1 WHERE id = ?`, [level, xpForLevel(level), accountId]);
        },

        /** An extension JWT as Twitch would sign it (with the TEST secret). */
        extToken({ opaque, userId = null, channelId = '424242', role = 'viewer' }) {
            const now = Math.floor(Date.now() / 1000);
            return jwt.sign({ exp: now + 3600, opaque_user_id: opaque, user_id: userId || undefined, channel_id: channelId, role, pubsub_perms: {} }, extSecret, { algorithm: 'HS256', noTimestamp: true });
        },

        async close() {
            await hub.close();
            await new Promise(resolve => server.close(() => resolve()));
            const left = await ctx.cleanup();
            fs.rmSync(tmp, { recursive: true, force: true });
            return left;
        }
    });
}

// ------------------------------------------------------------------ the browser

/** The stand-in for Twitch's helper script: window.__fakeTwitch (set before load) says what to do. */
export const FAKE_HELPER = `(function () {
  var cfg = window.__fakeTwitch || {};
  window.__ghShare = 0;
  // Twitch fires onAuthorized again (token renewal, identity shared): hand out cfg.token2.
  window.__ghReauth = function () {
    if (window.__ghAuthorize) window.__ghAuthorize({ channelId: cfg.channelId || '424242', clientId: 'ghtestclient', token: cfg.token2, userId: cfg.opaque });
  };
  window.Twitch = { ext: {
    viewer: { isLinked: !!cfg.userId, role: cfg.role || 'viewer' },
    actions: { requestIdShare: function () { window.__ghShare++; } },
    onAuthorized: function (cb) {
      window.__ghAuthorize = cb;
      if (cfg.never) return;
      setTimeout(function () { cb({ channelId: cfg.channelId || '424242', clientId: 'ghtestclient', token: cfg.token, userId: cfg.opaque, helixToken: '' }); }, cfg.delay || 30);
    },
    onContext: function (cb) { setTimeout(function () { cb({ theme: cfg.theme || 'dark' }, ['theme']); }, 5); },
    onVisibilityChanged: function () {},
    onError: function () {},
    rig: { log: function () {} }
  } };
})();`;

export async function launchBrowser() {
    const { default: puppeteer } = await import('puppeteer');
    // --no-sandbox: the server has no user-namespace sandbox (the bot's own headless browser uses the same flag).
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage'] });
    const pid = browser.process() ? browser.process().pid : null;
    return {
        browser,
        pid,
        async close() {
            try { await browser.close(); } catch { /* already gone */ }
            if (pid) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
        }
    };
}

/**
 * A page with the console watched. Options: width/height, fakeTwitch (config for the helper stub),
 * refreshToken (pre-signed-in website), block (url substrings to fail), hang (url substrings never answered),
 * respond (url substring -> {status, body}),
 * noWebSocket (the browser has no WebSocket, so the game polls).
 */
export async function openPage(browser, h, url, { width = 318, height = 496, fakeTwitch = null, refreshToken = null, block = [], hang = [], respond = {}, noWebSocket = false, reducedMotion = true } = {}) {
    // Each page gets its own browser context, so pages never share storage (each its own player).
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const close = page.close.bind(page);
    page.close = async () => { await close().catch(() => {}); await context.close().catch(() => {}); };
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const log = { errors: [], network: [], failed: [], fontHosts: [], fonts: [] };
    page.on('requestfinished', (r) => { if (/\.woff2(\?|$)/.test(r.url())) log.fonts.push(r.url()); });
    page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
    page.on('pageerror', (e) => log.errors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) log.network.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', (r) => log.failed.push(r.url()));
    await page.evaluateOnNewDocument((cfg, rt, noWs) => {
        if (cfg) window.__fakeTwitch = cfg;
        // Seed the refresh token once per tab: a reload must keep the rotated token the game stored.
        if (rt) { try { if (!sessionStorage.getItem('gh.seeded')) { localStorage.setItem('gh.refresh.v1', rt); sessionStorage.setItem('gh.seeded', '1'); } } catch (e) { /* none */ } }
        if (noWs) { window.WebSocket = undefined; }
    }, fakeTwitch, refreshToken, noWebSocket);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const u = req.url();
        for (const b of block) if (u.includes(b)) return req.abort('failed');
        if (u === HELPER_URL) return req.respond({ status: 200, contentType: 'application/javascript', body: FAKE_HELPER });
        // Phase 4: the fonts ship with the game, so any request to a font host is a failure (recorded).
        if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) { log.fontHosts.push(u); return req.abort('failed'); }
        for (const x of hang) if (u.includes(x)) return undefined; // left unanswered: the page keeps waiting
        for (const [part, r] of Object.entries(respond)) {
            if (u.includes(part) && (!r.method || r.method === req.method())) {
                return req.respond({ status: r.status, contentType: 'application/json', headers: r.headers || {}, body: JSON.stringify(r.body) });
            }
        }
        return req.continue();
    });
    if (url) await page.goto(h.origin + url, { waitUntil: 'domcontentloaded' });
    return { page, log };
}

/** Elements that stick out past the right edge (sideways scrolling), and the page's own scroll widths. */
export async function overflowReport(page) {
    return page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.position === 'fixed') continue;
            if (el.closest('dialog:not([open])') || el.closest('.sr-only') || el.closest('.view-title')) continue;
            if (r.right > w + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').join('.')} right=${Math.round(r.right)}`);
        }
        const view = document.querySelector('.view');
        return {
            width: w,
            docScroll: document.documentElement.scrollWidth,
            viewScroll: view ? view.scrollWidth - view.clientWidth : 0,
            offenders: out.slice(0, 10)
        };
    });
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait for a selector, optionally containing text. */
export async function waitText(page, selector, text, timeout = 8000) {
    await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some(e => !t || e.textContent.includes(t)), { timeout }, selector, text || '');
}

/** Wait for selector and click it inside the page in one step, so a re-render between finding and clicking
 *  cannot detach it (Puppeteer's page.click queries, then clicks). */
export async function clickSel(page, selector, timeout = 8000) {
    await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        if (!el || el.disabled) return false;
        el.click();
        return true;
    }, { timeout }, selector);
}

/** Click the first element matching selector whose text includes `text`. */
export async function clickText(page, selector, text) {
    const ok = await page.evaluate((sel, t) => {
        const el = [...document.querySelectorAll(sel)].find(e => e.textContent.includes(t) && !e.disabled);
        if (!el) return false;
        el.click();
        return true;
    }, selector, text);
    if (!ok) throw new Error(`nothing to click: ${selector} "${text}"`);
}
