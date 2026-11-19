// Greenhouse Tycoon (phase 4): the website's new cards in a headless browser, at desktop width and at the
// panel size (318 x 496 and 380 wide), against a throwaway v2 server (_frontend-harness.js, ghtest_ tables):
//   - quests: the "done" reminder, Show, collect
//   - the season card, the leaderboard dialog (season and all time, two pages, your own place)
//   - decorations: buy, show in the greenhouse strip, put away
//   - achievements: unlocked by the purchase, collected from Profile
//   - notifications: the bell's unread count, the list, mark all as read
//   - Replant: refused below level 25, the confirm dialog lists what resets and what stays, level back to 1
//   - the fonts come from /greenhouse/assets, never from a font host; no sideways scrolling; no console errors;
//     keyboard: the bell and the dialogs
// Optional: GH_SHOTS_DIR (screenshots), GH_AXE_PATH (axe-core, writes a11y-phase4.json).
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
let player;

before(async () => {
    h = await startHarness();
    b = await launchBrowser();
    // A season with a running weekly challenge (one active player is enough in this test).
    await h.store.flags.set('challenges.minActivePlayers', 1, 'test');
    player = await h.devSignIn('p4-player', 'Fern Fan');
    await h.store.meta.startSeason();
    await h.store.meta.advanceChallenges();
    h.store.meta.invalidate();
    // 25 other growers on both boards, so the leaderboard has two pages.
    const cur = await h.store.meta.current();
    for (let i = 1; i <= 25; i++) {
        const [r] = await h.store.db.query(`INSERT INTO ${h.t.accounts} (display_name, level) VALUES (?, ?)`, [`Grower ${i}`, 1 + (i % 9)]);
        const id = Number(r.insertId);
        await h.store.db.query(`INSERT INTO ${h.t.season_standings} (season_id, account_id, score) VALUES (?, ?, ?)`, [cur.season.id, id, 50 * i]);
        await h.store.db.query(`INSERT INTO ${h.t.account_stats} (account_id, xp_earned) VALUES (?, ?)`, [id, 100 * i]);
    }
});

after(async () => {
    for (const p of pages) await p.page.close().catch(() => {});
    if (b) await b.close();
    if (SHOTS && a11y.length) fs.writeFileSync(path.join(SHOTS, 'a11y-phase4.json'), JSON.stringify(a11y, null, 2));
    const left = h ? await h.close() : [];
    await closePool();
    assert.deepEqual(left, [], 'ghtest_ tables dropped');
});

async function open(url, opts) {
    const p = await openPage(b.browser, h, url, opts);
    pages.push(p);
    return p;
}

/** A new tab signed in as the test player (each tab rotates its own refresh token). */
async function openAs(opts) {
    const s = await h.devSignIn('p4-player');
    return open('/greenhouse', { ...opts, refreshToken: s.refreshToken });
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
        return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')) })) };
    });
    a11y.push({ label, ...res });
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

const toastSeen = (page, text) => waitText(page, '.toast-text', text);
// Wait until the dialog is gone from the page (its close event, which returns focus, runs a moment after Escape).
const closeDialog = async (page) => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog')); };
// Click through the DOM: a re-render between finding and clicking an element cannot detach it.
async function tap(page, sel) {
    await page.waitForSelector(sel);
    await page.evaluate((x) => { const el = document.querySelector(x); if (!el) throw new Error(`missing ${x}`); el.click(); }, sel);
}
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const isDisabled = (page, sel) => page.evaluate((s) => !!document.querySelector(s)?.disabled, sel);

/** Mark one of today's quests done (as if the player had played it), as the server would. */
async function finishAQuest(accountId) {
    await h.api('GET', '/state', { token: (await h.devSignIn('p4-player')).token });
    const [rows] = await h.store.db.query(`SELECT quest_code, period_key FROM ${h.t.account_quests} WHERE account_id = ? AND period_key LIKE 'd%' ORDER BY quest_code LIMIT 1`, [accountId]);
    await h.store.db.query(`UPDATE ${h.t.account_quests} SET progress = target, completed_at = NOW(3) WHERE account_id = ? AND quest_code = ? AND period_key = ?`, [accountId, rows[0].quest_code, rows[0].period_key]);
    await h.store.db.query(`UPDATE ${h.t.accounts} SET state_version = state_version + 1 WHERE id = ?`, [accountId]);
}

describe('phase 4 on the website (desktop)', () => {
    test('quests, season and leaderboard, decorations, achievements, notifications, Replant', async () => {
        await finishAQuest(player.accountId);
        await h.boost(player.accountId, { cash: 2_000_000, level: 12 });
        const p = await openAs({ width: 1280, height: 800 });
        const page = p.page;
        await page.waitForSelector('[data-key="plot-1"]');

        // Quests: the reminder, Show focuses the first Collect, and collecting pays.
        await waitText(page, '.reminder p', 'quest is done');
        await shot(page, 'p4-desktop-grow');
        await tap(page, '[data-key="quests-show"]');
        assert.match(await page.evaluate(() => document.activeElement.dataset.key || ''), /^quest-claim-d/);
        await page.keyboard.press('Enter');
        await toastSeen(page, 'Quest reward');
        await page.waitForFunction(() => !document.querySelector('.reminder'));
        await waitText(page, '.quest-challenge', 'Weekly challenge');

        // The season card and the leaderboard: two pages, then all time.
        await tap(page, '[data-key="tab-profile"]');
        await waitText(page, '#gh-season-title', 'Season 1');
        await tap(page, '[data-key="open-board"]');
        await page.waitForSelector('dialog[open] .board-row');
        assert.equal(await count(page, 'dialog[open] .board-row'), 20);
        await waitText(page, 'dialog[open] .board-row', 'Grower 25');
        await waitText(page, 'dialog[open]', 'Page 1 of 2');
        await shot(page, 'p4-desktop-leaderboard');
        await tap(page, '[data-key="board-next"]');
        await waitText(page, 'dialog[open]', 'Page 2 of 2');
        await waitText(page, 'dialog[open] .board-row', 'Grower 1');
        await waitText(page, 'dialog[open] .board-me', 'You');
        await clickText(page, 'dialog[open] .seg', 'All time');
        await waitText(page, 'dialog[open] .board-row', 'XP');
        await closeDialog(page);

        // Decorations: buy one, it shows in the greenhouse; put it away.
        await tap(page, '[data-key="tab-upgrades"]');
        await clickText(page, '.seg', 'Decorations');
        await page.waitForSelector('[data-key="decor-buy-potted_fern"]');
        await shot(page, 'p4-desktop-decorations');
        await tap(page, '[data-key="decor-buy-potted_fern"]');
        await toastSeen(page, 'is now in your greenhouse');
        await page.waitForSelector('[data-key="decor-place-potted_fern"]');
        await tap(page, '[data-key="tab-grow"]');
        await waitText(page, '.decor-strip .decor-name', 'Hanging fern basket');
        await tap(page, '[data-key="tab-upgrades"]');
        await tap(page, '[data-key="decor-place-potted_fern"]');
        await waitText(page, '[data-key="decor-place-potted_fern"]', 'Show');
        await tap(page, '[data-key="tab-grow"]');
        await page.waitForFunction(() => !document.querySelector('.decor-strip'));

        // The purchase unlocked an achievement: a notification, then collect it on Profile.
        await page.waitForSelector('.bell-count');
        await tap(page, '[data-key="notifications"]');
        await waitText(page, 'dialog[open] .note', 'Achievement unlocked');
        await shot(page, 'p4-desktop-notifications');
        await tap(page, '[data-key="notes-read"]');
        await page.waitForFunction(() => !document.querySelector('.bell-count'));
        await closeDialog(page);
        await tap(page, '[data-key="tab-profile"]');
        await page.waitForSelector('[data-key="ach-claim-decor_1"]');
        await tap(page, '[data-key="ach-claim-decor_1"]');
        await toastSeen(page, 'Homely touch');
        await page.waitForSelector('[data-key="ach-all"]:not([disabled])');
        await tap(page, '[data-key="ach-all"]');
        await waitText(page, 'dialog[open] .quest-title', 'First harvest');
        await closeDialog(page);
        await shot(page, 'p4-desktop-profile');

        // Replant: closed below level 25; open at 25; the dialog says what resets and what stays.
        await tap(page, '[data-key="tab-upgrades"]');
        await page.waitForSelector('[data-key="replant"]');
        assert.equal(await isDisabled(page, '[data-key="replant"]'), true, 'Replant is closed at level 12');
        await h.boost(player.accountId, { level: 25 });
        await page.waitForFunction(() => { const x = document.querySelector('[data-key="replant"]'); return x && !x.disabled; }, { timeout: 20000 });
        await tap(page, '[data-key="replant"]');
        await waitText(page, 'dialog[open]', 'Starts again');
        await waitText(page, 'dialog[open]', 'Badges and decorations');
        await shot(page, 'p4-desktop-replant-confirm');
        await tap(page, '[data-key="replant-confirm"]');
        await toastSeen(page, 'Replanted');
        await waitText(page, '.level-chip', 'Lv 1');
        await waitText(page, '#gh-view-title', 'Greenhouse');
        await noSideways(page, 'desktop');
        await axe(p, 'p4-desktop-grow-after-replant');

        const fonts = p.log.fonts.filter(u => u.includes('/greenhouse/assets/Geist-Variable.'));
        assert.ok(fonts.length >= 1, `the Geist font loads from the site: ${JSON.stringify(p.log.fonts)}`);
        clean(p, 'desktop phase 4');
        assert.deepEqual(h.errorsLogged, [], 'no server errors');

        const st = await h.api('GET', '/state', { token: (await h.devSignIn('p4-player')).token });
        assert.equal(st.json.state.replant.count, 1);
        assert.equal(st.json.state.account.level, 1);
        assert.equal(st.json.state.cosmetics.decorations.length, 1, 'the decoration survives the Replant');
    });
});

describe('phase 4 at the panel size', () => {
    test('every new card and dialog fits at 318 and 380 wide; keyboard reaches the bell', async () => {
        for (const width of [318, 380]) {
            const p = await openAs({ width, height: 496 });
            const page = p.page;
            await page.waitForSelector('[data-key="plot-1"]');
            for (const [tab, seg] of [['grow', null], ['upgrades', 'Upgrades'], ['upgrades', 'Decorations'], ['profile', null]]) {
                await tap(page, `[data-key="tab-${tab}"]`);
                if (seg) await clickText(page, '.seg', seg);
                await sleep(250);
                await noSideways(page, `${width} ${tab} ${seg || ''}`);
                await shot(page, `p4-${width}-${tab}${seg ? `-${seg.toLowerCase()}` : ''}`);
                if (width === 318) await axe(p, `p4-318-${tab}${seg ? `-${seg.toLowerCase()}` : ''}`);
            }
            await tap(page, '[data-key="open-board"]');
            await page.waitForSelector('dialog[open] .board-row');
            await noSideways(page, `${width} leaderboard`);
            await shot(page, `p4-${width}-leaderboard`);
            await closeDialog(page);
            await page.waitForSelector('[data-key="ach-all"]:not([disabled])');
            await tap(page, '[data-key="ach-all"]');
            await page.waitForSelector('dialog[open] .quest');
            await noSideways(page, `${width} achievements`);
            await closeDialog(page);

            // Keyboard: the bell opens the list, Escape closes it and focus returns to the bell.
            await page.focus('[data-key="notifications"]');
            assert.equal(await page.evaluate(() => `${document.activeElement.dataset.key}|${document.querySelectorAll('dialog').length}`), 'notifications|0', 'the bell has focus and no dialog is left');
            await page.keyboard.press('Enter');
            await page.waitForSelector('dialog[open]');
            assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog[open]')), 'focus moves into the dialog');
            await noSideways(page, `${width} notifications`);
            await shot(page, `p4-${width}-notifications`);
            await closeDialog(page);
            assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'notifications', 'focus returns to the bell');
            clean(p, `${width} panel size`);
            await page.close();
        }
    });
});
