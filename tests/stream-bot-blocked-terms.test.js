import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBlockedTerms, cleanTerms, BLOCKED_TERMS_SCOPE, REAPPROVE_MESSAGE } from '../core/stream-bot/twitch-blocked-terms.js';
import { STREAM_BOT_SCOPES, REAPPROVE, FORBIDDEN_SCOPES } from '../core/stream-bot/scopes.js';

/*
 * H-763: saved banned words (Firebot / Streamer.bot import) go to Twitch blocked terms only when the owner presses
 * "Add to Twitch blocked terms" on the Import page (core/stream-bot/twitch-blocked-terms.js, the route in
 * dashboard/routes/stream-bot-import.js). Against a fake Helix: pagination of what Twitch already has, skipping those,
 * term length rules, a missing scope asking for a re-approve, a 429 retried once, and the scope on the grant.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ME = { userId: '900000001' };
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

function fakeHelix({ existing = [], pageSize = 2, failPost = {}, missingScope = false, rateLimitOnce = new Set() } = {}) {
    const calls = [];
    const added = [];
    return {
        calls, added,
        async call(profileId, method, p, { query, body, need } = {}) {
            const q = typeof query === 'function' ? query(ME) : (query || {});
            calls.push({ method, path: p, q, body, need });
            if (missingScope) throw Object.assign(new Error('scope'), { code: 'missing_scope' });
            assert.deepEqual(need, [BLOCKED_TERMS_SCOPE]);
            assert.equal(q.broadcaster_id, ME.userId);
            assert.equal(q.moderator_id, ME.userId);
            if (method === 'GET') {
                const start = q.after ? Number(q.after) : 0;
                const slice = existing.slice(start, start + pageSize).map((text) => ({ text }));
                const next = start + pageSize < existing.length ? String(start + pageSize) : null;
                return { data: { data: slice, pagination: next ? { cursor: next } : {} }, me: ME };
            }
            if (rateLimitOnce.has(body.text)) { rateLimitOnce.delete(body.text); throw err(429, 'Too Many Requests'); }
            if (failPost[body.text]) throw err(failPost[body.text], 'The term is not allowed');
            added.push(body.text);
            return { data: { data: [{ text: body.text }] }, me: ME };
        },
    };
}
const noSleep = async () => {};

test('cleanTerms: trimmed, one of each ignoring case, Twitch lengths 2 to 500', () => {
    const r = cleanTerms(['  spam  ', 'SPAM', 'x', '', 'a'.repeat(501), 'free  followers', null]);
    assert.deepEqual(r.terms, ['spam', 'free followers']);
    assert.equal(r.invalid, 2, 'one too short, one too long; blanks are not counted');
});

test('adds only what Twitch does not have yet, reading every page first', async () => {
    const h = fakeHelix({ existing: ['Spam', 'scam link', 'other'], pageSize: 2 });
    const r = await addBlockedTerms({ helix: h, profileId: 1, words: ['spam', 'free followers', 'Scam Link', 'cheap viewers'], sleep: noSleep });
    assert.deepEqual([r.ok, r.added, r.skipped, r.failed, r.invalid], [true, 2, 2, 0, 0]);
    assert.deepEqual(h.added, ['free followers', 'cheap viewers']);
    assert.equal(h.calls.filter((c) => c.method === 'GET').length, 2, 'both pages read');
    assert.equal(h.calls.find((c) => c.method === 'GET').q.first, 100);
});

test('a missing scope asks for a re-approve on Connections; nothing is sent', async () => {
    const h = fakeHelix({ missingScope: true });
    const r = await addBlockedTerms({ helix: h, profileId: 1, words: ['spam'], sleep: noSleep });
    assert.equal(r.ok, false);
    assert.equal(r.reapprove, true);
    assert.equal(r.error, REAPPROVE_MESSAGE);
    assert.equal(r.href, '/stream/bot/connections');
    assert.equal(h.added.length, 0);
});

test('a refused term is reported and the rest still go; a 429 is retried once', async () => {
    const h = fakeHelix({ failPost: { 'bad term': 400 }, rateLimitOnce: new Set(['later']) });
    const r = await addBlockedTerms({ helix: h, profileId: 1, words: ['bad term', 'later', 'fine'], sleep: noSleep });
    assert.deepEqual([r.added, r.failed], [2, 1]);
    assert.deepEqual(h.added, ['later', 'fine']);
    assert.match(r.failures[0].error, /not allowed/);
});

test('nothing to add: no call to Twitch at all', async () => {
    const h = fakeHelix();
    const r = await addBlockedTerms({ helix: h, profileId: 1, words: ['x'], sleep: noSleep });
    assert.deepEqual([r.ok, r.added, r.invalid], [true, 0, 1]);
    assert.equal(h.calls.length, 0);
});

test('the grant asks for the scope, offers it as a re-approve, and still never asks for follows or revenue', () => {
    assert.ok(STREAM_BOT_SCOPES.includes(BLOCKED_TERMS_SCOPE));
    assert.ok(REAPPROVE.some((r) => r.scope === BLOCKED_TERMS_SCOPE));
    for (const s of FORBIDDEN_SCOPES) assert.equal(STREAM_BOT_SCOPES.includes(s), false);
});

test('only the owner\'s button sends words: a session route with a rate limit, a confirm in the page, no other caller', () => {
    const route = read('dashboard/routes/stream-bot-import.js');
    assert.ok(/router\.post\('\/stream\/bot\/api\/import\/words\/:id\/twitch', needApi, blockedTermsLimiter,/.test(route));
    const js = read('dashboard/public/js/stream-bot-import.js');
    const i = js.indexOf("querySelectorAll('[data-twitch-terms]')");
    assert.ok(i > 0);
    const handler = js.slice(i, i + 1500);
    assert.ok(handler.indexOf('window.confirm(') > 0 && handler.indexOf('window.confirm(') < handler.indexOf("send('POST'"), 'confirm before sending');
    assert.ok(read('dashboard/views/stream-bot/import.ejs').includes('data-twitch-terms="<%= w.id %>"'));
    // Nothing else in the code calls it (no automatic path).
    const callers = [];
    for (const dir of ['core', 'dashboard/routes', 'jobs', 'services']) {
        const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (p.endsWith('.js') && read(p).includes('addBlockedTerms(')) callers.push(p);
        } };
        if (fs.existsSync(path.join(root, dir))) walk(dir);
    }
    assert.deepEqual(callers.sort(), ['core/stream-bot/twitch-blocked-terms.js', 'dashboard/routes/stream-bot-import.js']);
});

test('the Import page: the button shows with the grant, is disabled with a re-approve link without the scope, absent without Twitch', async () => {
    const { createViewEngine } = await import('../dashboard/services/view-engine.js');
    const demo = await import('../scripts/site-shots/demo-data.mjs');
    const { importPage } = await import('../scripts/site-shots/stream-bot-import-demo.mjs');
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
    const page = await importPage(demo, { root });
    const render = (extra) => engine.renderFile(path.join(views, `${page.template}.ejs`), {
        user: demo.user, uiTheme: 'dark', uiStyle: 'cards', uiDensity: 'comfortable',
        userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme: 'dark', dashboardLayout: 'grid', density: 'comfortable' },
        csrfToken: 't', clientId: demo.BOT_ID, ...page.locals, ...extra, settings: {}, _locals: {} });
    const id = page.locals.words[0].id;
    const on = render({ twitchTerms: { connected: true, scopeOk: true } });
    assert.ok(on.includes(`data-twitch-terms="${id}"`));
    assert.equal(new RegExp(`data-twitch-terms="${id}"[^>]*disabled`).test(on), false);
    const old = render({ twitchTerms: { connected: true, scopeOk: false }, words: page.locals.words.map((w) => ({ ...w, twitch: { at: '2026-11-19T22:00:00Z', added: 3, skipped: 1, failed: 0 } })) });
    assert.ok(new RegExp(`data-twitch-terms="${id}"[^>]*disabled`).test(old), 'disabled until re-approved');
    assert.ok(old.includes('href="/stream/bot/connections">re-approve the Stream bot grant'));
    assert.ok(old.includes('Sent to Twitch blocked terms'));
    const none = render({ twitchTerms: { connected: false, scopeOk: false } });
    assert.equal(none.includes('data-twitch-terms='), false);
    assert.equal(render({}).includes('data-twitch-terms='), false, 'no twitchTerms local: no button');
});
