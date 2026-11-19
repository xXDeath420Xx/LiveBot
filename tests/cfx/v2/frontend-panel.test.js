// Greenhouse Tycoon (phase 3): the Twitch panel build (exactly the files that go into the zip) in a headless
// browser at 318 x 496, with Twitch's helper replaced by a stub that hands out extension JWTs signed with a
// TEST secret, against a throwaway v2 server on ghtest_ tables.
//   - a viewer plays on the opaque id at once; "Grower" until they rename; identity sharing is optional
//   - every onAuthorized is exchanged again at /auth/twitch-ext
//   - logged-out viewer, auth timeout, missing helper, the broadcaster, the separate_saves notice, light theme
//   - config.html; no sideways scrolling; no console errors
//   - phase 4: no link-code controls in the panel (website-only); the review save for Twitch reviewers (only in
//     a test or review state with the server's switch on), its banner, "Back to my save"; no font host
// Optional: GH_SHOTS_DIR, GH_AXE_PATH as in frontend-web.test.js (writes a11y-panel.json).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { closePool } from './_helpers.js';
import { startHarness, launchBrowser, openPage, overflowReport, sleep, waitText, clickText, clickSel } from './_frontend-harness.js';

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
    if (SHOTS && a11y.length) fs.writeFileSync(path.join(SHOTS, 'a11y-panel.json'), JSON.stringify(a11y, null, 2));
    const left = h ? await h.close() : [];
    await closePool();
    assert.deepEqual(left, [], 'ghtest_ tables dropped');
});

const opaque = () => `U${crypto.randomBytes(8).toString('hex')}`;

async function openPanel(fake, opts = {}) {
    const p = await openPage(b.browser, h, opts.url || '/panel/panel.html', { width: 318, height: 496, fakeTwitch: fake, ...opts });
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

function clean(p, label) {
    const errors = p.log.errors.filter(e => !/Failed to load resource: the server responded with a status of 4\d\d/.test(e));
    assert.deepEqual(errors, [], `${label}: console errors`);
    assert.deepEqual(p.log.network, [], `${label}: 5xx answers`);
    assert.deepEqual(p.log.fontHosts, [], `${label}: requests to a font host`);
}

describe('panel: a viewer', () => {
    test('plays on the opaque id at once, every tab fits, plant and harvest work', async () => {
        const id = opaque();
        const p = await openPanel({ opaque: id, token: h.extToken({ opaque: id }) });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        await waitText(page, '.who-name', 'Grower');
        assert.equal(await page.$('.brand'), null, 'no site header in the panel');
        await shot(page, 'panel-grow-start');

        await page.click('[data-key="plot-1"]');
        await page.waitForSelector('dialog[open] .pick');
        await shot(page, 'panel-plant-dialog');
        await clickText(page, 'dialog[open] .pick', 'Sunmoss');
        await waitText(page, '.toast-text', 'Planted Sunmoss');
        h.clock.offset += 5 * 60_000;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitText(page, '.plot-status', 'Ready');
        await shot(page, 'panel-grow-ready');
        await page.click('[data-key="plot-1"]');
        await waitText(page, '.toast-text', 'Harvested');

        for (const [tab, seg] of [['grow', null], ['market', 'Orders'], ['market', 'Sell'], ['market', 'Shop'], ['breed', null], ['upgrades', 'Upgrades'], ['upgrades', 'Staff'], ['upgrades', 'Decorations'], ['profile', null]]) {
            // Clicked inside the page in one step: a poll or countdown can redraw the tab bar between a
            // separate query and click ("Node is detached from document").
            await page.$eval(`[data-key="tab-${tab}"]`, el => el.click());
            if (seg) await clickText(page, '.seg', seg);
            await sleep(200);
            const name = `panel-${tab}${seg ? `-${seg.toLowerCase()}` : ''}`;
            await noSideways(page, name);
            await shot(page, name);
            await axe(p, name);
        }
        await waitText(page, '.card-title', 'Use this save on the website');
        await page.click('[data-key="id-share"]');
        assert.equal(await page.evaluate(() => window.__ghShare), 1, 'requestIdShare called');
        assert.equal(await page.$('[data-key="sign-out"]'), null, 'no sign-out button in the panel');
        // Link codes are website-only (owner decision): the panel keeps only the identity-sharing card.
        assert.equal(await page.$('[data-key="make-code"]'), null, 'no "make a link code" in the panel');
        assert.equal(await page.$('#gh-code'), null, 'no link-code field in the panel');
        assert.equal(await page.$('[data-key="review-try"]'), null, 'no review-save card outside a review state');
        assert.ok(p.log.fonts.some(u => u.endsWith('/panel/Geist-Variable.woff2')), `the font comes from the package: ${JSON.stringify(p.log.fonts)}`);
        clean(p, 'viewer');
    });

    test('every onAuthorized is exchanged again; sharing the identity links the save', async () => {
        const id = opaque();
        const p = await openPanel({ opaque: id, token: h.extToken({ opaque: id }), token2: h.extToken({ opaque: id, userId: '777000111' }) });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        let exchanges = 0;
        page.on('request', (r) => { if (r.url().endsWith('/gh-api/api/v2/auth/twitch-ext')) exchanges++; });
        await page.evaluate(() => window.__ghReauth());
        await sleep(800);
        assert.ok(exchanges >= 1, 'token exchanged again');
        await page.click('[data-key="tab-profile"]');
        await waitText(page, '.card p', 'linked to your Twitch account');
        await shot(page, 'panel-profile-shared');
        const [rows] = await h.store.db.query(`SELECT COUNT(DISTINCT account_id) AS n FROM ${h.t.identities} WHERE platform_user_id IN (?, ?)`, [id, '777000111']);
        assert.equal(Number(rows[0].n), 1, 'the panel id and the Twitch id share one save');
        clean(p, 'reauth');
    });

    test('the separate_saves notice when the Twitch account already has its own save', async () => {
        const id = opaque();
        const real = String(800_000_000 + crypto.randomInt(1_000_000));
        const panelSave = await h.api('POST', '/auth/twitch-ext', { body: { token: h.extToken({ opaque: id }) } });
        await h.store.ledger.apply({ accountId: panelSave.json.accountId, key: `prog:${panelSave.json.accountId}:1`, reason: 'test', cash: 10 });
        const tw = await h.store.accounts.signIn({ platform: 'twitch', platformUserId: real });
        await h.store.ledger.apply({ accountId: tw.accountId, key: `prog:${tw.accountId}:1`, reason: 'test', cash: 10 });

        const p = await openPanel({ opaque: id, userId: real, token: h.extToken({ opaque: id, userId: real }) });
        await waitText(p.page, '.notice', 'already had its own save');
        await shot(p.page, 'panel-notice-separate-saves');
        await p.page.click('.notice-close');
        await p.page.waitForFunction(() => !document.querySelector('.notice'));
        clean(p, 'notice');
    });

    test('the broadcaster plays on their channel without prompts; light theme', async () => {
        const id = opaque();
        const p = await openPanel({ opaque: id, role: 'broadcaster', theme: 'light', token: h.extToken({ opaque: id, role: 'broadcaster', channelId: '555000555' }) });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
        await shot(page, 'panel-light-grow');
        await page.click('[data-key="tab-profile"]');
        await waitText(page, '.card p', 'This is your channel');
        assert.equal(await page.$('[data-key="id-share"]'), null, 'no identity prompt for the broadcaster');
        await shot(page, 'panel-broadcaster-profile');
        await axe(p, 'panel-light-profile');
        clean(p, 'broadcaster');
    });
});

describe('panel: the review save (phase 4)', () => {
    test('offered only in a review state with the switch on; switch, sandbox, and back', async () => {
        const id = opaque();
        const fake = { opaque: id, token: h.extToken({ opaque: id }) };

        // Switch off: no card even in Hosted Test.
        await h.store.flags.set('review.enabled', false, 'test');
        h.store.flags.clearCache();
        const off = await openPanel(fake, { url: '/panel/panel.html?anchor=panel&mode=viewer&state=hosted_test' });
        await off.page.waitForSelector('[data-key="plot-1"]');
        await clickSel(off.page, '[data-key="tab-profile"]');
        await waitText(off.page, '.card-title', 'Use this save on the website');
        assert.equal(await off.page.$('[data-key="review-try"]'), null, 'no card while the switch is off');
        await off.page.close();

        await h.store.flags.set('review.enabled', true, 'test');
        h.store.flags.clearCache();
        // Released extension (state=released): still no card.
        const rel = await openPanel(fake, { url: '/panel/panel.html?anchor=panel&mode=viewer&state=released' });
        await rel.page.waitForSelector('[data-key="plot-1"]');
        await clickSel(rel.page, '[data-key="tab-profile"]');
        await waitText(rel.page, '.card-title', 'Use this save on the website');
        assert.equal(await rel.page.$('[data-key="review-try"]'), null, 'no card for a released extension');
        await rel.page.close();

        const p = await openPanel(fake, { url: '/panel/panel.html?anchor=panel&mode=viewer&state=hosted_test' });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');
        await waitText(page, '.who-name', 'Grower');
        await clickSel(page, '[data-key="tab-profile"]');
        await page.waitForSelector('[data-key="review-try"]');
        await shot(page, 'panel-review-offer');
        await clickSel(page, '[data-key="review-try"]');
        await waitText(page, '.review-banner', 'Shared review save');
        await waitText(page, '.who-name', 'Review save');
        await noSideways(page, 'review grow');
        await shot(page, 'panel-review-grow');
        await axe(p, 'panel-review-grow');
        // The example save is mid-game.
        await waitText(page, '.level-chip', 'Lv 12');
        // Sandboxed: no rename, no identity sharing, no Replant.
        await clickSel(page, '[data-key="tab-profile"]');
        await page.waitForSelector('#gh-name');
        assert.equal(await page.evaluate(() => document.querySelector('#gh-name').disabled), true, 'rename is off');
        assert.equal(await page.$('[data-key="id-share"]'), null, 'no identity sharing on the review save');
        await clickSel(page, '[data-key="tab-upgrades"]');
        await page.waitForSelector('[data-key="replant"]');
        assert.equal(await page.evaluate(() => document.querySelector('[data-key="replant"]').disabled), true, 'Replant is off');
        // A token renewal keeps the reviewer on the review save.
        fake.token2 = h.extToken({ opaque: id });
        await page.evaluate((t) => { window.__fakeTwitch.token2 = t; window.__ghReauth(); }, fake.token2);
        await sleep(800);
        await waitText(page, '.who-name', 'Review save');

        await clickSel(page, '[data-key="review-back"]');
        await waitText(page, '.toast-text', 'Back on your own save');
        await waitText(page, '.who-name', 'Grower');
        await page.waitForFunction(() => !document.querySelector('.review-banner'));
        const [rows] = await h.store.db.query(`SELECT COUNT(*) AS n FROM ${h.t.identities} WHERE platform = 'review'`);
        assert.equal(Number(rows[0].n), 1, 'one shared review sign-in');
        clean(p, 'review save');
    });
});

describe('panel: states', () => {
    test('a logged-out viewer sees "Log in to Twitch to play" with a disabled action', async () => {
        const anon = `A${crypto.randomBytes(8).toString('hex')}`;
        const p = await openPanel({ opaque: anon, token: h.extToken({ opaque: anon }) });
        await waitText(p.page, '.screen-title', 'Log in to Twitch to play');
        assert.equal(await p.page.$eval('.screen .btn', el => el.disabled), true);
        await noSideways(p.page, 'signed out');
        await shot(p.page, 'panel-signed-out');
        await axe(p, 'panel-signed-out');
        const [rows] = await h.store.db.query(`SELECT COUNT(*) AS n FROM ${h.t.identities} WHERE platform_user_id = ?`, [anon]);
        assert.equal(Number(rows[0].n), 0, 'nothing stored for a logged-out viewer');
        clean(p, 'signed out');
    });

    test('Twitch never authorizes: the timeout screen after 10 s', async () => {
        const p = await openPanel({ never: true });
        await waitText(p.page, '.screen-sub', 'Opening the greenhouse');
        await shot(p.page, 'panel-loading');
        await waitText(p.page, '.screen-title', 'Twitch has not signed you in yet', 14000);
        await noSideways(p.page, 'timeout');
        await shot(p.page, 'panel-auth-timeout');
        clean(p, 'timeout');
    });

    test('the helper did not load', async () => {
        const p = await openPanel({ never: true }, { block: ['extension-files.twitch.tv'] });
        await waitText(p.page, '.screen-sub', 'helper did not load');
        await shot(p.page, 'panel-helper-missing');
    });

    test('backend down in the panel', async () => {
        const id = opaque();
        const p = await openPanel({ opaque: id, token: h.extToken({ opaque: id }) }, { block: ['/gh-api/api/v2/catalog'] });
        await waitText(p.page, '.screen-title', 'not answering');
        await noSideways(p.page, 'panel down');
        await shot(p.page, 'panel-backend-down');
    });

    test('config.html says there is nothing to set up and is not clipped', async () => {
        const p = await openPage(b.browser, h, '/panel/config.html', { width: 640, height: 400 });
        pages.push(p);
        await waitText(p.page, 'p', 'nothing to set up');
        const r = await overflowReport(p.page);
        assert.ok(r.docScroll <= r.width, JSON.stringify(r));
        await shot(p.page, 'panel-config');
        clean(p, 'config');
    });
});
