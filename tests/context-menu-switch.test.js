import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { menusSwitchedOn } from '../core/context-menu-config.js';
import { FEATURE_SPECS, defaultsFor } from '../core/feature-config-spec.js';

/*
 * The Context Menus page's switch (core/feature-config-spec.js 'context-menus'.enabled) was saved and never
 * read: right-click actions kept working with it off. core/context-menu-config.js checkAccess now refuses
 * every menu while it is off (accuracy audit 2026-11-19).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the switch is on by default and off only for an explicit off value', () => {
    assert.equal(defaultsFor('context-menus').enabled, true);
    assert.equal(menusSwitchedOn(defaultsFor('context-menus')), true);
    assert.equal(menusSwitchedOn({}), true);
    assert.equal(menusSwitchedOn(null), true);
    assert.equal(menusSwitchedOn({ enabled: 1 }), true);
    for (const off of [false, 0, '0', 'false']) assert.equal(menusSwitchedOn({ enabled: off }), false, String(off));
});

test('checkAccess consults the switch before the per-menu row', () => {
    const src = fs.readFileSync(path.join(root, 'core/context-menu-config.js'), 'utf8');
    const body = src.slice(src.indexOf('export async function checkAccess'));
    const sw = body.indexOf("getFeatureConfig('context-menus'");
    const row = body.indexOf('FROM context_menu_config');
    assert.ok(sw > 0 && row > sw, 'switch read before the row');
    assert.ok(FEATURE_SPECS['context-menus'].fields.some((f) => f.key === 'enabled'));
});
