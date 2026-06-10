import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banUser, unbanUser, deleteMessage } from '../../services/certifried-bot/defender/kick-moderation.js';

function fakeFetch(captured, response = { ok: true, status: 200, text: async () => '' }) {
    return async (url, opts) => {
        captured.url = url;
        captured.opts = opts;
        captured.body = opts.body ? JSON.parse(opts.body) : null;
        return response;
    };
}

test('banUser posts to moderation/bans with broadcaster + user id', async () => {
    const cap = {};
    const res = await banUser('123', '456', { reason: 'spam' }, 'tok', fakeFetch(cap));
    assert.equal(res.ok, true);
    assert.equal(cap.url, 'https://api.kick.com/public/v1/moderation/bans');
    assert.equal(cap.opts.method, 'POST');
    assert.equal(cap.opts.headers.Authorization, 'Bearer tok');
    assert.equal(cap.opts.headers['Content-Type'], 'application/json');
    assert.equal(cap.body.broadcaster_user_id, 123);
    assert.equal(cap.body.user_id, 456);
    assert.equal(cap.body.reason, 'spam');
    assert.equal('duration' in cap.body, false); // permanent ban omits duration
});

test('banUser includes duration when given', async () => {
    const cap = {};
    await banUser('1', '2', { duration: 60 }, 'tok', fakeFetch(cap));
    assert.equal(cap.body.duration, 60);
});

test('banUser forwards durationMin as duration (minutes)', async () => {
    const cap = {};
    await banUser('1', '2', { durationMin: 30 }, 'tok', fakeFetch(cap));
    assert.equal(cap.body.duration, 30);
    assert.strictEqual(typeof cap.body.duration, 'number');
});

test('banUser omits duration when durationMin absent (permanent)', async () => {
    const cap = {};
    await banUser('1', '2', { reason: 'spam' }, 'tok', fakeFetch(cap));
    assert.equal('duration' in cap.body, false);
});

test('unbanUser DELETEs moderation/bans', async () => {
    const cap = {};
    await unbanUser('123', '456', 'tok', fakeFetch(cap));
    assert.equal(cap.url, 'https://api.kick.com/public/v1/moderation/bans');
    assert.equal(cap.opts.method, 'DELETE');
    assert.equal(cap.body.broadcaster_user_id, 123);
    assert.equal(cap.body.user_id, 456);
});

test('deleteMessage DELETEs chat/{id}', async () => {
    const cap = {};
    await deleteMessage('msg-uuid', 'tok', fakeFetch(cap));
    assert.equal(cap.url, 'https://api.kick.com/public/v1/chat/msg-uuid');
    assert.equal(cap.opts.method, 'DELETE');
});

test('error path returns ok:false with body text', async () => {
    const cap = {};
    const res = await banUser('1', '2', {}, 'tok',
        fakeFetch(cap, { ok: false, status: 403, text: async () => 'Forbidden' }));
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.error, 'Forbidden');
});

test('error path survives a throwing response body', async () => {
    const cap = {};
    const res = await banUser('1', '2', {}, 'tok',
        fakeFetch(cap, { ok: false, status: 500, text: async () => { throw new Error('stream broke'); } }));
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.equal(res.error, null); // safeText swallows the throw
});
