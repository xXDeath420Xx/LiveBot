// Greenhouse Tycoon (phase 3), optional: the Lighthouse accessibility score of /greenhouse (audit B8 row 3 asks
// for 90 or more), signed out and signed in, at 318 x 496 and at desktop width.
// Lighthouse is not a dependency of the repo. Install it anywhere outside the repo and point at it:
//   npm install --prefix /tmp/gh-tools lighthouse@12
//   GH_LIGHTHOUSE=/tmp/gh-tools/node_modules/lighthouse/core/index.js node --test tests/cfx/v2/frontend-lighthouse.test.js
// Without GH_LIGHTHOUSE the test is skipped. GH_SHOTS_DIR=<dir> also writes lighthouse-a11y.json there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closePool } from './_helpers.js';
import { startHarness, launchBrowser } from './_frontend-harness.js';

const LH = process.env.GH_LIGHTHOUSE && fs.existsSync(process.env.GH_LIGHTHOUSE) ? process.env.GH_LIGHTHOUSE : null;
const SHOTS = process.env.GH_SHOTS_DIR || null;
let h;
let b;
const scores = [];

before(async () => {
    if (!LH) return;
    h = await startHarness();
    b = await launchBrowser();
});

after(async () => {
    if (!LH) return;
    if (b) await b.close();
    if (SHOTS && scores.length) {
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'lighthouse-a11y.json'), JSON.stringify(scores, null, 2));
    }
    const left = h ? await h.close() : [];
    await closePool();
    assert.deepEqual(left, []);
});

async function audit(label, { width, height, mobile, refreshToken = null }) {
    const { default: lighthouse } = await import(pathToFileURL(LH).href);
    const context = await b.browser.createBrowserContext();
    const page = await context.newPage();
    try {
        await page.evaluateOnNewDocument((rt) => {
            if (rt) { try { if (!sessionStorage.getItem('gh.seeded')) { localStorage.setItem('gh.refresh.v1', rt); sessionStorage.setItem('gh.seeded', '1'); } } catch (e) { /* none */ } }
        }, refreshToken);
        const flags = { output: 'json', logLevel: 'error', onlyCategories: ['accessibility'], disableStorageReset: true };
        const config = {
            extends: 'lighthouse:default',
            settings: {
                onlyCategories: ['accessibility'],
                formFactor: mobile ? 'mobile' : 'desktop',
                screenEmulation: { mobile, width, height, deviceScaleFactor: 1, disabled: false },
                throttlingMethod: 'provided',
                disableStorageReset: true
            }
        };
        const result = await lighthouse(`${h.origin}/greenhouse`, flags, config, page);
        const lhr = result.lhr;
        const score = Math.round(lhr.categories.accessibility.score * 100);
        const failed = Object.values(lhr.audits)
            .filter(a => a.score !== null && a.score < 1 && a.scoreDisplayMode === 'binary')
            .map(a => a.id);
        const text = await page.evaluate(() => document.body.innerText.slice(0, 60).replace(/\s+/g, ' '));
        scores.push({ label, score, failed, screen: text });
        return { score, failed };
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
    }
}

test('Lighthouse accessibility of /greenhouse is 90 or more', { skip: !LH && 'GH_LIGHTHOUSE not set' }, async () => {
    const s = await h.devSignIn('lh-player', 'Lighthouse');
    const runs = [
        ['signed out, 318 x 496', { width: 318, height: 496, mobile: true }],
        ['signed out, desktop', { width: 1280, height: 800, mobile: false }],
        ['game, 318 x 496', { width: 318, height: 496, mobile: true, refreshToken: s.refreshToken }],
        ['game, desktop', { width: 1280, height: 800, mobile: false, refreshToken: (await h.devSignIn('lh-player')).refreshToken }]
    ];
    for (const [label, opts] of runs) {
        const r = await audit(label, opts);
        console.log(`# lighthouse a11y ${label}: ${r.score}${r.failed.length ? ` (failed: ${r.failed.join(', ')})` : ''}`);
        assert.ok(r.score >= 90, `${label}: ${r.score} ${r.failed.join(', ')}`);
    }
});
