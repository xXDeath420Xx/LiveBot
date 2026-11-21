import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { gamesWithDefaults, mediaWithDefaults, ttsWithDefaults, HEIST_TARGETS, HEIST_LABEL, APPROVAL, APPROVAL_LABEL, LIMITS } from '../core/stream-bot/community/settings.js';
import { commandDrafts } from '../core/stream-bot/community/seed.js';

/*
 * The Community tab (dashboard/routes/stream-bot-community.js, views/stream-bot/community*.ejs, mediashare-overlay.ejs,
 * public/js/stream-bot-community.js, public/js/stream-bot-mediashare.js) with invented Maple Hollow data:
 *   render   Dark, Light and Sand: the overview, games, store, quotes and media pages; one h1; the Stream bot tabs with Community
 *            current and the Community sub-navigation; every label points at a control; ids unique; not-migrated states
 *   copy     sentence case headings, no emoji, nothing about buying points with money
 *   safety   page JSON cannot close its <script>; scripts set text with textContent and never innerHTML; the OBS page loads
 *            nothing from outside CertiFried except the muted YouTube player, and never unmutes it
 *   routes   pages and API need a session, literal paths before /:param, server.js mounts the router after the overlay routes,
 *            the OBS page is GET only (so it needs no CSRF exemption), the tab is listed
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
const cmds = (group, made = 0) => commandDrafts(group).map((d, i) => ({ name: d.name, command: d.trigger_config.match.text.trim(), id: i < made ? 700 + i : null, enabled: false }));
const when = new Date('2026-11-20T19:30:00Z');

const PAGES = {
    overview: ['stream-bot/community', { active: 'community', section: 'overview', ready: true, counts: { items: 3, quotes: { total: 12, off: 2 }, media: 1 }, currency: 'leaves', gamesOn: ['slots', 'heist'], mediaOpen: true }],
    games: ['stream-bot/community-games', { active: 'community', section: 'games', ready: true, pointsReady: true, settings: gamesWithDefaults({ slots: { enabled: true } }), tablesReady: true,
        heistTargets: HEIST_TARGETS.map((k) => ({ value: k, label: HEIST_LABEL[k] })), limits: LIMITS, currency: 'leaves', commands: cmds('games', 4),
        live: { lineup: { open: true, list: [{ name: 'MapleFan_88', platform: 'twitch', sub: true, at: when.toISOString() }, { name: 'Pip', platform: 'kick', sub: false, at: when.toISOString() }] }, raffle: { cost: 10, winners: 1, maxTickets: 10, entries: 2, tickets: 5, names: [] }, heist: null } }],
    store: ['stream-bot/community-store', { active: 'community', section: 'store', ready: true, currency: 'leaves',
        items: [{ id: 1, name: 'Hydrate', description: 'Drink some water', cost: 500, stock: 3, perUserLimit: 1, limitWindow: 'day', cooldownSec: 60, automationId: 9, enabled: true }, { id: 2, name: 'Free hug', description: '', cost: 0, stock: null, perUserLimit: null, limitWindow: 'day', cooldownSec: 0, automationId: null, enabled: false }],
        redemptions: [{ id: 5, itemName: 'Hydrate', platform: 'twitch', viewerName: 'Wren_Reads', cost: 500, status: 'done', createdAt: when }, { id: 4, itemName: 'Hydrate', platform: 'kick', viewerName: 'Pip', cost: 500, status: 'refunded', createdAt: when }],
        automations: [{ id: 9, name: 'Store: hydrate text', enabled: false }], windows: [{ value: 'day', label: 'in 24 hours' }, { value: 'ever', label: 'ever' }], commands: cmds('store') }],
    quotes: ['stream-bot/community-quotes', { active: 'community', section: 'quotes', ready: true, q: '',
        quotes: [{ id: 1, number: 1, text: 'one more try </script><b>x</b>', saidBy: 'MapleFan_88', game: 'Celeste', enabled: true, importedFrom: null, line: '' }, { id: 2, number: 2, text: 'the floor is lava', saidBy: 'Wren_Reads', game: 'Minecraft', enabled: false, importedFrom: 'firebot', line: '' }],
        counts: { total: 2, off: 1 }, commands: cmds('quotes', 3) }],
    media: ['stream-bot/community-media', { active: 'community', section: 'media', ready: true, running: true, media: mediaWithDefaults({ open: true }), tts: ttsWithDefaults({ words: ['noob*'] }),
        approval: APPROVAL.map((k) => ({ value: k, label: APPROVAL_LABEL[k] })), voices: [{ value: 'ryan', label: 'Ryan (medium, male) · US English' }, { value: 'alan', label: 'Alan (medium, male) · British English' }], builtIn: 33, limits: LIMITS,
        pageUrl: 'https://certifriedmultitool.com/stream/bot/overlay/mediashare/sbs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', status: { pages: 1, previews: 0, gate: { vodSafe: false, reason: 'Studio is not connected.' } }, musicRunning: true,
        queue: [{ id: 3, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Cat video', channel: 'Cats Ltd', viewerName: 'MapleFan_88', durationMs: 95_000, status: 'pending' }, { id: 4, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Dog video', channel: '', viewerName: 'Pip', durationMs: 61_000, status: 'playing' }],
        history: [{ title: 'Old one', url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', viewerName: 'Wren_Reads', status: 'played' }],
        commands: cmds('media'), ttsCommands: cmds('tts'), currency: 'leaves' }],
};

function checkPage(html, label, section) {
    const h1 = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/g) || [];
    assert.equal(h1.length, 1, `${label}: one h1`);
    assert.ok(html.includes('<nav class="sb-tabs" aria-label="Stream bot">'), `${label}: tabs`);
    assert.match(html, /href="\/stream\/bot\/community" aria-current="page">Community</, `${label}: Community is the current tab`);
    assert.ok(html.includes('<nav class="sbc-subnav" aria-label="Community">'), `${label}: sub-navigation`);
    if (section !== 'overview') assert.match(html, new RegExp(`href="/stream/bot/community/${section}" aria-current="page"`), `${label}: its sub-page is current`);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `${label}: ids are unique`);
    for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `${label}: label for="${m[1]}" has a control`);
    for (const m of html.matchAll(/<h[12]\b[^>]*>([^<]+)</g)) {
        const t = m[1].trim();
        assert.ok(!/ [A-Z][a-z]+ [A-Z][a-z]/.test(t.replace(/CertiFried [A-Z][a-z]+( [A-Z][a-z]+)?|Media Share|Stream bot/g, '')), `${label}: "${t}" is sentence case`);
    }
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), `${label}: no emoji`);
    assert.ok(!/(buy|purchase)\s+(points|leaves)/i.test(html), `${label}: never sells points`);
    const data = html.match(/<script type="application\/json" id="sbc-data">([\s\S]*?)<\/script>/);
    if (data) assert.doesNotThrow(() => JSON.parse(data[1]), `${label}: page JSON parses`);
}

test('every Community page renders in Dark, Light and Sand', () => {
    for (const [section, [template, locals]] of Object.entries(PAGES)) {
        for (const theme of ['dark', 'light', 'sand']) {
            const html = render(template, locals, theme);
            assert.match(html, new RegExp(`<html data-theme="${theme}"`));
            checkPage(html, `${section}/${theme}`, section);
        }
    }
    const games = render(...PAGES.games);
    assert.match(games, /id="sbc-slots-on" checked/);
    assert.match(games, /<option value="easy" selected>Corner Store<\/option>/);
    assert.match(games, /<code>!slots<\/code>[\s\S]*?<span class="cf-cell-muted">Not added/, 'commands not added yet are listed');
    const store = render(...PAGES.store);
    assert.match(store, /<a href="\/stream\/bot\/automations\/9">Store: hydrate text<\/a>/);
    assert.match(store, /data-refund="5"/);
    assert.ok(!/data-refund="4"/.test(store), 'a refunded one has no button');
    const quotes = render(...PAGES.quotes);
    assert.ok(!quotes.includes('</script><b>x</b>'), 'quote text is escaped');
    assert.match(quotes, /1 quote is switched off/);
    assert.match(quotes, /Imported from Firebot/);
    const media = render(...PAGES.media);
    assert.match(media, /VOD protection is off, so videos wait: Studio is not connected\./);
    assert.match(media, /data-media="approve" data-id="3"/);
    assert.match(media, /data-media="remove" data-id="4">Skip</);
    assert.match(media, /value="sbs_A{32}"|mediashare\/sbs_A{32}/);
    assert.match(media, /<textarea id="sbc-tts-words"[^>]*>noob\*<\/textarea>/);
});

test('not-migrated states say when things start', () => {
    assert.match(render('stream-bot/community', { ...PAGES.overview[1], ready: false, counts: null }), /start after the next CertiFried update/);
    assert.match(render('stream-bot/community-store', { ...PAGES.store[1], ready: false, items: [], redemptions: [] }), /The store starts after the next CertiFried update/);
    assert.match(render('stream-bot/community-quotes', { ...PAGES.quotes[1], ready: false, quotes: [], counts: { total: 0, off: 0 } }), /Quotes start after the next CertiFried update/);
    assert.match(render('stream-bot/community-media', { ...PAGES.media[1], ready: false, running: false, media: null, tts: null, pageUrl: null, status: null, queue: [], history: [] }), /start after the next CertiFried update/);
    assert.match(render('stream-bot/community-games', { ...PAGES.games[1], ready: false, live: null }), /Chat games start after the next CertiFried update/);
});

test('the OBS page: muted video only from youtube-nocookie, speech from this server, text set safely', () => {
    const html = render('stream-bot/mediashare-overlay', { preview: false });
    assert.match(html, /<title>CertiFried Media Share<\/title>/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.ok(!/https?:\/\//.test(html), 'the page itself loads nothing from outside');
    const js = read('dashboard/public/js/stream-bot-mediashare.js');
    const hosts = [...js.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(hosts)], ['www.youtube-nocookie.com']);
    assert.match(js, /mute=1/);
    assert.ok(!/unMute|mute=0|setVolume/.test(js), 'never unmutes a video');
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(js));
    const cjs = read('dashboard/public/js/stream-bot-community.js');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(cjs), 'the dashboard script builds no markup from strings');
    for (const f of ['dashboard/public/css/stream-bot-community.css']) assert.ok(!/#[0-9a-f]{3,6}\b/i.test(read(f)), `${f}: colours from the theme tokens only`);
});

test('routes: session on pages and API, literal paths first, mounted after the overlay routes, the OBS page GET only, the tab listed', () => {
    const src = read('dashboard/routes/stream-bot-community.js');
    for (const m of src.matchAll(/router\.(get|post|put|delete)\('([^']+)', ([a-zA-Z]+)/g)) {
        const [, method, p, first] = m;
        if (p.startsWith('/stream/bot/overlay/')) { assert.equal(method, 'get', `${p} is GET only`); continue; }
        assert.ok(first === 'needPage' || first === 'needApi', `${method} ${p} needs a session`);
    }
    const order = [...src.matchAll(/router\.\w+\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(order.indexOf('/stream/bot/api/community/quotes/enable-imported') < order.indexOf('/stream/bot/api/community/quotes/:id'), 'literal before /:id');
    const server = read('dashboard/server.js');
    assert.ok(server.indexOf("import('./routes/stream-bot-overlays.js')") < server.indexOf("import('./routes/stream-bot-community.js')"), 'after the overlay routes');
    assert.ok(!server.includes("'/stream/bot/overlay/mediashare/'"), 'no CSRF exemption needed');
    assert.match(read('dashboard/views/stream-bot/_tabs.ejs'), /\['community', '\/stream\/bot\/community', 'Community'\]/);
    assert.match(read('core/stream-bot/index.js'), /attachCommunity\(box\)/);
});
