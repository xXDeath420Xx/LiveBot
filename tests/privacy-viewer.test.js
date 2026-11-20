import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ejs from 'ejs';
import { createViewerSignIn, VIEWER_PROVIDERS } from '../core/stream-bot/viewer-signin.js';
import { createPrivacyViewerRouter, sessionAccounts } from '../dashboard/routes/privacy-viewer.js';

/*
 * H-772: /privacy/viewer lets a viewer with no CertiFried account export or delete the stream bot data keyed to their
 * Twitch or Kick account. Covered: the identity-only sign-in (Twitch asks for no scope and refuses a token that has
 * one; Kick asks for user:read with PKCE; state checked; the token revoked after one use, nothing stored), the routes
 * (sign-in, 30-minute session, counts, JSON export, delete only with DELETE typed, sign-out, unknown providers), and the
 * page. Fake Twitch / Kick (no network) and fake privacy functions; the real ones are in tests/stream-bot-privacy.test.js.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeProviders({ twitchScopes = [] } = {}) {
    const calls = [];
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    const fetchImpl = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, method: init.method || 'GET', body: init.body ? String(init.body) : '', auth: init.headers?.Authorization || null });
        if (u === VIEWER_PROVIDERS.twitch.token) return json(200, { access_token: 'tw-access', refresh_token: 'tw-refresh' });
        if (u === VIEWER_PROVIDERS.twitch.validate) return json(200, { user_id: '555001', login: 'MapleFan_88', scopes: twitchScopes });
        if (u === VIEWER_PROVIDERS.twitch.revoke) return json(200, {});
        if (u === VIEWER_PROVIDERS.kick.token) return json(200, { access_token: 'kk-access' });
        if (u === VIEWER_PROVIDERS.kick.user) return json(200, { data: [{ user_id: 777001, name: 'JuniperSkies' }] });
        if (u.startsWith(VIEWER_PROVIDERS.kick.revoke)) return json(200, {});
        return json(404, {});
    };
    return { calls, fetchImpl };
}
const creds = { twitch: { clientId: 'tw-client', clientSecret: 'tw-secret' }, kick: { clientId: 'kk-client', clientSecret: 'kk-secret' } };

test('sign-in: identity only; Twitch has no scope, Kick user:read with PKCE; redirect URLs', () => {
    const s = createViewerSignIn({ creds, baseUrl: 'https://certifriedmultitool.com/', fetchImpl: fakeProviders().fetchImpl });
    assert.equal(s.redirectUri('twitch'), 'https://certifriedmultitool.com/privacy/viewer/twitch/callback');
    assert.equal(s.redirectUri('kick'), 'https://certifriedmultitool.com/privacy/viewer/kick/callback');
    const tw = new URL(s.start('twitch').url);
    assert.equal(tw.origin + tw.pathname, 'https://id.twitch.tv/oauth2/authorize');
    assert.equal(tw.searchParams.get('scope'), '', 'no Twitch scope at all');
    assert.equal(tw.searchParams.get('code_challenge'), null);
    const k = s.start('kick');
    const ku = new URL(k.url);
    assert.equal(ku.searchParams.get('scope'), 'user:read');
    assert.equal(ku.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(k.verifier && k.state);
    assert.equal(createViewerSignIn({ creds: { twitch: { clientId: 'x' } }, baseUrl: 'https://x' }).configured('twitch'), false, 'no secret: not offered');
    // tests/twitch-scope-rules.test.js scans these files with the rest of the repo; the plain check here too.
    for (const f of ['core/stream-bot/viewer-signin.js', 'dashboard/routes/privacy-viewer.js']) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        assert.ok(!/'[^']*(user:read:follows|user:read:email|analytics:|revenue|payout)[^']*'/.test(src), `${f} names no forbidden scope`);
    }
});

test('sign-in: finish reads the identity, revokes the token, and refuses bad state or a token with scopes', async () => {
    const p = fakeProviders();
    const s = createViewerSignIn({ creds, baseUrl: 'https://certifriedmultitool.com', fetchImpl: p.fetchImpl });
    const st = s.start('twitch');
    const who = await s.finish('twitch', { code: 'abc123', state: st.state }, { provider: 'twitch', state: st.state, at: Date.now() });
    assert.deepEqual(who, { platform: 'twitch', id: '555001', login: 'maplefan_88', name: 'maplefan_88' });
    assert.ok(p.calls.some((c) => c.url === VIEWER_PROVIDERS.twitch.revoke && c.body.includes('token=tw-access')), 'revoked after one use');
    assert.ok(!p.calls.some((c) => c.url.startsWith('https://api.twitch.tv/')), 'no Helix call at all');

    const ks = s.start('kick');
    const kw = await s.finish('kick', { code: 'k1', state: ks.state }, { provider: 'kick', state: ks.state, verifier: ks.verifier, at: Date.now() });
    assert.deepEqual(kw, { platform: 'kick', id: '777001', login: 'juniperskies', name: 'JuniperSkies' });
    assert.ok(p.calls.some((c) => c.url === VIEWER_PROVIDERS.kick.token && c.body.includes(`code_verifier=${ks.verifier}`)));
    assert.ok(p.calls.some((c) => c.url.startsWith(VIEWER_PROVIDERS.kick.revoke) && c.url.includes('token=kk-access')));

    const reason = async (fn) => { try { await fn(); return null; } catch (e) { return e.reason; } };
    assert.equal(await reason(() => s.finish('twitch', { code: 'a', state: 'x'.repeat(32) }, { provider: 'twitch', state: st.state })), 'expired');
    assert.equal(await reason(() => s.finish('twitch', { code: 'a', state: st.state }, null)), 'expired', 'no saved state');
    assert.equal(await reason(() => s.finish('twitch', { code: 'a', state: st.state }, { provider: 'kick', state: st.state })), 'expired', 'other provider');
    assert.equal(await reason(() => s.finish('twitch', { error: 'access_denied', state: st.state }, { provider: 'twitch', state: st.state })), 'denied');
    assert.equal(await reason(() => s.finish('twitch', { code: 'a', state: st.state }, { provider: 'twitch', state: st.state, at: Date.now() - 11 * 60_000 })), 'expired', 'ten minutes at most');
    const scoped = createViewerSignIn({ creds, baseUrl: 'https://x', fetchImpl: fakeProviders({ twitchScopes: ['user:read:email'] }).fetchImpl });
    const ss = scoped.start('twitch');
    assert.equal(await reason(() => scoped.finish('twitch', { code: 'a', state: ss.state }, { provider: 'twitch', state: ss.state })), 'scopes');
});

/** The router on a tiny app: one cookie-less "browser" = one session object; the view rendered to JSON locals. */
async function app({ now = () => Date.now() } = {}) {
    const calls = { exported: [], deleted: [], followsDeleted: [] };
    const signIn = {
        configured: (p) => p === 'twitch' || p === 'kick',
        start: (p) => ({ url: `https://${p}.example/authorize?state=s-${p}`, state: `s-${p}`, verifier: p === 'kick' ? 'v' : null }),
        finish: async (p, q, saved) => {
            if (!saved || saved.state !== q.state) { const e = new (await import('../core/stream-bot/viewer-signin.js')).ViewerSignInError('expired'); throw e; }
            return p === 'twitch' ? { platform: 'twitch', id: '555001', login: 'maplefan_88', name: 'maplefan_88' } : { platform: 'kick', id: '777001', login: 'juniperskies', name: 'JuniperSkies' };
        },
    };
    const privacy = {
        exportForAccounts: async (acc) => { calls.exported.push(acc); return { tables: { stream_bot_events_about_you: { total: 2, rows: [{ id: 1 }, { id: 2 }] } }, note: 'n' }; },
        deleteForAccounts: async (acc) => { calls.deleted.push(acc); return { deleted: { stream_bot_events: 2 } }; },
    };
    const follows = {
        followsExport: async (ids) => (ids.includes('555001') ? [{ follower_id: '555001', broadcaster_login: 'maple_hollow' }] : []),
        followsDelete: async (ids) => { calls.followsDeleted.push(ids); return 1; },
    };
    const sessions = { a: {}, b: {} };
    const a = express();
    a.use(express.urlencoded({ extended: false }));
    a.use((req, res, next) => { req.session = sessions[req.headers['x-browser'] || 'a']; next(); });
    a.set('view engine', 'ejs');
    a.engine('ejs', (file, locals, cb) => cb(null, JSON.stringify({ view: path.basename(file), accounts: locals.accounts, counts: locals.counts, message: locals.message, error: locals.error, deleted: locals.deleted, providers: locals.providers })));
    a.set('views', path.join(root, 'dashboard/views'));
    a.use(createPrivacyViewerRouter({ signIn, privacy, follows, now, limits: false }));
    const server = http.createServer(a);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const go = async (p, { method = 'GET', body = null, browser = 'a' } = {}) => {
        const res = await fetch(base + p, { method, redirect: 'manual', headers: { 'x-browser': browser, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body });
        const text = await res.text();
        let page = null;
        try { page = JSON.parse(text); } catch { /* not the page */ }
        return { status: res.status, location: res.headers.get('location'), headers: res.headers, text, page };
    };
    return { go, calls, sessions, close: () => new Promise((r) => server.close(r)) };
}

test('routes: sign in, see counts, export, delete only with DELETE typed, sign out', async () => {
    const t = await app();
    try {
        let r = await t.go('/privacy/viewer');
        assert.deepEqual([r.page.view, r.page.accounts, r.page.counts], ['privacy-viewer.ejs', [], null]);
        r = await t.go('/privacy/viewer/export');
        assert.equal(r.location, '/privacy/viewer', 'not signed in: no export');
        r = await t.go('/privacy/viewer/delete', { method: 'POST', body: 'confirm=DELETE' });
        assert.equal(r.location, '/privacy/viewer');
        assert.equal(t.calls.deleted.length, 0);
        assert.equal((await t.go('/privacy/viewer/trovo')).status, 404, 'Twitch, Kick and YouTube only (YouTube since H-741)');

        r = await t.go('/privacy/viewer/twitch');
        assert.equal(r.status, 302);
        assert.match(r.location, /^https:\/\/twitch\.example\//);
        assert.equal(t.sessions.a.privacyViewerAuth.state, 's-twitch');
        r = await t.go('/privacy/viewer/twitch/callback?code=c&state=wrong');
        assert.equal(r.location, '/privacy/viewer');
        assert.match((await t.go('/privacy/viewer')).page.error, /expired/, 'a bad state signs nobody in');
        await t.go('/privacy/viewer/twitch');
        r = await t.go('/privacy/viewer/twitch/callback?code=c&state=s-twitch');
        assert.equal(r.status, 303);
        await t.go('/privacy/viewer/kick');
        await t.go('/privacy/viewer/kick/callback?code=c&state=s-kick');
        assert.equal(t.sessions.a.privacyViewerAuth, undefined, 'the one-time state is gone');

        r = await t.go('/privacy/viewer');
        assert.deepEqual(r.page.accounts.map((a) => a.platform).sort(), ['kick', 'twitch']);
        assert.ok(r.page.accounts.every((a) => !('id' in a)), 'ids are not put into the page');
        assert.deepEqual(r.page.counts, [{ table: 'stream_bot_events_about_you', total: 2 }, { table: 'twitch_user_follows', total: 1 }]);
        assert.deepEqual(t.calls.exported.at(-1).sort((x, y) => x.platform.localeCompare(y.platform)), [{ platform: 'kick', id: '777001' }, { platform: 'twitch', id: '555001' }], 'only platform and id go to the data layer');
        assert.deepEqual((await t.go('/privacy/viewer', { browser: 'b' })).page.accounts, [], 'another browser is not signed in');

        r = await t.go('/privacy/viewer/export');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-disposition'), /attachment; filename="certifried-viewer-data-\d{4}-\d{2}-\d{2}\.json"/);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        const file = JSON.parse(r.text);
        assert.equal(file.tables.stream_bot_events_about_you.total, 2);
        assert.equal(file.tables.twitch_user_follows.rows[0].broadcaster_login, 'maple_hollow');

        r = await t.go('/privacy/viewer/delete', { method: 'POST', body: 'confirm=delete' });
        assert.equal(t.calls.deleted.length, 0, 'DELETE must be typed exactly');
        assert.match((await t.go('/privacy/viewer')).page.error, /Type DELETE/);
        r = await t.go('/privacy/viewer/delete', { method: 'POST', body: 'confirm=DELETE' });
        assert.equal(r.status, 303);
        assert.equal(t.calls.deleted.length, 1);
        assert.deepEqual(t.calls.followsDeleted, [['555001']], 'follows: the Twitch account only');
        r = await t.go('/privacy/viewer');
        assert.match(r.page.message, /deleted/);
        assert.deepEqual(r.page.deleted, [{ table: 'stream_bot_events', n: 2 }, { table: 'twitch_user_follows', n: 1 }]);

        await t.go('/privacy/viewer/sign-out', { method: 'POST', body: '' });
        assert.deepEqual((await t.go('/privacy/viewer')).page.accounts, []);
    } finally { await t.close(); }
});

test('the signed-in account lasts 30 minutes', () => {
    const now = Date.now();
    const s = { privacyViewer: { accounts: [{ platform: 'twitch', id: '1', at: now - 29 * 60_000 }, { platform: 'kick', id: '2', at: now - 31 * 60_000 }, { platform: 'youtube', id: '3', at: now }] } };
    assert.deepEqual(sessionAccounts(s, now).map((a) => a.platform), ['twitch']);
    assert.deepEqual(sessionAccounts(undefined, now), []);
});

test('the page renders signed out and signed in, with CSRF on both forms and no script', () => {
    const file = path.join(root, 'dashboard/views/privacy-viewer.ejs');
    const r = (locals) => ejs.render(fs.readFileSync(file, 'utf8'), { user: null, providers: { twitch: true, kick: true }, counts: null, message: null, error: null, deleted: null, csrfToken: 'tok123', ...locals }, { filename: file });
    const out = r({ accounts: [] });
    assert.ok(out.includes('href="/privacy/viewer/twitch"') && out.includes('href="/privacy/viewer/kick"'));
    assert.ok(!out.includes('/privacy/viewer/delete'));
    const inn = r({ accounts: [{ platform: 'twitch', login: 'maplefan_88', name: '<b>x</b>' }], counts: [{ table: 'stream_bot_events_about_you', total: 2 }] });
    assert.ok(inn.includes('&lt;b&gt;x&lt;/b&gt;'), 'names are escaped');
    assert.equal((inn.match(/name="_csrf" value="tok123"/g) || []).length, 2, 'sign-out and delete carry the CSRF token');
    assert.ok(inn.includes('action="/privacy/viewer/delete"') && inn.includes('pattern="DELETE"'));
    assert.equal((inn.match(/<h1\b/g) || []).length, 1);
    const routes = fs.readFileSync(path.join(root, 'dashboard/routes/privacy-viewer.js'), 'utf8');
    assert.ok(routes.indexOf("'/privacy/viewer/export'") < routes.indexOf("'/privacy/viewer/:provider'"), 'literal paths before /:provider');
    assert.ok(fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8').includes("import('./routes/privacy-viewer.js')"), 'mounted');
});
