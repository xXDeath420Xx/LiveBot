import test from 'node:test';
import assert from 'node:assert/strict';
import { privateReplyDelayMs } from '../core/prefix-command-manager.js';

// The Core page and the cleanup command say a self-destruct delay of 0 turns it off; replies to
// commands in private categories used to delete themselves after 10 seconds anyway.
test('a delay of 0 never deletes replies, even in a private category', () => {
    assert.equal(privateReplyDelayMs({ cleanupDelay: 0, privateCategories: new Set(['moderation']) }, 'moderation'), 0);
});

test('a set delay applies to private categories only', () => {
    const config = { cleanupDelay: 30, privateCategories: new Set(['moderation']) };
    assert.equal(privateReplyDelayMs(config, 'moderation'), 30000);
    assert.equal(privateReplyDelayMs(config, 'music'), 0);
});

test('the delay is capped at the 300 seconds the page allows', () => {
    assert.equal(privateReplyDelayMs({ cleanupDelay: 900, privateCategories: new Set(['info']) }, 'info'), 300000);
});
