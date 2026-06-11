import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyKickSignature, allowThankYou, makeHandleKickEvent } from '../../services/certifried-bot/kick-events.js';

// Generate a real RSA keypair so verification is tested end-to-end.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

function sign(messageId, timestamp, rawBody) {
    return crypto.sign('RSA-SHA256', Buffer.from(`${messageId}.${timestamp}.${rawBody}`), privateKey).toString('base64');
}

test('verifies a correctly signed payload', () => {
    const body = '{"broadcaster":{"user_id":1}}';
    const sig = sign('msg-1', '2026-06-11T00:00:00Z', body);
    assert.equal(verifyKickSignature({
        messageId: 'msg-1', timestamp: '2026-06-11T00:00:00Z', rawBody: body,
        signatureB64: sig, publicKeyPem: pubPem
    }), true);
});

test('rejects a tampered body or wrong message id', () => {
    const body = '{"a":1}';
    const sig = sign('msg-1', 'ts', body);
    assert.equal(verifyKickSignature({ messageId: 'msg-1', timestamp: 'ts', rawBody: '{"a":2}', signatureB64: sig, publicKeyPem: pubPem }), false);
    assert.equal(verifyKickSignature({ messageId: 'msg-X', timestamp: 'ts', rawBody: body, signatureB64: sig, publicKeyPem: pubPem }), false);
});

test('rejects garbage signature and missing fields without throwing', () => {
    assert.equal(verifyKickSignature({ messageId: 'm', timestamp: 't', rawBody: 'b', signatureB64: '!!!notb64', publicKeyPem: pubPem }), false);
    assert.equal(verifyKickSignature({}), false);
});

test('throttle allows 5 per minute per channel then blocks', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) assert.equal(allowThankYou('thr-test-1', now + i), true);
    assert.equal(allowThankYou('thr-test-1', now + 10), false, '6th within window blocked');
    assert.equal(allowThankYou('thr-test-2', now), true, 'other channels unaffected');
    assert.equal(allowThankYou('thr-test-1', now + 61_000), true, 'window expiry frees a slot');
});

function fakePool(features) {
    const calls = { inserts: [] };
    return {
        calls,
        execute: async (sql, params) => {
            if (/INSERT INTO tokes_kick_events/.test(sql)) { calls.inserts.push(params); return [{}]; }
            return [[{ features_enabled: JSON.stringify(features) }]];
        }
    };
}

test('follow event stores + sends templated thank-you', async () => {
    const pool = fakePool({ thank_follow: 'Thanks {{username}} for the follow! 💚' });
    const sent = [];
    const handle = makeHandleKickEvent({ pool, send: async (bid, text) => { sent.push({ bid, text }); return true; }, allow: () => true });
    const r = await handle('channel.followed', { broadcaster: { user_id: 31564961 }, follower: { username: 'newfan' } });
    assert.equal(r, 'thanked');
    assert.equal(pool.calls.inserts.length, 1);
    assert.deepEqual(sent[0], { bid: '31564961', text: 'Thanks newfan for the follow! 💚' });
});

test('no template configured → stored only, nothing sent', async () => {
    const pool = fakePool({ tokes: true });
    const handle = makeHandleKickEvent({ pool, send: async () => { throw new Error('should not send'); }, allow: () => true });
    assert.equal(await handle('channel.followed', { broadcaster: { user_id: 1 }, follower: { username: 'x' } }), 'stored');
});

test('throttled events are stored but not sent', async () => {
    const pool = fakePool({ thank_follow: 'hi {{username}}' });
    const handle = makeHandleKickEvent({ pool, send: async () => true, allow: () => false });
    assert.equal(await handle('channel.followed', { broadcaster: { user_id: 1 }, follower: { username: 'x' } }), 'throttled');
});

test('subscription events use thank_sub; events without broadcaster ignored', async () => {
    const pool = fakePool({ thank_sub: 'Welcome to the fam, {{username}}!' });
    const sent = [];
    const handle = makeHandleKickEvent({ pool, send: async (b, t) => { sent.push(t); return true; }, allow: () => true });
    assert.equal(await handle('channel.subscription.new', { broadcaster: { user_id: 2 }, subscriber: { username: 'subby' } }), 'thanked');
    assert.equal(sent[0], 'Welcome to the fam, subby!');
    assert.equal(await handle('channel.followed', { follower: { username: 'ghost' } }), 'ignored:no-broadcaster');
});
