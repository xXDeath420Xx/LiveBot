import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftoverAction, isGoneError } from '../utils/live-role-logic.js';

test('a holder no longer tracked in the server has the role taken back', () => {
    assert.equal(leftoverAction({ inServer: true, hasRole: true, tracked: false }), 'remove');
});

test('a holder still tracked is left to the normal check cycle', () => {
    assert.equal(leftoverAction({ inServer: true, hasRole: true, tracked: true }), 'keep');
});

test('records for people who left, or who no longer hold the role, are dropped', () => {
    assert.equal(leftoverAction({ inServer: false, hasRole: false, tracked: false }), 'forget');
    assert.equal(leftoverAction({ inServer: true, hasRole: false, tracked: false }), 'forget');
    assert.equal(leftoverAction({ inServer: true, hasRole: false, tracked: true }), 'forget');
});

test('only unknown member / unknown role errors make a grant permanently moot', () => {
    assert.equal(isGoneError({ code: 10007 }), true);
    assert.equal(isGoneError({ code: 10011 }), true);
    assert.equal(isGoneError({ code: 50013 }), false, 'missing permissions: retry later');
    assert.equal(isGoneError(null), false);
});
