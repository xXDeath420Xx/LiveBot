import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
    actorAuthority, canManageRole, keyPermissions, validateRoleEdit, mergePermissionEdit,
    rolesAtLastLeave, roleIdsOf, auditReason,
} from '../core/role-manager-logic.js';
import { resolveColor, resolvePermissions } from '../core/bulk-role-creator.js';

const G = '100000000000000001';
const r = (n) => `2000000000000000${String(n).padStart(2, '0')}`;
const role = (n, position, extra = {}) => ({ id: r(n), position, managed: false, ...extra });

test('authority: owner and super-admin are limited only by the bot', () => {
    assert.deepEqual(actorAuthority({ isOwner: true, topPosition: 3 }), { ownerOrBypass: true, top: 3 });
    assert.deepEqual(actorAuthority({ isSuperAdmin: true }), { ownerOrBypass: true, top: 0 });
    assert.deepEqual(actorAuthority({ topPosition: '7' }), { ownerOrBypass: false, top: 7 });
    assert.deepEqual(actorAuthority(), { ownerOrBypass: false, top: 0 });
});

test('hierarchy: below both the bot and the actor, never managed or @everyone', () => {
    const ctx = { guildId: G, botTop: 20, actor: actorAuthority({ topPosition: 10 }) };
    assert.equal(canManageRole(role(1, 9), ctx).ok, true);
    assert.match(canManageRole(role(2, 10), ctx).reason, /your own highest role/, 'equal to the actor is refused');
    assert.match(canManageRole(role(3, 15), ctx).reason, /your own highest role/);
    assert.match(canManageRole(role(4, 20), ctx).reason, /bot's highest role/);
    assert.match(canManageRole(role(5, 2, { managed: true }), ctx).reason, /Managed/);
    assert.match(canManageRole({ id: G, position: 0, managed: false }, ctx).reason, /@everyone/);
    assert.equal(canManageRole(undefined, ctx).ok, false);
});

test('hierarchy: the owner (or super-admin) can go up to just under the bot', () => {
    const ctx = { guildId: G, botTop: 20, actor: actorAuthority({ isOwner: true, topPosition: 1 }) };
    assert.equal(canManageRole(role(1, 19), ctx).ok, true);
    assert.equal(canManageRole(role(2, 20), ctx).ok, false);
});

test('key permissions: Administrator collapses the rest; junk is empty', () => {
    const adminBits = PermissionFlagsBits.Administrator | PermissionFlagsBits.BanMembers;
    assert.deepEqual(keyPermissions(adminBits), ['Administrator']);
    assert.deepEqual(keyPermissions(String(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageMessages)), ['BanMembers', 'ManageMessages']);
    assert.deepEqual(keyPermissions(PermissionFlagsBits.SendMessages), []);
    assert.deepEqual(keyPermissions('not-a-number'), []);
});

test('edit validation: only fields present, names trimmed and bounded', () => {
    const deps = { resolveColor, resolvePermissions };
    assert.deepEqual(validateRoleEdit({ name: '  Mods ' }, deps), { patch: { name: 'Mods' } });
    assert.deepEqual(validateRoleEdit({ color: null, hoist: 1 }, deps), { patch: { color: 0, hoist: true } });
    assert.deepEqual(validateRoleEdit({ color: '#ff0000' }, deps).patch, { color: 0xff0000 });
    assert.deepEqual(validateRoleEdit({ permissions: ['banmembers'] }, deps).patch, { permissions: ['BanMembers'] });
    assert.match(validateRoleEdit({ name: '   ' }, deps).error, /needs a name/);
    assert.match(validateRoleEdit({ name: 'x'.repeat(101) }, deps).error, /100/);
    assert.match(validateRoleEdit({ color: 'nope' }, deps).error, /colour/);
    assert.match(validateRoleEdit({ permissions: 'BanMembers' }, deps).error, /list/);
    assert.match(validateRoleEdit({ permissions: ['Fly'] }, deps).error, /Unknown/);
    assert.match(validateRoleEdit({}, deps).error, /Nothing/);
});

test('permission edits: can always keep or drop, can only ADD what the actor may grant', () => {
    const may = (name) => name === 'SendMessages';
    assert.deepEqual(
        mergePermissionEdit(['BanMembers', 'SendMessages', 'Administrator'], ['BanMembers'], may),
        { final: ['BanMembers', 'SendMessages'], refused: ['Administrator'] },
    );
    assert.deepEqual(mergePermissionEdit([], ['Administrator'], () => false), { final: [], refused: [] }, 'removing is allowed');
});

test('roles at last leave: replays adds/removes in id order, resets on each leave', () => {
    const ev = (id, event_type, ids = [], timestamp = `t${id}`) => ({ id, event_type, metadata: JSON.stringify({ roleIds: ids }), timestamp });
    const events = [
        ev(9, 'GUILD_MEMBER_LEAVE'),          // the latest leave — out of order on purpose
        ev(1, 'GUILD_MEMBER_JOIN'),
        ev(2, 'MEMBER_ROLES_ADDED', [r(1), r(2)]),
        ev(3, 'MEMBER_ROLES_REMOVED', [r(1)]),
        ev(4, 'GUILD_MEMBER_LEAVE'),
        ev(5, 'GUILD_MEMBER_JOIN'),
        ev(6, 'MEMBER_ROLES_ADDED', [r(3)]),
        ev(7, 'MEMBER_ROLES_ADDED', [r(4), r(3)]),
        ev(8, 'MEMBER_ROLES_REMOVED', [r(4)]),
    ];
    assert.deepEqual(rolesAtLastLeave(events), { leftAt: 't9', roleIds: [r(3)] });
    assert.deepEqual(rolesAtLastLeave(events.filter(e => e.id <= 4)), { leftAt: 't4', roleIds: [r(2)] });
    assert.equal(rolesAtLastLeave(events.filter(e => e.id < 4)), null, 'never left');
    assert.equal(rolesAtLastLeave([]), null);
});

test('role ids from metadata: string or object, junk dropped', () => {
    assert.deepEqual(roleIdsOf(JSON.stringify({ roleIds: [r(1), 'x', 5] })), [r(1)]);
    assert.deepEqual(roleIdsOf({ roleIds: [r(2)] }), [r(2)]);
    assert.deepEqual(roleIdsOf('{broken'), []);
    assert.deepEqual(roleIdsOf(null), []);
});

test('audit reasons are ASCII-only and bounded', () => {
    assert.equal(auditReason('Role edited by bübba — via dashboard 🎉'), 'Role edited by bbba  via dashboard ');
    assert.equal(auditReason('x'.repeat(500)).length, 400);
    assert.equal(auditReason('🎉'), 'Role Manager (dashboard)');
});
