// Greenhouse Tycoon (phase 3): the website in a headless browser, at the Twitch panel size (318 x 496) and at
// desktop width, against a throwaway v2 server (tests/cfx/v2/_frontend-harness.js) on ghtest_ tables.
//   - sign-in: the dev route (a refresh token placed in storage), Discord through the dashboard route
//   - the core loop by clicking: plant, harvest, sell, buy an upgrade, hire staff, breed, collect the daily
//     reward, rename
//   - every state screen: signed out, session expired, backend down, maintenance, rate limited, offline,
//     polling without a WebSocket, loading
//   - no sideways scrolling, no console errors, no 5xx answers, keyboard use
// Optional: GH_SHOTS_DIR=<dir> saves screenshots; GH_AXE_PATH=<axe.min.js> runs axe-core on each screen and
// writes <GH_SHOTS_DIR>/a11y-web.json.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closePool } from './_helpers.js';
import { startHarness, launchBrowser, openPage, overflowReport, sleep, waitText, clickText } from './_frontend-harness.js';

const SHOTS = process.env.GH_SHOTS_DIR || null;
const AXE = !!(process.env.GH_AXE_PATH && fs.existsSync(process.env.GH_AXE_PATH));
const a11y = [];
const pages = [];
let h;
let b;

before(async () => {
    h = await startHarness();
    b = await launchBrowser();
});

after(async () => {
    for (const p of pages) await p.page.close().catch(() => {});
    if (b) await b.close();
    if (SHOTS && a11y.length) fs.writeFileSync(path.join(SHOTS, 'a11y-web.json'), JSON.stringify(a11y, null, 2));
    const left = h ? await h.close() : [];
    await closePool();
    assert.deepEqual(left, [], 'ghtest_ tables dropped');
});

async function open(url, opts) {
    const p = await openPage(b.browser, h, url, opts);
    pages.push(p);
    return p;
}

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noSideways(page, label) {
    const r = await overflowReport(page);
    assert.ok(r.docScroll <= r.width && r.viewScroll <= 0 && r.offenders.length === 0, `${label}: ${JSON.stringify(r)}`);
}

/** axe-core (served by the harness from this origin, so the page's CSP allows it). */
async function axe(p, label) {
    if (!AXE) return;
    const page = p.page;
    const before = p.log.errors.length;
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ url: `${h.origin}/__test/axe.js` });
    const res = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, resultTypes: ['violations'] });
        return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')) })), passes: r.passes.length };
    });
    a11y.push({ label, ...res });
    // axe itself sets inline styles while it measures contrast; the page's CSP refuses them and logs it.
    p.log.errors = p.log.errors.filter((e, i) => i < before || !/Applying inline style violates/.test(e));
    const serious = res.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    assert.deepEqual(serious, [], `${label}: axe serious/critical violations`);
}

/** Console errors other than the browser's own "Failed to load resource" lines for expected 4xx answers. */
function realErrors(log) {
    return log.errors.filter(e => !/Failed to load resource: the server responded with a status of 4\d\d/.test(e));
}

async function clean(p, label) {
    assert.deepEqual(realErrors(p.log), [], `${label}: console errors`);
    assert.deepEqual(p.log.network, [], `${label}: 5xx answers`);
}

const toastSeen = (page, text) => waitText(page, '.toast-text', text);

describe('website: signed out and sign-in', () => {
    test('the sign-in screen at panel size and desktop width', async () => {
        for (const [w, hgt, name] of [[318, 496, 'web-318-signin'], [1280, 800, 'web-desktop-signin']]) {
            const p = await open('/greenhouse', { width: w, height: hgt });
            await waitText(p.page, '.screen-title', 'Sign in to play');
            await noSideways(p.page, name);
            await shot(p.page, name);
            await axe(p, name);
            assert.match(await p.page.title(), /Greenhouse Tycoon/);
            await clean(p, name);
        }
    });

    test('the page has its own CSP, no inline script, cached hashed assets', async () => {
        const res = await fetch(`${h.origin}/greenhouse`);
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /script-src 'self'(;|$)/);
        assert.match(res.headers.get('cache-control'), /no-store/);
        const html = await res.text();
        assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
        const asset = html.match(/\/greenhouse\/assets\/(app\.[0-9a-f]{10}\.js)/);
        assert.ok(asset, 'hashed script');
        const a = await fetch(`${h.origin}/greenhouse/assets/${asset[1]}`);
        assert.equal(a.status, 200);
        assert.match(a.headers.get('cache-control'), /max-age=31536000/);
        assert.equal((await fetch(`${h.origin}/greenhouse/assets/nope.js`)).status, 404);
        assert.equal((await fetch(`${h.origin}/greenhouse/assets/..%2Findex.html`)).status, 404);
    });

    test('Discord: not logged in to the dashboard goes to its login; logged in plays', async () => {
        h.discordUser = null;
        const p = await open('/greenhouse', { width: 318, height: 496 });
        await waitText(p.page, 'button', 'Continue with Discord');
        const nav = p.page.waitForRequest(r => r.url().includes('/auth/discord?returnTo='), { timeout: 8000 });
        await clickText(p.page, 'button', 'Continue with Discord');
        const req = await nav;
        assert.ok(req.url().endsWith(`/auth/discord?returnTo=${encodeURIComponent('/greenhouse?signin=discord')}`), req.url());

        h.discordUser = { id: '123456789012345678', username: 'leafy', globalName: 'Leafy Lu' };
        const q = await open('/greenhouse?signin=discord', { width: 318, height: 496 });
        await waitText(q.page, '.who-name', 'Leafy Lu');
        assert.equal(new URL(q.page.url()).search, '', 'the signin=discord parameter is removed');
        await shot(q.page, 'web-318-grow-new-player');
        await clean(q, 'discord sign-in');

        const secret = process.env.CFX2_DASHBOARD_SECRET;
        process.env.CFX2_DASHBOARD_SECRET = '';
        try {
            const r = await open('/greenhouse', { width: 318, height: 496 });
            await waitText(r.page, 'button', 'Continue with Discord');
            await clickText(r.page, 'button', 'Continue with Discord');
            await waitText(r.page, '.screen-error', 'not set up yet');
            await shot(r.page, 'web-318-signin-unavailable');
        } finally {
            process.env.CFX2_DASHBOARD_SECRET = secret;
        }
    });
});

describe('website: the core loop by clicking (desktop)', () => {
    test('plant, harvest, sell, upgrade, hire, breed, daily, rename', async () => {
        const s = await h.devSignIn('web-player-1', 'Web Player');
        const p = await open('/greenhouse', { width: 1280, height: 800, refreshToken: s.refreshToken });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        await shot(page, 'web-desktop-grow-start');

        for (const [slot, name] of [[1, 'Sunmoss'], [2, 'Velvet Fern']]) {
            await page.click(`[data-key="plot-${slot}"]`);
            await page.waitForSelector('dialog[open] .pick');
            await clickText(page, 'dialog[open] .pick', name);
            await toastSeen(page, `Planted ${name}`);
            await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        }
        await shot(page, 'web-desktop-grow-growing');

        await page.click('[data-key="plot-2"]');
        await page.waitForSelector('dialog[open] [data-key="water"]');
        await shot(page, 'web-desktop-plot-dialog');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));

        h.clock.offset += 10 * 60_000;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitText(page, '.plot-status', 'Ready');
        await shot(page, 'web-desktop-grow-ready');
        await clickText(page, 'button', 'Harvest all');
        await toastSeen(page, 'Harvested');

        await page.click('[data-key="tab-market"]');
        await clickText(page, '.seg', 'Sell');
        await page.waitForSelector('[data-key="sell-all"]');
        await shot(page, 'web-desktop-market-sell');
        await page.click('[data-key="sell-all"]');
        await page.waitForSelector('dialog[open] .btn-primary');
        await page.click('dialog[open] .btn-primary');
        await toastSeen(page, 'Sold');

        await h.boost(s.accountId, { cash: 250_000, level: 6 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-key="tab-upgrades"]');

        await page.click('[data-key="tab-upgrades"]');
        await page.waitForSelector('[data-key="up-grow_lights"]');
        await page.click('[data-key="up-grow_lights"]');
        await toastSeen(page, 'is now level 1');
        await shot(page, 'web-desktop-upgrades');

        await clickText(page, '.seg', 'Staff');
        await page.waitForSelector('[data-key="hire-gardener"]');
        await page.click('[data-key="hire-gardener"]');
        await toastSeen(page, 'Hired a Gardener');
        await shot(page, 'web-desktop-staff');

        await page.click('[data-key="tab-breed"]');
        await page.waitForSelector('#parent-a');
        await page.select('#parent-a', '1');
        await page.select('#parent-b', '2');
        await page.waitForSelector('[data-key="start-cross"]:not([disabled])');
        await shot(page, 'web-desktop-breed-preview');
        await page.click('[data-key="start-cross"]');
        await toastSeen(page, 'Cross started');
        h.clock.offset += 3 * 3_600_000;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-key="tab-breed"]');
        await page.click('[data-key="tab-breed"]');
        await page.waitForSelector('[data-key="claim-cross"]:not([disabled])');
        await page.click('[data-key="claim-cross"]');
        await toastSeen(page, 'New hybrid');
        await waitText(page, '.gallery-name', 'Sunmoss × Velvet Fern');
        await shot(page, 'web-desktop-breed');

        await page.click('[data-key="tab-grow"]');
        await page.waitForSelector('[data-key="daily"]');
        await page.click('[data-key="daily"]');
        await toastSeen(page, 'Daily reward');

        await page.click('[data-key="tab-profile"]');
        await page.waitForSelector('#gh-name');
        await page.click('#gh-name', { clickCount: 3 });
        await page.type('#gh-name', 'Fern Fan');
        await page.click('[data-key="name-save"]');
        await toastSeen(page, 'Name saved');
        await waitText(page, '.who-name', 'Fern Fan');
        await waitText(page, '#gh-name-help', 'You can change your name again in');
        assert.equal(await page.$eval('#gh-name', el => el.disabled), true);
        await waitText(page, '.stat dd');
        await shot(page, 'web-desktop-profile');

        await page.click('[data-key="tab-market"]');
        await clickText(page, '.seg', 'Orders');
        await shot(page, 'web-desktop-market-orders');
        await clickText(page, '.seg', 'Shop');
        await page.waitForSelector('[data-key="buy-seed-1-go"]');
        await page.click('[data-key="buy-seed-1-go"]');
        await toastSeen(page, 'Bought 1 Sunmoss seeds');
        await shot(page, 'web-desktop-market-shop');
        await page.click('[data-key="tab-grow"]');
        await sleep(200);
        await shot(page, 'web-desktop-grow');
        await noSideways(page, 'desktop grow');
        await axe(p, 'web-desktop-grow');

        await clean(p, 'core loop');
        assert.deepEqual(h.errorsLogged, [], 'no server errors');

        const rt = await page.evaluate(() => localStorage.getItem('gh.refresh.v1'));
        const fresh = await h.api('POST', '/auth/refresh', { body: { refreshToken: rt } });
        await page.close();
        const st = await h.api('GET', '/state', { token: fresh.json.token });
        assert.equal(st.json.state.account.displayName, 'Fern Fan');
        assert.equal(st.json.state.upgrades.find(u => u.code === 'grow_lights').level, 1);
        assert.equal(st.json.state.staff.find(x => x.code === 'gardener').count, 1);
        assert.equal(st.json.state.hybrids.length, 1);
        assert.equal(st.json.state.daily.claimedToday, true);
    });

    test('a refused name shows the reason and keeps the old name', async () => {
        const s = await h.devSignIn('web-player-2', 'Second');
        const p = await open('/greenhouse', { width: 318, height: 496, refreshToken: s.refreshToken });
        await p.page.waitForSelector('[data-key="tab-profile"]');
        await p.page.click('[data-key="tab-profile"]');
        await p.page.waitForSelector('#gh-name');
        await p.page.click('#gh-name', { clickCount: 3 });
        await p.page.type('#gh-name', 'Admin');
        await p.page.click('[data-key="name-save"]');
        await waitText(p.page, '.toast-text', 'not allowed');
        await shot(p.page, 'web-318-rename-refused');
        await waitText(p.page, '.who-name', 'Second');
        assert.equal(await p.page.$eval('#gh-name', el => el.disabled), false);
    });
});

describe('website at 318 x 496', () => {
    test('every tab and dialog fits with no sideways scrolling', async () => {
        const p = await open('/greenhouse', { width: 318, height: 496, refreshToken: (await h.devSignIn('web-player-1')).refreshToken });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        const visits = [
            ['grow', null], ['market', 'Orders'], ['market', 'Sell'], ['market', 'Shop'],
            ['breed', null], ['upgrades', 'Upgrades'], ['upgrades', 'Staff'], ['profile', null]
        ];
        for (const [tab, seg] of visits) {
            await page.click(`[data-key="tab-${tab}"]`);
            if (seg) await clickText(page, '.seg', seg);
            await sleep(200);
            const name = `web-318-${tab}${seg ? `-${seg.toLowerCase()}` : ''}`;
            await noSideways(page, name);
            await shot(page, name);
            await axe(p, name);
        }
        await page.click('[data-key="tab-grow"]');
        await page.waitForSelector('[data-key="plot-1"]');
        await page.click('[data-key="plot-1"]');
        await page.waitForSelector('dialog[open]');
        await noSideways(page, 'plant dialog');
        await shot(page, 'web-318-plant-dialog');
        await axe(p, 'web-318-plant-dialog');
        await page.keyboard.press('Escape');
        await clean(p, '318 tabs');
    });

    test('keyboard: plots and dialogs work without a mouse, focus is visible and returns', async () => {
        const p = await open('/greenhouse', { width: 318, height: 496, refreshToken: (await h.devSignIn('web-player-1')).refreshToken });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        await page.focus('[data-key="plot-1"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog[open]');
        assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog[open]')), 'focus moves into the dialog');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'plot-1', 'focus returns to the plot');
        await page.keyboard.press('Tab');
        const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
        assert.notEqual(outline, 'none', 'keyboard focus is visible');
        // A poll can redraw the tab bar between focus() and the key press; try the pair again if so.
        for (let i = 0; i < 3; i++) {
            await page.focus('[data-key="tab-market"]');
            await page.keyboard.press('Enter');
            if (await page.waitForFunction(() => (document.querySelector('#gh-view-title')?.textContent || '').includes('Market'), { timeout: 2500 }).then(() => true, () => false)) break;
        }
        await waitText(page, '#gh-view-title', 'Market');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'tab-market', 'focus stays on the tab');
        await clean(p, 'keyboard');
    });
});

describe('website: state screens', () => {
    test('loading, backend down, maintenance, session expired', async () => {
        const loading = await open('/greenhouse', { width: 318, height: 496, hang: ['/gh-api/api/v2/catalog'] });
        await waitText(loading.page, '.screen-sub', 'Opening the greenhouse');
        await shot(loading.page, 'web-318-loading');
        await loading.page.close();

        const down = await open('/greenhouse', { width: 318, height: 496, block: ['/gh-api/api/v2/catalog'] });
        await waitText(down.page, '.screen-title', 'not answering');
        await waitText(down.page, '.retry-in', 'Trying again in');
        await noSideways(down.page, 'down');
        await shot(down.page, 'web-318-backend-down');
        await axe(down, 'web-318-backend-down');
        await down.page.close();

        const maint = await open('/greenhouse', { width: 318, height: 496, respond: { '/gh-api/api/v2/catalog': { status: 503, body: { error: { code: 'SERVICE_DISABLED', message: 'The game is paused for maintenance.' } } } } });
        await waitText(maint.page, '.screen-sub', 'paused for maintenance');
        await shot(maint.page, 'web-318-maintenance');
        await maint.page.close();

        const expired = await open('/greenhouse', { width: 318, height: 496, refreshToken: `ghr_${'a'.repeat(43)}` });
        await waitText(expired.page, '.screen-error', 'You were signed out');
        await shot(expired.page, 'web-318-session-expired');
        assert.equal(await expired.page.evaluate(() => localStorage.getItem('gh.refresh.v1')), null, 'the dead token is forgotten');
        await clean(expired, 'expired');
    });

    test('rate limited, offline, and polling when there is no WebSocket', async () => {
        const s = await h.devSignIn('web-player-3', 'Third');
        const rl = await open('/greenhouse', {
            width: 318, height: 496, refreshToken: s.refreshToken,
            respond: { '/gh-api/api/v2/daily': { method: 'POST', status: 429, headers: { 'Retry-After': '30' }, body: { error: { code: 'RATE_LIMITED', message: 'Slow down a little and try again.' } } } }
        });
        await rl.page.waitForSelector('[data-key="daily"]');
        await rl.page.click('[data-key="daily"]');
        await waitText(rl.page, '.toast-text', 'Slow down');
        await shot(rl.page, 'web-318-rate-limited');
        const toasts = await rl.page.$$eval('.toast-text', els => els.map(e => e.textContent));
        assert.equal(toasts.filter(t => t.includes('Slow down')).length, 1, 'one notice, not two');

        await rl.page.setOfflineMode(true);
        await waitText(rl.page, '.notice', 'You are offline');
        await shot(rl.page, 'web-318-offline');
        await rl.page.setOfflineMode(false);
        await rl.page.waitForFunction(() => ![...document.querySelectorAll('.notice')].some(n => n.textContent.includes('offline')), { timeout: 8000 });
        await rl.page.close();

        const poll = await open('/greenhouse', { width: 318, height: 496, refreshToken: (await h.devSignIn('web-player-3')).refreshToken, noWebSocket: true });
        await poll.page.waitForSelector('[data-key="plot-1"]');
        await waitText(poll.page, '.quiet-line', 'Live updates are paused', 16000);
        await shot(poll.page, 'web-318-polling');
        await h.boost(s.accountId, { cash: 1234 });
        await poll.page.waitForFunction(() => /\$1\.\d?k/.test(document.querySelector('.cash').textContent), { timeout: 20000 });
        await clean(poll, 'polling');
    });

    test('a change made elsewhere arrives at once over the WebSocket hint', async () => {
        const s = await h.devSignIn('web-player-4', 'Fourth');
        const p = await open('/greenhouse', { width: 318, height: 496, refreshToken: s.refreshToken });
        await p.page.waitForSelector('[data-key="plot-1"]');
        await p.page.waitForFunction(() => !document.querySelector('.quiet-line'));
        await sleep(800);
        await h.boost(s.accountId, { cash: 98_765 });
        await p.page.waitForFunction(() => document.querySelector('.cash').textContent.includes('99'), { timeout: 4000 });
        await clean(p, 'ws hint');
    });
});
