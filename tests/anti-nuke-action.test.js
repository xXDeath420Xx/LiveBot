import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normaliseNukeAction, NUKE_ACTIONS } from '../core/anti-nuke-action.js';

// Stored action_on_trigger values (anti_nuke_config, 2026-11-19) and what core/anti-nuke-manager.js does.
test('the four actions the command offers are kept', () => {
    for (const a of ['kick', 'ban', 'strip', 'alert']) assert.equal(normaliseNukeAction(a), a);
    assert.deepEqual([...NUKE_ACTIONS], ['kick', 'ban', 'strip', 'alert']);
});

test('older setup-script values strip roles instead of doing nothing', () => {
    for (const a of ['strip_roles', 'remove_roles', 'strip_permissions', 'STRIP_ROLES']) assert.equal(normaliseNukeAction(a), 'strip');
});

test('anything unknown only alerts', () => {
    for (const a of ['', null, undefined, 'lockdown', 'quarantine']) assert.equal(normaliseNukeAction(a), 'alert');
});

test('the manager normalises the stored action before its switch', () => {
    const src = fs.readFileSync(new URL('../core/anti-nuke-manager.js', import.meta.url), 'utf8');
    assert.match(src, /config\.action_on_trigger = normaliseNukeAction\(config\.action_on_trigger\)/);
    for (const a of ['kick', 'ban', 'strip', 'alert']) assert.match(src, new RegExp(`case '${a}':`));
});
