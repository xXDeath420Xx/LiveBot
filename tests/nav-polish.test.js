import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
    THEMES, AUTO_THEME_SCRIPT, themeMode, parseUiOptions, nextHiddenChecklists, setPreferences, DEFAULTS,
} from '../core/user-preferences.js';
import { parseHex, contrast, accentTokens, serverAccentCss, MODE_SURFACES } from '../core/accent-tint.js';
import { RECOMMENDED, BASICS, PROTECTIONS, buildChecklist } from '../core/setup-checklist.js';
import { getGuide } from '../dashboard/content/guides/index.js';
import { PROTECTION_GRID } from '../core/security-overview-logic.js';
import { RELATED, relatedPages, buildManageNav } from '../core/manage-nav.js';
import { extractFields, parsePageMap, buildIndex, cleanText, includesIn, getSettingsIndex } from '../core/settings-index.js';
import { FEATURE_SPECS, FEATURE_KEYS } from '../core/feature-config-spec.js';
import { up, down, ADD_COLUMN, FIX_INSULT_SOURCE } from '../migrations/335_nav_polish.js';

/*
 * Wave 17 "nav polish": the pure logic behind
 *   - the Auto theme (core/user-preferences.js AUTO_THEME_SCRIPT, themeMode)
 *   - per-server accent colours (core/accent-tint.js) and the ui_options column (migration 335)
 *   - the overview setup checklist (core/setup-checklist.js)
 *   - related pages (core/manage-nav.js RELATED / relatedPages)
 *   - the settings-field search index (core/settings-index.js) and its browser matcher
 *     (dashboard/public/js/cf-field-search.js)
 * plus the wiring each one needs in the templates and dashboard/server.js.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const nav = buildManageNav(FEATURE_SPECS);
const navPages = new Set(nav.flatMap((s) => s.items.map((i) => i.page)));

// ── Auto theme ──────────────────────────────────────────────────────────────

test('auto theme: offered, valid, and resolves light/dark from the OS', async () => {
    const auto = THEMES.find((t) => t.value === 'auto');
    assert.ok(auto && auto.label === 'Auto' && auto.blurb.length <= 90);
    assert.equal(themeMode('auto', true), 'light');
    assert.equal(themeMode('auto', false), 'dark');
    assert.equal(themeMode('sand'), 'light');
    assert.equal(themeMode('forest'), 'dark');
    await assert.rejects(setPreferences('1', { theme: 'automatic' }), /Unknown theme "automatic"/);

    // The inline script itself, run against a fake <html> and matchMedia.
    const body = AUTO_THEME_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
    const run = (theme, light, mode = null) => {
        const attrs = new Map([['data-theme', theme]]);
        if (mode) attrs.set('data-theme-mode', mode);
        let onChange = null;
        const mq = { matches: light, addEventListener: (_e, fn) => { onChange = fn; } };
        const document = { documentElement: { getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, String(v)) } };
        vm.runInNewContext(body, { document, window: { matchMedia: () => mq }, matchMedia: () => mq });
        return { attrs, flip: (v) => { mq.matches = v; onChange(); } };
    };
    let r = run('auto', true);
    assert.equal(r.attrs.get('data-theme'), 'light');
    assert.equal(r.attrs.get('data-theme-mode'), 'auto');
    r.flip(false);
    assert.equal(r.attrs.get('data-theme'), 'dark', 'follows the OS when it switches');
    r = run('forest', true);
    assert.equal(r.attrs.get('data-theme'), 'forest', 'other themes are left alone');
    assert.equal(r.attrs.has('data-theme-mode'), false);
});

test('every themed template carries the Auto script and the Dark Reader lock, after the anti-flash script', () => {
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else if (p.endsWith('.ejs')) files.push(p);
        }
    })(views);
    let themed = 0;
    for (const f of files) {
        let src = fs.readFileSync(f, 'utf8');
        // Public site pages take these scripts from the shared head partial.
        if (src.includes("include('partials/site-head'")) src = src.replace("include('partials/site-head'", fs.readFileSync(path.join(views, 'partials/site-head.ejs'), 'utf8'));
        const tag = (src.match(/<html\s[^\n]*/) || [''])[0];
        if (!/data-theme="<%= locals\.uiTheme/.test(tag)) continue;
        themed++;
        const rel = path.relative(views, f);
        assert.ok(src.includes(AUTO_THEME_SCRIPT), `${rel} has the Auto theme script`);
        assert.match(src, /<meta name="darkreader-lock">/, `${rel} asks Dark Reader to stand down`);
        const flash = src.indexOf('Anti-flash');
        if (flash !== -1) assert.ok(src.indexOf(AUTO_THEME_SCRIPT) > flash, `${rel}: Auto runs after the anti-flash script`);
    }
    assert.ok(themed >= 45, `${themed} themed templates`);
});

// ── Server accent ───────────────────────────────────────────────────────────

test('accent tint: any embed colour is fitted to readable contrast in both modes', () => {
    const samples = ['#5865F2', '#FFFF00', '#000000', '#FFFFFF', '#0a1a40', '#57F287', '#ED4245', '#9B59B6', '#808080', '#ff00ff', '#00ffff', '#3a2a00'];
    for (const hex of samples) {
        for (const mode of ['dark', 'light']) {
            const t = accentTokens(hex, mode);
            const surfaces = MODE_SURFACES[mode].map(parseHex);
            for (const s of surfaces) {
                assert.ok(contrast(parseHex(t['--cf-accent']), s) >= 3, `${hex} ${mode}: accent ${t['--cf-accent']} >= 3:1`);
                assert.ok(contrast(parseHex(t['--cf-accent-fg']), s) >= 4.5, `${hex} ${mode}: accent-fg ${t['--cf-accent-fg']} >= 4.5:1`);
            }
            assert.ok(contrast(parseHex(t['--cf-accent']), parseHex(t['--cf-on-accent'])) >= 4.5, `${hex} ${mode}: text on the accent >= 4.5:1`);
            assert.equal(t['--accent-purple'], t['--cf-accent-fg'], 'legacy accent follows the text accent');
        }
    }
    // A colour that already reads is kept as is.
    assert.equal(accentTokens('#5865F2', 'light')['--cf-accent'], '#5865f2');
    assert.equal(accentTokens('nope', 'dark'), null);
    assert.equal(serverAccentCss('#12345'), '');
});

test('accent tint: CSS overrides the accent only, per mode, and leaves Custom alone', () => {
    const css = serverAccentCss('#e91e63');
    const [dark, light] = css.split('\n');
    assert.match(dark, /^:root:not\(\[data-theme="light"\]\):not\(\[data-theme="sand"\]\):not\(\[data-theme="custom"\]\) \{/);
    assert.match(light, /^:root\[data-theme="light"\], :root\[data-theme="sand"\] \{/);
    for (const line of [dark, light]) {
        const props = [...line.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
        assert.deepEqual(props.sort(), ['--accent-purple', '--bs-link-color-rgb', '--cf-accent', '--cf-accent-fg', '--cf-accent-hover', '--cf-accent-line', '--cf-accent-soft', '--cf-on-accent']);
        assert.ok(!/--cf-(bg|surface|text|border)/.test(line), 'surfaces and text untouched');
        assert.equal((line.match(/!important/g) || []).length, props.length);
    }
    assert.ok(!/<|>|\{[^}]*\{/.test(css.replace(/^[^{]*\{|\}$/gm, '')), 'no markup can leak out of the style block');
});

test('ui_options: parse, defaults, checklist hide/show', () => {
    assert.equal(DEFAULTS.serverAccent, false);
    assert.deepEqual(DEFAULTS.hiddenChecklists, []);
    assert.deepEqual(parseUiOptions(null), { serverAccent: false, hiddenChecklists: [] });
    assert.deepEqual(parseUiOptions('{"serverAccent":true,"hiddenChecklists":["123456789012345678","x"]}'), { serverAccent: true, hiddenChecklists: ['123456789012345678'] });
    assert.deepEqual(parseUiOptions('{"serverAccent":"yes"}').serverAccent, false, 'only a real true turns it on');
    const a = '111111111111111111', b = '222222222222222222';
    assert.deepEqual(nextHiddenChecklists([], { hideChecklist: a }), [a]);
    assert.deepEqual(nextHiddenChecklists([a], { hideChecklist: a }), [a], 'no duplicates');
    assert.deepEqual(nextHiddenChecklists([a, b], { showChecklist: a }), [b]);
    assert.deepEqual(nextHiddenChecklists([a, b], { showAllChecklists: true }), []);
    assert.throws(() => nextHiddenChecklists([], { hideChecklist: 'drop table' }), /Invalid server id/);
    const many = Array.from({ length: 250 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const capped = nextHiddenChecklists(many, { hideChecklist: b });
    assert.equal(capped.length, 200);
    assert.equal(capped.at(-1), b, 'the newest is kept');
});

test('migration 335: adds ui_options once, resets the dead insult source', async () => {
    const calls = [];
    let exists = false;
    const db = {
        async execute(sql) {
            calls.push(sql);
            if (/information_schema\.COLUMNS/.test(sql)) return [exists ? [{ 1: 1 }] : []];
            if (/ADD COLUMN/.test(sql)) exists = true;
            if (/DROP COLUMN/.test(sql)) exists = false;
            return [[]];
        },
    };
    await up(db);
    await up(db);
    assert.equal(calls.filter((c) => c === ADD_COLUMN).length, 1);
    assert.equal(calls.filter((c) => c === FIX_INSULT_SOURCE).length, 2, 'the data fix is idempotent and runs each time');
    assert.match(ADD_COLUMN, /ADD COLUMN ui_options LONGTEXT .*json_valid\(ui_options\)/);
    assert.match(FIX_INSULT_SOURCE, /JSON_SET\(config, '\$\.insult_source', 'builtin'\)/);
    assert.match(FIX_INSULT_SOURCE, /feature_key = 'fun'/);
    assert.match(FIX_INSULT_SOURCE, /<> 'builtin'/);
    await down(db);
    assert.equal(calls.filter((c) => /DROP COLUMN ui_options/.test(c)).length, 1);
});

// ── Setup checklist ─────────────────────────────────────────────────────────

const grid = (on) => PROTECTION_GRID.map((g) => ({ key: g.key, label: g.label, page: g.page, on: on[g.key] ?? null }));

test('setup checklist: counts what is known, links each missing step', () => {
    const out = buildChecklist({
        grid: grid({ raid: true, antiNuke: false, spammer: true, phishing: false, globalBan: null, verification: true }),
        basics: { modLog: true, serverLog: false, welcome: null, automod: false },
    });
    // globalBan, selfbot, welcome and tickets are unknown: left out, not counted as missing. The recommended
    // steps come first, in their own order, then the other basics, then the other protections.
    assert.deepEqual(out.items.map((i) => i.key), ['serverLog', 'raid', 'phishing', 'modLog', 'automod', 'verification', 'antiNuke', 'spammer']);
    assert.deepEqual(out.items.map((i) => i.kind), ['recommended', 'recommended', 'recommended', 'setup', 'setup', 'protection', 'protection', 'protection']);
    assert.equal(out.items.find((i) => i.key === 'raid').guide, 'raid-protection');
    assert.equal(out.items.find((i) => i.key === 'modLog').guide, null);
    assert.equal(out.total, 8);
    assert.equal(out.done, 4);
    assert.equal(out.percent, 50);
    assert.equal(out.complete, false);
    const anti = out.items.find((i) => i.key === 'antiNuke');
    assert.deepEqual([anti.page, anti.field, anti.kind], ['security', 'antiNukeEnabled', 'protection']);
    assert.equal(buildChecklist({}).total, 0);
    assert.equal(buildChecklist({}).complete, false, 'nothing known is not "complete"');
    const all = buildChecklist({ grid: grid(Object.fromEntries([...PROTECTIONS, ...RECOMMENDED].map((p) => [p.key, true]))), basics: { modLog: true, serverLog: true, welcome: true, automod: true, tickets: true } });
    assert.equal(all.complete, true);
    assert.equal(all.total, RECOMMENDED.length + BASICS.length + PROTECTIONS.length);
});

test('setup checklist: the recommended steps keep the order from the onboarding data, each with a guide', () => {
    // docs/onboarding-checklist-2026-11-20.md: most often set up in the first week, among the features whose
    // first-week servers were more often still active after 30 days.
    assert.deepEqual(RECOMMENDED.map((r) => r.key), ['welcome', 'serverLog', 'raid', 'phishing', 'selfbot', 'globalBan', 'tickets']);
    for (const r of RECOMMENDED) {
        assert.ok(getGuide(r.guide), `${r.key}: guide ${r.guide} exists`);
        if (r.from === 'grid') assert.ok(PROTECTION_GRID.some((g) => g.key === r.key), `${r.key}: is a security grid row`);
    }
    const keys = [...RECOMMENDED, ...BASICS, ...PROTECTIONS].map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, 'no step twice');
});

test('setup checklist: every step points at a real page and a field that exists on it', () => {
    const pageMap = new Map(parsePageMap(read('dashboard/views/manage-tailwind.ejs')).map((e) => [e.page, e.partial]));
    const gridPage = (p) => ({ ...p, page: PROTECTION_GRID.find((g) => g.key === p.key).page });
    const steps = [...RECOMMENDED.map((r) => (r.from === 'grid' ? gridPage(r) : r)), ...BASICS, ...PROTECTIONS.map(gridPage)];
    for (const s of steps) {
        assert.ok(navPages.has(s.page), `${s.key}: page ${s.page} exists`);
        assert.ok(s.label.length <= 60 && s.why.length <= 90 && !/!/.test(s.label + s.why), `${s.key}: plain, short copy`);
        if (!s.field) continue;
        const partial = pageMap.get(s.page);
        assert.ok(partial, `${s.key}: ${s.page} has a partial`);
        const src = read(`dashboard/views/partials/manage/${partial}.ejs`);
        assert.ok(src.includes(`id="${s.field}"`), `${s.key}: #${s.field} is on ${partial}.ejs`);
    }
});

// ── Related pages ───────────────────────────────────────────────────────────

test('related pages: every pair names real pages; 3-5 per page, never itself', () => {
    for (const [from, list] of Object.entries(RELATED)) {
        assert.ok(navPages.has(from), `RELATED key ${from} is a page`);
        for (const p of list) assert.ok(navPages.has(p), `RELATED ${from} -> ${p} is a page`);
    }
    for (const page of navPages) {
        const rel = relatedPages(page, nav);
        assert.ok(rel.length >= 3 && rel.length <= 5, `${page}: ${rel.length} related`);
        assert.ok(!rel.some((r) => r.page === page), `${page} is not related to itself`);
        assert.equal(new Set(rel.map((r) => r.page)).size, rel.length, `${page}: no duplicates`);
    }
    const v = relatedPages('verification', nav).map((r) => r.page);
    assert.deepEqual(v.slice(0, 3), ['welcome', 'role-manager', 'rejoin'], 'explicit pairs first');
    const m = relatedPages('moderation', nav).map((r) => r.page);
    assert.ok(m.includes('automod') && m.includes('logging'));
    assert.ok(relatedPages('welcome', nav).some((r) => r.page === 'verification'), 'pairs apply both ways');
    assert.ok(relatedPages('streaming', nav).length >= 3, 'an alias gets its target page\'s list');
    assert.deepEqual(relatedPages('no-such-page', nav), []);
    assert.equal(relatedPages('verification', nav, { limit: 2 }).length, 2);
});

// ── Settings-field index ────────────────────────────────────────────────────

test('settings index: extracts labelled fields, skips scripts and EJS-built text', () => {
    const src = `
        <label for="muteRole">Mute role</label><select id="muteRole"></select>
        <label class="x"><input type="checkbox" id="vfOn"> <span><strong>Verification on</strong></span></label>
        <label><input type="checkbox" id="banner"><div><strong>Enable banner</strong><small>Generate an image</small></div></label>
        <input id="search1" aria-label="Search members">
        <h3 id="logs">Log settings</h3>
        <h3>Escalation &amp; rules</h3>
        <h3><%= title %></h3>
        <label for="<%= id %>">Dynamic</label>
        <label for="dup">Mute role</label>
        <script>var x = '<label for="fake">Fake</label>';</script>
        <%# <label for="hidden">Commented</label> %>
        <label for="n1">12</label>`;
    assert.deepEqual(extractFields(src), [
        { label: 'Mute role', field: 'muteRole' },
        { label: 'Verification on', field: 'vfOn' },
        { label: 'Enable banner', field: 'banner' },
        { label: 'Search members', field: 'search1' },
        { label: 'Log settings', field: 'logs' },
        { label: 'Escalation & rules', field: 'text:Escalation & rules' },
    ]);
    assert.equal(cleanText('  A <b>bold</b>&nbsp;move <%= x %> '), 'A bold move');
    assert.deepEqual(includesIn(`<%- include('partials/manage/_x', {}) %> <%- include("./y") %> <%- include(\`z\${a}\`) %>`), ['partials/manage/_x', './y']);
});

test('settings index: built from the real templates; every id it lists is on its page', () => {
    const pageMap = parsePageMap(read('dashboard/views/manage-tailwind.ejs'));
    assert.ok(pageMap.length > 90);
    const readPartial = (name) => {
        try { return read(`dashboard/views/partials/manage/${name.endsWith('.ejs') ? name : `${name}.ejs`}`); } catch { return null; }
    };
    const index = buildIndex({ nav, pageMap, readPartial, specs: FEATURE_SPECS });
    const pages = Object.keys(index);
    assert.ok(pages.length > 100, `${pages.length} pages indexed`);
    const has = (page, label, field) => assert.ok((index[page] || []).some(([l, f]) => l === label && (!field || f === field)), `${page}: "${label}"`);
    has('moderation', 'Mute role', 'f-moderation-muted_role_id');   // sentence case since wave 18 (pages-kit)
    has('verification', 'Verification on', 'vfEnabled');
    has('logging', 'Default log channel', 'log-channel-id');
    has('fun', 'Allow /insult', 'fc-f-insults_enabled');   // /insult is the text form since the 2026-11-18 split
    has('fun', 'Insult source', 'fc-f-insult_source');   // back since wave 20 (Evil Insult served locally)
    const partialOf = new Map(pageMap.map((e) => [e.page, e.partial]));
    for (const page of pages) {
        assert.ok(navPages.has(page), `${page} is a nav page`);
        for (const [label, field] of index[page]) {
            assert.ok(label.length >= 2 && label.length <= 90, `${page}: label "${label}"`);
            if (field.startsWith('text:') || field.startsWith('fc-f-')) continue;
            const partial = partialOf.get(page);
            const sources = [readPartial(partial) || ''];
            for (const inc of includesIn(sources[0])) sources.push(readPartial(inc.replace(/^\.\//, '').replace(/^partials\/manage\//, '')) || '');
            assert.ok(sources.some((s) => s.includes(`id="${field}"`)), `${page}: #${field} exists`);
        }
    }
    // Cached per view generation.
    const a = getSettingsIndex({ viewsDir: views, nav, specs: FEATURE_SPECS, generation: 41 });
    assert.equal(getSettingsIndex({ viewsDir: views, nav, specs: FEATURE_SPECS, generation: 41 }), a);
    assert.notEqual(getSettingsIndex({ viewsDir: views, nav, specs: FEATURE_SPECS, generation: 42 }), a);
});

test('cf-field-search.js: matching ranks the label, needs every word, ignores 1-letter queries', () => {
    const sandbox = { self: {}, fetch: () => Promise.reject(new Error('no network')) };
    vm.runInNewContext(read('dashboard/public/js/cf-field-search.js'), sandbox);
    const F = sandbox.self.CFFields;
    const plain = (v) => JSON.parse(JSON.stringify(v));   // arrays from the sandbox's realm
    const entries = F._flatten({
        pages: {
            moderation: [['Mute Role', 'f-moderation-muted_role_id'], ['Moderation Log Channel', 'f-moderation-mod_log_channel_id'], ['Recent Infractions', 'text:Recent Infractions']],
            logging: [['Default Log Channel', 'log-channel-id']],
            welcome: [['Welcome Channel', 'f-welcome-channel_id']],
        },
        titles: { moderation: 'Moderation', logging: 'Logging', welcome: 'Welcome messages' },
    });
    assert.equal(entries.length, 5);
    assert.deepEqual(plain(F.match(entries, 'm', 10)), []);
    assert.deepEqual(plain(F.match(entries, 'mute role', 10).map((e) => e.field)), ['f-moderation-muted_role_id']);
    const ch = F.match(entries, 'channel', 10).map((e) => e.label);
    assert.equal(ch.length, 3);
    assert.equal(F.match(entries, 'log channel', 10)[0].label, 'Default Log Channel');
    assert.equal(F.match(entries, 'welcome', 10)[0].page, 'welcome', 'the page title counts too');
    assert.equal(F.href('123', entries[0]), '/manage/123?page=moderation&field=f-moderation-muted_role_id');
    assert.equal(F.match(entries, 'channel', 2).length, 2);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

function renderManage(file, locals) {
    return ejs.render(read(`dashboard/views/${file}`), {
        user: { id: '1', username: 'tester', avatar: null },
        guild: { id: '222222222222222222', name: 'Test', icon: null, memberCount: 10 },
        page: 'overview', manageNav: nav, featureConfigKeys: FEATURE_KEYS, featureConfigSpecs: FEATURE_SPECS,
        roles: [], channels: [], voiceChannels: [], categories: [], csrfToken: 't', userPrefs: { pinnedPages: [] },
        prefixConfig: {}, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
        ...locals,
    }, { filename: path.join(views, file), views: [views] });
}

test('manage pages: switcher, checklist, related pages, settings search and the server colour', () => {
    for (const file of ['manage-tailwind.ejs', 'manage-classic.ejs']) {
        const ov = renderManage(file, { settingsIndexVersion: 7 });
        assert.match(ov, /id="cfSwitcherBtn"/, `${file}: server switcher`);
        assert.match(ov, /id="cfChecklist"/, `${file}: setup checklist`);
        assert.match(ov, /\/js\/cf-field-search\.js/, `${file}: settings search script`);
        assert.ok(!/cf-server-accent/.test(ov.replace(/#cf-server-accent|id="cf-server-accent"/g, (m) => m)) || !/<style id="cf-server-accent">/.test(ov), `${file}: no tint unless chosen`);
        const hidden = renderManage(file, { checklistHidden: true });
        assert.ok(!/id="cfChecklist"/.test(hidden), `${file}: a dismissed checklist is not rendered`);
        const sub = renderManage(file, { page: 'moderation', relatedPages: relatedPages('moderation', nav), moderationConfig: {}, recentInfractions: [], escalationRules: [] });
        assert.match(sub, /class="cf-related"/, `${file}: related pages on a feature page`);
        assert.match(sub, /href="\/manage\/222222222222222222\?page=automod"/);
        const tinted = renderManage(file, { serverAccentCss: serverAccentCss('#e91e63') });
        assert.match(tinted, /<style id="cf-server-accent">:root:not\(\[data-theme="light"\]\)/, `${file}: server colour`);
    }
    const tw = renderManage('manage-tailwind.ejs', { settingsIndexVersion: 7 });
    assert.match(tw, /"indexVersion":7/);
    assert.match(tw, /placeholder="Go to a page or setting"/);
    assert.match(read('dashboard/public/js/cf-manage.js'), /CFFields\.highlightFromUrl\(\)/);
    assert.match(read('dashboard/views/manage-classic.ejs'), /CFFields\.highlightFromUrl\(\)/);
});

test('settings page: Auto theme, hover preview, server colour switch, extension note', () => {
    const tpl = read('dashboard/views/settings-tailwind.ejs');
    const html = ejs.render(tpl, {
        user: { id: '1', username: 'tester', avatar: null }, themes: THEMES, densities: [], layouts: [], styles: [], sections: [],
        userPrefs: { serverAccent: true, hiddenChecklists: ['111111111111111111', '222222222222222222'] },
    }, { filename: path.join(views, 'settings-tailwind.ejs'), views: [views] });
    assert.match(html, /class="theme-option" data-theme="auto"/);
    assert.match(html, /data-swatch="auto"/);
    assert.match(html, /id="serverAccentToggle" checked/);
    assert.match(html, /Hidden on 2 servers/);
    assert.match(html, /id="checklistShowAll"/);
    assert.match(html, /If you use a dark-mode browser extension, turn it off for this site: the site has its own themes\./);
    assert.match(tpl, /addEventListener\('mouseenter', \(\) => startPreview\('theme'/);
    assert.match(tpl, /card\.addEventListener\('mouseenter', \(\) => startPreview\('style'/);
    assert.match(tpl, /savePreference\(\{ serverAccent: on \}\)/);
    assert.match(tpl, /savePreference\(\{ showAllChecklists: true \}\)/);
});

test('server.js: switcher list, settings index, preferences and checklist routes', () => {
    const server = read('dashboard/server.js');
    assert.match(server, /async function manageableGuildsFor\(req\)/);
    assert.match(server, /app\.get\('\/dashboard', checkAuth, async \(req, res\) => \{\s+try \{\s+const manageableGuilds = await manageableGuildsFor\(req\);/);
    assert.match(server, /app\.get\('\/api\/me\/servers', checkAuth/);
    assert.match(server, /app\.get\('\/api\/settings-index', checkAuth/);
    assert.match(server, /serverAccent: req\.body\.serverAccent === true/);
    assert.match(server, /hideChecklist: String\(req\.body\.hideChecklist\)/);
    assert.match(server, /relatedPages: relatedPageList,/);
    assert.match(server, /serverAccentCss: serverAccentStyle,/);
    assert.match(read('dashboard/routes/api/features/insight.js'), /router\.get\('\/checklist'/);
});

test('cf-ui.css: both site-header markups take the theme tokens (Light had a dark bar)', () => {
    const css = read('dashboard/public/css/cf-ui.css');
    assert.match(css, /\.navbar:has\(\.navbar-content\),\s*\.navbar:has\(> \.navbar-container\) \{/);
    assert.match(css, /\.navbar > \.navbar-container \{/);
});
