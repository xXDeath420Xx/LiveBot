// Greenhouse Tycoon (register H-641): the website's "Your data" card on the Profile tab, in a headless browser
// against a throwaway v2 server (tests/cfx/v2/_frontend-harness.js) on ghtest_ tables, and the proof that the
// Twitch panel package does not change.
//   - the card: heading, group label, both buttons, the policy link; keyboard only: Enter on "Download my data"
//     saves greenhouse-tycoon-data-<day>.json with this save's export; Tab reaches "Delete my save"
//   - the delete dialog: a labelled modal, focus on the confirmation field, what goes and "cannot be undone",
//     Escape closes it and focus goes back; a wrong word is announced (role=alert) and deletes nothing;
//     DELETE deletes the save and every linked sign-in and signs out (stored refresh token removed)
//   - axe-core (optional, GH_AXE_PATH) on the card and the dialog; GH_SHOTS_DIR=<dir> saves screenshots
//   - the panel: no card in the panel's Profile; the fresh panel build is byte-identical to dist/panel/ and to
//     every file inside dist/greenhouse-panel.zip, and its panel.js has none of the card's code or text
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closePool } from './_helpers.js';
import { startHarness, launchBrowser, openPage, waitText, clickSel } from './_frontend-harness.js';
import { createPrivacy } from '../../../services/cfx/privacy/index.js';
import { PANEL_FILES } from '../../../frontend/greenhouse/build.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(repo, 'frontend/greenhouse/dist');
const AXE = !!(process.env.GH_AXE_PATH && fs.existsSync(process.env.GH_AXE_PATH));
const SHOTS = process.env.GH_SHOTS_DIR || null;
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

async function axe(p, label) {
    if (!AXE) return;
    const page = p.page;
    const before = p.log.errors.length;
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ url: `${h.origin}/__test/axe.js` });
    const res = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, resultTypes: ['violations'] });
        return r.violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }));
    });
    p.log.errors = p.log.errors.filter((e, i) => i < before || !/Applying inline style violates/.test(e));
    assert.deepEqual(res.filter(v => v.impact === 'serious' || v.impact === 'critical'), [], `${label}: axe serious/critical violations`);
}

const realErrors = (log) => log.errors.filter(e => !/Failed to load resource: the server responded with a status of 4\d\d/.test(e));
const activeKey = (page) => page.evaluate(() => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key || document.activeElement.id : null));
const attr = (page, sel, name) => page.evaluate((s, n) => document.querySelector(s).getAttribute(n), sel, name);

/** A Kick-only player (no Discord, so no /privacy) with a second sign-in linked and a refresh token. */
async function kickPlayer() {
    const id = String(crypto.randomInt(1e8, 9e8));
    const s = await h.store.accounts.signIn({ platform: 'kick', platformUserId: id, displayName: 'Kick grower' });
    const r = await h.store.db.query(`INSERT INTO ${h.t.identities} (account_id, platform, platform_user_id, display_name, linked_at) VALUES (?, 'twitch', ?, 'Linked', NOW(3))`,
        [s.accountId, String(crypto.randomInt(1e8, 9e8))]);
    const twitchIdentity = Number(r[0].insertId);
    const { refreshToken } = await h.store.sessions.issue({ accountId: s.accountId, identityId: s.identityId });
    await h.store.sessions.issue({ accountId: s.accountId, identityId: twitchIdentity });
    return { ...s, platformUserId: id, refreshToken, twitchIdentity };
}

describe('website: the Your data card', () => {
    test('download by keyboard, the delete dialog, a wrong word, then DELETE signs out and the save is gone', async () => {
        const me = await kickPlayer();
        const p = await open('/greenhouse', { width: 1280, height: 900, refreshToken: me.refreshToken });
        const { page } = p;
        await clickSel(page, '[data-key="tab-profile"]');
        await page.waitForSelector('[data-card="your-data"]');

        // The card: a section heading that labels the card group, two buttons, the policy link.
        const card = await page.evaluate(() => {
            const el = document.querySelector('[data-card="your-data"]');
            const group = el.querySelector('[role="group"]');
            const heading = document.getElementById(group.getAttribute('aria-labelledby'));
            return {
                heading: heading && heading.textContent, headingTag: heading && heading.tagName,
                buttons: [...el.querySelectorAll('button')].map(x => [x.dataset.key, x.textContent, x.type]),
                link: el.querySelector('a') && el.querySelector('a').getAttribute('href'),
                inRightColumn: !!el.closest('.profile-col') && !!el.closest('[data-slot="profile.achievements"]')
            };
        });
        assert.equal(card.heading, 'Your data');
        assert.equal(card.headingTag, 'H2');
        assert.deepEqual(card.buttons, [['data-download', 'Download my data', 'button'], ['data-delete', 'Delete my save', 'button']]);
        assert.equal(card.link, '/privacy#greenhouse-tycoon');
        assert.ok(card.inRightColumn);
        await page.evaluate(() => document.querySelector('[data-card="your-data"]').scrollIntoView({ block: 'center' }));
        await shot(page, 'h641-desktop-card');
        await axe(p, 'your-data-card');

        // Download, keyboard only. The page's own download is captured (blob text and file name).
        await page.evaluate(() => {
            window.__dl = null;
            const make = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (blob) => { blob.text().then(t => { window.__dl = Object.assign(window.__dl || {}, { text: t, type: blob.type }); }); return make(blob); };
            const click = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                if (this.download) { window.__dl = Object.assign(window.__dl || {}, { name: this.download }); return undefined; }
                return click.call(this);
            };
        });
        await page.focus('[data-key="data-download"]');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__dl && window.__dl.text && window.__dl.name, { timeout: 8000 });
        const dl = await page.evaluate(() => window.__dl);
        assert.match(dl.name, /^greenhouse-tycoon-data-\d{4}-\d{2}-\d{2}\.json$/);
        assert.equal(dl.type, 'application/json');
        const data = JSON.parse(dl.text);
        assert.equal(data.greenhouse_account_id, me.accountId);
        assert.deepEqual(data.greenhouse_sign_ins.map(s => s.platform).sort(), ['kick', 'twitch']);
        assert.equal(data.tables[h.t.accounts].rows.length, 1);
        await waitText(page, '.toast-text', 'Your data is downloading');

        // Tab reaches the delete button; Enter opens the dialog with focus on the confirmation field.
        await page.focus('[data-key="data-download"]');
        await page.keyboard.press('Tab');
        assert.equal(await activeKey(page), 'data-delete');
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog[open] #gh-delete-confirm');
        const dlg = await page.evaluate(() => {
            const d = document.querySelector('dialog[open]');
            return {
                title: document.getElementById(d.getAttribute('aria-labelledby')).textContent,
                modal: d.matches(':modal'),
                text: d.textContent,
                label: d.querySelector('label[for="gh-delete-confirm"]').textContent,
                focus: document.activeElement.id
            };
        });
        assert.equal(dlg.title, 'Delete your save?');
        assert.equal(dlg.modal, true);
        assert.equal(dlg.focus, 'gh-delete-confirm');
        assert.equal(dlg.label, 'Type DELETE to confirm');
        for (const part of ['permanently deletes', 'every sign-in linked to this save', 'cannot be undone', 'signed out on every device']) {
            assert.ok(dlg.text.includes(part), `dialog says "${part}"`);
        }
        await shot(page, 'h641-desktop-dialog');
        await axe(p, 'your-data-delete-dialog');

        // Escape closes it; focus goes back to the button that opened it.
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        assert.equal(await activeKey(page), 'data-delete');

        // A wrong word (lower case) is refused in the page and announced; nothing is deleted.
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog[open] #gh-delete-confirm');
        await page.keyboard.type('delete');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#gh-delete-error[role="alert"]');
        await shot(page, 'h641-desktop-dialog-mismatch');
        assert.equal(await attr(page, '#gh-delete-confirm', 'aria-invalid'), 'true');
        assert.equal(await attr(page, '#gh-delete-confirm', 'aria-describedby'), 'gh-delete-error');
        assert.equal(await activeKey(page), 'delete-confirm', 'focus back on the confirmation field');
        const refs = () => createPrivacy({ db: h.store.db, t: h.t }).countReferences(me.accountId);
        assert.ok(await refs() > 0, 'still there');

        // DELETE: the save and both sign-ins go, the page signs out and says so, the stored token is removed.
        await page.evaluate(() => { document.getElementById('gh-delete-confirm').value = ''; });
        await page.focus('#gh-delete-confirm');
        await page.keyboard.type('DELETE');
        await clickSel(page, '[data-key="delete-go"]');
        await waitText(page, '.screen-error', 'Your save was deleted and you are signed out.');
        assert.equal(await page.evaluate(() => localStorage.getItem('gh.refresh.v1')), null);
        assert.equal(await refs(), 0);
        const [left] = await h.store.db.query(`SELECT COUNT(*) AS n FROM ${h.t.identities} WHERE id IN (?, ?)`, [me.identityId, me.twitchIdentity]);
        assert.equal(Number(left[0].n), 0, 'both sign-ins deleted');
        const [sess] = await h.store.db.query(`SELECT COUNT(*) AS n FROM ${h.t.sessions} WHERE identity_id IN (?, ?)`, [me.identityId, me.twitchIdentity]);
        assert.equal(Number(sess[0].n), 0, 'refresh tokens deleted');
        assert.deepEqual(realErrors(p.log), [], 'console errors');
        assert.deepEqual(p.log.network, [], '5xx answers');
    });

    test('at the panel size (318 px) the card fits without sideways scrolling', async () => {
        const me = await kickPlayer();
        const p = await open('/greenhouse', { width: 318, height: 496, refreshToken: me.refreshToken });
        await clickSel(p.page, '[data-key="tab-profile"]');
        await p.page.waitForSelector('[data-card="your-data"]');
        const r = await p.page.evaluate(() => {
            const el = document.querySelector('[data-card="your-data"]');
            return { right: Math.round(el.getBoundingClientRect().right), width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
        });
        assert.ok(r.right <= r.width && r.scroll <= r.width, JSON.stringify(r));
        await p.page.evaluate(() => document.querySelector('[data-card="your-data"]').scrollIntoView({ block: 'center' }));
        await shot(p.page, 'h641-318-card');
    });
});

describe('Twitch panel: unchanged', () => {
    test('the panel Profile has no Your data card', async () => {
        const opaque = `U${crypto.randomBytes(8).toString('hex')}`;
        const p = await open('/panel/panel.html', { width: 318, height: 496, fakeTwitch: { token: h.extToken({ opaque }), opaque } });
        await clickSel(p.page, '[data-key="tab-profile"]', 15000);
        await p.page.waitForSelector('.about', { timeout: 8000 });
        assert.equal(await p.page.$('[data-card="your-data"]'), null);
        assert.equal(await p.page.evaluate(() => document.body.textContent.includes('Your data')), false);
    });

    test('a fresh panel build is byte-identical to dist/panel/ and to the files in dist/greenhouse-panel.zip', () => {
        const fresh = h.panel.outDir; // built by the harness from the current source
        assert.deepEqual(fs.readdirSync(fresh).sort(), [...PANEL_FILES]);
        const unzipped = fs.mkdtempSync(path.join(os.tmpdir(), 'gh641-zip-'));
        try {
            execFileSync('unzip', ['-q', '-o', path.join(DIST, 'greenhouse-panel.zip'), '-d', unzipped]);
            assert.deepEqual(fs.readdirSync(unzipped).sort(), [...PANEL_FILES], 'zip entries');
            for (const f of PANEL_FILES) {
                const now = fs.readFileSync(path.join(fresh, f));
                assert.ok(now.equals(fs.readFileSync(path.join(DIST, 'panel', f))), `${f} equals dist/panel/${f}`);
                assert.ok(now.equals(fs.readFileSync(path.join(unzipped, f))), `${f} equals the zip's ${f}`);
            }
        } finally {
            fs.rmSync(unzipped, { recursive: true, force: true });
        }
        const js = fs.readFileSync(path.join(fresh, 'panel.js'), 'utf8');
        for (const s of ['your-data', 'Your data', 'Download my data', '/account/export', '/account/delete']) assert.ok(!js.includes(s), `panel.js has no "${s}"`);
        assert.ok(!fs.readFileSync(path.join(fresh, 'panel.css'), 'utf8').includes('your-data'), 'panel.css has no card styles');
        // ...while the website build has both.
        const webJs = fs.readFileSync(path.join(h.web.outDir, 'assets', h.web.files.JS), 'utf8');
        const webCss = fs.readFileSync(path.join(h.web.outDir, 'assets', h.web.files.CSS), 'utf8');
        assert.ok(webJs.includes('Download my data') && webJs.includes('/account/delete'));
        assert.ok(webCss.includes('your-data'));
    });
});
