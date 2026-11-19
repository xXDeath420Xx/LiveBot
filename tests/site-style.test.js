import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { STYLES, THEMES, DEFAULTS, LAYOUTS, normaliseStyle, setPreferences } from '../core/user-preferences.js';
import { SECTIONS, buildManageNav } from '../core/manage-nav.js';
import { FEATURE_SPECS, FEATURE_KEYS } from '../core/feature-config-spec.js';
import { up, down, ADD_COLUMN } from '../migrations/334_site_style.js';

/*
 * Site styles (core/user-preferences.js STYLES): the overall look, chosen per user and
 * rendered as <html data-style>, independent of the colour theme (data-theme).
 *
 *   - only known style values are accepted, the default is "cards"
 *   - every template that renders data-theme also renders data-style, from res.locals
 *   - the dashboard middleware sets uiStyle and honours a ?style= preview
 *   - every style x every theme resolves the core --cf-* tokens in cf-ui.css to a value
 *   - cf-manage.css has rules for each style and a hue for each section
 *   - the Settings page offers each style with its screenshots
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const views = path.join(root, 'dashboard/views');

test('styles: known values only, cards by default', async () => {
    assert.deepEqual(STYLES.map((s) => s.value), ['cards', 'compact', 'classic']);
    assert.equal(DEFAULTS.siteStyle, 'cards');
    for (const s of STYLES) {
        assert.ok(s.label && s.blurb && s.blurb.length <= 90, `${s.value} has a label and a one-line description`);
        assert.equal(normaliseStyle(s.value), s.value);
        assert.equal(normaliseStyle(s.value.toUpperCase()), s.value);
    }
    for (const bad of ['', null, undefined, 'dark', 'cards ', 'cards"><script>', 'Classic!', 42]) {
        assert.equal(normaliseStyle(bad), bad === 'cards ' ? 'cards' : null, `rejects ${JSON.stringify(bad)}`);
    }
    // Rejected before any database write.
    await assert.rejects(setPreferences('1', { siteStyle: 'bootstrap' }), /Unknown style "bootstrap"/);
    assert.deepEqual(LAYOUTS.map((l) => l.value), ['grid', 'cozy', 'list'], 'saved layout values unchanged');
});

test('migration 334 adds site_style idempotently', async () => {
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
    assert.equal(calls.filter((c) => c === ADD_COLUMN).length, 1, 'added once');
    assert.match(ADD_COLUMN, /site_style VARCHAR\(24\) NOT NULL DEFAULT 'cards'/);
    await down(db);
    await down(db);
    assert.equal(calls.filter((c) => /DROP COLUMN site_style/.test(c)).length, 1, 'dropped once');
});

test('every themed template renders data-style from res.locals', () => {
    const files = fs.readdirSync(views).filter((f) => f.endsWith('.ejs'));
    let themed = 0;
    for (const f of files) {
        const html = fs.readFileSync(path.join(views, f), 'utf8');
        const tag = (html.match(/<html[^\n]*/) || [''])[0];
        if (!/data-theme="<%= locals\.uiTheme/.test(tag)) continue;
        themed++;
        assert.match(tag, /data-style="<%= locals\.uiStyle \|\| 'cards' %>"/, `${f} <html> has data-style`);
    }
    // 45 since wave 15 removed the never-rendered views (index, servers, dashboard, profile, ...).
    assert.ok(themed >= 40, `${themed} themed templates`);
});

test('middleware: uiStyle from the saved preference, ?style= previews without saving', () => {
    const server = read('dashboard/server.js');
    assert.match(server, /res\.locals\.uiStyle = 'cards';/);
    assert.match(server, /res\.locals\.uiStyle = prefs\.siteStyle \|\| 'cards';/);
    assert.match(server, /const previewStyle = normaliseStyle\(req\.query\?\.style\);/);
    assert.match(server, /siteStyle: req\.body\.siteStyle/);
    assert.match(server, /Unknown style/);
    assert.match(server, /styles: STYLES,/);
});

function renderManage(locals) {
    const template = read('dashboard/views/manage-tailwind.ejs');
    return ejs.render(template, {
        user: { id: '1', username: 'tester', avatar: null },
        guild: { id: '222222222222222222', name: 'Test', icon: null, memberCount: 10 },
        page: 'overview',
        manageNav: buildManageNav(FEATURE_SPECS),
        featureConfigKeys: FEATURE_KEYS,
        featureConfigSpecs: FEATURE_SPECS,
        roles: [], channels: [], voiceChannels: [], categories: [],
        csrfToken: 't', userPrefs: { pinnedPages: [] },
        prefixConfig: {}, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
        ...locals,
    }, { filename: path.join(views, 'manage-tailwind.ejs'), views: [views] });
}

test('rendered <html> carries the style; the toolbar picker and preview bar follow it', () => {
    const plain = renderManage({});
    assert.match(plain, /<html data-theme="dark" data-density="comfortable" data-style="cards" lang="en">/);
    assert.match(plain, /<option value="cards" selected>Cards<\/option>/);
    assert.ok(!/cf-preview-bar/.test(plain.replace(/\.cf-preview-bar/g, '')), 'no preview bar without a preview');

    const classic = renderManage({ uiStyle: 'classic', uiTheme: 'light' });
    assert.match(classic, /<html data-theme="light" data-density="comfortable" data-style="classic" lang="en">/);
    assert.match(classic, /<option value="classic" selected>Classic<\/option>/);

    const preview = renderManage({ uiStyle: 'compact', uiStylePreview: 'compact' });
    assert.match(preview, /data-style="compact"/);
    assert.match(preview, /Previewing the <strong>Compact<\/strong> style/);
    assert.match(preview, /id="cfPreviewUse" data-style="compact"/);
});

/* ---------------------------------------------------------------------------
   A small resolver for the token rules in cf-ui.css: top-level rules whose
   selectors are :root plus [data-theme]/[data-style] conditions. Enough to
   answer "what does --cf-accent resolve to for theme X in style Y".
--------------------------------------------------------------------------- */
function topLevelRules(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    let depth = 0, start = 0, sel = '';
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
            if (depth === 0) { sel = css.slice(start, i).trim(); start = i + 1; }
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) { rules.push({ sel, body: css.slice(start, i) }); start = i + 1; }
        } else if (ch === ';' && depth === 0) {
            start = i + 1;                                        // @import ...;
        }
    }
    return rules;
}

const COND = /\[data-(theme|style)(?:="([a-z]+)")?\]|:not\(\[data-(theme|style)(?:="([a-z]+)")?\]\)/g;
function matchRoot(selector, attrs) {
    const s = selector.trim();
    if (!s.startsWith(':root')) return null;
    let rest = s.slice(5);
    // :where(...) adds no specificity, but its conditions still have to hold.
    let whereOk = true;
    rest = rest.replace(/:where\(((?:[^()]|\([^()]*\))*)\)/g, (_, inner) => {
        if (matchRoot(':root' + inner, attrs) === null) whereOk = false;
        return '';
    });
    if (!whereOk) return null;
    if (rest.replace(COND, '') !== '') return null;              // anything else (descendants etc.)
    let spec = 1;
    for (const m of rest.matchAll(COND)) {
        spec++;
        if (m[1] && m[2] !== undefined) { if (attrs[m[1]] !== m[2]) return null; }
        else if (m[1]) { if (attrs[m[1]] === undefined) return null; }
        else if (m[4] !== undefined) { if (attrs[m[3]] === m[4]) return null; }
        else if (attrs[m[3]] !== undefined) return null;
    }
    return spec;
}

function resolveTokens(css, attrs) {
    const decls = new Map();                                   // name -> { spec, order, value }
    topLevelRules(css).forEach((rule, order) => {
        if (rule.sel.startsWith('@')) return;
        let best = null;
        for (const part of rule.sel.split(',')) {
            const spec = matchRoot(part, attrs);
            if (spec !== null && (best === null || spec > best)) best = spec;
        }
        if (best === null) return;
        for (const d of rule.body.split(';')) {
            const m = d.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/);
            if (!m) continue;
            const prev = decls.get(m[1]);
            if (!prev || best > prev.spec || (best === prev.spec && order >= prev.order)) decls.set(m[1], { spec: best, order, value: m[2] });
        }
    });
    const value = (name, seen = new Set()) => {
        if (seen.has(name)) return '';
        seen.add(name);
        const d = decls.get(name);
        if (!d) return '';
        return d.value.replace(/var\((--[a-z0-9-]+)(?:,\s*([^)]*))?\)/g, (_, n, fb) => value(n, seen) || fb || '');
    };
    return value;
}

test('cf-ui.css: named themes beat the dark defaults (each theme really changes the page)', () => {
    const css = read('dashboard/public/css/cf-ui.css');
    const v = (theme, name) => resolveTokens(css, { theme, style: 'cards' })(name);
    assert.equal(v('amoled', '--cf-bg'), '#000000');
    assert.equal(v('plum', '--cf-accent'), '#c4a5ff');
    assert.equal(v('forest', '--cf-surface'), '#101a16');
    assert.equal(v('dark', '--cf-accent'), '#b4e04f');
    assert.notEqual(v('midnight', '--cf-bg'), v('dark', '--cf-bg'));
});

const CORE_TOKENS = ['--cf-bg', '--cf-surface', '--cf-surface-2', '--cf-border', '--cf-border-strong', '--cf-text', '--cf-text-2',
    '--cf-text-3', '--cf-accent', '--cf-accent-fg', '--cf-on-accent', '--cf-accent-soft', '--cf-accent-line', '--cf-radius',
    '--cf-radius-lg', '--accent-purple', '--bs-link-color-rgb'];

test('cf-ui.css: every style x every theme resolves the core tokens', () => {
    const css = read('dashboard/public/css/cf-ui.css');
    const themes = THEMES.map((t) => t.value).filter((t) => t !== 'custom');
    assert.ok(themes.length >= 10);
    for (const theme of themes) {
        const byStyle = {};
        for (const style of STYLES.map((s) => s.value)) {
            const tok = resolveTokens(css, { theme, style });
            for (const name of CORE_TOKENS) assert.ok(tok(name).trim(), `${theme} / ${style}: ${name} resolves`);
            byStyle[style] = tok;
        }
        assert.notEqual(byStyle.classic('--cf-accent'), byStyle.cards('--cf-accent'), `${theme}: Classic has its own accent`);
        assert.equal(byStyle.compact('--cf-accent'), byStyle.cards('--cf-accent'), `${theme}: Cards and Compact share the brand accent`);
        assert.equal(byStyle.compact('--cf-radius-lg'), '8px', `${theme}: Compact keeps its radius`);
        assert.equal(byStyle.cards('--cf-radius-lg'), '12px', `${theme}: Cards is rounder`);
    }
    // No attribute at all (logged-out pages) = the Cards look on the dark tokens.
    const bare = resolveTokens(css, {});
    assert.equal(bare('--cf-radius-lg'), '12px');
    assert.equal(bare('--cf-accent'), '#b4e04f');
    // A Custom theme keeps its own accent under Classic.
    assert.equal(resolveTokens(css, { theme: 'custom', style: 'classic' })('--cf-accent'),
        resolveTokens(css, { theme: 'custom', style: 'cards' })('--cf-accent'));
});

test('cf-manage.css: rules for each style and a hue for each section', () => {
    const css = read('dashboard/public/css/cf-manage.css');
    assert.ok((css.match(/:root:not\(\[data-style="compact"\]\)/g) || []).length > 40, 'Cards rules');
    assert.ok((css.match(/:root\[data-style="classic"\]/g) || []).length > 10, 'Classic rules');
    assert.match(css, /\.module-badges \{ display: contents; \}/, 'Compact rows keep their flex layout');
    assert.match(css, /\.module-open \{ display: none; \}/);
    for (const s of SECTIONS) {
        assert.match(css, new RegExp(`\\.modules-section\\[data-category="${s.key}"\\],\\s+\\[data-sec="${s.key}"\\]\\s+\\{ --sec: #[0-9a-f]{6}; \\}`), `${s.key} hue`);
    }
    const hues = [...css.matchAll(/\[data-sec="([a-z]+)"\]\s+\{ --sec: (#[0-9a-f]{6}); \}/g)].filter((m) => m[1] !== 'other').map((m) => m[2]);
    assert.equal(new Set(hues).size, hues.length, 'each section has its own hue');
});

test('settings page offers each style with screenshots and a preview link', () => {
    const tpl = read('dashboard/views/settings-tailwind.ejs');
    assert.match(tpl, /id="site-style"/);
    assert.match(tpl, /role="radiogroup" aria-label="Site style"/);
    assert.match(tpl, /savePreference\(\{ siteStyle: style, dashboardLayout: 'grid' \}\)/);
    const html = ejs.render(tpl, {
        user: { id: '1', username: 'tester', avatar: null }, themes: THEMES, densities: [], layouts: LAYOUTS, styles: STYLES, sections: [],
        uiStyle: 'compact',
    }, { filename: path.join(views, 'settings-tailwind.ejs'), views: [views] });
    for (const s of STYLES) {
        assert.match(html, new RegExp(`data-style-use="${s.value}"`));
        assert.match(html, new RegExp(`href="/dashboard\\?style=${s.value}" data-style-preview="${s.value}"`));
        for (const v of ['dark', 'light']) {
            const rel = `dashboard/public/img/styles/${s.preview}-${v}.webp`;
            assert.match(html, new RegExp(`src="/img/styles/${s.preview}-${v}\\.webp"`));
            assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists`);
            const size = fs.statSync(path.join(root, rel)).size;
            assert.ok(size > 2000 && size < 150 * 1024, `${rel} is ${size} bytes`);
        }
    }
    assert.match(html, /<html data-theme="dark" data-density="comfortable" data-style="compact" lang="en">/);
});
