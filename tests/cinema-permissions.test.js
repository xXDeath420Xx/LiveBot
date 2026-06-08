import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canControl } from '../handlers/cinema/state.js';

const member = (id, roleIds = [], manageGuild = false) => ({
  id,
  roles: { cache: new Map(roleIds.map((r) => [r, { id: r }])) },
  permissions: { has: () => manageGuild },
});

test('starter can control', () => {
  assert.equal(canControl(member('u1'), { started_by: 'u1' }, {}), true);
});

test('member with control role can control', () => {
  assert.equal(
    canControl(member('u2', ['mod']), { started_by: 'u1' }, { control_role_id: 'mod' }),
    true
  );
});

test('Manage Guild can control even without the role', () => {
  assert.equal(canControl(member('u3', [], true), { started_by: 'u1' }, {}), true);
});

test('random member cannot control', () => {
  assert.equal(canControl(member('u4'), { started_by: 'u1' }, { control_role_id: 'mod' }), false);
});
