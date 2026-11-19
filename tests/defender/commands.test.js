import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsMinRole, resolveDefenderCommand } from '../../services/certifried-bot/defender/commands/index.js';

test('everyone passes for any user', () => {
    assert.equal(meetsMinRole('everyone', { isBroadcaster: false, isManager: false, isAdmin: false }), true);
});

test('broadcaster tier requires broadcaster/manager/admin', () => {
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: true, isManager: false, isAdmin: false }), true);
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: false, isManager: true, isAdmin: false }), true);
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: false, isManager: false, isAdmin: true }), true);
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: false, isManager: false, isAdmin: false }), false);
});

test('manager tier requires manager/admin', () => {
    assert.equal(meetsMinRole('manager', { isBroadcaster: true, isManager: false, isAdmin: false }), false);
    assert.equal(meetsMinRole('manager', { isBroadcaster: false, isManager: true, isAdmin: false }), true);
    assert.equal(meetsMinRole('manager', { isBroadcaster: false, isManager: false, isAdmin: true }), true);
});

test('admin tier requires admin', () => {
    assert.equal(meetsMinRole('admin', { isBroadcaster: false, isManager: true, isAdmin: false }), false);
    assert.equal(meetsMinRole('admin', { isBroadcaster: false, isManager: false, isAdmin: true }), true);
});

test('resolveDefenderCommand resolves keys and aliases', () => {
    assert.equal(resolveDefenderCommand('add-ban').key, 'add-ban');
    assert.equal(resolveDefenderCommand('add-bans').key, 'add-ban'); // alias
    assert.equal(resolveDefenderCommand('kbd').key, 'ping');         // alias
    assert.equal(resolveDefenderCommand('ADD-BAN').key, 'add-ban');  // case-insensitive
    assert.equal(resolveDefenderCommand('not-a-command'), null);
});

test('manager commands carry the manager tier', () => {
    assert.equal(resolveDefenderCommand('add-ban').minRole, 'manager');
    assert.equal(resolveDefenderCommand('check-ban').minRole, 'everyone');
    assert.equal(resolveDefenderCommand('add-manager') ?? null, null); // add-manager is dashboard/admin-only, not a chat cmd here
});
