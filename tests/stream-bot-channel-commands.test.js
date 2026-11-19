import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { channelCommandsPage, CHANNEL_COMMANDS_PAGE_ID } from '../scripts/site-shots/stream-bot-import-demo.mjs';

/*
 * Twitch channel commands in the stream bot area (/stream/bot/commands/:channelId: dashboard/routes/stream-bot-channel.js,
 * views/stream-bot/channel-commands.ejs) and the code it shares with the Kick page (views/partials/channel-bot/commands-body.ejs,
 * dashboard/routes/channel-bot-commands.js, public/css/channel-bot.css).
 *
 *   render   Dark, Light and Sand; one h1, the Commands tab current, the Chat commands switch with its label and the
 *            note that imported commands stay off; the body talks to the Twitch API base; no timers form on Twitch
 *   shared   the Kick page and the Twitch page include the same partial; both route files mount the same handlers;
 *            both frames link the shared CSS
 *   routes   session first, literal before param, the switch only writes features_enabled.commands, ownership needs a
 *            channel linked to the user's own profile and a channel bot row
 *   browser  the theme audit for the page; THEME_RENDER_SKIP=1 skips it
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
const render = (template, locals, theme = 'dark') => engine.renderFile(path.join(views, `${template}.ejs`), { ...common(theme), ...locals, settings: {}, _locals: {} });

test('the Twitch commands page renders in Dark, Light and Sand with the switch, the imported note and the shared body', () => {
    const page = channelCommandsPage();
    for (const theme of ['dark', 'light', 'sand']) {
        const html = render(page.template, page.locals, theme);
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
        assert.match(html, /<h1[^>]*>maplehollow_tv<\/h1>/);
        assert.match(html, /<a href="\/stream\/bot\/commands" aria-current="page">Commands<\/a>/);
        assert.match(html, /<label class="cf-row-label" for="sbc-master">/);
        assert.match(html, /id="sbc-master" data-channel="700000001">/, 'the switch is off as stored');
        assert.match(html, /the 2 commands imported from Firebot or Streamer\.bot stay off/);
        assert.match(html, /var base = "\/stream\/bot\/api\/twitch-channel\/700000001"/, 'the shared body uses the Twitch API');
        assert.equal(html.includes('id="tm-add"'), false, 'no timers form on Twitch');
        assert.match(html, /Timed messages are sent on Kick only/);
        assert.ok(html.includes('!lurk') && html.includes('!rules'), 'commands listed');
        assert.ok(html.includes('href="/css/channel-bot.css'));
        assert.ok(html.includes('src="/js/kick-dashboard.js'));
        const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(new Set(all).size, all.length, 'ids are unique');
        for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) assert.ok(all.includes(m[1]), `label for="${m[1]}" has its control`);
    }
    const list = render(page.template, { ...page.locals, channel: null, bots: [{ channelId: '700000001', name: 'maplehollow_tv' }] });
    assert.match(list, /href="\/stream\/bot\/commands\/700000001">Open<\/a>/, 'the list links each channel');
});

test('the Kick page renders the same partial against the Kick API, timers included', () => {
    const page = channelCommandsPage();
    const html = render('kick/channel-commands', { ...page.locals, user: { id: 1, name: 'maple' }, channel: { ...page.locals.channel, channel_id: '700000002', channel_name: 'maplehollow' } });
    assert.match(html, /var base = "\/kick\/api\/channel\/700000002"/);
    assert.ok(html.includes('id="tm-add"'), 'Kick has timers');
    assert.ok(html.includes('href="/css/channel-bot.css'), 'the Kick frame links the shared CSS');
    assert.match(read('dashboard/views/kick/channel-commands.ejs'), /include\('\.\.\/partials\/channel-bot\/commands-body'/);
    assert.match(read('dashboard/views/stream-bot/channel-commands.ejs'), /include\('\.\.\/partials\/channel-bot\/commands-body'/);
});

test('both route files mount the shared handlers; the Twitch routes check the session and ownership', () => {
    const kick = read('dashboard/routes/kick-channel.js');
    const tw = read('dashboard/routes/stream-bot-channel.js');
    assert.match(kick, /mountChannelCommandRoutes\(router, \{\s*base: '\/kick\/api\/channel', guard: requireKickAuth/);
    assert.match(tw, /mountChannelCommandRoutes\(router, \{\s*base: API, guard: needApi/);
    assert.doesNotMatch(kick, /router\.(post|put|delete|get)\('\/kick\/api\/channel\/:channelId\/(custom|responders|commands\/)/, 'no second copy of the handlers in kick-channel.js');
    const routes = [...tw.matchAll(/^router\.(get|post|put|delete)\(\s*[`']([^`']+)[`']\s*,\s*([A-Za-z]+)/gm)].map((m) => ({ method: m[1], path: m[2].replace('${API}', '/stream/bot/api/twitch-channel'), first: m[3] }));
    assert.ok(routes.length >= 3);
    for (const r of routes) assert.equal(r.first, r.path.startsWith('/stream/bot/api/') ? 'needApi' : 'needPage', `${r.method} ${r.path}`);
    assert.ok(routes.findIndex((r) => r.path === '/stream/bot/commands') < routes.findIndex((r) => r.path === '/stream/bot/commands/:channelId'));
    assert.match(tw, /JSON_SET\(COALESCE\(features_enabled, '\{\}'\), '\$\.commands', JSON_EXTRACT\(\?, '\$'\)\)/, 'the switch writes features_enabled.commands only');
    assert.doesNotMatch(tw, /req\.(params|query|body)\??\.profile/i);
    assert.match(read('dashboard/server.js'), /import\('\.\/routes\/stream-bot-channel\.js'\)/);
    assert.match(read('dashboard/views/stream-bot/_tabs.ejs'), /\['commands', '\/stream\/bot\/commands', 'Commands'\]/);
});

test('ownership: only a Twitch channel linked to the user\'s own profile that the channel bot serves', async () => {
    const { resolveTwitchChannel, twitchChannelBots } = await import('../dashboard/routes/stream-bot-channel.js');
    const store = {
        getProfileByOwner: async (id) => (id === 'owner' ? { id: 7 } : null),
        listChannels: async () => [{ platform: 'twitch', platform_user_id: '700000001', login: 'maplehollow_tv' }, { platform: 'kick', platform_user_id: '700000002' }],
    };
    const db = { execute: async (sql, [cid]) => [[cid === '700000001' ? { id: 2, channel_id: '700000001', channel_name: 'maplehollow_tv' } : undefined].filter(Boolean)] };
    assert.deepEqual(await twitchChannelBots({ store, db, ownerId: 'owner' }), [{ id: 2, channelId: '700000001', name: 'maplehollow_tv' }]);
    assert.equal((await resolveTwitchChannel({ store, db, ownerId: 'owner', channelId: '700000001' })).id, 2);
    assert.equal(await resolveTwitchChannel({ store, db, ownerId: 'someone-else', channelId: '700000001' }), null, 'not your profile');
    assert.equal(await resolveTwitchChannel({ store, db, ownerId: 'owner', channelId: '700000002' }), null, 'a Kick id is not a Twitch channel');
    assert.equal(await resolveTwitchChannel({ store, db, ownerId: 'owner', channelId: '1 OR 1=1' }), null);
});

test('Twitch commands page in Dark, Light and Sand: no contrast violation, no wrong-family box, no flash, no script error', { skip: process.env.THEME_RENDER_SKIP === '1', timeout: 600000 }, async () => {
    const { audit } = await import('../scripts/theme-audit/run.mjs');
    const { report } = await audit({ only: [CHANNEL_COMMANDS_PAGE_ID, 'kick-channel-commands'], concurrency: 1, sheetIds: [], quiet: true });
    const problems = [];
    for (const id of [CHANNEL_COMMANDS_PAGE_ID, 'kick-channel-commands']) {
        const p = report.pages[id];
        if (!p) { problems.push(`${id}: not in the audit`); continue; }
        for (const t of report.themes) {
            const e = p[t];
            if (e.failed) problems.push(`${id} ${t}: failed (${e.failed})`);
            for (const n of e.nodes) problems.push(`${id} ${t}: contrast ${n.ratio}:1 (${n.fg} on ${n.bg}) ${n.target}`);
            for (const n of e.islands) problems.push(`${id} ${t}: ${n.bg} box ${n.w}x${n.h} ${n.sel}`);
            for (const err of e.errors) problems.push(`${id} ${t}: script error ${err}`);
            if (e.firstPaint && !e.firstPaint.ok) problems.push(`${id} ${t}: first frame differs`);
        }
    }
    assert.deepEqual(problems, []);
});
