import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMessage, makeLoadAutomod } from '../../services/certifried-bot/kick-automod.js';

test('no settings = no violations (feature off by default)', () => {
    assert.equal(evaluateMessage('HELLO LOOK http://scam.xyz !!!!!!', {}), null);
});

test('links rule blocks URLs', () => {
    assert.equal(evaluateMessage('join my discord.gg/abc now', { links: true })?.rule, 'links');
    assert.equal(evaluateMessage('check http://x.com', { links: true })?.rule, 'links');
    assert.equal(evaluateMessage('no link here', { links: true }), null);
});

test('caps rule fires past threshold, ignores short messages', () => {
    assert.equal(evaluateMessage('THIS IS ALL SHOUTING', { caps: true })?.rule, 'caps');
    assert.equal(evaluateMessage('hello there friends', { caps: true }), null);
    assert.equal(evaluateMessage('OMG', { caps: true }), null, 'short message exempt (under min length)');
});

test('caps threshold is configurable', () => {
    // "Hello World" = 10 letters, 2 caps = 20%
    assert.equal(evaluateMessage('Hello World Ok', { caps: true, caps_pct: 15 })?.rule, 'caps');
    assert.equal(evaluateMessage('Hello World Ok', { caps: true, caps_pct: 90 }), null);
});

test('symbols rule fires on symbol spam', () => {
    assert.equal(evaluateMessage('!!!@@@###$$$%%%', { symbols: true })?.rule, 'symbols');
    assert.equal(evaluateMessage('normal sentence here', { symbols: true }), null);
});

test('max_len rule blocks long messages; 0 = off', () => {
    assert.equal(evaluateMessage('x'.repeat(50), { max_len: 20 })?.rule, 'max_len');
    assert.equal(evaluateMessage('x'.repeat(50), { max_len: 0 }), null);
    assert.equal(evaluateMessage('short', { max_len: 20 }), null);
});

test('first violated rule wins; links checked before caps', () => {
    const hit = evaluateMessage('GO TO HTTP://SCAM.XYZ NOW', { links: true, caps: true });
    assert.equal(hit.rule, 'links');
});

test('blank message never violates', () => {
    assert.equal(evaluateMessage('   ', { links: true, caps: true, symbols: true }), null);
});

test('loadAutomod reads the automod key from features_enabled JSON', async () => {
    const pool = { execute: async () => [[{ features_enabled: JSON.stringify({ automod: { caps: true } }) }]] };
    const load = makeLoadAutomod({ pool });
    assert.deepEqual(await load(1), { caps: true });
});

test('loadAutomod returns null when there is no automod key', async () => {
    const pool = { execute: async () => [[{ features_enabled: JSON.stringify({ tokes: true }) }]] };
    const load = makeLoadAutomod({ pool });
    assert.equal(await load(1), null);
});
