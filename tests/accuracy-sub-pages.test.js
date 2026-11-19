/**
 * Sub-site accuracy pass (2026-11-19): invite links, TikTok counts, the Kick commands list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const MIN = '1643797540086';

test('custom-bot and server-picker invites ask for the minimum set, like /invite', () => {
    assert.match(read('dashboard/server.js'), /req\.query\.admin === '1' \? '8' : '1643797540086'/, '/invite still defines the set');
    for (const f of ['dashboard/middleware/auth.js', 'dashboard/routes/bots.js', 'dashboard/views/bot-management-tailwind.ejs', 'dashboard/views/bot-assignment.ejs']) {
        const src = read(f);
        assert.doesNotMatch(src, /permissions=8&/, `${f} asks for Administrator`);
        assert.ok(src.includes(`permissions=${MIN}&`), `${f} uses the minimum set`);
    }
    assert.equal(read('dashboard/middleware/auth.js').split(`permissions=${MIN}&`).length - 1, 2, 'both bot-not-in-server redirects');
    const inviteBase = read('dashboard/server.js').match(/inviteBase: `[^`]+`/)[0];
    assert.ok(inviteBase.includes(`permissions=${MIN}&`), 'bot assignment invite');
});

test('TikTok rows saved for older videos keep their counts', () => {
    const src = read('jobs/tiktok-video-checker.js');
    assert.doesNotMatch(src, /video\.(views|likes|shares|comments)\b/, 'fields utils/platforms/tiktok.js never returns');
    assert.equal(src.split('video.view_count ?? 0').length - 1, 2, 'both inserts read view_count');
    const page = read('dashboard/views/tiktok-analytics.ejs');
    assert.doesNotMatch(page, /refreshed when it checks the creator/);
    assert.match(page, /first seen/);
});

test('the Kick commands page does not offer the closed game\'s !cfx commands', () => {
    // The built-in list moved to the module the Kick and Twitch command pages share.
    const route = read('dashboard/routes/channel-bot-commands.js');
    assert.match(route, /command_key NOT IN \('cfx', 'cfxdaily', 'cfxmarket', 'cfxleaderboard', 'cfxsell'\)/);
    const page = read('dashboard/views/kick/channel-commands.ejs');
    assert.doesNotMatch(page, /Leave empty for the built-in reply/, 'built-in custom replies are not used by the bot');
});

test('Kick pages describe the defaults the bot uses', async () => {
    const { DEFAULTS } = await import('../services/certifried-bot/defender/channel-settings.js');
    assert.equal(DEFAULTS.phishingThreshold, 2);
    const panel = read('dashboard/views/kick/panel.ejs');
    assert.match(panel, /default 2\./);
    assert.match(panel, /value="2"/);
    const features = read('dashboard/views/kick/features.ejs');
    const protection = features.slice(features.indexOf("title: 'Protection'"), features.indexOf("title: 'Moderation'"));
    assert.doesNotMatch(protection, /Automod/, 'automod is off until rules are set (tests/kick/defaults.test.js)');
    assert.doesNotMatch(features, /banned anywhere on the network/);
});
