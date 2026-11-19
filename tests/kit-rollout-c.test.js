import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePageMap } from '../core/settings-index.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * Wave 21c "kit-rollout-c": the replies, automation, logging and support pages rebuilt on the
 * wave 18 settings-row kit (cf-settings.css, partials/kit/), the same way as the six pilots
 * (tests/pages-kit.test.js).
 *
 *   - every page kept every element id, form field name, data-* attribute, form action and
 *     inline handler it had before the rebuild (tests/fixtures/kit-rollout-c-fields.json,
 *     captured from the original partials with the stub data below), and every class its own
 *     scripts look up is still in the markup
 *   - every page reads as the kit: kit sections and panels, sentence-case headings, no emoji in
 *     the markup, no cards inside cards, and every static table is a kit table in its own
 *     scrolling box (or stacked on a phone)
 *   - every page still renders under the Classic site style
 *
 * KIT_C_WRITE_FIXTURE=1 re-captures the fixture from whatever partials are on disk; it was
 * written once, from the partials as they were before the rebuild.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FIXTURE = path.join(root, 'tests/fixtures/kit-rollout-c-fields.json');
const EMOJI = /\p{Extended_Pictographic}/u;

const PAGES = [
    // replies
    'custom-commands', 'autoresponders', 'tags',
    // automation
    'announce', 'custom-embeds', 'schedule', 'reminders', 'timecapsules', 'weather', 'automemes', 'sticky',
    'auto-purge', 'smart-purge', 'utilities',
    // logging
    'action-log', 'analytics', 'activity-audit', 'serverstats', 'stat-displays', 'emojistats',
    // support
    'tickets', 'forms', 'todo',
];

// ── stub data shared by the fixture capture and the comparison ─────────────────────────────

function stubs() {
    const guild = { id: '222222222222222222', name: 'Acme Gaming', icon: null, memberCount: 1234 };
    const roles = ['Admin', 'Moderator', 'Member', 'Muted', 'Verified'].map((name, i) => ({ id: `30000000000000000${i}`, name, color: 0x5865f2 }));
    const channels = ['general', 'rules', 'mod-log', 'welcome', 'bot-commands'].map((name, i) => ({ id: `40000000000000000${i}`, name, type: 0 }));
    const voiceChannels = [{ id: '500000000000000000', name: 'Lounge', type: 2 }, { id: '500000000000000001', name: 'Join to create', type: 2 }];
    const categories = [{ id: '600000000000000000', name: 'Community', type: 4 }, { id: '600000000000000001', name: 'Support', type: 4 }];
    const day = (d, h = 12) => new Date(Date.UTC(2026, 9, d, h, 0));
    const base = { guild, channels, roles, voiceChannels, categories, settings: {} };
    return {
        'custom-commands': {
            ...base, prefixConfig: { prefix: '!' },
            // The manage template passes `customCommands` to the partial as `commands`.
            get customCommands() { return this.commands; },
            commands: [
                { id: 1, command_name: 'rules', response: 'Read #rules before posting, {user}.', action_type: 'reply', action_content: '', required_roles: '[]', allowed_channels: '[]' },
                { id: 2, command_name: 'price', response: 'BTC is {api:https://api.example.com/btc}', action_type: 'reply', action_content: '', required_roles: JSON.stringify([roles[2].id]), allowed_channels: '[]' },
                { id: 3, command_name: 'verifyme', response: '', action_type: 'add_role', action_content: roles[4].id, required_roles: '[]', allowed_channels: JSON.stringify([channels[4].id]) },
            ],
        },
        autoresponders: { ...base },
        tags: {
            ...base,
            tags: [
                { id: 1, tag_name: 'faq', tag_content: 'Check the pinned messages first.', creator_id: '111111111111111111', creator_tag: 'tester', use_count: 42 },
                { id: 2, tag_name: 'apply', tag_content: 'Applications open on the 1st of each month.', creator_id: '111111111111111112', creator_tag: 'helper', use_count: 3 },
            ],
        },
        announce: { ...base },
        'custom-embeds': {
            ...base,
            customEmbeds: [
                { id: 5, embed_name: 'rules', title: 'Server rules', description: 'Be kind. No spam.', color: '#3ba55d', url: '', author_name: 'Staff', author_icon_url: '', footer_text: 'Updated weekly', image_url: '', thumbnail_url: '', channel_id: channels[1].id, message_id: '900000000000000001', created_at: day(2) },
                { id: 6, embed_name: 'draft', title: '', description: 'Draft text', color: null, url: '', author_name: '', author_icon_url: '', footer_text: '', image_url: '', thumbnail_url: '', channel_id: channels[0].id, message_id: null, created_at: day(9) },
            ],
        },
        schedule: { ...base },
        reminders: {
            ...base,
            reminders: [
                { id: 1, user_id: '111111111111111111', channel_id: channels[0].id, message: 'Stream starts in an hour', remind_at: day(20, 18), is_active: 1 },
                { id: 2, user_id: '800000000000000001', channel_id: channels[4].id, message: 'Check the raffle', remind_at: day(21, 9), is_active: 1 },
            ],
        },
        timecapsules: { ...base },
        weather: { ...base, weatherStats: { totalUsers: 14, activeAlerts: 2, alertsSent: 381 }, weatherConfig: { enabled: 1, check_interval: 30 } },
        automemes: { ...base },
        sticky: { ...base },
        'auto-purge': {
            ...base,
            purgeConfigs: [
                { id: 1, channel_id: channels[4].id, enabled: 1, interval_hours: 24, purge_time: null, last_purge_at: day(12, 0) },
                { id: 2, channel_id: channels[0].id, enabled: 0, interval_hours: null, purge_time: '03:00', last_purge_at: null },
            ],
        },
        'smart-purge': {
            ...base,
            purgeRules: [
                { id: 1, name: 'Clear bot spam', channel_id: channels[4].id, enabled: 1, dry_run: 0, delete_after_seconds: 3600, target: 'matching', match_mode: 'any', filters: JSON.stringify({ from_bots: true, has_link: true, phrases: ['giveaway'] }), exempt_pinned: 1, exempt_bots: 0, exempt_role_ids: JSON.stringify([roles[0].id]), exempt_user_ids: '[]', scan_complete: 1, last_run_at: day(12, 10), last_deleted: 4, total_deleted: 210, last_error: null },
                { id: 2, name: 'Old chat', channel_id: channels[0].id, enabled: 0, dry_run: 1, delete_after_seconds: 604800, target: 'all', match_mode: 'all', filters: '{}', exempt_pinned: 1, exempt_bots: 1, exempt_role_ids: '[]', exempt_user_ids: '[]', scan_complete: 0, last_run_at: null, last_deleted: 0, total_deleted: 0, last_error: 'Missing Manage Messages' },
            ],
        },
        utilities: {
            ...base,
            autoPublisherConfig: { is_enabled: 1 }, autoPublisher: { is_enabled: 1 },
            autorolesConfig: { is_enabled: 1, roles_to_assign: [roles[2].id] }, autoroles: { is_enabled: 1, roles_to_assign: [roles[2].id] },
            tempChannels: { creator_channel_id: voiceChannels[1].id, category_id: categories[0].id, naming_template: "{username}'s Channel" },
            tempChannelConfig: { creator_channel_id: voiceChannels[1].id, category_id: categories[0].id, naming_template: "{username}'s Channel" },
        },
        'action-log': {
            ...base,
            actionLogs: [
                { id: 1, action: 'settings_update', event_type: 'dashboard', user_id: '111111111111111111', userName: 'tester', user: 'tester', target_id: null, target: null, targetName: null, old_value: '{"prefix":"?"}', new_value: '{"prefix":"!"}', reason: null, timestamp: day(12, 14) },
                { id: 2, action: 'ban', event_type: 'moderation', user_id: '111111111111111111', userName: 'tester', user: 'tester', target_id: '800000000000000001', target: 'pixelpal', targetName: 'Pixel Pal', old_value: null, new_value: null, reason: 'Scam links', timestamp: day(11, 9) },
            ],
        },
        analytics: {
            ...base,
            serverStats: [
                { date: '2026-10-10', total_members: 1200, online_members: 310, message_count: 820, joins: 12, leaves: 3 },
                { date: '2026-10-11', total_members: 1215, online_members: 290, message_count: 760, joins: 18, leaves: 3 },
                { date: '2026-10-12', total_members: 1234, online_members: 342, message_count: 1010, joins: 21, leaves: 2 },
            ],
        },
        'activity-audit': { ...base },
        serverstats: {
            ...base,
            statDisplayChannels: [{ id: 1, channel_id: voiceChannels[0].id, stat_type: 'members', template: 'Members: {value}', config: null }],
        },
        'stat-displays': {
            ...base,
            statDisplayChannels: [
                { id: 1, channel_id: voiceChannels[0].id, stat_type: 'members', template: 'Members: {value}', config: null },
                { id: 2, channel_id: '500000000000000002', stat_type: 'role', template: 'Mods: {value}', config: JSON.stringify({ role_id: roles[1].id }) },
                { id: 3, channel_id: '500000000000000003', stat_type: 'twitch_followers', template: 'Followers: {value}', config: { twitch_username: 'acmelive' } },
            ],
        },
        emojistats: { ...base },
        tickets: {
            ...base,
            // The ticket analytics block reads `data` (no route passes it; see the "tickets" test below).
            data: { ticketStats: null, activeTickets: [] },
            ticketConfig: { panel_channel_id: channels[0].id, support_role_id: roles[1].id, ticket_category_id: categories[1].id },
            forms: [{ form_id: 'f1', form_name: 'Staff application' }],
            ticketFormsList: [{ form_id: 'f1', form_name: 'Staff application' }],
            ticketPanels: [
                { panel_id: 'p1', panel_name: 'General support', panel_channel_id: channels[0].id, panel_message_id: '900000000000000002', ticket_category_id: categories[1].id, support_role_id: roles[1].id, log_channel_id: channels[2].id, embed_title: 'Need help?', embed_description: 'Open a ticket and a moderator will be with you shortly.', embed_color: '#3ba55d', button_text: 'Open a ticket', button_emoji: '', ticket_name_format: 'ticket-{number}', save_transcripts: 1 },
                { panel_id: 'p2', panel_name: 'Appeals', panel_channel_id: null, panel_message_id: null, ticket_category_id: categories[1].id, support_role_id: roles[0].id, log_channel_id: null, embed_title: '', embed_description: '', embed_color: null, button_text: '', button_emoji: '', ticket_name_format: 'appeal-{username}', save_transcripts: 0 },
            ],
        },
        forms: {
            ...base, botName: 'CertiFried Utility', viewerId: '111111111111111111', viewerName: 'Tester',
            guildMembers: [{ id: '111111111111111111', username: 'tester', display: 'Tester' }, { id: '111111111111111112', username: 'helper', display: 'Helper' }],
            forms: [
                { form_id: 'f1', form_name: 'Staff application', form_description: 'Apply to join the team.', question_count: 4, submission_count: 12, panel_count: 1, submit_channel_id: channels[2].id, dm_on_submit: 1, dm_user_ids: '[]', auto_reply: 'Thanks, we will be in touch.', show_questions_on_panel: 0, ticket_attached: 0 },
                { form_id: 'f2', form_name: 'Event feedback', form_description: '', question_count: 0, submission_count: 0, panel_count: 0, submit_channel_id: null, dm_on_submit: 0, dm_user_ids: '[]', auto_reply: '', show_questions_on_panel: 1, ticket_attached: 1 },
            ],
        },
        todo: { ...base },
    };
}

const LISTS = ['commands', 'tags', 'customEmbeds', 'reminders', 'purgeConfigs', 'purgeRules', 'actionLogs', 'serverStats', 'statDisplayChannels', 'ticketPanels', 'forms'];

/** A page's partial (from manage-tailwind.ejs's pageMap). */
function partialOf(page) {
    const entry = parsePageMap(read('dashboard/views/manage-tailwind.ejs')).find((e) => e.page === page);
    return entry ? entry.partial : page;
}

/**
 * The partial rendered through the dashboard's view engine, included from a wrapper page the way
 * the manage templates include it (so Classic's CSS restore applies); `empty` drops the lists.
 */
function renderPage(page, { empty = false, classic = false, drop = [] } = {}) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const locals = { ...stubs()[page], classicCss: classic };
    for (const k of drop) delete locals[k];
    if (empty) for (const k of LISTS) if (Array.isArray(locals[k])) locals[k] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-c-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${partialOf(page)}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const stripScripts = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');

/** Classes a page's scripts look up (selectors and classList checks), as written in the script. */
function scriptClasses(js) {
    const out = new Set();
    for (const m of js.matchAll(/(?:querySelector(?:All)?|closest|matches)\(\s*(['"`])([^'"`]+)\1/g)) {
        for (const c of m[2].matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(c[1]);
    }
    for (const m of js.matchAll(/getElementsByClassName\(\s*['"`]([\w-]+)['"`]/g)) out.add(m[1]);
    for (const m of js.matchAll(/classList\.contains\(\s*['"`]([\w-]+)['"`]/g)) out.add(m[1]);
    return out;
}

/** What a page's markup exposes to its scripts, its forms and the server. */
function fieldsOf(html) {
    const markup = stripScripts(html);
    const classes = new Set([...markup.matchAll(/\sclass="([^"]*)"/gi)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
    return {
        ids: new Set([...markup.matchAll(/<[a-z][^>]*?\sid="([^"]+)"/gi)].map((m) => m[1])),
        names: new Set([...markup.matchAll(/<(?:input|select|textarea|button)\b[^>]*?\sname="([^"]+)"/gi)].map((m) => m[1])),
        data: new Set([...markup.matchAll(/<[a-z][^>]*>/gi)].flatMap((m) => [...m[0].matchAll(/\s(data-[\w-]+)=/gi)].map((d) => d[1].toLowerCase()))),
        actions: new Set([...markup.matchAll(/<form\b[^>]*?\saction="([^"]*)"/gi)].map((m) => m[1])),
        handlers: new Set([...markup.matchAll(/\son[a-z]+="([^"]*)"/gi)].flatMap((m) => [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((f) => f[1]))
            .filter((f) => !['confirm', 'if', 'return', 'event', 'alert', 'prompt'].includes(f))),
        hooks: new Set([...scriptClasses(scriptsOf(html))].filter((c) => classes.has(c))),
    };
}

/** Everything a page exposes, over a render with its lists and one without. */
function capture(page) {
    const all = { ids: new Set(), names: new Set(), data: new Set(), actions: new Set(), handlers: new Set(), hooks: new Set() };
    for (const empty of [false, true]) {
        const f = fieldsOf(renderPage(page, { empty }));
        for (const k of Object.keys(all)) f[k].forEach((x) => all[k].add(x));
    }
    return all;
}

if (process.env.KIT_C_WRITE_FIXTURE === '1') {
    const out = {};
    for (const page of PAGES) {
        const c = capture(page);
        out[page] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [...v].sort()]));
    }
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({ _about: 'Element ids, form field names, data-* attributes, form actions, inline handlers and script-looked-up classes of the wave 21c pages BEFORE the kit rebuild (tests/kit-rollout-c.test.js stubs). The rebuilt pages must keep every one.', pages: out }, null, 1) + '\n');
}

// ── nothing lost ─────────────────────────────────────────────────────────────────────────────

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).pages;
// Words that keep their capital in a sentence-case heading.
const PROPER = new Set(['AutoMod', 'CAPTCHA', 'XP', 'DM', 'DMs', 'Discord', 'ID', 'IDs', 'URL', 'URLs', 'API', 'CSV', 'JSON', 'Twitch', 'Reddit', 'UTC', 'I', 'OwO', 'Unverified', 'Verified']);

test('kit rollout C: the fixture covers every page', () => {
    assert.deepEqual(Object.keys(fixture).sort(), [...PAGES].sort());
});

for (const page of PAGES) {
    test(`${page}: keeps its ids, field names, data attributes, form actions, handlers and script hooks`, () => {
        const before = fixture[page];
        const now = capture(page);
        const lost = (k) => before[k].filter((x) => !now[k].has(x));
        assert.deepEqual(lost('ids'), [], 'ids missing after the rebuild');
        assert.deepEqual([...now.names].sort(), before.names, 'form field names unchanged');
        assert.deepEqual(lost('data'), [], 'data-* attributes missing');
        assert.deepEqual([...now.actions].sort(), before.actions, 'form actions (routes) unchanged');
        assert.deepEqual(lost('handlers'), [], 'inline handlers missing');
        assert.deepEqual(lost('hooks'), [], 'classes its scripts look up are no longer in the markup');
        // New ids are only the kit's own (descriptions, section titles, error slots).
        const added = [...now.ids].filter((x) => !before.ids.includes(x));
        for (const x of added) assert.match(x, /(-desc|-title|-head|-error|-empty|-rows)$|^cfk-/, `unexpected new id #${x}`);
        // Ids its scripts read that the original page had must still be in the markup.
        const js = scriptsOf(renderPage(page));
        const wanted = [...js.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]\s*\)/g)].map((m) => m[1]).filter((x) => before.ids.includes(x));
        for (const id of wanted) assert.ok(now.ids.has(id), `script looks up #${id}`);
    });

    test(`${page}: built on the kit, sentence case, plain copy, no emoji, no cards, tables in their own box`, () => {
        for (const empty of [false, true]) {
            const html = renderPage(page, { empty });
            const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
            const where = empty ? ' (empty)' : '';
            assert.match(markup, /class="cf-section[ "]/, `uses kit sections${where}`);
            assert.match(markup, /class="cf-rows[ "]/, `uses kit panels${where}`);
            const noOptions = markup.replace(/<option\b[^>]*>[^<]*<\/option>/g, '');
            assert.ok(!EMOJI.test(noOptions), `no emoji in the page${where}: ${(noOptions.match(new RegExp(`.{0,40}${EMOJI.source}.{0,20}`, 'u')) || [''])[0]}`);
            assert.ok(!/class="[^"]*\b(card|manage-card|feature-card|stat-card)\b/.test(markup), `no card containers${where}`);
            const headings = [...markup.matchAll(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
            headings.push(...[...markup.matchAll(/class="page-section-title">[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1].trim()));
            headings.push(...[...markup.matchAll(/class="cf-row-label"[^>]*>([^<]+)</g)].map((m) => m[1].trim()));
            headings.push(...[...markup.matchAll(/class="cf-rows-head"[^>]*>([^<]+)</g)].map((m) => m[1].trim()));
            assert.ok(headings.length >= 2, `headings found${where}`);
            for (const h of headings) {
                const words = h.split(/\s+/).slice(1).map((w) => w.replace(/^[("'#]+|[)"',.:;?]+$/g, ''));
                const caps = words.filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w));
                assert.deepEqual(caps, [], `"${h}" is sentence case${where}`);
                assert.ok(!h.includes('!'), `"${h}" has no exclamation mark${where}`);
            }
            // Buttons and descriptions read plainly: no exclamation marks.
            const texts = [
                ...[...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => m[1]),
                ...[...markup.matchAll(/class="(?:cf-row-desc|cf-section-desc|page-section-subtitle|cf-state-text)"[^>]*>([\s\S]*?)<\/(?:p|div)>/gi)].map((m) => m[1]),
            ].map((t) => t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
            for (const t of texts) assert.ok(!/!(\s|$)/.test(t), `"${t.slice(0, 60)}" has an exclamation mark${where}`);
            // Tables sit in their own scrolling box (.cf-table-wrap), so a phone never scrolls the page
            // sideways; they are kit tables (.cf-table) unless the page styles its own (activity-audit's
            // member table, restyled in cf-manage.css).
            for (const m of markup.matchAll(/<table\b([^>]*)>/gi)) {
                if (page !== 'activity-audit') assert.match(m[1], /class="[^"]*\bcf-table\b/, `a table that is not a kit table${where}`);
                const before = markup.slice(0, m.index);
                const wraps = [...before.matchAll(/class="[^"]*\bcf-table-wrap\b/g)];
                const open = wraps.length ? wraps[wraps.length - 1].index : -1;
                assert.ok(open >= 0 && open > before.lastIndexOf('</table>'), `a table outside .cf-table-wrap${where}`);
            }
        }
    });

    test(`${page}: renders under Classic`, () => {
        assert.match(renderPage(page, { classic: true }), /class="cf-rows[ "]/);
    });
}

test('tickets: renders with a configured ticket setup and no `data` local (no route passes one)', () => {
    // The ticket activity block used to read data.ticketStats directly, so any server whose ticket
    // setup had a panel channel and category got "data is not defined" (a 500).
    const html = renderPage('tickets', { drop: ['data'] });
    assert.match(html, /id="ticketSearchInput"/);
    assert.ok(!/data is not defined/.test(html));
});
