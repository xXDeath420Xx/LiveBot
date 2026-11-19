import test from 'node:test';
import assert from 'node:assert/strict';
import {
    describeSendState, serialiseLockState, parseLockState, restoreValueFor, shouldDeleteOverwrite,
} from '../core/lockdown-state.js';

const SEND = 1n << 11n;          // PermissionFlagsBits.SendMessages
const VIEW = 1n << 10n;          // PermissionFlagsBits.ViewChannel

test('reads the three states of @everyone Send Messages', () => {
    assert.deepEqual(describeSendState(SEND, 0n, SEND), { version: 1, send_messages: 'allow', had_overwrite: true });
    assert.deepEqual(describeSendState(0n, SEND | VIEW, SEND), { version: 1, send_messages: 'deny', had_overwrite: true });
    assert.deepEqual(describeSendState(VIEW, 0n, SEND), { version: 1, send_messages: 'neutral', had_overwrite: true });
    assert.deepEqual(describeSendState(null, null, SEND), { version: 1, send_messages: 'neutral', had_overwrite: false });
});

test('round-trips through the lockdowns.original_perms column', () => {
    for (const s of [describeSendState(SEND, 0n, SEND), describeSendState(null, null, SEND), describeSendState(0n, 0n, SEND)]) {
        assert.deepEqual(parseLockState(serialiseLockState(s)), s);
    }
});

test('unreadable records fall back (null) instead of guessing', () => {
    assert.equal(parseLockState(null), null);
    assert.equal(parseLockState(''), null);
    assert.equal(parseLockState('{not json'), null);
    assert.equal(parseLockState('{"send_messages":"maybe"}'), null);
    assert.equal(parseLockState('[]'), null);
});

test('restore values for permissionOverwrites.edit', () => {
    assert.equal(restoreValueFor({ send_messages: 'allow' }), true);
    assert.equal(restoreValueFor({ send_messages: 'deny' }), false);
    assert.equal(restoreValueFor({ send_messages: 'neutral' }), null);
    assert.equal(restoreValueFor(null), null, 'no record → today\'s behaviour (neutral)');
});

test('an overwrite the lock created is removed again, but only if nothing else was added to it', () => {
    const none = { send_messages: 'neutral', had_overwrite: false };
    const existed = { send_messages: 'neutral', had_overwrite: true };
    assert.equal(shouldDeleteOverwrite(none, 0n, 0n), true);
    assert.equal(shouldDeleteOverwrite(none, 0n, VIEW), false, 'someone denied View meanwhile — keep it');
    assert.equal(shouldDeleteOverwrite(existed, 0n, 0n), false, 'it existed before the lock — keep it');
    assert.equal(shouldDeleteOverwrite(null, 0n, 0n), false);
});
