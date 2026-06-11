import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendChannelMessage } from '../../jobs/kick-timer-scheduler.js';

test('posts to /chat with broadcaster id + bot type using the owner token', async () => {
    let captured;
    const deps = {
        resolveChannel: async () => ({ broadcasterId: '31564961', token: 'tok', scopes: [] }),
        fetchImpl: async (url, opts) => { captured = { url, opts }; return { ok: true }; }
    };
    const ok = await sendChannelMessage('31564961', 'hello chat', deps);
    assert.equal(ok, true);
    assert.match(captured.url, /\/chat$/);
    assert.equal(captured.opts.method, 'POST');
    assert.match(captured.opts.headers.Authorization, /Bearer tok/);
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.broadcaster_user_id, 31564961);
    assert.equal(body.type, 'bot');
    assert.equal(body.content, 'hello chat');
});

test('returns false when the channel has no token (not enrolled)', async () => {
    const ok = await sendChannelMessage('1', 'hi', { resolveChannel: async () => null, fetchImpl: async () => ({ ok: true }) });
    assert.equal(ok, false);
});

test('content is truncated to 500 chars', async () => {
    let body;
    await sendChannelMessage('1', 'x'.repeat(600), {
        resolveChannel: async () => ({ broadcasterId: '1', token: 't' }),
        fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: true }; }
    });
    assert.equal(body.content.length, 500);
});

test('returns false when the API rejects', async () => {
    const ok = await sendChannelMessage('1', 'hi', {
        resolveChannel: async () => ({ broadcasterId: '1', token: 't' }),
        fetchImpl: async () => ({ ok: false, status: 403 })
    });
    assert.equal(ok, false);
});
