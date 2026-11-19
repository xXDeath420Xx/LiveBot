import test from 'node:test';
import assert from 'node:assert/strict';
import { createWplusClient } from '../src/wplus-client.js';

// Minimal fetch double that records how it was called.
function makeFetch(handler) {
    const calls = [];
    const impl = async (url, opts = {}) => {
        calls.push({ url, opts });
        return handler(url, opts, calls.length);
    };
    impl.calls = calls;
    return impl;
}

function res({ status = 200, headers = {}, body = {} } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    };
}

const LOGIN_OK = { 'set-cookie': 'wp_session=abc123; HttpOnly; Path=/' };

test('logs in form-encoded, not as JSON', async () => {
    // The upstream docs imply JSON; posting JSON to /login returns 200 with no
    // cookie and every later call 401s. Lock the encoding down.
    const fetchImpl = makeFetch(async (url) =>
        url.endsWith('/login') ? res({ status: 302, headers: LOGIN_OK }) : res({ body: { status: 'ok' } }));

    const client = createWplusClient({ baseUrl: 'http://x', password: 'pw', fetchImpl });
    await client.rcon('wp.status');

    const login = fetchImpl.calls[0];
    assert.ok(login.url.endsWith('/login'));
    assert.equal(login.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(login.opts.body instanceof URLSearchParams);
    assert.equal(login.opts.body.get('password'), 'pw');
});

test('throws a clear error when login returns no cookie', async () => {
    const fetchImpl = makeFetch(async () => res({ status: 200 })); // 200, no Set-Cookie — the trap
    const client = createWplusClient({ baseUrl: 'http://x', password: 'pw', fetchImpl });

    await assert.rejects(client.rcon('wp.status'), /did not return a wp_session cookie/);
});

test('sends the command with the session cookie and no body password', async () => {
    const fetchImpl = makeFetch(async (url) =>
        url.endsWith('/login')
            ? res({ status: 302, headers: LOGIN_OK })
            : res({ body: { status: 'ok', message: 'Players: 0' } }));

    const client = createWplusClient({ baseUrl: 'http://x', password: 'pw', fetchImpl });
    const out = await client.rcon('wp.status');

    const call = fetchImpl.calls[1];
    assert.equal(call.opts.headers.Cookie, 'wp_session=abc123');
    assert.deepEqual(JSON.parse(call.opts.body), { command: 'wp.status' });
    assert.equal(out.message, 'Players: 0');
});

test('re-authenticates once on 401 and retries', async () => {
    // Rotating the RCON password invalidates outstanding tokens, so 401 means
    // "log in again", not "fail".
    let rconAttempts = 0;
    const fetchImpl = makeFetch(async (url) => {
        if (url.endsWith('/login')) return res({ status: 302, headers: LOGIN_OK });
        rconAttempts++;
        return rconAttempts === 1
            ? res({ status: 401, body: { error: 'Authentication required' } })
            : res({ body: { status: 'ok', message: 'done' } });
    });

    const client = createWplusClient({ baseUrl: 'http://x', password: 'pw', fetchImpl });
    const out = await client.rcon('wp.players');

    assert.equal(out.message, 'done');
    assert.equal(rconAttempts, 2, 'should have retried once');
    assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/login')).length, 2);
});

test('concurrent cold calls trigger only one login', async () => {
    const fetchImpl = makeFetch(async (url) => {
        if (url.endsWith('/login')) {
            await new Promise((r) => setTimeout(r, 5));
            return res({ status: 302, headers: LOGIN_OK });
        }
        return res({ body: { status: 'ok' } });
    });

    const client = createWplusClient({ baseUrl: 'http://x', password: 'pw', fetchImpl });
    await Promise.all([client.get('/api/status'), client.get('/api/livemap'), client.get('/api/config')]);

    assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/login')).length, 1);
});
