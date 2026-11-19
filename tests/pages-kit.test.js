import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { buildManageNav, PAGE_ALIASES } from '../core/manage-nav.js';
import { FEATURE_SPECS } from '../core/feature-config-spec.js';
import { PAGE_HELP, pageHelp, missingHelp } from '../core/page-help.js';
import { parsePageMap, extractFields } from '../core/settings-index.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { loadClassicMap } from '../dashboard/services/classic-style.js';

/*
 * Wave 18 "pages-kit": the settings-row kit (dashboard/public/css/cf-settings.css,
 * dashboard/views/partials/kit/, dashboard/public/js/cf-settings.js), the "What this does" help
 * on every manage page (core/page-help.js) and the six pilot pages rebuilt on the kit.
 *
 *   - every page in the manage navigation has a plain-language help sentence
 *   - every "Recommended settings" value names a field that is on that page and is a value the
 *     field accepts (an option it has, a number inside its min/max, a boolean for a switch)
 *   - the kit partials render
 *   - the pilot pages kept every form field name and element id they had before the rebuild
 *     (tests/fixtures/pages-kit-fields.json, captured from the original partials with the same
 *     stub data), and read as the kit: sentence-case headings, no emoji, no nested cards
 *
 * PAGES_KIT_WRITE_FIXTURE=1 re-captures the fixture from whatever partials are on disk; it was
 * written once, from the partials as they were before the rebuild.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FIXTURE = path.join(root, 'tests/fixtures/pages-kit-fields.json');
const PILOTS = ['moderation', 'automod', 'verification', 'welcome', 'logging', 'leveling'];
const nav = buildManageNav(FEATURE_SPECS);
const navPages = nav.flatMap((s) => s.items.map((i) => i.page));
const pageMap = parsePageMap(read('dashboard/views/manage-tailwind.ejs'));
const partialOf = new Map(pageMap.map((e) => [e.page, e.partial]));
const EMOJI = /\p{Extended_Pictographic}/u;

// ── stub data shared by the fixture capture and the comparison ─────────────────────────────

function stubs() {
    const guild = { id: '222222222222222222', name: 'Acme Gaming', icon: null, memberCount: 1234 };
    const roles = ['Admin', 'Moderator', 'Member', 'Muted', 'Verified'].map((name, i) => ({ id: `30000000000000000${i}`, name, color: 0x5865f2 }));
    const channels = ['general', 'rules', 'mod-log', 'welcome', 'bot-commands'].map((name, i) => ({ id: `40000000000000000${i}`, name, type: 0 }));
    const ws = { channel_id: channels[3].id, message: 'Hi {user}', banner_enabled: 1, card_title_text: 'Welcome, {user}!', card_subtitle_text: '', card_background_url: '', goodbye_enabled: 0, goodbye_channel_id: '', goodbye_message: '' };
    return {
        moderation: {
            guild, channels, roles,
            settings: { mod_log_channel_id: channels[2].id, muted_role_id: roles[3].id },
            infractions: [
                { type: 'warn', reason: 'Spam', created_at: new Date(Date.UTC(2026, 9, 12)), user_id: '800000000000000001', moderator_id: '111111111111111111',
                    user: { id: '800000000000000001', username: 'pixelpal', displayName: 'Pixel Pal', avatar: null, inServer: true },
                    moderator: { id: '111111111111111111', username: 'tester', displayName: 'Tester', avatar: null, inServer: true } },
            ],
            escalationRules: [{ id: 7, infraction_count: 3, time_period_hours: 24, action: 'timeout', action_duration_minutes: 60 }],
        },
        automod: {
            guild, heatConfig: {},
            automodRules: [
                { id: 1, filter_type: 'antiSpam', action: 'mute', action_duration_minutes: 10, config: '{"messageLimit":5,"timePeriod":10}' },
                { id: 2, filter_type: 'bannedWords', action: 'delete', config: { words: ['alpha', 'beta'] } },
            ],
        },
        verification: { guild },
        welcome: { guild, channels, settings: ws, welcomeSettings: ws },
        logging: {
            guild, channels, auditLogs: [], channelSettingsMap: new Map([[channels[0].id, { webhook_url: 'https://discord.com/api/webhooks/1/x' }]]),
            settings: {
                log_channel_id: channels[2].id, enabled_logs: '["messageDelete","ban"]', log_categories: JSON.stringify({ ban: channels[2].id }),
                action_color_rows: {
                    messageDelete: { actions: [{ key: 'messageDelete', label: 'Deleted', value: '#ef4444', custom: false, fallback: '#ef4444' }] },
                    ban: { actions: [{ key: 'ban', label: 'Ban', value: '#991b1b', custom: true, fallback: '#7f1d1d' }] },
                    system: { notPosted: 'Not posted in a log channel' },
                },
            },
        },
        leveling: {
            guild, roles, channels,
            settings: { leveling_enabled: 1, leveling_xp_rate: 15, leveling_xp_cooldown: 60, level_up_channel_id: '', leveling_ignored_channels: [channels[4].id], leveling_ignored_roles: [], monthly_reset_enabled: 0, reset_interval_days: 30, last_reset_at: null },
            rewards: [{ id: 3, level: 10, role_id: roles[2].id }],
        },
    };
}

/**
 * The pilot partial rendered through the dashboard's view engine, included from a wrapper page the
 * way the manage templates include it (so Classic's CSS restore applies); `empty` drops the lists.
 */
function renderPilot(page, { empty = false, classic = false } = {}) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const locals = { ...stubs()[page], classicCss: classic };
    if (empty) {
        if (locals.infractions) locals.infractions = [];
        if (locals.escalationRules) locals.escalationRules = [];
        if (locals.automodRules) locals.automodRules = [];
        if (locals.rewards) locals.rewards = [];
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-kit-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${page}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Element ids and form field names in rendered markup (scripts left out: they are not markup). */
function fieldsOf(html) {
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const ids = new Set([...markup.matchAll(/<[a-z][^>]*?\sid="([^"]+)"/gi)].map((m) => m[1]));
    const names = new Set([...markup.matchAll(/<(?:input|select|textarea|button)\b[^>]*?\sname="([^"]+)"/gi)].map((m) => m[1]));
    return { ids, names };
}

if (process.env.PAGES_KIT_WRITE_FIXTURE === '1') {
    const out = {};
    for (const page of PILOTS) {
        const ids = new Set();
        const names = new Set();
        for (const empty of [false, true]) {
            const f = fieldsOf(renderPilot(page, { empty }));
            f.ids.forEach((x) => ids.add(x));
            f.names.forEach((x) => names.add(x));
        }
        out[page] = { ids: [...ids].sort(), names: [...names].sort() };
    }
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({ _about: 'Element ids and form field names of the six pilot pages BEFORE the wave 18 rebuild (tests/pages-kit.test.js stubs). The rebuilt pages must keep every one.', pages: out }, null, 1) + '\n');
}

// ── help coverage ───────────────────────────────────────────────────────────────────────────

test('help: every manage page has a plain-language "What this does" sentence', () => {
    assert.ok(navPages.length >= 147, `${navPages.length} nav pages`);
    assert.deepEqual(missingHelp(nav), [], 'pages without help');
    const known = new Set(navPages);
    for (const key of Object.keys(PAGE_HELP)) assert.ok(known.has(key), `help for "${key}", which is not a nav page`);
    for (const [key, entry] of Object.entries(PAGE_HELP)) {
        const h = entry.help;
        assert.equal(typeof h, 'string', key);
        assert.ok(h.length >= 30 && h.length <= 260, `${key}: ${h.length} characters`);
        assert.match(h, /^[A-Z]/, `${key}: starts with a capital`);
        assert.match(h, /\.$/, `${key}: ends with a full stop`);
        assert.ok(!h.includes('!'), `${key}: no exclamation marks`);
        assert.ok(!EMOJI.test(h), `${key}: no emoji`);
        assert.ok(!/[<>]/.test(h), `${key}: plain text, no markup`);
        const sentences = h.split(/(?<=\.)\s+(?=[A-Z])/).length;
        assert.ok(sentences <= 2, `${key}: ${sentences} sentences (one or two)`);
        if (entry.recommended) {
            assert.ok(entry.recommended.note && entry.recommended.note.length <= 320, `${key}: recommended note`);
            assert.ok(!EMOJI.test(entry.recommended.note) && !entry.recommended.note.includes('!'), `${key}: note is plain`);
        }
    }
    // Aliases resolve to their page's help; unknown pages have none.
    for (const [alias, target] of Object.entries(PAGE_ALIASES)) assert.equal(pageHelp(alias).page, target);
    assert.equal(pageHelp('no-such-page'), null);
    assert.equal(pageHelp('catalog').recommended, null);
    assert.ok(pageHelp('moderation').recommended.values['f-moderation-muted_role_id'].pick.includes('muted'));
});

// ── recommended values ───────────────────────────────────────────────────────────────────────

/** The source of every template a page renders (its partial and that partial's includes). */
function sourcesFor(page) {
    const partial = partialOf.get(page);
    if (!partial || partial === 'feature-config') return null;
    const own = read(`dashboard/views/partials/manage/${partial}.ejs`);
    const incs = [...own.matchAll(/include\(\s*['"`]([^'"`$]+)['"`]/g)].map((m) => m[1]);
    const more = incs.map((i) => {
        const rel = i.startsWith('partials/') ? i : path.posix.join('partials/manage', i);
        const file = path.join(views, rel.endsWith('.ejs') ? rel : `${rel}.ejs`);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    });
    return [own, ...more].join('\n');
}

const tagAttr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
    return m ? m[1] : null;
};

/** What a static partial's control accepts: { kind, options, dynamic, min, max, values }. */
function controlIn(src, key) {
    // EJS output becomes a marker first, so a `>` inside <%= ... %> cannot end a tag early.
    const markup = src.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<%[\s\S]*?%>/g, 'EJS_OUT');
    const tags = [...markup.matchAll(/<(input|select|textarea)\b[^>]*>/gi)];
    const byId = tags.filter((m) => tagAttr(m[0], 'id') === key);
    const hits = byId.length ? byId : tags.filter((m) => tagAttr(m[0], 'name') === key);
    if (!hits.length) return null;
    const [tag, kind] = [hits[0][0], hits[0][1].toLowerCase()];
    if (kind === 'select') {
        const body = markup.slice(hits[0].index, markup.indexOf('</select>', hits[0].index));
        const options = [...body.matchAll(/<option\b[^>]*\svalue="([^"]*)"/gi)].map((m) => m[1]);
        return { kind: 'select', multiple: /\smultiple\b/.test(tag), options: options.filter((v) => !v.includes('EJS_OUT')), dynamic: body.includes('EJS_OUT') };
    }
    if (kind === 'textarea') return { kind: 'text', maxlength: Number(tagAttr(tag, 'maxlength')) || null };
    const type = (tagAttr(tag, 'type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
        return { kind: type, group: hits.length > 1 || (tagAttr(tag, 'value') || '').includes('EJS_OUT'), values: hits.map((h) => tagAttr(h[0], 'value')) };
    }
    if (type === 'number') {
        const num = (a) => (tagAttr(tag, a) == null || tagAttr(tag, a).includes('EJS_OUT') ? null : Number(tagAttr(tag, a)));
        return { kind: 'number', min: num('min'), max: num('max') };
    }
    return { kind: 'text', maxlength: Number(tagAttr(tag, 'maxlength')) || null };
}

/** Values a checkbox group built by EJS accepts (the Logging page's category keys). */
function dynamicGroupValues(page, src) {
    if (page === 'logging') {
        const block = src.slice(src.indexOf('const logCategories = ['), src.indexOf('];', src.indexOf('const logCategories = [')));
        return [...block.matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
    }
    return null;
}

function checkValue(where, ctl, want) {
    const spec = want && typeof want === 'object' && !Array.isArray(want) ? want : { value: want };
    if (spec.pick) {
        assert.ok(Array.isArray(spec.pick) && spec.pick.length && spec.pick.every((s) => typeof s === 'string' && s === s.toLowerCase()), `${where}: pick is a list of lower-case names`);
        assert.ok(ctl.kind === 'select' && ctl.dynamic, `${where}: pick is only for a channel/role select`);
        return;
    }
    const v = spec.value;
    if (ctl.kind === 'checkbox' && !ctl.group) assert.equal(typeof v, 'boolean', `${where}: a switch takes true/false`);
    else if (ctl.kind === 'checkbox') {
        assert.ok(Array.isArray(v) && v.length, `${where}: a checkbox group takes a list`);
        for (const x of v) assert.ok(ctl.values.includes(x), `${where}: "${x}" is one of its checkboxes`);
        assert.equal(new Set(v).size, v.length, `${where}: no repeats`);
    } else if (ctl.kind === 'radio') assert.ok(ctl.values.includes(String(v)), `${where}: "${v}" is one of its choices`);
    else if (ctl.kind === 'select') {
        if (Array.isArray(v)) for (const x of v) assert.ok(ctl.options.includes(String(x)), `${where}: option ${x}`);
        else assert.ok(ctl.options.includes(String(v)), `${where}: "${v}" is one of its options (${ctl.options.join(', ')})`);
    } else if (ctl.kind === 'number') {
        assert.ok(Number.isFinite(v) && Number.isInteger(v), `${where}: a whole number`);
        if (ctl.min != null) assert.ok(v >= ctl.min, `${where}: ${v} >= min ${ctl.min}`);
        if (ctl.max != null) assert.ok(v <= ctl.max, `${where}: ${v} <= max ${ctl.max}`);
    } else {
        assert.equal(typeof v, 'string', `${where}: text`);
        if (ctl.maxlength) assert.ok(v.length <= ctl.maxlength, `${where}: within maxlength`);
        assert.ok(!EMOJI.test(v), `${where}: no emoji`);
    }
}

test('recommended settings: every value names a field on its page and is a value that field accepts', () => {
    let pages = 0;
    let checked = 0;
    for (const [page, entry] of Object.entries(PAGE_HELP)) {
        if (!entry.recommended) continue;
        pages++;
        const values = entry.recommended.values;
        assert.ok(values && Object.keys(values).length, `${page}: values`);
        const spec = FEATURE_SPECS[page];
        const src = sourcesFor(page);
        for (const [key, want] of Object.entries(values)) {
            const where = `${page} ${key}`;
            checked++;
            if (!src) {
                // Generated (feature-config) page: fc-f-<spec field key>.
                assert.ok(spec, `${where}: page has a partial or a spec`);
                const fkey = key.replace(/^fc-f-/, '');
                assert.ok(key.startsWith('fc-f-'), `${where}: generated pages use fc-f-<key>`);
                const field = spec.fields.find((f) => f.key === fkey);
                assert.ok(field, `${where}: a field of ${page}`);
                assert.ok(field.wired !== false && !spec.unwired, `${where}: not a setting the bot ignores`);
                const ctl = field.type === 'toggle' ? { kind: 'checkbox' }
                    : field.type === 'number' ? { kind: 'number', min: field.min ?? null, max: field.max ?? null }
                        : field.type === 'select' ? { kind: 'select', options: field.options.map((o) => String(o.value)) }
                            : ['channel', 'role', 'channels', 'roles'].includes(field.type) ? { kind: 'select', dynamic: true, options: [] }
                                : { kind: 'text' };
                checkValue(where, ctl, want);
                continue;
            }
            const ctl = controlIn(src, key);
            assert.ok(ctl, `${where}: no control with that id or name on the page`);
            if (ctl.kind === 'checkbox' && ctl.group) {
                const dyn = dynamicGroupValues(page, src);
                if (dyn) ctl.values = dyn;
            }
            checkValue(where, ctl, want);
        }
    }
    assert.ok(pages >= 8, `${pages} pages recommend values`);
    assert.ok(checked >= 40, `${checked} values checked`);
});

test('recommended settings: never switches on a feature that removes people', () => {
    const forbidden = ['vfEnabled', 'prEnabled', 'inNever', 'inQuiet', 'prAction', 'inNeverAction', 'inQuietAction'];
    for (const [page, entry] of Object.entries(PAGE_HELP)) {
        for (const key of Object.keys(entry.recommended?.values || {})) assert.ok(!forbidden.includes(key), `${page}: ${key}`);
    }
});

// ── kit partials ─────────────────────────────────────────────────────────────────────────────

test('kit partials render', () => {
    const kit = (name, locals) => ejs.render(read(`dashboard/views/partials/kit/${name}.ejs`), locals, { filename: path.join(views, `partials/kit/${name}.ejs`) });
    // _help: nothing without help; the block, and parseable data, with it.
    assert.equal(kit('_help', { help: null }).trim(), '');
    const h = kit('_help', { help: pageHelp('moderation') });
    assert.match(h, /<aside class="cf-help" id="cfHelp" aria-labelledby="cfHelpLabel" data-page="moderation">/);
    assert.match(h, /What this does/);
    assert.match(h, /id="cfHelpRec"[^>]*>Recommended settings<\/button>/);
    const json = h.match(/<script type="application\/json" id="cfHelpData">([\s\S]*?)<\/script>/)[1];
    assert.deepEqual(JSON.parse(json), pageHelp('moderation').recommended);
    const plain = kit('_help', { help: pageHelp('catalog') });
    assert.match(plain, /class="cf-help-body">Every feature/);
    assert.ok(!plain.includes('cfHelpRec'), 'no button without recommended values');
    // Markup in a help string would be escaped, and </script> cannot break out of the JSON.
    const evil = kit('_help', { help: { page: 'x', help: '<b>x</b>', recommended: { note: '', values: { a: '</script><script>alert(1)</script>' } } } });
    assert.ok(evil.includes('&lt;b&gt;x&lt;/b&gt;') && !evil.includes('</script><script>alert'));

    // _state: each kind, with its role.
    assert.match(kit('_state', { kind: 'loading', title: 'Loading rules', text: null }), /class="cf-state cf-state--loading" role="status" aria-live="polite">[\s\S]*cf-spinner[\s\S]*Loading rules/);
    assert.match(kit('_state', { kind: 'error', title: 'Could not load', text: 'Try again.' }), /cf-state--error" role="alert">[\s\S]*Could not load[\s\S]*Try again\./);
    const empty = kit('_state', { kind: 'empty', title: 'No rules yet', text: 'Add one above.', boxed: true, id: 'xEmpty' });
    assert.match(empty, /class="cf-state cf-state--empty cf-state--boxed" id="xEmpty"/);
    assert.match(kit('_state', { kind: 'bogus', title: null, text: null }), /cf-state--empty[\s\S]*Nothing here yet/);

    // _options: names with a prefix, the selected one(s), an optional empty option.
    const items = [{ id: '1', name: 'general' }, { id: '2', name: 'mod-log' }];
    const one = kit('_options', { items, selected: '2', prefix: '#', empty: 'No channel' });
    assert.match(one, /<option value="">No channel<\/option>/);
    assert.match(one, /<option value="2" selected>#mod-log<\/option>/);
    assert.match(one, /<option value="1">#general<\/option>/);
    const many = kit('_options', { items, selected: ['1', '2'], prefix: null, empty: null });
    assert.equal((many.match(/ selected/g) || []).length, 2);
    assert.ok(!many.includes('value=""'));

    // _kpis
    const k = kit('_kpis', { items: [{ label: 'Rules', value: 3 }, { label: 'Channel', value: '#mod-log', small: true }], label: 'AutoMod at a glance' });
    assert.match(k, /<dl class="cf-kpis" aria-label="AutoMod at a glance">/);
    assert.match(k, /<dt>Channel<\/dt><dd class="cf-kpi-value is-small">#mod-log<\/dd>/);
    assert.equal(kit('_kpis', { items: [], label: null }).trim(), '');
});

test('kit: both manage templates load it and render the help; the route passes it', () => {
    for (const t of ['manage-tailwind', 'manage-classic']) {
        const src = read(`dashboard/views/${t}.ejs`);
        assert.match(src, /<link rel="stylesheet" href="\/css\/cf-settings\.css">/, `${t}: stylesheet`);
        assert.match(src, /<script src="\/js\/cf-settings\.js" defer><\/script>/, `${t}: script`);
        const at = src.indexOf("include('partials/kit/_help', { help: locals.pageHelp || null })");
        assert.ok(at > 0 && at < src.indexOf('include(`partials/manage/${activePage.partial}`'), `${t}: help before the page partial`);
    }
    const server = read('dashboard/server.js');
    assert.match(server, /pageHelpEntry = \(await import\('\.\.\/core\/page-help\.js'\)\)\.pageHelp\(String\(req\.query\.page\)\);/);
    assert.match(server, /pageHelp: pageHelpEntry,/);
    // The kit's CSS uses only tokens both templates define (Classic maps a subset of cf-ui's).
    const css = read('dashboard/public/css/cf-settings.css');
    const classic = read('dashboard/views/manage-classic.ejs');
    const own = new Set([...css.matchAll(/(--cf-[\w-]+)\s*:/g)].map((m) => m[1]));   // set by the kit itself (--cf-tone)
    for (const v of new Set([...css.matchAll(/var\((--cf-[\w-]+)\)/g)].map((m) => m[1]).filter((x) => !own.has(x)))) {
        assert.ok(classic.includes(`${v}:`), `${v} is defined for Classic`);
        assert.ok(read('dashboard/public/css/cf-ui.css').includes(`${v}:`), `${v} is defined in cf-ui.css`);
    }
    assert.ok(!EMOJI.test(css) && !EMOJI.test(read('dashboard/public/js/cf-settings.js')), 'no emoji in the kit');
    // The save bar hears the recommended fill.
    const manageJs = read('dashboard/public/js/cf-manage.js');
    assert.match(manageJs, /f\.addEventListener\('cf:dirty'/);
    assert.match(manageJs, /f\.addEventListener\('cf:clean'/);
});

// ── pilot pages ──────────────────────────────────────────────────────────────────────────────

test('pilot pages keep every field name and id they had before the rebuild', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).pages;
    for (const page of PILOTS) {
        const before = fixture[page];
        assert.ok(before && before.ids.length && before.names.length >= 0, `${page}: fixture`);
        const ids = new Set();
        const names = new Set();
        for (const empty of [false, true]) {
            const f = fieldsOf(renderPilot(page, { empty }));
            f.ids.forEach((x) => ids.add(x));
            f.names.forEach((x) => names.add(x));
        }
        const lostIds = before.ids.filter((x) => !ids.has(x));
        assert.deepEqual(lostIds, [], `${page}: ids missing after the rebuild`);
        assert.deepEqual([...names].sort(), before.names, `${page}: form field names unchanged`);
        // New ids are only the kit's own (descriptions, section titles, error slots).
        const added = [...ids].filter((x) => !before.ids.includes(x));
        for (const x of added) assert.match(x, /(-desc|-title|-head|-error|-empty|-rows)$|^cfk-/, `${page}: unexpected new id #${x}`);
    }
});

test('pilot pages: built on the kit, sentence-case headings, no emoji, no cards inside cards', () => {
    // Words that keep their capital in a sentence-case heading.
    const PROPER = new Set(['AutoMod', 'CAPTCHA', 'XP', 'DM', 'DMs', 'Discord', 'ID', 'IDs', 'URL', 'CSV', 'Twitch', 'OwO', 'Unverified', 'Verified']);
    for (const page of PILOTS) {
        const html = renderPilot(page);
        const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
        assert.match(markup, /class="cf-section[ "]/, `${page}: uses kit sections`);
        assert.match(markup, /class="cf-rows"/, `${page}: uses kit rows`);
        assert.ok(!EMOJI.test(markup), `${page}: no emoji in the page`);
        assert.ok(!/class="[^"]*\b(card|manage-card|mod-section-card|welcome-section-card|leveling-section-card|vf-card|automod-form-card)\b/.test(markup), `${page}: no card containers`);
        const headings = [...markup.matchAll(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
        headings.push(...[...markup.matchAll(/class="page-section-title">[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1].trim()));
        headings.push(...[...markup.matchAll(/class="cf-row-label"[^>]*>([^<]+)</g)].map((m) => m[1].trim()));
        assert.ok(headings.length >= 3, `${page}: headings found`);
        for (const h of headings) {
            const words = h.split(/\s+/).slice(1).map((w) => w.replace(/^[("']+|[)"',.:;?]+$/g, ''));
            const caps = words.filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w));
            assert.deepEqual(caps, [], `${page}: "${h}" is sentence case`);
        }
    }
});

test('pilot pages: the settings search still finds their fields, and Classic still restores the other pages', () => {
    const fieldsOfPage = (page) => extractFields(sourcesFor(page) || '');
    const has = (page, label, field) => assert.ok(fieldsOfPage(page).some((f) => f.label === label && f.field === field), `${page}: "${label}" -> ${field}`);
    has('moderation', 'Mute role', 'f-moderation-muted_role_id');
    has('moderation', 'Moderation log channel', 'f-moderation-mod_log_channel_id');
    has('logging', 'Default log channel', 'log-channel-id');
    has('verification', 'Verification on', 'vfEnabled');
    has('welcome', 'Welcome channel', 'f-welcome-channel_id');
    has('leveling', 'XP per message', 'f-leveling-leveling_xp_rate');
    has('automod', 'Filter type', 'filter-type-select');
    // The Classic map still restores a partial's original CSS. Checked on a synthetic partial built
    // from a map entry (one of its rules, as the redesign left it), so the check depends on no real
    // page staying un-rebuilt.
    const map = loadClassicMap();
    const [key, entry] = Object.entries(map).find(([, e]) => Object.keys(e.rules || {}).length);
    const [today, [original]] = Object.entries(entry.rules)[0];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-kit-'));
    try {
        const sviews = path.join(dir, 'views');
        fs.mkdirSync(path.dirname(path.join(sviews, key)), { recursive: true });
        fs.writeFileSync(path.join(sviews, key), `<style>.x {${today}}</style><b><%= label %></b>`);
        fs.writeFileSync(path.join(dir, 'p.ejs'), `<%- include(${JSON.stringify(path.join(sviews, key.replace(/\.ejs$/, '')))}) %>`);
        const engine = createViewEngine({ viewsDir: sviews, cache: false });
        const classic = engine.renderFile(path.join(dir, 'p.ejs'), { classicCss: true, label: 'x' });
        const modern = engine.renderFile(path.join(dir, 'p.ejs'), { classicCss: false, label: 'x' });
        assert.ok(classic.includes(`{${original}}`), `${key}: classic CSS restored`);
        assert.ok(modern.includes(`{${today}}`) && modern !== classic, `${key}: cards/compact keep today's CSS`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // A rebuilt page renders in Classic too (its old rules no longer match, so it keeps the kit look).
    for (const page of PILOTS) assert.match(renderPilot(page, { classic: true }), /class="cf-rows"/, `${page} renders under Classic`);
});
