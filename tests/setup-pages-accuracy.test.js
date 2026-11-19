import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';

// Setup pages accuracy pass (2026-11-19): the pages load what they save.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');

function render(page, locals) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-acc-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${page}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const guild = { id: '999000000000000501', name: 'Test', members: { me: null } };

test('the manage route passes the modlog layout switch to the Bot appearance page', () => {
    const src = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    assert.match(src, /modlog_components_v2: guildConfig\.modlog_components_v2 \? 1 : 0/);
});

test('Bot appearance shows the saved modlog layout', () => {
    const on = render('appearance', { guild, settings: { modlog_components_v2: 1 }, customBotInfo: null });
    assert.match(on, /id="f-appearance-modlog_components_v2"[^>]*checked/);
    const off = render('appearance', { guild, settings: { modlog_components_v2: 0 }, customBotInfo: null });
    assert.doesNotMatch(off, /id="f-appearance-modlog_components_v2"[^>]*checked/);
});

test('General settings keeps a saved timezone that is not in its list, and lists every prefix category', () => {
    const html = render('core', {
        guild, roles: [], settings: { timezone: 'Europe/Dublin' },
        prefixConfig: { prefix: '!', enabled: 1, private_categories: '["owo"]' },
    });
    assert.match(html, /<option value="Europe\/Dublin" selected>Current: Europe\/Dublin<\/option>/);
    assert.match(html, /value="owo" checked/);
    const listed = render('core', { guild, roles: [], settings: { timezone: 'Europe/London' }, prefixConfig: { prefix: '!', enabled: 1 } });
    assert.doesNotMatch(listed, /Current: /);
});
