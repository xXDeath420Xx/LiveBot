import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyHmac, basicAuthHeader, buildErrorMessage } from '../utils/fourthwall-api.js';

test('verifyHmac accepts valid signature', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"event":"ORDER_PLACED","id":"e1"}');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(verifyHmac(body, sig, secret), true);
});

test('verifyHmac rejects bad signature', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"event":"ORDER_PLACED"}');
    const sig = 'a'.repeat(64);
    assert.equal(verifyHmac(body, sig, secret), false);
});

test('verifyHmac rejects mismatched length without crashing', () => {
    assert.equal(verifyHmac(Buffer.from('x'), 'short', 'secret'), false);
});

test('verifyHmac rejects missing inputs', () => {
    assert.equal(verifyHmac(null, 'sig', 'secret'), false);
    assert.equal(verifyHmac(Buffer.from('x'), null, 'secret'), false);
    assert.equal(verifyHmac(Buffer.from('x'), 'sig', null), false);
});

test('basicAuthHeader encodes user:pass to Basic base64', () => {
    const h = basicAuthHeader('user@example.com', 'p@ss');
    assert.equal(h, 'Basic ' + Buffer.from('user@example.com:p@ss').toString('base64'));
});

test('buildErrorMessage normalizes 401 to credentials-rejected', () => {
    assert.match(buildErrorMessage({ status: 401, data: { error: 'Unauthorized' }}), /credentials.*rejected/i);
});

test('buildErrorMessage falls back to status text', () => {
    assert.match(buildErrorMessage({ status: 500, data: null }), /500/);
});
