import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { SECTIONS, PAGES, PAGE_ALIASES, SPEC_CATEGORY_SECTION, SPEC_OVERRIDES, sectionForSpec, buildManageNav } from '../core/manage-nav.js';
import { FEATURE_SPECS, FEATURE_KEYS, CATEGORIES } from '../core/feature-config-spec.js';

/*
 * Manage-page navigation coverage (core/manage-nav.js + dashboard/views/manage-tailwind.ejs).
 *
 * The owner's complaint was feature cards scattered and hard to find. The overview is now
 * rendered from one list; these tests keep that list and the page router (pageMap) in step:
 * every routable page has exactly one row, in exactly one section, and no row points at a
 * page that does not render.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const template = fs.readFileSync(path.join(views, 'manage-tailwind.ejs'), 'utf8');

/** Static pageMap keys and partial names, parsed from the template. */
function pageMapEntries() {
    const start = template.indexOf('const pageMap = {');
    const end = template.indexOf('\n                };', start);
    assert.ok(start > 0 && end > start, 'pageMap block found');
    const block = template.slice(start, end);
    return [...block.matchAll(/^\s*'([a-z0-9-]+)':\s*\{\s*partial:\s*'([a-z0-9-]+)'/gm)].map((m) => ({ key: m[1], partial: m[2] }));
}

test('pageMap parses and every partial it names exists', () => {
    const entries = pageMapEntries();
    assert.ok(entries.length > 90, `parsed ${entries.length} pageMap entries`);
    for (const { key, partial } of entries) {
        assert.ok(fs.existsSync(path.join(views, 'partials/manage', partial + '.ejs')), `${key} -> partials/manage/${partial}.ejs`);
    }
});

test('every routable page has exactly one nav entry, and every entry routes', () => {
    const routable = new Set([...pageMapEntries().map((e) => e.key), ...FEATURE_KEYS]);
    const nav = buildManageNav(FEATURE_SPECS);
    const seen = new Map();
    for (const sec of nav) for (const it of sec.items) seen.set(it.page, (seen.get(it.page) || 0) + 1);

    for (const page of routable) {
        if (PAGE_ALIASES[page]) continue;
        assert.equal(seen.get(page) || 0, 1, `page "${page}" should have exactly one nav entry`);
    }
    for (const page of seen.keys()) assert.ok(routable.has(page), `nav entry "${page}" has no pageMap/spec route`);
    for (const [alias, target] of Object.entries(PAGE_ALIASES)) {
        assert.ok(routable.has(alias), `alias ${alias} is routable`);
        assert.equal(seen.get(target), 1, `alias ${alias} -> ${target} has an entry`);
        assert.ok(!seen.has(alias), `alias ${alias} has no entry of its own`);
    }
});

test('sections: unique keys, none empty, nothing falls into "Other"', () => {
    const keys = SECTIONS.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.length >= 12 && keys.length <= 18, `${keys.length} sections`);
    for (const k of keys) assert.match(k, /^[a-z]+$/, `section key ${k} (also a CSS hook and saved-order key)`);
    const nav = buildManageNav(FEATURE_SPECS);
    assert.ok(!nav.some((s) => s.key === 'other'), 'every spec page is filed in a real section');
    // Specific sections: none so small it should be merged, none so big it is a catch-all.
    for (const s of nav) assert.ok(s.items.length >= 4 && s.items.length <= 14, `${s.key} has ${s.items.length} pages`);
    for (const s of SECTIONS) {
        assert.ok(s.label && s.desc && s.desc.length <= 90, `${s.key} label and one-line description`);
        assert.match(s.icon, /^fa-[a-z0-9-]+$/, `${s.key} icon`);
    }
    for (const p of PAGES) assert.ok(keys.includes(p.section), `${p.page} section ${p.section}`);
    for (const c of CATEGORIES) assert.ok(keys.includes(SPEC_CATEGORY_SECTION[c]), `spec category ${c} is mapped`);
    for (const [k, s] of Object.entries(SPEC_OVERRIDES)) {
        assert.ok(FEATURE_SPECS[k], `override ${k} is a spec key`);
        assert.ok(keys.includes(s), `override ${k} -> ${s}`);
    }
});

test('entries carry what the overview, search and icons need', () => {
    for (const sec of buildManageNav(FEATURE_SPECS)) {
        for (const it of sec.items) {
            assert.match(it.page, /^[a-z0-9-]{1,40}$/, 'slug (also the pin/recent validation pattern)');
            assert.ok(it.title && it.title.length <= 40, `${it.page} title`);
            assert.ok(typeof it.desc === 'string', `${it.page} desc`);
            assert.match(it.icon, /^fa[bsr]? fa-[a-z0-9-]+$/, `${it.page} icon "${it.icon}"`);
        }
    }
    // Hand-written copy (generated blurbs may quote what the bot itself posts).
    for (const p of PAGES) assert.ok(!/[\u{1F300}-\u{1FAFF}✨]/u.test(p.title + p.desc), `${p.page} copy has no emoji`);
});

test('generated pages: hand-registered entries win, unknown categories are visible', () => {
    const nav = buildManageNav({
        modmail: { label: 'Modmail spec', category: 'Server Tools', icon: 'fa-envelope', blurb: '' },
        'x-test': { label: 'X', category: 'No Such Category', icon: 'fa-x', blurb: 'b' },
    });
    const all = nav.flatMap((s) => s.items);
    assert.equal(all.filter((i) => i.page === 'modmail').length, 1);
    assert.equal(sectionForSpec('x-test', { category: 'No Such Category' }), 'other');
    assert.equal(nav.at(-1).key, 'other');
    assert.deepEqual(nav.at(-1).items.map((i) => i.page), ['x-test']);
    assert.ok(buildManageNav().length === SECTIONS.length, 'works with no specs');
});

function render(page) {
    return ejs.render(template, {
        user: { id: '1', username: 'tester', avatar: null },
        guild: { id: '222222222222222222', name: 'Test', icon: null, memberCount: 10 },
        page,
        manageNav: buildManageNav(FEATURE_SPECS),
        featureConfigKeys: FEATURE_KEYS,
        featureConfigSpecs: FEATURE_SPECS,
        roles: [], channels: [], voiceChannels: [], categories: [],
        csrfToken: 't', userPrefs: { pinnedPages: [] },
        // server.js always passes these; the page map reads them without a typeof guard.
        prefixConfig: {}, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
    }, { filename: path.join(views, 'manage-tailwind.ejs'), views: [views] });
}

test('rendered overview: one row per page, each inside exactly one section', () => {
    const html = render('overview');
    const sectionRe = /<section class="modules-section" data-category="([a-z]+)"[\s\S]*?<\/section>/g;
    const where = new Map();
    let sections = 0;
    for (const m of html.matchAll(sectionRe)) {
        sections++;
        for (const r of m[0].matchAll(/\?page=([a-z0-9-]+)" class="module-card"/g)) {
            assert.ok(!where.has(r[1]), `page ${r[1]} appears in ${where.get(r[1])} and ${m[1]}`);
            where.set(r[1], m[1]);
        }
    }
    assert.equal(sections, SECTIONS.length);
    const total = [...html.matchAll(/class="module-card"/g)].length;
    assert.equal(total, where.size, 'no row outside a section');
    const nav = buildManageNav(FEATURE_SPECS);
    for (const sec of nav) for (const it of sec.items) assert.equal(where.get(it.page), sec.key, `${it.page} rendered in ${sec.key}`);
    for (const { key } of pageMapEntries()) {
        if (PAGE_ALIASES[key]) continue;
        assert.ok(where.has(key), `pageMap page ${key} has a row on the overview`);
    }
    assert.match(html, /id="overviewSearch"/);
    assert.match(html, /<script src="\/js\/cf-manage\.js" defer><\/script>/);
    // Cards markup: every row carries its badge holder and the Open line (hidden in Compact).
    assert.equal([...html.matchAll(/<span class="module-badges">/g)].length, total);
    assert.equal([...html.matchAll(/<span class="module-open" aria-hidden="true">/g)].length, total);
    assert.ok(html.trimEnd().endsWith('</html>'), 'nothing after </html>');
});

test('rendered sub-page: sidebar marks the current page and its section is open', () => {
    const html = render('message-threats');
    assert.match(html, /<details class="cf-sidenav-group" data-sec="protection" open>[\s\S]*?\?page=message-threats" aria-current="page">Message threats</);
    assert.match(html, /<li aria-current="page">Message threats<\/li>/, 'breadcrumb uses the nav title');
    assert.equal((html.match(/<details class="cf-sidenav-group" data-sec="[a-z]+" open>/g) || []).length, 1);
    assert.match(html, /id="cfPinBtn" data-page="message-threats" aria-pressed="false"/);
});
