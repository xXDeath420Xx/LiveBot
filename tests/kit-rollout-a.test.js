import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { FEATURE_SPECS, FEATURE_KEYS } from '../core/feature-config-spec.js';
import { PAGES, stubs } from './fixtures/kit-rollout-a-stubs.js';
import { extractFields } from '../core/settings-index.js';

/*
 * Wave 21a "kit-rollout-a": group A of the manage pages rebuilt on the wave 18 settings-row kit
 * (dashboard/public/css/cf-settings.css, dashboard/views/partials/kit/) - the Setup, Protection,
 * Joining and Roles pages listed in PAGES below, plus the generic feature-config renderer that
 * draws every page generated from core/feature-config-spec.js.
 *
 *   - every page kept each element id, form field name, data-* attribute and form action/method
 *     it had before the rebuild (tests/fixtures/kit-rollout-a-fields.json, captured from the
 *     original partials with the same stub data), so the routes, page scripts and the settings
 *     search keep working
 *   - every page reads as the kit: kit sections and panels, sentence-case headings, no emoji, no
 *     card containers, and renders under the Classic style too
 *   - the generated pages: the renderer builds its DOM with createElement (no HTML strings), keeps
 *     the fc-f-<key> ids, data-key/data-type hooks and the fc-save / fc-status / fc-root ids
 *
 * KIT_A_WRITE_FIXTURE=1 re-captures the fixture from whatever partials are on disk; it was written
 * once, from the partials as they were before the rebuild. KIT_A_PAGES=a,b limits the page tests.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FIXTURE = path.join(root, 'tests/fixtures/kit-rollout-a-fields.json');
const EMOJI = /\p{Extended_Pictographic}/u;

const ONLY = process.env.KIT_A_PAGES ? process.env.KIT_A_PAGES.split(',').map((s) => s.trim()).filter(Boolean) : null;
const SELECTED = ONLY ? PAGES.filter((p) => ONLY.includes(p)) : PAGES;

/**
 * A page partial rendered through the dashboard's view engine, included from a wrapper page the
 * way the manage templates include it (so Classic's CSS restore applies); `empty` drops the lists.
 */
export function renderPage(page, { empty = false, classic = false } = {}) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const locals = { ...stubs()[page], classicCss: classic };
    if (empty) {
        for (const [k, v] of Object.entries(locals)) {
            if (['roles', 'channels', 'voiceChannels', 'categories'].includes(k)) continue;
            if (Array.isArray(v)) locals[k] = [];
            else if (v instanceof Map) locals[k] = new Map();
        }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-a-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${page}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Ids, form field names, data-* attribute names and form action/method pairs in rendered markup. */
export function fieldsOf(html) {
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
    const ids = new Set([...markup.matchAll(/<[a-z][^>]*?\sid="([^"]+)"/gi)].map((m) => m[1]));
    const names = new Set([...markup.matchAll(/<(?:input|select|textarea|button)\b[^>]*?\sname="([^"]+)"/gi)].map((m) => m[1]));
    const data = new Set([...markup.matchAll(/<[a-z][^>]*>/gi)].flatMap((m) => [...m[0].matchAll(/\s(data-[\w-]+)(?=[\s=>/])/gi)].map((d) => d[1].toLowerCase())));
    const forms = new Set([...markup.matchAll(/<form\b[^>]*>/gi)].map((m) => {
        const a = m[0].match(/\saction="([^"]*)"/i);
        const me = m[0].match(/\smethod="([^"]*)"/i);
        return `${(me ? me[1] : 'get').toUpperCase()} ${a ? a[1] : ''}`;
    }));
    return { ids, names, data, forms };
}

/** The union over the full and the empty render (lists and their empty states both show up). */
export function captureFields(page) {
    const out = { ids: new Set(), names: new Set(), data: new Set(), forms: new Set() };
    for (const empty of [false, true]) {
        const f = fieldsOf(renderPage(page, { empty }));
        for (const k of Object.keys(out)) f[k].forEach((x) => out[k].add(x));
    }
    return out;
}

/** The source of a page's partial and the partials it includes (what the settings search reads). */
function sourceOf(page) {
    const own = read(`dashboard/views/partials/manage/${page}.ejs`);
    const incs = [...own.matchAll(/include\(\s*['"`]([^'"`$]+)['"`]/g)].map((m) => m[1]);
    const more = incs.map((i) => {
        const rel = i.startsWith('partials/') ? i : path.posix.join('partials/manage', i);
        const file = path.join(views, rel.endsWith('.ejs') ? rel : `${rel}.ejs`);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    });
    return [own, ...more].join('\n');
}

/** Controls the overview's settings search finds on a page (by id; headings found by text are left out). */
const searchFields = (page) => [...new Set(extractFields(sourceOf(page)).map((f) => f.field).filter((f) => !f.startsWith('text:')))].sort();

if (process.env.KIT_A_WRITE_FIXTURE === '1') {
    const out = {};
    for (const page of PAGES) {
        const f = captureFields(page);
        out[page] = { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, [...v].sort()])), search: searchFields(page) };
    }
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({ _about: 'Element ids, form field names, data-* attributes and form action/method of the wave 21a pages BEFORE the kit rebuild (tests/kit-rollout-a.test.js stubs). The rebuilt pages must keep every one.', pages: out }, null, 1) + '\n');
}

// ── the rebuilt pages ────────────────────────────────────────────────────────────────────────

// New ids a rebuild may add: the kit's own (descriptions, section titles, empty/error slots).
const NEW_ID = /(-desc|-title|-head|-error|-empty|-rows|-hint|-label)$|^cfk-/;
// New data-* attributes a rebuild may add: stacked-table cell labels, the page-header master switch
// (public/js/cf-pagehead.js) and the chip picker's option kind and role colour (public/js/cf-picker.js).
const NEW_DATA = new Set(['data-label', 'data-feature-switch', 'data-kind', 'data-color']);

test('rebuilt pages keep every id, field name, data attribute and form they had before', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).pages;
    assert.deepEqual(Object.keys(fixture).sort(), [...PAGES].sort(), 'fixture covers every page');
    for (const page of SELECTED) {
        const before = fixture[page];
        const now = captureFields(page);
        assert.deepEqual(before.ids.filter((x) => !now.ids.has(x)), [], `${page}: ids missing after the rebuild`);
        assert.deepEqual([...now.names].sort(), before.names, `${page}: form field names unchanged`);
        assert.deepEqual(before.data.filter((x) => !now.data.has(x)), [], `${page}: data attributes missing after the rebuild`);
        assert.deepEqual([...now.forms].sort(), before.forms, `${page}: form actions and methods unchanged`);
        for (const x of [...now.ids].filter((i) => !before.ids.includes(i))) assert.match(x, NEW_ID, `${page}: unexpected new id #${x}`);
        for (const x of [...now.data].filter((d) => !before.data.includes(d))) assert.ok(NEW_DATA.has(x), `${page}: unexpected new attribute ${x}`);
    }
});

test('rebuilt pages: the settings search still finds every control it found before', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).pages;
    for (const page of SELECTED) {
        const now = new Set(searchFields(page));
        assert.deepEqual(fixture[page].search.filter((f) => !now.has(f)), [], `${page}: controls the settings search no longer finds`);
    }
});

// Words that keep their capital in a sentence-case heading.
const PROPER = new Set(['AutoMod', 'CAPTCHA', 'XP', 'DM', 'DMs', 'Discord', 'Discord\'s', 'ID', 'IDs', 'URL', 'URLs', 'CSV', 'JSON', 'Twitch', 'Kick',
    'YouTube', 'TikTok', 'OwO', 'NSFW', 'API', 'AI', 'Gemini', 'Unverified', 'Verified', 'CertiFried', 'I', 'OK', 'UTC', 'Hashbot', 'Nitro']);

/** Visible headings in rendered markup: h1-h4, the page title, kit row labels and section titles. */
function headingsOf(markup) {
    const out = [...markup.matchAll(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    out.push(...[...markup.matchAll(/class="page-section-title">[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1]));
    out.push(...[...markup.matchAll(/class="cf-row-label"[^>]*>([\s\S]*?)<\/(?:label|span|div|p)>/g)].map((m) => m[1]));
    return out.map((h) => h.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '\'').replace(/\s+/g, ' ').trim()).filter((h) => h && !h.includes('<%'));
}

function sentenceCaseProblems(headings) {
    const bad = [];
    for (const h of headings) {
        const words = h.split(/\s+/).slice(1).map((w) => w.replace(/^[("'#/]+|[)"',.:;?!]+$/g, ''));
        const caps = words.filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w));
        if (caps.length) bad.push(`"${h}" (${caps.join(', ')})`);
    }
    return bad;
}

test('rebuilt pages: built on the kit, sentence-case headings, no emoji, no cards', () => {
    for (const page of SELECTED) {
        for (const empty of [false, true]) {
            const html = renderPage(page, { empty });
            const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
            const where = `${page}${empty ? ' (empty)' : ''}`;
            assert.match(markup, /class="cf-section[ "]/, `${where}: uses kit sections`);
            assert.match(markup, /class="cf-rows[ "]/, `${where}: uses kit panels`);
            const emoji = markup.match(EMOJI);
            assert.equal(emoji, null, `${where}: emoji in the page (${emoji && emoji[0]})`);
            const card = markup.match(/class="[^"]*?\b((?:[\w-]+-)?card)\b/);
            assert.equal(card, null, `${where}: card container .${card && card[1]}`);
            // Copy only: visible text, not attribute values or code samples (a bot prefix is often "!").
            const text = markup.replace(/<!--[\s\S]*?-->/g, '').replace(/<(code|pre|kbd)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
            assert.ok(!/[A-Za-z)]!(\s|$)/.test(text), `${where}: no exclamation marks in copy`);
            assert.deepEqual(sentenceCaseProblems(headingsOf(markup)), [], `${where}: headings are sentence case`);
        }
    }
});

// Pages whose scripts hold emoji as CONTENT: the reaction-roles emoji picker's list of common emoji.
const CONTENT_EMOJI_SCRIPTS = new Set(['reaction-roles']);

test('rebuilt pages: page scripts build no emoji into the UI', () => {
    for (const page of SELECTED.filter((p) => !CONTENT_EMOJI_SCRIPTS.has(p))) {
        const scripts = [...renderPage(page).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
        const hit = scripts.match(EMOJI);
        assert.equal(hit, null, `${page}: emoji in a page script (${hit && hit[0]})`);
    }
});

test('rebuilt pages render under the Classic style (no Classic CSS restore left to apply)', () => {
    for (const page of SELECTED) {
        const classic = renderPage(page, { classic: true });
        assert.match(classic, /class="cf-rows[ "]/, `${page}: renders under Classic`);
        // The restore map's old rules no longer match a rebuilt page: it looks the same in both.
        assert.equal(classic, renderPage(page, { classic: false }), `${page}: Classic restored old CSS into the rebuilt page`);
    }
});

// ── the generated (feature-config) pages ─────────────────────────────────────────────────────

/**
 * Just enough DOM to run the feature-config page script: elements with attributes, properties,
 * children, text, listeners, and the two lookups the script makes (getElementById and
 * querySelectorAll('#fc-root [data-key]')).
 */
function fakeDocument() {
    class Node {
        constructor(tag) { this.tagName = tag ? tag.toUpperCase() : '#text'; this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null; this._text = ''; this.className = ''; this.style = {}; }
        appendChild(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); return n; }
        replaceChildren(...ns) { this.children.forEach((c) => { c.parent = null; }); this.children = []; ns.forEach((n) => this.appendChild(n)); }
        setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
        getAttribute(k) { return k === 'id' ? (this.id ?? null) : (k in this.attrs ? this.attrs[k] : null); }
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
        get textContent() { return this.tagName === '#text' ? this._text : this._text + this.children.map((c) => c.textContent).join(''); }
        set textContent(v) { this.children = []; this._text = String(v); }
        // Options may sit inside <optgroup>s (the voice picker), as in a browser.
        get options() { return [...this.walk()].filter((c) => c.tagName === 'OPTION'); }
        get selectedOptions() { return this.options.filter((c) => c.selected); }
        // A select's value is its (first) selected option's, else the first option's, as in a browser.
        get value() {
            if (this.tagName !== 'SELECT') return this._value ?? '';
            const opt = this.options.find((c) => c.selected) || (this.multiple ? null : this.options[0]);
            return opt ? opt.value : '';
        }
        set value(v) { this._value = String(v); }
        *walk() { yield this; for (const c of this.children) yield* c.walk(); }
    }
    const body = new Node('body');
    const doc = {
        body,
        createElement: (t) => new Node(t),
        createTextNode: (t) => { const n = new Node(null); n._text = String(t); return n; },
        getElementById: (id) => { for (const n of body.walk()) if (n.id === id) return n; return null; },
        querySelectorAll(sel) {
            assert.equal(sel, '#fc-root [data-key]', 'the only selector the page script uses');
            const root = doc.getElementById('fc-root');
            return [...root.walk()].filter((n) => n !== root && n.getAttribute('data-key') !== null);
        },
    };
    return doc;
}

const ROW_SAMPLE = { toggle: 1, select: null, days: '["monday"]', time: '09:30:00', timezone: 'America/Los_Angeles', roles: '[]', number: 60, text: 'Question of the Week' };

function fcPayload(key, { config: overrides = {}, voices } = {}) {
    const s = FEATURE_SPECS[key];
    const config = {};
    for (const f of s.fields) config[f.key] = f.default ?? null;
    Object.assign(config, overrides);
    let rows = s.list ? [Object.fromEntries(s.list.columns.map((c, i) => [c, /channel/.test(c) ? '400000000000000002' : `v${i}`]))] : undefined;
    if (s.list?.editor) {
        // An editable row carries its edit fields too, as loadList() selects them.
        for (const f of s.list.edit) rows[0][f.key] = f.type === 'select' ? f.options[1].value : ROW_SAMPLE[f.type];
    }
    return {
        success: true,
        spec: { key, label: s.label, icon: s.icon, iconPack: s.iconPack || 'fas', colour: s.colour, blurb: s.blurb, commands: s.commands || [], category: s.category || null, note: s.note || null, unwired: s.unwired || null, fields: s.fields.map((f) => ({ ...f, wired: f.wired !== false })), voices, hasList: !!s.list, listTitle: s.list?.title || null, listLabels: s.list?.labels || null,
            listKey: s.list?.editor ? s.list.key : null, listEdit: s.list?.editor ? s.list.edit : null, listAddLabel: s.list?.editor && s.list.canAdd !== false ? (s.list.addLabel || 'Add') : null,
            // H-703 (context menus): editable lists name their rows, Save button and meta line; publicSpec() in feature-config.js.
            listNoun: s.list?.editor ? (s.list.noun || ['channel', 'channels']) : null, listSaveLabel: s.list?.editor ? (s.list.saveLabel || 'Save channel') : null, listMeta: s.list?.editor ? (s.list.meta || null) : null },
        config, rows,
    };
}

function renderFeatureConfig(key, { classic = false } = {}) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const base = stubs().initialize;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-a-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, 'partials/manage/feature-config'))}) %>`);
        return engine.renderFile(file, { ...base, classicCss: classic, featureKey: key, featureConfigSpecs: FEATURE_SPECS });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** The page's own script, run in a sandbox with the fake DOM and a fetch that answers like the route. */
async function runFeatureConfig(key, payload = {}) {
    const html = renderFeatureConfig(key);
    const pageScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
    const document = fakeDocument();
    const root = document.createElement('div');
    root.setAttribute('id', 'fc-root');
    document.body.appendChild(root);
    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, opts });
        const body = opts.method === 'PUT' ? { success: true, message: 'Saved' } : fcPayload(key, payload);
        return { ok: true, json: async () => body };
    };
    vm.runInNewContext(pageScript, { document, fetch, window: {}, setTimeout: () => 0, clearTimeout: () => {} }, { filename: `feature-config(${key})` });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return { html, document, calls };
}

test('generated pages: the renderer keeps fc-f-<key> controls, data-key/data-type and save, for every spec feature', async () => {
    assert.ok(FEATURE_KEYS.length >= 40, `${FEATURE_KEYS.length} generated pages`);
    for (const key of FEATURE_KEYS) {
        const spec = FEATURE_SPECS[key];
        const { document, calls } = await runFeatureConfig(key);
        assert.equal(calls[0].url, `/api/guilds/222222222222222222/feature-config/${key}`, `${key}: loads its spec`);
        const labels = [...document.body.walk()].filter((n) => n.tagName === 'LABEL');
        for (const f of spec.fields) {
            const ctl = document.getElementById(`fc-f-${f.key}`);
            assert.ok(ctl, `${key}: #fc-f-${f.key}`);
            assert.equal(ctl.getAttribute('data-key'), f.key, `${key}.${f.key}: data-key`);
            const want = ['toggle', 'number', 'select', 'color', 'channel', 'role', 'channels', 'roles', 'multiline', 'message', 'voice', 'days', 'time', 'timezone'].includes(f.type) ? f.type : 'text';
            assert.equal(ctl.getAttribute('data-type'), want, `${key}.${f.key}: data-type`);
            const tag = { toggle: 'INPUT', number: 'INPUT', color: 'INPUT', select: 'SELECT', channel: 'SELECT', role: 'SELECT', channels: 'SELECT', roles: 'SELECT', multiline: 'TEXTAREA', message: 'TEXTAREA', voice: 'SELECT', days: 'DIV', timezone: 'SELECT' }[f.type] || 'INPUT';
            assert.equal(ctl.tagName, tag, `${key}.${f.key}: control`);
            if (f.type === 'toggle') assert.equal(ctl.type, 'checkbox');
            if (f.type === 'channels' || f.type === 'roles') assert.equal(ctl.multiple, true);
            if (f.type === 'days') {
                // A checkbox group: named by aria-label, each day box labelled by its own <label>.
                assert.equal(ctl.getAttribute('aria-label'), f.label, `${key}.${f.key}: group named "${f.label}"`);
                assert.equal(ctl.children.length, 7, `${key}.${f.key}: seven days`);
            } else {
                const label = labels.find((l) => l.getAttribute('for') === `fc-f-${f.key}`);
                assert.ok(label && label.textContent === f.label, `${key}.${f.key}: labelled "${f.label}"`);
            }
            assert.ok(ctl.parent.className === 'cf-row-control' && /\bcf-row\b/.test(ctl.parent.parent.className), `${key}.${f.key}: in a kit row`);
        }
        assert.ok(document.getElementById('fc-status'), `${key}: #fc-status`);
        const save = document.getElementById('fc-save');
        assert.ok(save && save.tagName === 'BUTTON', `${key}: #fc-save`);
        if (spec.list && !spec.list.editor) assert.ok([...document.body.walk()].some((n) => n.tagName === 'TABLE' && /cf-table--stack/.test(n.className)), `${key}: list table`);
        if (spec.list?.editor) {
            // Row controls must not carry data-key, or the main Save would send them.
            const rowCtls = [...document.body.walk()].filter((n) => n.getAttribute('data-rkey') !== null);
            assert.ok(rowCtls.length >= spec.list.edit.length, `${key}: row editor controls`);
            assert.ok(rowCtls.every((n) => n.getAttribute('data-key') === null), `${key}: row controls stay out of the main Save`);
            const rowSave = [...document.body.walk()].find((n) => n.tagName === 'BUTTON' && n.textContent === (spec.list.saveLabel || 'Save channel'));
            assert.ok(rowSave, `${key}: row Save button`);
            await rowSave.listeners.click[0]();
            const rowId = /channel/.test(spec.list.key) ? '400000000000000002' : `v${spec.list.columns.indexOf(spec.list.key)}`;
            const rowPut = calls.find((c) => c.opts.method === 'PUT' && c.url.endsWith(`/rows/${encodeURIComponent(rowId)}`));
            assert.ok(rowPut, `${key}: row saves to /rows/<id>`);
            const rowBody = JSON.parse(rowPut.opts.body);
            if (key === 'qotd') {
                // The sample row is weekly: days are sent, the custom interval (hidden) is not.
                assert.deepEqual(rowBody.schedule_days, ['monday'], `${key}: days sent as an array`);
                assert.ok(!('custom_interval_minutes' in rowBody), `${key}: hidden fields are not sent`);
            } else {
                assert.deepEqual(Object.keys(rowBody).sort(), spec.list.edit.map((f) => f.key).sort(), `${key}: row payload keys`);
            }
            const addBtn = [...document.body.walk()].some((n) => n.tagName === 'BUTTON' && n.textContent === spec.list.addLabel);
            assert.equal(addBtn, spec.list.canAdd !== false, `${key}: add button only where rows can be added`);
        }
        // Save PUTs every field, typed as before: toggles as booleans, multi-selects as arrays.
        await save.listeners.click[0]();
        const put = calls.find((c) => c.opts.method === 'PUT' && !c.url.includes('/rows/'));
        assert.ok(put && put.url === calls[0].url, `${key}: saves to its feature-config route`);
        const body = JSON.parse(put.opts.body);
        assert.deepEqual(Object.keys(body).sort(), spec.fields.map((f) => f.key).sort(), `${key}: payload keys`);
        for (const f of spec.fields) {
            if (f.type === 'toggle') assert.equal(typeof body[f.key], 'boolean', `${key}.${f.key}: boolean`);
            else if (f.type === 'channels' || f.type === 'roles' || f.type === 'days') assert.ok(Array.isArray(body[f.key]), `${key}.${f.key}: array`);
            else assert.equal(typeof body[f.key], 'string', `${key}.${f.key}: string`);
        }
        assert.equal(document.getElementById('fc-status').textContent, 'Saved', `${key}: status after save`);
    }
});

test('generated pages: server-rendered title, kit loading state, no HTML strings, no emoji, Classic unchanged', () => {
    const src = read('dashboard/views/partials/manage/feature-config.ejs');
    const pageScript = src.slice(src.indexOf('<script>'));
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(pageScript), 'DOM is built with createElement/textContent');
    assert.ok(!EMOJI.test(src), 'no emoji');
    for (const key of FEATURE_KEYS) {
        const html = renderFeatureConfig(key);
        const spec = FEATURE_SPECS[key];
        const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
        assert.match(markup, /<div id="fc-root">[\s\S]*class="cf-state cf-state--loading"/, `${key}: loading state`);
        const title = markup.match(/class="page-section-title">[\s\S]*?<span>([^<]+)<\/span>/);
        assert.ok(title && title[1] === spec.label.replace(/&/g, '&amp;').replace(/'/g, '&#39;'), `${key}: page title from the spec`);
        assert.equal(renderFeatureConfig(key, { classic: true }), html, `${key}: Classic restored old CSS`);
    }
    // An unknown feature still renders (no title, the script reports the API's error).
    assert.match(renderFeatureConfig('no-such-feature'), /id="fc-root"/);
});

test('generated pages: voice fields are a grouped picker (Piper, then Kokoro) with a preview, and keep a saved voice that is not installed', async () => {
    const voices = [
        { label: 'Piper · US English', engine: 'piper', voices: [{ value: 'ryan', label: 'Ryan (medium, male)' }, { value: 'amy', label: 'Amy (medium, female)' }] },
        { label: 'Kokoro · US English', engine: 'kokoro', voices: [{ value: 'kokoro_am_michael', label: 'Michael (Kokoro, US), male' }] },
    ];
    for (const [key, field] of [['tts', 'default_voice'], ['voice-reader', 'voice']]) {
        assert.equal(FEATURE_SPECS[key].fields.find((f) => f.key === field).type, 'voice', `${key}.${field} is a voice field`);
        // A Kokoro voice saved: selected inside its group, posted back unchanged.
        let run = await runFeatureConfig(key, { voices, config: { [field]: 'kokoro_am_michael' } });
        const ctl = run.document.getElementById(`fc-f-${field}`);
        const groups = ctl.children.filter((c) => c.tagName === 'OPTGROUP').map((g) => g.label);
        assert.deepEqual(groups, ['Piper · US English', 'Kokoro · US English'], `${key}: grouped by engine, Piper first`);
        assert.equal(ctl.children[0].value, '', `${key}: a blank "Default" first`);
        assert.equal(ctl.value, 'kokoro_am_michael');
        const btn = run.document.getElementById(`fc-f-${field}-preview`);
        assert.ok(btn && btn.tagName === 'BUTTON' && btn.textContent === 'Preview voice', `${key}: preview button`);
        assert.equal(btn.parent.parent.className, 'cf-row-control', `${key}: preview sits under the picker`);
        await run.document.getElementById('fc-save').listeners.click[0]();
        assert.equal(JSON.parse(run.calls.find((c) => c.opts.method === 'PUT').opts.body)[field], 'kokoro_am_michael');
        // A saved voice that is not installed stays selected and is saved back as it was.
        run = await runFeatureConfig(key, { voices, config: { [field]: 'old_voice' } });
        const kept = run.document.getElementById(`fc-f-${field}`);
        assert.equal(kept.value, 'old_voice', `${key}: unknown saved voice still selected`);
        assert.match(kept.selectedOptions[0].textContent, /^Current: old_voice/);
        await run.document.getElementById('fc-save').listeners.click[0]();
        assert.equal(JSON.parse(run.calls.find((c) => c.opts.method === 'PUT').opts.body)[field], 'old_voice');
        // Nothing saved: "Default" (blank) is what saves.
        run = await runFeatureConfig(key, { voices });
        assert.equal(run.document.getElementById(`fc-f-${field}`).value, '');
    }
});
