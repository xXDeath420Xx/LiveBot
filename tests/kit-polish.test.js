import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { buildManageNav } from '../core/manage-nav.js';
import { FEATURE_SPECS } from '../core/feature-config-spec.js';
import { pageHelp } from '../core/page-help.js';
import { stubs as stubsA } from './fixtures/kit-rollout-a-stubs.js';

/*
 * Wave 22 "kit-polish": the settings-row kit's shared fixes and new parts
 * (dashboard/public/css/cf-settings.css) and the page bugs the kit rollout turned up.
 *
 *   kit      stacked tables sit flush on phones (the first/last-cell padding no longer outranks
 *            the stack reset), a section that ends a <form> keeps its gap, [hidden] beats every kit
 *            component, empty panel children draw no divider, and the common parts exist
 *   scripts  JSON in a page <script> is written raw with every < escaped (throne's script was a
 *            syntax error), and member-written text goes in as text, never as HTML (confessions,
 *            achievements, schedule), checked by running the page scripts against a tiny DOM
 *            whose innerHTML throws
 *   pages    core's switches have ids their labels point at; mass kick/ban confirm once with the
 *            count; commission-filter's "Delete it" confirms; schedule's buttons survive an
 *            apostrophe; the schedule page is described as the event/run planner it is; the
 *            language picker takes `locale` (allLocaleMeta) or `code`; rpg has no inline hover
 *            handlers; starboard is on the kit
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const partialsDir = path.join(views, 'partials/manage');
const css = read('dashboard/public/css/cf-settings.css');

function render(partial, locals) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-polish-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(partialsDir, partial))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const inlineScripts = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc=|type="application\/json"/.test(m[1])).map((m) => m[2]);

// ── a tiny DOM: enough for the page scripts under test; innerHTML is a failure ──────────────

class FakeEl {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentElement = null;
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.listeners = {};
        this._text = '';
        this.className = '';
        const self = this;
        this.classList = {
            add: (...c) => { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...c])].join(' '); },
            remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
            contains: (c) => self.className.split(/\s+/).includes(c),
            toggle: (c, force) => {
                const on = force === undefined ? !self.classList.contains(c) : !!force;
                if (on) self.classList.add(c); else self.classList.remove(c);
                return on;
            },
        };
    }
    set innerHTML(v) {
        // Pages under test must not build HTML from data; a page allowed to (throne's static
        // settings template) has its markup recorded so the test can check what went in.
        if (!this.ownerDocument.allowHtml) throw new Error(`innerHTML used on <${this.tagName.toLowerCase()} id="${this.id || ''}">`);
        this.html = String(v);
    }
    get innerHTML() { throw new Error('innerHTML read'); }
    set textContent(v) { this.children = []; this._text = String(v ?? ''); }
    get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...nodes) {
        for (const n of nodes) {
            if (n == null) continue;
            if (typeof n === 'object') n.parentElement = this;
            this.children.push(typeof n === 'object' ? n : String(n));
        }
    }
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
    setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(v);
        if (k === 'id') this.id = String(v);
    }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, target = this) {
        const ev = { type, target, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false };
        for (let n = target; n; n = n.parentElement) for (const fn of n.listeners[type] || []) fn.call(n, ev);
        return ev;
    }
    closest(sel) {
        const m = sel.match(/^\[data-([\w-]+)\]$/);
        for (let n = this; n; n = n.parentElement) {
            if (m && n.dataset[m[1].replace(/-([a-z])/g, (x, c) => c.toUpperCase())] !== undefined) return n;
        }
        return null;
    }
    *walk() { for (const c of this.children) if (typeof c === 'object') { yield c; yield* c.walk(); } }
    find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
    findAll(pred) { return [...this.walk()].filter(pred); }
}

function fakeDocument(ids) {
    const doc = { listeners: {} };
    const byId = new Map(ids.map((id) => { const e = new FakeEl('div', doc); e.id = id; return [id, e]; }));
    doc.createElement = (tag) => new FakeEl(tag, doc);
    doc.getElementById = (id) => byId.get(id) || null;
    doc.querySelector = () => null;
    doc.querySelectorAll = () => [];
    doc.addEventListener = (t, fn) => { (doc.listeners[t] ||= []).push(fn); };
    return doc;
}

/** Run a page's inline scripts against the fake DOM; `api(url)` answers fetch. */
async function runPage(html, ids, api, { allowHtml = false } = {}) {
    const document = fakeDocument(ids);
    document.allowHtml = allowHtml;
    const calls = [];
    const ctx = {
        document, console: { log() {}, error() {}, warn() {} }, calls,
        alert: (m) => calls.push(['alert', m]), confirm: () => true, location: { reload() {} },
        fetch: async (url, opts = {}) => { calls.push([opts.method || 'GET', url]); return { ok: true, json: async () => api(url, opts) }; },
        setTimeout, Promise, Date, Map, Set, Number, String, Array, Object, JSON, Math,
        bootstrap: { Modal: class { show() { calls.push(['modal']); } static getInstance() { return { hide() {} }; } } },
    };
    ctx.window = ctx; // pages may keep state on window, as in a browser
    vm.createContext(ctx);
    for (const code of inlineScripts(html)) vm.runInContext(code, ctx, { timeout: 2000 });
    for (const fn of document.listeners.DOMContentLoaded || []) fn();
    await new Promise((r) => setTimeout(r, 30));
    return { document, ctx, calls };
}

const EVIL = `It's <img src=x onerror=alert(1)> "quoted" </script>`;
const guild = { id: '222222222222222222', name: 'Acme Gaming' };

// ── kit ─────────────────────────────────────────────────────────────────────────────────────

test('kit: stacked table cells are not padded by the first/last-cell rules on phones', () => {
    // Every first/last-cell padding rule is scoped away from stacked tables (or to desktop width).
    const outside = css.replace(/@media \(min-width: 641px\) \{[\s\S]*?\n\}/g, '');
    for (const m of outside.matchAll(/^([^{}\n]*(?:td|th)[^{}\n]*:(?:first|last)-child[^{}\n]*)\{[^}]*padding/gm)) {
        const sel = m[1];
        if (/cf-table--stack/.test(sel) && !/:not\(\.cf-table--stack\)/.test(sel)) assert.fail(`stacked-table padding outside the desktop query: ${sel.trim()}`);
        if (/cf-table/.test(sel)) assert.match(sel, /:not\(\.cf-table--stack\)/, `first/last-cell padding must skip stacked tables: ${sel.trim()}`);
    }
    assert.match(css, /@media \(min-width: 641px\) \{\s*\.cf-rows table\.cf-table--stack :is\(th, td\):first-child/);
    // The phone stack reset itself is still there.
    assert.match(css, /table\.cf-table--stack td \{[^}]*padding: 0 !important/);
});

test('kit: section gaps, [hidden], empty panel children', () => {
    assert.match(css, /\.cf-section \{ --cf-section-gap: var\(--cf-8\);/);
    assert.match(css, /form:has\(~ :not\([^)]*\)\) > \.cf-section:last-child \{ margin-bottom: var\(--cf-section-gap\); \}/);
    assert.match(css, /:root\[data-style="compact"\] \.cf-section \{ --cf-section-gap: var\(--cf-6\); \}/, 'compact sets the gap variable, not the margin');
    assert.ok(!/\[data-style="compact"\] \.cf-section \{ margin-bottom/.test(css), 'compact no longer overrides last-child margins');
    assert.match(css, /\[hidden\]:is\(\[class\*="cf-"\], \.btn, \.form-control, \.form-select\),[\s\S]*?\{ display: none !important; \}/);
    assert.match(css, /\.cf-rows > :is\(\[hidden\], \.cf-hidden, :empty:not\([^)]*\)\) \{ display: none !important; \}/);
    // Dividers are drawn only after a shown sibling, never by the old `* + *`.
    assert.ok(!/\.cf-rows > \* \+ \* \{ border-top:/.test(css), 'old divider rule removed');
    assert.match(css, /\.cf-rows > :not\(\[hidden\], \.cf-hidden, :empty, script[^)]*\) ~ \* \{ border-top: 1px solid var\(--cf-border\); \}/);
});

test('kit: the common parts exist, on tokens only', () => {
    for (const cls of ['cf-tabs', 'cf-tab', 'cf-segmented', 'cf-notice', 'cf-chips', 'cf-chip', 'cf-chip-remove', 'cf-list-item--multi', 'cf-list-title',
        'cf-list-meta', 'cf-list-body', 'cf-expand', 'cf-expand-toggle', 'cf-input-group', 'cf-check-grid', 'cf-range', 'cf-status-line', 'cf-kpi-sub',
        'cf-search', 'cf-modal', 'cf-modal-dialog', 'cf-modal-head', 'cf-modal-body', 'cf-modal-foot', 'cf-dropzone', 'cf-gallery', 'cf-gallery-item']) {
        assert.match(css, new RegExp(`\\.${cls}\\b[^{]*\\{`), `.${cls} is styled`);
    }
    assert.match(css, /\.cf-section \.cf-section-desc code/, 'code inside section descriptions');
    // The inline status line is not the overview's .cf-status pill (cf-manage.css): an empty one
    // draws nothing (no border, padding, background or dot), and no page uses the pill name for it.
    assert.ok(!/\.cf-status(?![-\w])/.test(css), 'the kit does not style .cf-status');
    assert.match(css, /\.cf-status-line \{[^}]*padding: 0; border: 0; background: none;/);
    assert.match(css, /\.cf-status-line:empty::before \{ display: none; \}/);
    for (const f of fs.readdirSync(partialsDir).filter((x) => x.endsWith('.ejs'))) {
        assert.ok(!/cf-status(?![-\w])/.test(fs.readFileSync(path.join(partialsDir, f), 'utf8')), `${f}: uses .cf-status (the overview pill); the kit's line is .cf-status-line`);
    }
    assert.match(css, /\.cf-chip \{\s*--cf-tone: var\(--cf-chip, var\(--cf-text-2\)\);/, 'chips take a data colour');
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hex colours in the kit');
});

// ── scripts: JSON and user text ─────────────────────────────────────────────────────────────

test('no page writes escaped JSON into a <script>, and raw JSON there always escapes <', () => {
    const B = String.fromCharCode(92);
    for (const f of fs.readdirSync(partialsDir).filter((x) => x.endsWith('.ejs'))) {
        const src = fs.readFileSync(path.join(partialsDir, f), 'utf8');
        for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
            const code = m[1];
            assert.ok(!/<%=\s*JSON\.stringify/.test(code), `${f}: <%= JSON.stringify inside a <script> (HTML-escaped quotes break the script)`);
            for (const j of code.matchAll(/<%-\s*JSON\.stringify[\s\S]*?%>/g)) {
                assert.ok(j[0].includes(`.replace(/</g, '${B}${B}u003c')`), `${f}: raw JSON in a <script> must escape < (${j[0].slice(0, 80)}...)`);
            }
        }
    }
});

test('throne: the page script parses and runs, and channel names cannot break out of it', async () => {
    const channels = [{ id: '400000000000000001', name: EVIL }, { id: '400000000000000002', name: 'general' }];
    const html = render('throne', { guild, guildId: guild.id, channels, roles: [{ id: '3', name: 'Fans' }], notifications: [], featured: null, throneNotifications: [] });
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 1);
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code), 'throne script is valid JavaScript');
    assert.ok(!scripts.join('').includes('</script>'), 'no raw </script> inside the script');
    // The settings are rendered on the server now (2026-11-18 UI pass): channel names are escaped in
    // the markup, the saved channel is selected, and the dead wishlist-role picker is gone.
    const saved = render('throne', { guild, guildId: guild.id, channels, roles: [{ id: '3', name: 'Fans' }], throneNotifications: [], throneGuildConfig: null, throneSettings: { notification_channel_id: '400000000000000001', notify_gift_received: 1 } });
    assert.ok(saved.includes('id="throneSettingsBody"'), 'the settings panel rendered');
    assert.ok(saved.includes('#It&#39;s &lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &lt;/script&gt;</option>'), 'channel name escaped');
    assert.match(saved, /<option value="400000000000000001" data-kind="text" selected>/);
    assert.match(saved, /id="cfk-th-set-notify_gift_received"[^>]*checked/, 'saved toggles are shown on');
    assert.ok(!/wishlist_role/.test(saved), 'no wishlist role control (nothing reads it)');
});

test('confessions: member text goes in as text, with Approve / Reject wired by listeners', async () => {
    const html = render('confessions', { guild, channels: [] });
    const ids = ['confession-channel', 'require-approval', 'mod-channel', 'pending-confessions', 'recent-confessions',
        'cfs-pending-count', 'cfs-save-status', 'cfs-enabled', 'cfs-cooldown', 'cfs-min-length', 'cfs-max-length'];
    const { document, calls } = await runPage(html, ids, (url) => (url.endsWith('/confessions') ? {
        config: null,
        pendingConfessions: [{ id: 5, content: EVIL, submitted_at: '2026-10-12T10:00:00Z' }],
        recentConfessions: [{ id: 4, content: EVIL, approved: 1, submitted_at: '2026-10-11T10:00:00Z' }],
    } : { success: true }));
    const pending = document.getElementById('pending-confessions');
    const body = pending.find((n) => n.className.includes('cf-list-body'));
    assert.equal(body.textContent, EVIL, 'the confession is shown verbatim, as text');
    const approve = pending.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Approve');
    approve.dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(calls.some(([m, u]) => m === 'POST' && u.endsWith('/confessions/5/approve')), 'Approve posts for that confession');
    assert.ok(document.getElementById('recent-confessions').find((n) => n.textContent === 'Approved'));
});

test('achievements: names, descriptions, categories and icons go in as text', async () => {
    const html = render('achievements', { guild, channels: [] });
    const ids = ['enabled', 'announcement-channel', 'stat-users', 'stat-unlocks', 'stat-total', 'stat-total-list', 'achievement-leaderboard', 'achievements-list', 'recent-achievements',
        'ach-save-status', 'ach-search', 'ach-search-head'];
    const { document } = await runPage(html, ids, () => ({
        stats: { total_users: 1, total_completed: 2 },
        topUsers: [{ user_id: '8', username: EVIL, avatar: 'javascript:alert(1)', completed_achievements: 1, total_achievements: 2 }],
        achievements: [{ name: EVIL, description: EVIL, category: EVIL, icon_emoji: EVIL }],
        recentAchievements: [{ name: EVIL, icon: EVIL, user_id: '9', username: null, completed_at: '2026-10-12T10:00:00Z' }],
    }));
    const list = document.getElementById('achievements-list');
    assert.ok(list.find((n) => n.className === 'ach-name' && n.textContent === EVIL));
    assert.ok(list.find((n) => n.className === 'cf-pill' && n.textContent === EVIL));
    const lb = document.getElementById('achievement-leaderboard');
    assert.ok(!lb.find((n) => n.tagName === 'IMG'), 'a non-https avatar is not loaded');
    const recent = document.getElementById('recent-achievements');
    assert.ok(recent.find((n) => n.dataset.userId === '9'), 'a member who left is named by cf-user.js from data-user-id');
});

test('schedule: names with apostrophes keep every row button working (data attributes, one delegated listener)', async () => {
    const src = read('dashboard/views/partials/manage/schedule.ejs');
    const script = src.slice(src.indexOf('<script>'));
    assert.ok(!/onclick=/.test(script), 'the page script builds no inline onclick handlers');
    assert.ok(!/escapeHtml/.test(script), 'no HTML escaping needed: nothing is built as HTML');
    const html = render('schedule', { guild, channels: [] });
    const ids = ['schedule-breadcrumb', 'events-view', 'schedules-view', 'items-view', 'events-list', 'stat-events', 'stat-active', 'stat-schedules', 'stat-runs',
        'breadcrumb-event', 'breadcrumb-schedule', 'schedule-content', 'createEventForm', 'createEventModal', 'createScheduleForm', 'scheduleEventId', 'createScheduleModal',
        'addRunForm', 'runScheduleId', 'addRunModal', 'editItemId', 'editGameName', 'editCategory', 'editRunners', 'editEstimate', 'editSetup', 'editNotes', 'editRunModal'];
    const name = "Ana's \"big\" marathon </script>";
    const { document, calls } = await runPage(html, ids, (url) => {
        if (url.endsWith('/schedule/events')) return { events: [{ id: 3, name, slug: 'anas', is_active: 1, description: name }] };
        if (/\/events\/3\/schedules$/.test(url)) return { schedules: [{ id: 9, name, start_time: null }] };
        if (/\/schedules\/9\/items$/.test(url)) return { items: [{ id: 21, game_name: name, category: "Any%", runners: "O'Neil", estimate_seconds: 3600, setup_seconds: 300, notes: name, status: 'pending' }] };
        return { success: true };
    });
    const content = document.getElementById('schedule-content');
    // The ids the markup gives these views, wired under #schedule-content as in the page.
    for (const id of ['events-view', 'schedules-view', 'items-view']) content.append(document.getElementById(id));
    document.getElementById('events-view').append(document.getElementById('events-list'));
    const open = document.getElementById('events-list').find((n) => n.dataset.schAction === 'open-event' && n.tagName === 'BUTTON' && n.className.includes('btn'));
    assert.equal(open.dataset.name, name, 'the name rides in a data attribute, untouched');
    content.dispatch('click', open);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls.some(([, u]) => /\/events\/3\/schedules$/.test(u)), 'Open loads that event');
    assert.equal(document.getElementById('breadcrumb-event').textContent.trim(), name);
    const openSchedule = document.getElementById('schedules-view').find((n) => n.dataset.schAction === 'open-schedule');
    content.dispatch('click', openSchedule);
    await new Promise((r) => setTimeout(r, 20));
    const edit = document.getElementById('items-view').find((n) => n.dataset.schAction === 'edit-run');
    content.dispatch('click', edit);
    assert.equal(document.getElementById('editGameName').value, name, 'Edit fills the form from the data');
    assert.equal(document.getElementById('editRunners').value, "O'Neil");
    assert.ok(calls.some(([k]) => k === 'modal'));
});

// ── pages ────────────────────────────────────────────────────────────────────────────────────

test('core: every switch and select has an id its label points at', () => {
    const html = render('core', { ...stubsA().core, currentTimeStr: '12:00', currentTz: 'UTC' });
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const controls = [...markup.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0])
        .filter((t) => /class="[^"]*\b(cf-switch|form-select)\b/.test(t));
    assert.ok(controls.length >= 3);
    for (const t of controls) {
        const id = (t.match(/\sid="([^"]+)"/) || [])[1];
        assert.ok(id, `control without an id: ${t.slice(0, 100)}`);
        assert.ok(markup.includes(`for="${id}"`), `no <label for="${id}">`);
    }
});

test('mass: kick and ban confirm once, naming the count; commission-filter confirms "Delete it"', () => {
    const mass = read('dashboard/views/partials/manage/mass.ejs');
    for (const action of ['mass-kick', 'mass-ban']) {
        const tag = mass.match(new RegExp(`<form action="[^"]*${action}"[^>]*>`))[0];
        assert.ok(!/onsubmit/.test(tag), `${action}: no inline confirm (the script asks)`);
    }
    const script = mass.slice(mass.indexOf('<script>'));
    assert.equal((script.match(/confirm\(/g) || []).length, 1, 'one confirm in the script');
    assert.match(script, /new Set\(/, 'counts distinct IDs');
    assert.match(script, /`Kick \$\{who\}\?/);

    const html = render('commission-filter', { ...stubsA()['commission-filter'] });
    const del = html.match(/<form\b[^>]*>(?:(?!<\/form>)[\s\S])*?Delete it<\/button>/)[0];
    assert.match(del, /onsubmit="return confirm\(&#39;Delete this message from Discord\?|onsubmit="return confirm\('Delete this message from Discord\?/);
});

test('schedule page: help and navigation describe the event / run planner', () => {
    const nav = buildManageNav(FEATURE_SPECS).flatMap((s) => s.items);
    const item = nav.find((i) => i.page === 'schedule');
    assert.equal(item.title, 'Schedules');
    assert.match(item.desc, /event/i);
    assert.ok(!/message/i.test(item.desc), 'not "scheduled messages"');
    const h = pageHelp('schedule').help;
    assert.match(h, /marathon/i);
    assert.match(h, /runs/);
    assert.ok(!/message/i.test(h));
    for (const t of ['manage-tailwind', 'manage-classic']) assert.match(read(`dashboard/views/${t}.ejs`), /'schedule': 'Schedules',/);
});

test('language: option values come from `locale` (allLocaleMeta) or `code`', () => {
    for (const key of ['locale', 'code']) {
        const locales = [{ [key]: 'en', name: 'English', nativeName: 'English' }, { [key]: 'pt-BR', name: 'Portuguese', nativeName: 'Português' }];
        const html = render('language', { guild, locales, guildLocale: 'pt-BR' });
        assert.match(html, /<option value="en" >English<\/option>/, key);
        assert.match(html, /<option value="pt-BR" selected>Português \(Portuguese\)<\/option>/, key);
        assert.equal((html.match(/<option value="">/g) || []).length, 1, `${key}: only "Follow each member's Discord language" has an empty value`);
    }
});

test('rpg: no inline hover handlers; starboard is on the kit', () => {
    assert.ok(!/\sonmouse(over|out)=/.test(read('dashboard/views/partials/manage/rpg.ejs')));
    const sb = render('starboard', { guild, channels: [{ id: '1', name: 'stars' }], starboardConfig: { enabled: 1, channel_id: '1', threshold: 4 } });
    assert.match(sb, /class="cf-rows"/);
    assert.match(sb, /id="f-starboard-threshold"[^>]*value="4"/);
    assert.match(render('starboard', { guild, channels: [], starboardConfig: null }), /id="f-starboard-threshold"[^>]*value="3"/, 'default threshold without a config (3, as the column, /community starboard setup and thresholdFor)');
});
