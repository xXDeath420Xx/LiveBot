import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManageNav } from '../core/manage-nav.js';
import { FEATURE_SPECS, FEATURE_KEYS } from '../core/feature-config-spec.js';
import { STYLES } from '../core/user-preferences.js';
import { manageTemplateFor, restoreClassicCss, classicSource, loadClassicMap, viewKey } from '../dashboard/services/classic-style.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * The "Classic" site style (dashboard/views/manage-classic.ejs + dashboard/services/classic-style.js):
 *
 *   - the manage route renders manage-classic for classic, manage-tailwind for cards/compact
 *   - manage-classic does not load the redesign's stylesheets and has a working style switch
 *   - every page core/manage-nav.js lists is linked from the classic overview, and the classic
 *     pageMap serves every page manage-tailwind's does
 *   - restoring a partial's original CSS touches only <style> blocks and style="" values:
 *     markup, ids, scripts and EJS stay byte-identical
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// The dashboard's own view engine (include resolution and the classic hook), uncached.
const engine = createViewEngine({ viewsDir: views, cache: false });
function render(template, locals) {
    return engine.renderFile(path.join(views, template + '.ejs'), { ...locals });
}

function manageLocals(page, style) {
    return {
        user: { id: '1', username: 'tester', avatar: null, isSuperAdmin: false, canCreateBots: false },
        guild: { id: '222222222222222222', name: 'Test', icon: null, memberCount: 10 },
        page,
        manageNav: buildManageNav(FEATURE_SPECS),
        featureConfigKeys: FEATURE_KEYS,
        featureConfigSpecs: FEATURE_SPECS,
        roles: [], channels: [], voiceChannels: [], categories: [],
        csrfToken: 't', userPrefs: { pinnedPages: [], siteStyle: style },
        prefixConfig: {}, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
        uiStyle: style, classicCss: style === 'classic',
        siteStyles: STYLES.map((s) => ({ value: s.value, label: s.label })),
    };
}

const pageMapKeys = (src) => {
    const start = src.indexOf('const pageMap = {');
    const end = src.indexOf('const activePage = pageMap[page]', start);
    assert.ok(start > 0 && end > start, 'pageMap found');
    return new Set([...src.slice(start, end).matchAll(/^\s*'([a-z0-9-]+)':\s*\{/gm)].map((m) => m[1]));
};

test('route: classic renders manage-classic, cards and compact keep manage-tailwind', () => {
    assert.equal(manageTemplateFor('classic'), 'manage-classic');
    for (const s of ['cards', 'compact', undefined, null, '', 'bogus']) assert.equal(manageTemplateFor(s), 'manage-tailwind', String(s));
    const server = read('dashboard/server.js');
    assert.match(server, /const manageTemplate = manageTemplateFor\(res\.locals\.uiStyle\);/);
    assert.match(server, /res\.render\(manageTemplate, \{\s*classicCss: classic,/);
    assert.match(server, /app\.engine\('ejs', views\.engine\);/);
    assert.match(read('dashboard/services/view-engine.js'), /if \(variant === 'classic'\) src = classicSource\(viewsDir, file, src\);/);
});

test('classic overview: original shell, no redesign CSS, style switch, every page reachable', () => {
    const html = render('manage-classic', manageLocals('overview', 'classic'));
    assert.match(html, /<html data-theme="dark" data-density="comfortable" data-style="classic" lang="en">/);
    assert.ok(!/href="[^"]*cf-(ui|manage)\.css/.test(html), 'redesign stylesheets not loaded');
    assert.match(html, /bootstrap@5\.3\.3\/dist\/css\/bootstrap\.min\.css/, 'original Bootstrap look');
    assert.match(html, /--accent-purple: #a78bfa;/, 'original palette');
    assert.match(html, /class="section-header purple section-toggle"/, 'original category sections');

    // Style switch: a select of every style posting siteStyle + grid layout with the CSRF token.
    assert.match(html, /<meta name="csrf-token" content="t">/);
    assert.match(html, /id="styleSwitchSelect"/);
    for (const s of STYLES) assert.match(html, new RegExp(`<option value="${s.value}"${s.value === 'classic' ? ' selected' : ''}>${s.label}</option>`));
    assert.match(html, /fetch\('\/api\/me\/preferences'/);
    assert.match(html, /JSON\.stringify\(\{ siteStyle: value, dashboardLayout: 'grid' \}\)/);
    assert.match(html, /'X-CSRF-Token': meta \? meta\.getAttribute\('content'\) : ''/);

    const linked = new Set([...html.matchAll(/\?page=([a-z0-9-]+)"/g)].map((m) => m[1]));
    const pages = buildManageNav(FEATURE_SPECS).flatMap((s) => s.items.map((i) => i.page));
    assert.ok(pages.length >= 140, `${pages.length} pages`);
    const missing = pages.filter((p) => !linked.has(p));
    assert.deepEqual(missing, [], 'every manage-nav page has a card on the classic overview');
});

test('classic pageMap serves every page manage-tailwind does', () => {
    const live = pageMapKeys(read('dashboard/views/manage-tailwind.ejs'));
    const classic = pageMapKeys(read('dashboard/views/manage-classic.ejs'));
    const missing = [...live].filter((k) => !classic.has(k));
    assert.deepEqual(missing, [], 'pages missing from the classic pageMap');
    assert.ok(read('dashboard/views/manage-classic.ejs').includes("partial: 'feature-config'"), 'generated feature pages too');
});

test('classic sub-page: original purple CSS restored, same ids as the redesign', () => {
    const classic = render('manage-classic', manageLocals('moderation', 'classic'));
    const cards = render('manage-tailwind', manageLocals('moderation', 'cards'));
    assert.match(classic, /<li class="breadcrumb-item active">Moderation<\/li>/);
    // The redesign flattened this gradient to var(--cf-accent); classic has the original back.
    assert.ok(/linear-gradient\([^)]*#8b5cf6/i.test(classic), 'original purple gradient');
    const ids = (h) => [...h.matchAll(/\sid="([^"<]+)"/g)].map((m) => m[1]);
    const partialIds = (h) => new Set(ids(h.slice(h.indexOf('MANAGE_PAGE ='))));
    for (const id of partialIds(cards)) {
        if (/^(cf|sidenav|mob|ov)/i.test(id)) continue;           // shell ids of the new layout
        assert.ok(partialIds(classic).has(id), `#${id} kept`);
    }
});

test('cards and compact still render manage-tailwind with the redesign CSS', () => {
    for (const style of ['cards', 'compact']) {
        const html = render(manageTemplateFor(style), manageLocals('overview', style));
        assert.match(html, new RegExp(`data-style="${style}"`));
        assert.match(html, /href="[^"]*cf-manage\.css/);
        assert.ok(!/id="styleSwitchSelect"/.test(html));
    }
});

test('CSS restore: only style blocks and style attributes change, mapped rules all apply', () => {
    const map = loadClassicMap();
    const files = Object.keys(map);
    assert.ok(files.length >= 70, `${files.length} partials mapped`);
    const strip = (s) => s.replace(/(<script\b[\s\S]*?<\/script>)|<style\b[^>]*>[\s\S]*?<\/style>|\sstyle="[^"]*"/gi, (m, script) => script || '§');
    let applied = 0;
    let total = 0;
    for (const f of files) {
        const full = path.join(views, f);
        if (!fs.existsSync(full)) continue;
        const src = fs.readFileSync(full, 'utf8');
        const out = restoreClassicCss(src, map[f]);
        assert.equal(strip(out), strip(src), `${f}: nothing outside CSS changed`);
        // Every mapped key still present in today's file is replaced.
        for (const [k] of Object.entries(map[f].attrs || {})) {
            if (src.includes(` style="${k}"`)) { total++; if (!out.includes(` style="${k}"`) || map[f].attrs[k].includes(k)) applied++; }
        }
        assert.equal(classicSource(views, full, src), out);
    }
    assert.ok(total === 0 || applied === total, `${applied}/${total} attribute restores applied`);
    assert.equal(viewKey(views, path.join(views, 'partials/manage/moderation.ejs')), 'partials/manage/moderation.ejs');
    assert.equal(viewKey(views, path.join(root, 'index.js')), null);
    assert.equal(restoreClassicCss('<div style="x">', undefined), '<div style="x">');
});

test('CSS restore: ordered originals, scripts and EJS untouched', () => {
    const entry = { rules: { 'color: var(--a)': ['color: #111', 'color: #222'] }, attrs: { 'background: var(--a)': ['background: red'] } };
    const src = '<style>.x{color: var(--a)} <%= y %> .z{color: var(--a)} .w{color: var(--a)}</style>'
        + '<script>const s = "{color: var(--a)}";</script><b style="background: var(--a)"></b>';
    const out = restoreClassicCss(src, entry);
    assert.equal(out, '<style>.x{color: #111} <%= y %> .z{color: #222} .w{color: #222}</style>'
        + '<script>const s = "{color: var(--a)}";</script><b style="background: red"></b>');
});
