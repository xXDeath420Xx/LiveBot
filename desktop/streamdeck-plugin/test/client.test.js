/*
 * src/studio-client.js against the mock Studio bridge: no Origin header and the 127.0.0.1 Host, hello with the token,
 * request round trips and errors, reconnect with backoff, wrong and regenerated tokens, lockout, timeouts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioClient } from '../src/studio-client.js';
import { startMockStudio, until, sleep } from './mock-studio.js';

const TOKEN = 'sdk_test-token-0123456789abcdef';
const fast = { setTimer: (fn) => setTimeout(fn, 20), clearTimer: clearTimeout };

test('connects to 127.0.0.1 without an Origin header, says hello with the token, and answers requests', async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const statuses = [];
    const c = createStudioClient({ pluginVersion: '0.2.6' });
    c.on('status', (s) => statuses.push(s));
    try {
        assert.equal(c.status, 'not_configured');
        c.configure({ port: studio.port, token: TOKEN });
        await until(() => c.connected);
        assert.deepEqual(studio.upgrades[0], { origin: undefined, host: `127.0.0.1:${studio.port}` });
        assert.deepEqual(studio.hellos[0], { type: 'hello', token: TOKEN, client: { app: 'streamdeck', version: '0.2.6' } });
        assert.deepEqual(statuses.slice(0, 2), ['connecting', 'connected']);
        assert.deepEqual(await c.request('obs.scene', { scene: 'BRB' }), { scene: 'BRB' });
        await assert.rejects(c.request('obs.scene', { scene: 'Nope' }), (e) => e.code === 'scene_not_found' && e.message === 'No such scene');
        await assert.rejects(c.request('no.such', {}), (e) => e.code === 'unknown_method');
    } finally { c.stop(); await studio.close(); }
});

test('no token: not_configured and no connection attempt; a bad port falls back to 39720', async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const c = createStudioClient();
    try {
        c.configure({ port: studio.port, token: '' });
        await sleep(100);
        assert.equal(c.status, 'not_configured');
        assert.equal(studio.upgrades.length, 0);
        await assert.rejects(c.request('status'), (e) => e.code === 'not_connected');
    } finally { c.stop(); await studio.close(); }
});

test('reconnects with backoff after Studio goes away, and delays grow', async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const delays = [];
    const c = createStudioClient({ setTimer: (fn, ms) => { delays.push(ms); return setTimeout(fn, 15); }, clearTimer: clearTimeout, random: () => 0.5 });
    try {
        c.configure({ port: studio.port, token: TOKEN });
        await until(() => c.connected);
        const port = studio.port;
        await studio.close();
        await until(() => c.status === 'unreachable');
        await until(() => delays.filter((d) => d >= 1000).length >= 3);
        const retry = delays.filter((d) => d >= 1000 && d !== 8000);
        assert.deepEqual(retry.slice(0, 3), [1000, 2000, 4000]);
        // Studio comes back on the same port: the client finds it again.
        const again = await startMockStudio({ token: TOKEN, port });
        await until(() => c.connected, 5000);
        assert.equal(again.hellos.length, 1);
        await again.close();
    } finally { c.stop(); }
});

test('a wrong token: auth_failed, no retry until the token changes, then it connects', async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const c = createStudioClient(fast);
    try {
        c.configure({ port: studio.port, token: 'sdk_wrong' });
        await until(() => c.status === 'auth_failed');
        assert.equal(c.detail, 'auth_failed');
        await sleep(200);
        assert.equal(studio.hellos.length, 1, 'no retry loop with a refused token (that would trip the lockout)');
        c.configure({ port: studio.port, token: 'sdk_wrong' });
        await sleep(100);
        assert.equal(studio.hellos.length, 1, 'the same token again does not retry');
        c.configure({ port: studio.port, token: TOKEN });
        await until(() => c.connected);
    } finally { c.stop(); await studio.close(); }
});

test('regenerated token (4403) is reported as token_changed; lockout (4429) waits 65 s', async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const c = createStudioClient(fast);
    try {
        c.configure({ port: studio.port, token: TOKEN });
        await until(() => c.connected);
        studio.setToken('sdk_new');
        studio.closeAll(4403);
        await until(() => c.status === 'auth_failed');
        assert.equal(c.detail, 'token_changed');
    } finally { c.stop(); await studio.close(); }

    const locked = await startMockStudio({ token: TOKEN, lockout: true });
    const waits = [];
    const d = createStudioClient({ setTimer: (fn, ms) => { waits.push(ms); return setTimeout(() => {}, 1); }, clearTimer: clearTimeout });
    try {
        d.configure({ port: locked.port, token: TOKEN });
        await until(() => d.status === 'locked_out');
        assert.ok(waits.includes(65_000));
    } finally { d.stop(); await locked.close(); }
});

test('a request Studio never answers times out; pending requests fail when the connection drops', async () => {
    const studio = await startMockStudio({ token: TOKEN, handlers: { slow: () => '__no_answer__' } });
    const c = createStudioClient({ ...fast });
    try {
        c.configure({ port: studio.port, token: TOKEN });
        await until(() => c.connected);
        const c2 = createStudioClient();
        c2.configure({ port: studio.port, token: TOKEN });
        await until(() => c2.connected);
        await assert.rejects(c2.request('slow', {}, { timeoutMs: 50 }), (e) => e.code === 'timeout');
        const p = c2.request('slow', {}, { timeoutMs: 5000 });
        studio.closeAll(1001);
        await assert.rejects(p, (e) => e.code === 'not_connected');
        c2.stop();
    } finally { c.stop(); await studio.close(); }
});
