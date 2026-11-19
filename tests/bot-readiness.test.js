import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingReason, sendReconnecting, RETRY_SECONDS, MAX_RETRIES } from '../dashboard/services/bot-readiness.js';

/*
 * "Reconnecting to Discord" during a restart (dashboard/services/bot-readiness.js). What has to
 * stay true:
 *   - while bots are still logging in (no manager yet, manager still starting, the guild's mapped
 *     bot not ready) a missing guild is "pending", not "the bot is not in this server"
 *   - once every bot is up, a guild no bot has is a real error (no endless reconnect page)
 *   - pages get a 503 page that retries every 5 s and gives up after ~2 min; API callers get JSON
 *   - every guild gate in server.js and middleware/auth.js asks before denying
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const client = (ready, guilds = []) => ({ isReady: () => ready, guilds: { cache: new Map(guilds.map((g) => [g, { id: g }])) } });
function manager({ starting = false, mapping = {}, clients = {}, def = client(true) } = {}) {
    return {
        isStarting: () => starting,
        guildBotMapping: new Map(Object.entries(mapping)),
        clients: new Map(Object.entries({ default: def, ...clients })),
        getDefaultClient: () => def,
    };
}

test('pending while starting up; a real error once every bot is ready', () => {
    assert.equal(pendingReason('g', { botManager: null, fallbackClient: null }), 'starting', 'no manager, no client');
    assert.equal(pendingReason('g', { botManager: null, fallbackClient: client(false) }), 'starting');
    assert.equal(pendingReason('g', { botManager: null, fallbackClient: client(true) }), null, 'single-bot mode, bot ready: real');
    assert.equal(pendingReason('g', { botManager: manager({ starting: true }) }), 'starting', 'custom bots still logging in');
    assert.equal(pendingReason('g', { botManager: manager() }), null, 'everything up and nobody has it');
});

test('a mapped bot that is reconnecting is pending; a mapped bot that is gone is not', () => {
    const bm = manager({ mapping: { g: 'b1' }, clients: { b1: client(false) } });
    assert.equal(pendingReason('g', { botManager: bm }), 'reconnecting');
    assert.equal(pendingReason('g', { botManager: manager({ mapping: { g: 'b1' }, clients: { b1: client(true) } }) }), null);
    assert.equal(pendingReason('g', { botManager: manager({ mapping: { g: 'gone' } }) }), null, 'removed / failed login: real');
    assert.equal(pendingReason('g', { botManager: manager({ def: client(false) }) }), 'reconnecting', 'default bot down, unmapped guild');
});

test('BotManager.isStarting: until startup completes (capped), then a 30 s grace', async () => {
    process.env.BOT_ENCRYPTION_KEY ||= 'a'.repeat(64);   // utils/encryption.js needs one at import
    const { default: bm } = await import('../core/bot-manager.js');
    const t0 = 1_000_000;
    bm.startedAt = t0;
    bm.startupCompleteAt = null;
    assert.equal(bm.isStarting(t0 + 60_000), true);
    assert.equal(bm.isStarting(t0 + 6 * 60_000), false, 'capped: a startup that never finished stops counting');
    bm.startupCompleteAt = t0 + 90_000;
    assert.equal(bm.isStarting(t0 + 100_000), true, 'grace');
    assert.equal(bm.isStarting(t0 + 121_000), false);
    bm.startupCompleteAt = null;
    bm.markStartupComplete();
    assert.ok(bm.startupCompleteAt > 0);
    const first = bm.startupCompleteAt;
    bm.markStartupComplete();
    assert.equal(bm.startupCompleteAt, first, 'only the first call counts');
});

function fakeRes() {
    const res = { headers: {}, statusCode: 200, body: null, view: null, locals: null };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.render = (v, l) => { res.view = v; res.locals = l; return res; };
    return res;
}
const fakeReq = ({ json = false, url = '/manage/1' } = {}) => ({
    originalUrl: url, xhr: false, user: { id: 'u' },
    is: () => false,
    accepts: () => (json ? 'json' : 'html'),
});

test('answers: a 503 page that retries, or JSON for API callers', () => {
    const page = sendReconnecting(fakeReq(), fakeRes(), 'starting', 'The bot is not in this server.');
    assert.equal(page.statusCode, 503);
    assert.equal(page.headers['Retry-After'], String(RETRY_SECONDS));
    assert.equal(page.headers['Cache-Control'], 'no-store');
    assert.equal(page.view, 'reconnecting');
    assert.deepEqual(
        { reason: page.locals.reason, realError: page.locals.realError, retrySeconds: page.locals.retrySeconds, maxRetries: page.locals.maxRetries },
        { reason: 'starting', realError: 'The bot is not in this server.', retrySeconds: 5, maxRetries: 24 });
    assert.ok(RETRY_SECONDS * MAX_RETRIES >= 100 && RETRY_SECONDS * MAX_RETRIES <= 150, 'about two minutes');

    for (const req of [fakeReq({ json: true }), fakeReq({ url: '/api/guilds/1/settings' })]) {
        const api = sendReconnecting(req, fakeRes(), 'reconnecting', 'x');
        assert.equal(api.statusCode, 503);
        assert.equal(api.body.reconnecting, true);
        assert.equal(api.body.retryAfter, RETRY_SECONDS);
        assert.equal(api.view, null);
    }
});

test('wiring: every guild gate asks before denying', () => {
    const server = read('dashboard/server.js');
    assert.equal((server.match(/return denyAccess\(req, res, 403, 'The bot is not in this server\.'\)/g) || []).length, 0, 'no bare denial left');
    assert.ok((server.match(/notInGuild\(req, res, /g) || []).length >= 3);
    assert.match(server, /const pending = pendingReason\(req\.params\.guildId, \{ fallbackClient: client \}\);/);
    const auth = read('dashboard/middleware/auth.js');
    assert.ok((auth.match(/sendReconnecting\(req, res, pending, /g) || []).length >= 5, 'page + API gates, super-admin + member + manager paths');
    assert.match(read('index.js'), /botManager\.markStartupComplete\(\);/);
    const view = read('dashboard/views/reconnecting.ejs');
    assert.match(view, /<meta http-equiv="refresh"/, 'retries without JS too');
    assert.match(view, /sessionStorage/, 'counts attempts to give up after maxRetries');
});
