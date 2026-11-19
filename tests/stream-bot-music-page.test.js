import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { COMMANDS, DEFAULT_MESSAGES, MESSAGE_VARS } from '../core/stream-bot/music/text.js';
import { withDefaults, APPROVAL_MODES, SOURCES, SOURCE_LABEL, LIMITS } from '../core/stream-bot/music/settings.js';

/*
 * The Music page and the OBS player page (dashboard/routes/stream-bot-music.js, views/stream-bot/music.ejs and
 * music-overlay.ejs, public/js/stream-bot-music*.js):
 *   render   Dark, Light and Sand with invented Maple Hollow data; one h1; the Stream bot tabs with Music current;
 *            labels point at real controls; ids unique; the VOD protection line, its limits and the copyright note
 *   safety   page JSON cannot close its <script>; viewer text is escaped; the scripts never build markup from strings
 *   routes   every API route needs a session; literal paths before /:param paths; overlay routes rate limited and
 *            without a session; the audio route checks the signature before anything else
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

const req = (id, status, title, viewer, extra = {}) => ({ id, status, title, artist: 'Maple Hollow Band', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', source: 'youtube', viewer, platform: 'twitch', length: '3:20', explicit: null, playlist: null, reason: null, createdAt: '2026-11-19T12:00:00.000Z', ...extra });
function locals(over = {}) {
    const state = {
        vod: { on: true, line: 'VOD protection: on (music kept off Twitch VOD track 2)', overlay: true, held: null, studio: true },
        running: true, overlays: 1,
        now: { title: 'Golden Hour', artist: 'Maple Hollow Band', url: 'https://open.spotify.com/track/0000000000000000000001', requester: 'MapleFan_88', playlist: null, paused: false, position: '1:02', length: '3:20' },
        pending: [req(11, 'pending', 'Night Drive', 'BrambleByte_Live')], queued: [req(12, 'queued', 'Song 7', 'Juniper')],
    };
    return {
        ready: true, profile: { id: 1, displayName: 'Maple Hollow' }, state, settings: { ...withDefaults({ fallbackPlaylistId: 3 }), messages: { skipped: 'Gone: {song}' } },
        bans: [{ id: 1, kind: 'track', title: 'Nope', artist: 'Banned Band', createdBy: 'ModJuniper' }, { id: 2, kind: 'artist', artist: 'Loud Artist' }],
        playlists: [{ id: 2, name: 'Liked songs', kind: 'liked', items: 4 }, { id: 3, name: 'Road Trip', kind: 'imported', items: 120, sourceUrl: 'https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC' }],
        history: [req(10, 'played', 'Golden Hour', 'MapleFan_88'), req(9, 'failed', 'Gone Song', 'Juniper', { reason: 'no playable audio' })],
        plays: [], overlayUrl: 'https://certifriedmultitool.com/stream/bot/overlay/music/sbm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        commands: COMMANDS, commandsMade: 0, defaults: DEFAULT_MESSAGES, messageVars: MESSAGE_VARS, approvalModes: APPROVAL_MODES, sources: SOURCES,
        sourceLabels: SOURCE_LABEL, limits: LIMITS, spotifyLinked: true, spotify: { linked: true, enabled: true, playingLive: false, suspended: null, note: "'Night Drive' played from YouTube Music: your Spotify was in use by the Discord music bot." }, musicData: JSON.stringify({ state }).replace(/</g, '\\u003c'),
        ...over,
    };
}

test('the Music page renders in Dark, Light and Sand with its heading, the tabs, VOD protection, the limits and the copyright note', () => {
    for (const theme of ['dark', 'light', 'sand']) {
        const html = render('stream-bot/music', locals(), theme);
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g);
        assert.equal(h1.length, 1);
        assert.match(h1[0], />Music</);
        assert.ok(html.includes('<nav class="sb-tabs" aria-label="Stream bot">'));
        assert.match(html, /href="\/stream\/bot\/music" aria-current="page">Music</);
        assert.ok(html.includes('VOD protection: on (music kept off Twitch VOD track 2)'));
        assert.match(html, /clips/i);
        assert.match(html, /Kick VODs if Kick gets the live track/);
        assert.match(html, /Record without music/);
        assert.match(html, /copyrighted music on stream can still lead to takedowns/);
        assert.ok(html.includes('Spotify linked: plays real Spotify audio.'));
        assert.match(html, /played from YouTube Music: your Spotify was in use by the Discord music bot/);
        assert.match(html, /Spotify's terms do not allow broadcasting its audio in public/);
        assert.ok(html.includes('src="/js/stream-bot-music.js'));
        assert.ok(html.includes('data-sb-page="music"'));
    }
    const off = render('stream-bot/music', locals({ state: { ...locals().state, vod: { on: false, line: 'VOD protection: off. Desktop Audio is on track 2.', overlay: false, held: 'x', studio: true } } }));
    assert.match(off, /Requests are paused/);
    const unlinked = render('stream-bot/music', locals({ spotify: { linked: false, enabled: false, suspended: null, note: null } }));
    assert.match(unlinked, /Spotify is not linked/);
    assert.match(unlinked, /id="sbm-link-start"/);
    const resting = render('stream-bot/music', locals({ spotify: { linked: true, enabled: true, suspended: { why: 'Your Spotify was taken for Discord.', until: '2026-11-19T18:00:00.000Z' }, note: null } }));
    assert.match(resting, /resting until .*Your Spotify was taken for Discord/);
    const notReady = render('stream-bot/music', { ...locals(), ready: false });
    assert.match(notReady, /start after the next CertiFried restart/);
});

test('labels point at real controls, ids are unique, viewer text is escaped and page JSON cannot close its script', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const l = locals();
    l.history = [req(5, 'played', evil, evil)];
    l.state.queued = [req(6, 'queued', evil, evil)];
    l.musicData = JSON.stringify({ state: l.state }).replace(/</g, '\\u003c');
    const html = render('stream-bot/music', l);
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(all).size, all.length, 'ids are unique');
    for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) assert.ok(all.includes(m[1]), `label for="${m[1]}"`);
    assert.equal(html.includes('<img src=x'), false);
    const json = html.match(/<script type="application\/json" id="sbm-data">([\s\S]*?)<\/script>/)[1];
    assert.equal(json.includes('</'), false);
    assert.equal(JSON.parse(json).state.queued[0].title, evil);
});

test('the OBS player page: plays with a key, explains a dead link without one, and carries no site chrome or cookies', () => {
    const html = render('stream-bot/music-overlay', { key: 'sbm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    assert.match(html, /<audio id="sbmo-audio"/);
    assert.ok(html.includes('/js/stream-bot-music-overlay.js'));
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.equal(/site-header|csrf/.test(html), false);
    const gone = render('stream-bot/music-overlay', { key: null });
    assert.match(gone, /not valid any more/);
    assert.equal(gone.includes('<audio'), false);
});

test('the page scripts never build markup from strings', () => {
    for (const f of ['dashboard/public/js/stream-bot-music.js', 'dashboard/public/js/stream-bot-music-overlay.js']) {
        const src = read(f);
        assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    }
    const overlay = read('dashboard/public/js/stream-bot-music-overlay.js');
    assert.match(overlay, /\/report/);
    assert.match(overlay, /new EventSource/);
    assert.match(read('dashboard/public/css/stream-bot-music-overlay.css'), /theme: fixed/);
});

test('routes: sessions on every API route, literal paths first, the overlay without a session but rate limited, signature first', () => {
    const src = read('dashboard/routes/stream-bot-music.js');
    const routes = [...src.matchAll(/router\.(get|post|put|delete)\('([^']+)',\s*([a-zA-Z]+)/g)].map((m) => ({ method: m[1], path: m[2], guard: m[3] }));
    assert.ok(routes.length >= 18);
    for (const r of routes) {
        if (r.path.startsWith('/stream/bot/api/music')) assert.equal(r.guard, 'needApi', `${r.method} ${r.path} needs a session`);
        else if (r.path === '/stream/bot/music') assert.equal(r.guard, 'needPage');
        else { assert.match(r.path, /^\/stream\/bot\/overlay\/music\/:key/); assert.match(r.guard, /Limiter$/, `${r.path} is rate limited`); }
    }
    const order = routes.map((r) => `${r.method} ${r.path}`);
    for (let i = 0; i < order.length; i++) {
        const [m, p] = order[i].split(' ');
        if (!p.includes('/:')) continue;
        const pattern = new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
        for (let j = i + 1; j < order.length; j++) {
            const [m2, p2] = order[j].split(' ');
            if (m2 === m && !p2.includes('/:') && pattern.test(p2)) assert.fail(`${order[j]} is registered after ${order[i]}`);
        }
    }
    const audio = src.slice(src.indexOf("'/stream/bot/overlay/music/:key/audio/:playId'"));
    assert.ok(audio.indexOf('signer.verify') < audio.indexOf('upstreamFor'), 'the signature is checked before the audio is looked up');
    assert.ok(audio.indexOf('upstreamFor') < audio.indexOf('proxyAudio'));
    assert.doesNotMatch(src, /req\.(body|query|params)\.profileId/, 'no profile id from a request');
});

test('the Music tab, the overlay CSRF exemption and the route mount are in place', () => {
    assert.match(read('dashboard/views/stream-bot/_tabs.ejs'), /\['music', '\/stream\/bot\/music', 'Music'\]/);
    const server = read('dashboard/server.js');
    assert.match(server, /'\/stream\/bot\/overlay\/music\/',/);
    assert.match(server, /import\('\.\/routes\/stream-bot-music\.js'\)/);
});
