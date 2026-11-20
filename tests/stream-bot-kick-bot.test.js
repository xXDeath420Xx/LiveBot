import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import {
    KICK_CHANNEL_BOT_SCOPES, KICK_SCOPE_LABELS, KICK_BOT_SIGNIN_PATH, missingKickScopes, kickBotStatus, kickBotProblem,
} from '../core/stream-bot/kick-scopes.js';
import { createKickApi } from '../core/stream-bot/kick-api.js';
import { sanitizeReturnTo } from '../dashboard/routes/auth-tokes-bot.js';
import { sendChannelMessage } from '../jobs/kick-timer-scheduler.js';
import { connectionNotice } from '../dashboard/services/stream-bot-view.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { streamBotPages } from '../scripts/site-shots/stream-bot-demo.mjs';

/*
 * H-787: Stream bot > Connections shows the Kick CHANNEL BOT sign-in (tokes_platform_connections via
 * /tokes-bot/auth/kick), which the stream bot's Kick actions use, separately from the identity-only "Sign in with
 * Kick" that links the channel; and the actions fail in the same plain words with the sign-in link.
 *
 *   scopes    one list: /tokes-bot/auth/kick asks for exactly KICK_CHANNEL_BOT_SCOPES; every scope has plain words
 *   status    not signed in, needs re-linking, missing permissions ("Change title and category: needs permission"),
 *             Kick Defender off, all good
 *   returnTo  /stream/bot/connections is allowed back; anything off-site or elsewhere falls back to /kick
 *   actions   title/category/delete (kick-api.js), chat and timers (sendChannelMessage) refuse with the same words
 *   page      the row and its button render in Dark, Light and Sand; the run page links the sign-in
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ALL = KICK_CHANNEL_BOT_SCOPES.join(' ');
const WITHOUT_WRITE = KICK_CHANNEL_BOT_SCOPES.filter((s) => s !== 'channel:write').join(' ');

test.after(async () => { await pool.end().catch(() => {}); });

test('scopes: the sign-in route asks for exactly the shared list, and each scope has plain words', () => {
    const src = read('dashboard/routes/auth-tokes-bot.js');
    assert.match(src, /import \{ KICK_CHANNEL_BOT_SCOPES \} from '\.\.\/\.\.\/core\/stream-bot\/kick-scopes\.js'/);
    assert.match(src, /const KICK_SCOPES = KICK_CHANNEL_BOT_SCOPES\.join\(' '\);/);
    assert.equal((src.match(/const KICK_SCOPES\b/g) || []).length, 1, 'one definition');
    assert.ok(KICK_CHANNEL_BOT_SCOPES.includes('channel:write'), 'title and category');
    for (const s of KICK_CHANNEL_BOT_SCOPES) assert.ok(KICK_SCOPE_LABELS[s] && !KICK_SCOPE_LABELS[s].includes(':'), `${s} has plain words`);
    assert.deepEqual(missingKickScopes(WITHOUT_WRITE).map((m) => m.text), ['Change title and category: needs permission']);
    assert.deepEqual(missingKickScopes(ALL), []);
    assert.equal(missingKickScopes('').length, KICK_CHANNEL_BOT_SCOPES.length);
});

test('status: none, relink, unknown, missing, ok, and Kick Defender off', () => {
    const none = kickBotStatus(null);
    assert.deepEqual([none.state, none.actionLabel, none.signInHref], ['none', 'Sign in to Kick', '/tokes-bot/auth/kick?returnTo=/stream/bot/connections']);
    assert.equal(kickBotStatus({ hasToken: false, scopes: ALL }).state, 'none', 'a row with no token is not a sign-in');

    const relink = kickBotStatus({ hasToken: true, needsRelink: true, defenderEnabled: true, scopes: ALL });
    assert.deepEqual([relink.state, relink.tone, relink.actionLabel], ['relink', 'is-bad', 'Sign in to Kick']);
    assert.match(relink.label, /sign in again/);

    const unknown = kickBotStatus({ hasToken: true, defenderEnabled: true, scopes: null });
    assert.deepEqual([unknown.state, unknown.missing.length, unknown.actionLabel], ['unknown', 0, 'Sign in to Kick']);

    const missing = kickBotStatus({ hasToken: true, defenderEnabled: true, scopes: WITHOUT_WRITE });
    assert.deepEqual([missing.state, missing.label, missing.actionLabel], ['missing', 'Signed in; 1 permission missing', 'Grant missing permissions']);
    assert.deepEqual(missing.missing.map((m) => [m.scope, m.text]), [['channel:write', 'Change title and category: needs permission']]);

    const ok = kickBotStatus({ hasToken: true, defenderEnabled: true, scopes: ALL.split(' ') });
    assert.deepEqual([ok.state, ok.tone, ok.actionLabel, ok.defenderOff], ['ok', 'is-ok', null, false]);
    assert.equal(kickBotStatus({ hasToken: true, defenderEnabled: false, scopes: ALL }).defenderOff, true);
});

test('returnTo: Connections comes back; off-site, look-alike and traversal paths fall back to /kick', () => {
    assert.equal(sanitizeReturnTo('/stream/bot/connections'), '/stream/bot/connections');
    assert.equal(sanitizeReturnTo('/stream/bot/connections?ok=1'), '/stream/bot/connections?ok=1');
    assert.equal(sanitizeReturnTo('/kick'), '/kick');
    for (const bad of [
        'https://evil.example/stream/bot/connections', '//evil.example/stream/bot/connections', '/\\evil.example/stream/bot/connections',
        '/stream/bot/connectionsX', '/stream/bot/connections/../../admin', '/stream/bot', 'javascript:alert(1)', '', null, ['/stream/bot/connections'],
    ]) assert.equal(sanitizeReturnTo(bad), '/kick', `blocked: ${JSON.stringify(bad)}`);
    // The link on the page goes through that check.
    assert.equal(sanitizeReturnTo(new URL(KICK_BOT_SIGNIN_PATH, 'https://x.test').searchParams.get('returnTo')), '/stream/bot/connections');
});

test('returnTo: sign-in errors that come back to Connections have fixed text there', () => {
    const src = read('dashboard/routes/auth-tokes-bot.js');
    const kick = src.slice(src.indexOf("router.get('/tokes-bot/auth/kick/callback'"), src.indexOf('// LOGOUT & UTILITIES'));
    assert.match(kick, /const errorBase = sanitizeReturnTo\(req\.session\?\.tokesReturnTo\)\.startsWith\('\/stream\/bot\/connections'\)/);
    const codes = [...kick.matchAll(/\$\{errorBase\}\?error=([a-z_]+)/g)].map((m) => m[1]);
    assert.ok(codes.length >= 6, `${codes.length} codes read`);
    for (const c of codes) assert.ok(connectionNotice({ error: c }), `message for ${c}`);
});

test('actions: kick-api refuses with the plain words and the sign-in link, and a 401 says to sign in again', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }; };
    let ch = null;
    const kick = createKickApi({ resolveChannel: async () => ch, fetchImpl });
    await assert.rejects(kick.setTitle('800000001', 'New'), (e) => e.code === 'no_token' && e.href === KICK_BOT_SIGNIN_PATH
        && /^Kick channel bot: not signed in/.test(e.message) && e.message.includes('/tokes-bot/auth/kick?returnTo=/stream/bot/connections'));
    ch = { broadcasterId: '800000001', token: 't', scopes: WITHOUT_WRITE.split(' ') };
    await assert.rejects(kick.setCategory('800000001', 'Slots'), (e) => e.code === 'missing_scope' && e.scope === 'channel:write'
        && e.message.startsWith('Change title and category: needs permission. Grant it on Kick: http'));
    ch = { broadcasterId: '800000001', token: 't', scopes: ['user:read'] };
    await assert.rejects(kick.deleteMessage('800000001', 'abc-1'), (e) => e.message.startsWith('Delete chat messages: needs permission.'));
    assert.equal(calls.length, 0, 'nothing was sent to Kick');
    ch = { broadcasterId: '800000001', token: 't', scopes: ALL.split(' ') };
    await assert.rejects(kick.setTitle('800000001', 'New'), (e) => e.code === 'rejected' && /Kick no longer accepts the sign-in/.test(e.message));
    // An old sign-in that never recorded its scopes is not blocked here: Kick decides.
    assert.equal(kickBotProblem({ token: 't', scopes: [] }, 'channel:write'), null);
});

test('actions: chat and timers (sendChannelMessage) do not post without chat:write', async () => {
    let posted = 0;
    const fetchImpl = async () => { posted++; return { ok: true, status: 200 }; };
    const noWrite = { broadcasterId: '800000001', token: 't', scopes: ['user:read', 'channel:read'] };
    assert.equal(await sendChannelMessage('800000001', 'hi', { resolveChannel: async () => noWrite, fetchImpl }), false);
    assert.equal(await sendChannelMessage('800000001', 'hi', { resolveChannel: async () => null, fetchImpl }), false);
    assert.equal(posted, 0);
    assert.equal(await sendChannelMessage('800000001', 'hi', { resolveChannel: async () => ({ ...noWrite, scopes: ALL.split(' ') }), fetchImpl }), true);
    assert.equal(posted, 1);
    assert.equal(kickBotProblem(noWrite, 'chat:write').message.split('.')[0], 'Send chat messages and timers: needs permission');
    // The stream bot's chat action (live.js) checks the same sign-in before sending.
    const live = read('core/stream-bot/live.js');
    assert.match(live, /const problem = kickBotProblem\(ch, 'chat:write'\);\s*\n\s*if \(problem\) return \{ ok: false, error: problem\.message \};/);
});

test('page: the Kick channel bot row renders in Dark, Light and Sand; the run page links the sign-in', async () => {
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
    const pages = await streamBotPages(demo, { root });
    const conn = pages['stream-bot-connections'];
    const common = (theme) => ({ user: demo.user, uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable', csrfToken: 't', clientId: demo.BOT_ID,
        userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' } });
    for (const theme of ['dark', 'light', 'sand']) {
        const html = engine.renderFile(path.join(views, `${conn.template}.ejs`), { ...common(theme), ...conn.locals, settings: {}, _locals: {} });
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        assert.match(html, /<dt>Kick channel bot<\/dt><dd><span class="cf-pill is-warn">Signed in; 1 permission missing<\/span><\/dd>/);
        assert.ok(html.includes('<li class="cf-chip"><span>Change title and category: needs permission</span></li>'), `${theme}: missing scope in plain words`);
        assert.ok(html.includes('<a class="btn btn-primary btn-sm" href="/tokes-bot/auth/kick?returnTo=/stream/bot/connections">Grant missing permissions</a>'), `${theme}: button`);
        assert.ok(!/style="[^"]*#[0-9a-f]{3,6}/i.test(html.slice(html.indexOf('Kick channel bot'))), 'no inline colours: the kit classes carry the theme');
    }
    // Not signed in: "Sign in to Kick".
    const kickCh = conn.locals.channels.find((c) => c.platform === 'kick');
    const locals = { ...conn.locals, channels: conn.locals.channels.map((c) => (c === kickCh ? { ...c, health: { ...c.health, kickBot: kickBotStatus(null) } } : c)) };
    const html = engine.renderFile(path.join(views, `${conn.template}.ejs`), { ...common('dark'), ...locals, settings: {}, _locals: {} });
    assert.ok(html.includes('href="/tokes-bot/auth/kick?returnTo=/stream/bot/connections">Sign in to Kick</a>'));
    // Run history: the link inside a failed step's detail is clickable, the rest stays text.
    const run = pages['stream-bot-run'];
    const detail = kickBotProblem({ token: 't', scopes: ['user:read'] }, 'channel:write', { base: 'https://certifriedmultitool.com' }).message;
    const steps = [{ at: '1', type: 'stream.title', status: 'failed', detail: `kick: ${detail}`, ms: 5 }];
    const runHtml = engine.renderFile(path.join(views, `${run.template}.ejs`), { ...common('light'), ...run.locals, run: { ...run.locals.run, steps }, settings: {}, _locals: {} });
    assert.ok(runHtml.includes('kick: Change title and category: needs permission. Grant it on Kick: <a href="/tokes-bot/auth/kick?returnTo=/stream/bot/connections">Sign in to Kick</a>'));
    const evil = [{ at: '1', type: 'chat.send', status: 'failed', detail: '<b>x</b> https://evil.example/tokes-bot/auth/kick?returnTo=/elsewhere', ms: 1 }];
    const evilHtml = engine.renderFile(path.join(views, `${run.template}.ejs`), { ...common('dark'), ...run.locals, run: { ...run.locals.run, steps: evil }, settings: {}, _locals: {} });
    assert.ok(evilHtml.includes('&lt;b&gt;x&lt;/b&gt; https://evil.example/tokes-bot/auth/kick?returnTo=/elsewhere'), 'other text stays escaped and unlinked');
});
