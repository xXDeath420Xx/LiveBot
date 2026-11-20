import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePageMap, extractFields } from '../core/settings-index.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * Wave 21b "kit-rollout-b": the group B manage pages (engagement, events, games, economy, game
 * news, streams, creators, media) rebuilt on the wave 18 settings-row kit
 * (dashboard/public/css/cf-settings.css, dashboard/views/partials/kit/), the same way the six
 * pilot pages were (tests/pages-kit.test.js).
 *
 * A rebuild is markup only, so this pins down everything a page's behaviour hangs on. For each
 * partial, rendered through the dashboard's view engine with the stub data below (once with its
 * lists filled, once empty), tests/fixtures/kit-rollout-b-fields.json holds what the partial had
 * BEFORE the rebuild, and the rebuilt partial must still have all of it:
 *
 *   ids        every element id in the markup
 *   names      every form field name (the set must be identical: no field added or dropped)
 *   data       every data-* attribute name in the markup
 *   forms      every <form> as "METHOD action" (the routes the page posts to)
 *   handlers   every inline on*="..." handler (attribute and code)
 *   hooks      what the page's scripts look up in the markup: ids (getElementById, '#id'
 *              selectors) and classes ('.class' selectors, classList checks, closest()); every
 *              hook that was in the markup before must still be in it
 *   urls       every /api/ and /manage/ path the page's scripts call
 *
 * and it must read as the kit: kit sections and rows, sentence-case headings, no emoji, no
 * card containers. KIT_ROLLOUT_B_WRITE_FIXTURE=1 re-captures the fixture from the partials on
 * disk; it was written once, from the partials as they were before the rebuild.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FIXTURE = path.join(root, 'tests/fixtures/kit-rollout-b-fields.json');
const EMOJI = /\p{Extended_Pictographic}/u;

// The group B pages and the partial each renders (several streaming pages share one partial).
const PAGES = {
    engagement: ['achievements', 'starboard', 'birthday', 'confessions'],
    events: ['giveaways', 'polls', 'suggestions'],
    games: ['games', 'counting', 'minigames', 'owo', 'rpg'],
    economy: ['economy', 'gambling', 'trading'],
    gamenews: ['free-games', 'game-news', 'steam-library'],
    streams: ['streamers', 'teams', 'announcements', 'stream-ended', 'auto-track', 'twitch-schedules', 'twitch-clips', 'tiktok', 'event-schedule', 'self-promo'],
    creators: ['feeds', 'community-support', 'throne', 'kofi'],
    media: ['music', 'soundboard'],
};
const pageMap = parsePageMap(read('dashboard/views/manage-tailwind.ejs'));
const partialOf = new Map(pageMap.map((e) => [e.page, e.partial]));
const PARTIALS = [...new Set(Object.values(PAGES).flat().map((p) => partialOf.get(p)))];
// Not rebuilt in this wave (still checked for ids, fields, routes and hooks like the rest). Starboard
// was held back while the Classic CSS-restore tests used it as their un-rebuilt example; they use a
// synthetic partial now (wave 22 kit-polish) and starboard is on the kit like the rest.
const NOT_REBUILT = {};
const REBUILT = PARTIALS.filter((p) => !NOT_REBUILT[p]);

// ── stub data ───────────────────────────────────────────────────────────────────────────────

const D = (y, m, d, h = 12) => new Date(Date.UTC(y, m, d, h));

function stubs() {
    const guild = { id: '222222222222222222', name: 'Acme Gaming', icon: null, memberCount: 1234 };
    const roles = ['Admin', 'Moderator', 'Member', 'Live now', 'Subscriber'].map((name, i) => ({ id: `30000000000000000${i}`, name, color: 0x5865f2 }));
    const channels = ['general', 'announcements', 'starboard', 'giveaways', 'streams'].map((name, i) => ({ id: `40000000000000000${i}`, name, type: 0 }));
    const voiceChannels = [{ id: '500000000000000000', name: 'Lounge', type: 2 }];
    const u1 = '800000000000000001';
    const u2 = '800000000000000002';
    const streamers = [
        { name: 'pixelpal', platforms: ['twitch', 'youtube'], discord_user_id: u1, is_blacklisted: 0,
            subscriptions: [{ id: 11, subscription_id: 11, platform: 'twitch', edit_on_end: 1 }, { id: 12, subscription_id: 12, platform: 'youtube', edit_on_end: 0 }] },
        { name: 'nightowl', platforms: ['kick'], discord_user_id: null, is_blacklisted: 0, subscriptions: [{ id: 13, subscription_id: 13, platform: 'kick', edit_on_end: 0 }] },
    ];
    const streamingData = {
        guild, channels, roles,
        consolidatedStreamers: streamers,
        teamSubscriptions: [{ id: 5, team_name: 'speedrunners', announcement_channel_id: channels[4].id, live_role_id: roles[3].id, webhook_name: null, webhook_avatar_url: null }],
        twitchScheduleSyncs: [{ id: 9, streamer_id: 11, twitch_username: 'pixelpal', discord_channel_id: channels[4].id, is_enabled: 1, sync_discord_events: 1, last_synced: D(2026, 9, 12) }],
        scheduleTemplates: [{ id: 1, name: 'Weekly', theme: 'dark' }],
        autoTrackConfigs: [{ id: 3, role_id: roles[3].id, announcement_channel_id: channels[4].id, platforms: 'twitch', is_enabled: 1 }],
        streamEndedSubs: [],
        settings: { default_edit_on_end: 0, default_delete_on_end: 1 },
        twitchRoleSyncConfig: { broadcaster_twitch_username: 'pixelpal', vip_role_id: roles[4].id, mod_role_id: roles[1].id, remove_vip_on_leave: 1, enabled: 1, last_synced: D(2026, 9, 12) },
        twitchRoleSyncMembers: [{ discord_user_id: u1, twitch_username: 'pixelpal', is_vip: 1, is_mod: 0 }],
    };
    return {
        achievements: { guild },
        starboard: { guild, channels, starboardConfig: { enabled: 1, channel_id: channels[2].id, emoji: '⭐', threshold: 3, self_star: 0, nsfw_allowed: 0 } },
        birthday: {
            guild, channels, roles,
            birthdays: [
                { user_id: u1, username: 'pixelpal', month: 10, day: 14, year: null, timezone: 'UTC' },
                { user_id: u2, username: 'nightowl', month: 3, day: 2, year: 1999, timezone: 'Europe/London' },
            ],
            birthdayStats: { total: 2, thisMonth: 1, today: 0 },
            birthdayConfig: { enabled: 1, channel_id: channels[0].id, role_id: roles[2].id, message: 'Happy birthday {user}.', announce_hour: 9 },
            birthdayCards: [{ id: 4, slug: 'abc123', title: 'For Pixel Pal', title_font: 'Inter', is_posted: 0, recipient_id: u1, created_at: D(2026, 9, 1) }],
        },
        confessions: { guild, channels },
        giveaways: {
            guild, channels,
            giveaways: [
                { id: 21, prize: 'Steam key', winner_count: 1, channel_id: channels[3].id, ends_at: D(2026, 10, 1), is_active: 1, entries: 14, host_id: u1 },
                { id: 22, prize: 'Nitro', winner_count: 2, channel_id: channels[3].id, ends_at: D(2026, 8, 1), is_active: 0, ended: 1, entries: 40, winners: JSON.stringify([u2]) },
            ],
        },
        polls: {
            guild, channels,
            polls: [
                { id: 31, question: 'Next game night?', options: JSON.stringify(['Friday', 'Saturday']), channel_id: channels[0].id, ends_at: D(2026, 10, 1), is_active: 1, votes: 12 },
                { id: 32, question: 'Pizza or tacos?', options: JSON.stringify(['Pizza', 'Tacos']), channel_id: channels[0].id, ends_at: D(2026, 8, 1), is_active: 0, votes: 30 },
            ],
        },
        suggestions: {
            guild, channels, roles,
            suggestions: [{ id: 41, suggestion_id: 41, user_id: u1, content: 'Add a music channel', suggestion: 'Add a music channel', status: 'pending', upvotes: 5, downvotes: 1, created_at: D(2026, 9, 10), tags: [{ id: 1, tag_name: 'Channels', tag_color: '#3b82f6' }] }],
            suggestionConfig: { enabled: 1, channel_id: channels[0].id, review_channel_id: channels[1].id, staff_role_id: roles[1].id, anonymous: 0, dm_on_update: 1 },
            suggestionStats: { total: 1, pending: 1, approved: 0, rejected: 0, implemented: 0 },
            suggestionTags: [{ id: 1, tag_name: 'Channels', tag_color: '#3b82f6', tag_emoji: null }, { id: 2, tag_name: 'Events', tag_color: '#22c55e', tag_emoji: null }],
            suggestionFilters: {},
        },
        games: {
            guild,
            triviaQuestions: [{ question_id: 1, question: 'Largest planet?', answer: 'Jupiter', category: 'Science', difficulty: 'easy' }],
            hangmanWords: [{ word_id: 1, word: 'galaxy', hint: 'Lots of stars', category: 'Space', difficulty: 'medium' }],
            countingChannels: [{ channel_id: channels[0].id, current_count: 42, high_score: 100, channel_name: 'general' }],
            gameStats: { totalGames: 12, triviaPlayed: 8, hangmanPlayed: 4 },
        },
        counting: { guild, channels },
        minigames: { guild, channels },
        // The critters game page (page key owo) loads everything from its API; the server renders only the pickers.
        critters: { guild },
        rpg: { guild, rpgStats: { totalCharacters: 2, activeQuests: 1, topPlayers: [{ character_name: 'Aria', class: 'Mage', level: 12, experience: 3400 }] }, characters: [{ character_name: 'Aria', class: 'Mage', level: 12 }], quests: [] },
        economy: {
            guild, roles,
            economyConfig: { currency_name: 'coins', currency_symbol: 'C', daily_amount: 100, work_min: 10, work_max: 50, starting_balance: 0, enabled: 1 },
            shopItems: [{ id: 51, item_name: 'VIP pass', item_description: 'A week of VIP', item_type: 'role', item_emoji: null, price: 500, stock: 10, role_id: roles[4].id }],
            economyStats: { totalUsers: 40, totalCurrency: 12000, avgBalance: 300 },
            topUsers: [{ user_id: u1, username: 'pixelpal', wallet: 400, bank: 1200 }],
        },
        gambling: {
            guild,
            gamblingConfig: { enabled: 1, min_bet: 10, max_bet: 1000, cooldown_seconds: 30 },
            gamblingHistory: [{ user_id: u1, game_type: 'slots', bet_amount: 50, payout: 120, result: 'win', timestamp: D(2026, 9, 12) }],
            gamblingStats: { totalGames: 30, totalWagered: 3000, totalWon: 2600 },
            topGamblers: [{ user_id: u1, username: 'pixelpal', games_played: 20, total_wagered: 2000, total_won: 2300 }],
        },
        trading: {
            guild,
            activeTrades: [{ trade_id: 61, initiator_id: u1, partner_id: u2, awaiting_id: u2, status: 'pending', initiator_currency: 100, partner_currency: 0, initiator_items: '[]', partner_items: '[]', created_at: D(2026, 9, 12) }],
            tradeHistory: [{ trade_id: 60, initiator_id: u1, partner_id: u2, status: 'completed', initiator_currency: 50, partner_currency: 0, initiator_items: '[]', partner_items: '[]', created_at: D(2026, 9, 1), completed_at: D(2026, 9, 1) }],
            tradeStats: { active: 1, completed: 1, cancelled: 0 },
        },
        'free-games': {
            guild, channels, roles,
            freeGamesSubs: [{ id: 71, discord_channel_id: channels[1].id, role_id: roles[2].id, platforms: 'epic,steam', is_enabled: 1, custom_message: null }],
        },
        'game-news': { guild, channels, roles },
        'steam-library': { guild, channels },
        streaming: streamingData,
        'twitch-clips': { guild, channels },
        tiktok: {
            guild, channels, roles,
            tiktokSubs: [{ subscription_id: 81, username: 'pixelpal', announcement_channel_id: channels[4].id, ping_role_id: roles[3].id, has_live: 1, tiktok_vod_notifications: 1, vod_channel_id: channels[4].id }],
            tiktokConfig: { enabled: 1 },
            recentVideos: [{ username: 'pixelpal', video_url: 'https://www.tiktok.com/@pixelpal/video/1', description: 'Clip', created_at: D(2026, 9, 12) }],
        },
        'event-schedule': { guild, channels },
        'self-promo': { guild, channels, selfPromoConfig: { enabled: 1, channel_id: channels[4].id, keep_message: 1, dm_on_track: 0, platforms: 'twitch,kick', gate_enabled: 0, gate_min_level: 0, gate_required_roles: '[]', gate_delete_unauth: 0, roles } },
        feeds: {
            guild, guildId: guild.id, channels,
            redditFeeds: [{ id: 1, subreddit: 'gaming', channel_id: channels[1].id }],
            youtubeFeeds: [{ id: 2, youtube_channel_id: 'UC123', channel_name: 'Acme', channel_id: channels[1].id }],
            twitterFeeds: [{ id: 3, twitter_username: 'acme', channel_id: channels[1].id }],
            blueskyFeeds: [{ id: 4, handle: 'acme.bsky.social', channel_id: channels[1].id }],
        },
        'community-support': { guild, channels, communitySupportConfig: { enabled: 1, support_channel_id: channels[0].id, shoutout_channel_id: channels[1].id, raid_channel_id: channels[4].id, support_points: 5, raid_affiliate_points: 10, raid_non_affiliate_points: 5, affiliate_link_channel_id: '', non_affiliate_link_channel_id: '' } },
        throne: {
            guild, channels,
            throneNotifications: [{ id: 91, throne_username: 'pixelpal', channel_id: channels[1].id, notify_new_items: 1, notify_gifts: 1, notify_contributions: 0 }],
            throneGuildConfig: { featured_username: 'pixelpal' },
            throneSettings: null,
        },
        kofi: { guild, channels, roles },
        music: {
            guild, roles, channels, voiceChannels,
            musicConfig: { dj_role_id: roles[1].id, vote_skip_percentage: 50, max_songs_per_playlist: 100, max_playlists_per_user: 10, default_volume: 50, ai_dj_voice: 'nova', announce_channel_id: channels[0].id },
            availableDJVoices: [{ value: 'nova', label: 'Nova', category: 'Female' }, { value: 'onyx', label: 'Onyx', category: 'Male' }],
        },
        soundboard: { guild },
    };
}

/** Every list in a stub emptied (arrays to [], so the pages' empty states render). */
function emptied(locals) {
    const out = {};
    for (const [k, v] of Object.entries(locals)) {
        if (Array.isArray(v) && !['channels', 'roles', 'voiceChannels'].includes(k)) out[k] = [];
        else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && k !== 'guild') {
            out[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, Array.isArray(b) ? [] : b]));
        } else out[k] = v;
    }
    return out;
}

/**
 * The partial rendered through the dashboard's view engine from a wrapper page, the way the manage
 * templates include it (so Classic's CSS restore applies); `empty` drops the lists.
 */
function renderPartial(partial, { empty = false, classic = false } = {}) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const all = stubs();
    const base = all[partial];
    // The manage template's own locals (guild, channels, roles, settings) reach every include.
    const shell = { guild: all.streaming.guild, channels: all.streaming.channels, roles: all.streaming.roles, voiceChannels: all.music.voiceChannels, settings: {} };
    const locals = { ...shell, ...(empty ? emptied(base) : base), classicCss: classic };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-rollout-b-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${partial}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── what a page's behaviour hangs on ────────────────────────────────────────────────────────

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** The code a page runs: its inline scripts and the same-site .js files it loads. */
function scriptsOf(html) {
    const out = [];
    for (const m of html.matchAll(SCRIPT)) {
        if (/type="application\/json"/.test(m[1])) continue;
        const src = (m[1].match(/\ssrc="([^"?]+)/) || [])[1];
        if (src && src.startsWith('/')) {
            const file = path.join(root, 'dashboard/public', src);
            if (fs.existsSync(file)) out.push(fs.readFileSync(file, 'utf8'));
        } else out.push(m[2]);
    }
    return out.join('\n');
}

/** Ids and classes the scripts look up, and the site paths they call. */
function scriptHooks(code) {
    const ids = new Set();
    const classes = new Set();
    for (const m of code.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]/g)) ids.add(m[1]);
    for (const m of code.matchAll(/classList\.(?:contains|toggle)\(\s*['"]([\w-]+)['"]/g)) classes.add(m[1]);
    // Selector strings: querySelector(All), closest, matches and jQuery-style $('...'); for a
    // selector built by concatenation or a template, its literal part ('.row[data-id="' + id ...).
    for (const m of code.matchAll(/(?:querySelector(?:All)?|closest|matches|\$)\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`)/g)) {
        const sel = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' ');
        for (const x of sel.matchAll(/#([A-Za-z][\w-]*)/g)) ids.add(x[1]);
        for (const x of sel.matchAll(/\.([A-Za-z][\w-]*)/g)) classes.add(x[1]);
    }
    // A page's own getElementById helper (const $ = (id) => document.getElementById(id), var $ =
    // function (id) { return document.getElementById(id); }, function $(id) {...}): its calls with a
    // literal id are id lookups too.
    const helpers = new Set();
    for (const m of code.matchAll(/function\s+([\w$]+)\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+document\.getElementById\(\s*\2\s*\)/g)) helpers.add(m[1]);
    for (const m of code.matchAll(/(?:var|let|const)\s+([\w$]+)\s*=\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+document\.getElementById\(\s*\2\s*\)/g)) helpers.add(m[1]);
    for (const m of code.matchAll(/(?:var|let|const)\s+([\w$]+)\s*=\s*\(?\s*(\w+)\s*\)?\s*=>\s*document\.getElementById\(\s*\2\s*\)/g)) helpers.add(m[1]);
    for (const h of helpers) {
        const call = new RegExp(`(?<![\\w$.])${h.replace(/\$/g, '\\$')}\\(\\s*['"\`]([A-Za-z][\\w-]*)['"\`]\\s*\\)`, 'g');
        for (const m of code.matchAll(call)) ids.add(m[1]);
    }
    const urls = new Set([...code.matchAll(/['"`](\/(?:api|manage)\/[^'"`\s]*)/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ':x')));
    return { ids, classes, urls };
}

/** Everything the fixture records for one rendered page (scripts left out of the markup sets). */
function surfaceOf(html) {
    const markup = html.replace(SCRIPT, '');
    const tags = [...markup.matchAll(/<[a-z][a-z0-9-]*\b[^>]*>/gi)].map((m) => m[0]);
    const ids = new Set();
    const names = new Set();
    const data = new Set();
    const forms = new Set();
    const handlers = new Set();
    const classes = new Set();
    for (const t of tags) {
        const id = t.match(/\sid="([^"]+)"/);
        if (id) ids.add(id[1]);
        const name = /^<(input|select|textarea|button)\b/i.test(t) && t.match(/\sname="([^"]+)"/);
        if (name) names.add(name[1]);
        for (const a of t.matchAll(/\s(data-[\w-]+)(?==|\s|>|\/)/g)) data.add(a[1]);
        if (/^<form\b/i.test(t)) forms.add(`${((t.match(/\smethod="([^"]*)"/i) || [])[1] || 'GET').toUpperCase()} ${(t.match(/\saction="([^"]*)"/i) || [])[1] || '(none)'}`);
        for (const a of t.matchAll(/\s(on[a-z]+)="([^"]*)"/g)) handlers.add(`${a[1]}=${a[2].replace(/\s+/g, ' ').trim()}`);
        const cls = t.match(/\sclass="([^"]*)"/);
        if (cls) cls[1].split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    }
    const hooks = scriptHooks(scriptsOf(html));
    return { ids, names, data, forms, handlers, classes, hooks };
}

/** The union over the filled and the empty render. */
function capture(partial) {
    const acc = { ids: new Set(), names: new Set(), data: new Set(), forms: new Set(), handlers: new Set(), hookIds: new Set(), hookClasses: new Set(), urls: new Set(), search: new Set() };
    for (const empty of [false, true]) {
        const s = surfaceOf(renderPartial(partial, { empty }));
        for (const k of ['ids', 'names', 'data', 'forms', 'handlers']) s[k].forEach((x) => acc[k].add(x));
        // A script hook counts only if the markup has it (classes a script adds itself are not hooks).
        s.hooks.ids.forEach((x) => { if (s.ids.has(x)) acc.hookIds.add(x); });
        s.hooks.classes.forEach((x) => { if (s.classes.has(x)) acc.hookClasses.add(x); });
        s.hooks.urls.forEach((x) => acc.urls.add(x));
    }
    // Labelled controls the overview's settings search indexes (core/settings-index.js).
    extractFields(read(`dashboard/views/partials/manage/${partial}.ejs`)).forEach((f) => acc.search.add(f.field));
    return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, [...v].sort()]));
}

// KIT_ROLLOUT_B_ONLY=a,b limits the page checks to those partials (while working on them).
const ONLY = process.env.KIT_ROLLOUT_B_ONLY ? new Set(process.env.KIT_ROLLOUT_B_ONLY.split(',')) : null;
const checked = (list) => (ONLY ? list.filter((p) => ONLY.has(p)) : list);

if (process.env.KIT_ROLLOUT_B_WRITE_FIXTURE === '1') {
    const out = {};
    for (const partial of PARTIALS) out[partial] = capture(partial);
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({ _about: 'What the group B manage partials had BEFORE the wave 21b rebuild (tests/kit-rollout-b.test.js stubs): ids, form field names, data-* attributes, form routes, inline handlers, the ids and classes their scripts look up, and the paths their scripts call. The rebuilt partials must keep every one.', partials: out }, null, 1) + '\n');
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────

test('every group B page maps to a partial, and the fixture covers each partial', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).partials;
    for (const page of Object.values(PAGES).flat()) assert.ok(partialOf.get(page), `${page}: in the pageMap`);
    assert.equal(partialOf.get('teams'), 'streaming');
    assert.deepEqual(Object.keys(fixture).sort(), [...PARTIALS].sort());
    assert.equal(PARTIALS.length, 29);
});

test('rebuilt pages keep every id, field name, data attribute, route, handler and script hook', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).partials;
    for (const partial of checked(PARTIALS)) {
        const before = fixture[partial];
        const now = capture(partial);
        const lost = (k) => before[k].filter((x) => !now[k].includes(x));
        assert.deepEqual(lost('ids'), [], `${partial}: ids missing after the rebuild`);
        assert.deepEqual(now.names, before.names, `${partial}: form field names unchanged`);
        assert.deepEqual(lost('data'), [], `${partial}: data-* attributes missing`);
        assert.deepEqual(now.forms, before.forms, `${partial}: form routes unchanged`);
        assert.deepEqual(now.handlers, before.handlers, `${partial}: inline handlers unchanged`);
        assert.deepEqual(lost('hookIds'), [], `${partial}: ids its scripts look up are gone`);
        assert.deepEqual(lost('hookClasses'), [], `${partial}: classes its scripts look up are gone`);
        assert.deepEqual(now.urls, before.urls, `${partial}: script API paths unchanged`);
        // Fields the overview search opens by id (headings it lists as text:<heading> are reworded).
        assert.deepEqual(lost('search').filter((x) => !x.startsWith('text:')), [], `${partial}: settings the overview search finds`);
        // New ids are only the kit's own (descriptions, section titles, empty states).
        for (const x of now.ids.filter((i) => !before.ids.includes(i))) {
            assert.match(x, /(-desc|-title|-head|-error|-empty|-rows)$|^cfk-/, `${partial}: unexpected new id #${x}`);
        }
    }
});

// Words that keep their capital in a sentence-case heading.
const PROPER = new Set([
    'AutoMod', 'XP', 'DM', 'DMs', 'Discord', 'ID', 'IDs', 'URL', 'CSV', 'API', 'AI', 'DJ', 'RPG', 'OwO',
    'Twitch', 'YouTube', 'Kick', 'TikTok', 'Reddit', 'Bluesky', 'Twitter', 'X', 'Steam', 'Epic', 'GOG', 'Throne', 'Ko-fi',
    'Spotify', 'SoundCloud', 'I', 'VIP', 'VIPs', 'VOD', 'VODs', 'RSS', 'UTC', 'Prime', 'Games', 'Store', 'Playstation', 'PlayStation', 'Xbox', 'Nintendo',
    'Edit-on-End', 'Free',
    // Feature names, as the commands and code name them (commands/games/cat.js, commands/games/tree.js).
    'Cat Bot', 'Grow a Tree',
]);
const PROPER_PHRASES = [...PROPER].filter((p) => p.includes(' '));

/**
 * Markup without the parts that are content rather than dashboard copy: Discord message previews
 * (div.cf-dc, which quote what the bot really posts: slot symbols, OwO animals, embed titles) and the
 * economy page's amounts and item icons, which show the server's own currency symbol and item emoji
 * (.ec-money, .ec-price, .ec-item-emoji). Each element is removed with everything inside it.
 */
const CONTENT_CLASSES = new Set(['cf-dc', 'ec-money', 'ec-price', 'ec-item-emoji']);
function withoutContent(markup) {
    let out = markup;
    for (;;) {
        const open = [...out.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\sclass="([^"]*)"[^>]*>/gi)].find((m) => m[2].split(/\s+/).some((c) => CONTENT_CLASSES.has(c)));
        if (!open) return out;
        const start = open.index + open[0].length;
        let depth = 1;
        let end = out.length;
        for (const m of out.slice(start).matchAll(new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'gi'))) {
            depth += m[1] ? -1 : 1;
            if (!depth) { end = start + m.index + m[0].length; break; }
        }
        out = out.slice(0, open.index) + ' ' + out.slice(end);
    }
}

test('rebuilt pages: built on the kit, sentence-case headings, no emoji, no cards inside cards', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).partials;
    for (const partial of checked(REBUILT)) {
        const html = renderPartial(partial);
        const markup = html.replace(SCRIPT, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
        assert.match(markup, /class="cf-section[ "]/, `${partial}: uses kit sections`);
        assert.match(markup, /class="cf-rows[ "]/, `${partial}: uses kit rows`);
        // Text people read (a stored value, such as the starboard's chosen emoji, is data, not an icon).
        const shown = withoutContent(markup).replace(/<option\b[^>]*>[^<]*<\/option>/g, '').replace(/<[^>]*>/g, ' ');
        assert.ok(!EMOJI.test(shown), `${partial}: no emoji in the page (${(shown.match(new RegExp(EMOJI.source, 'gu')) || []).slice(0, 5).join(' ')})`);
        // No card containers (a class a script still looks up may keep its name).
        const cardClasses = [...new Set([...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)))]
            .filter((c) => /^(card|.+-card)$/.test(c) && !fixture[partial].hookClasses.includes(c));
        assert.deepEqual(cardClasses, [], `${partial}: no card containers`);
        const headings = [...markup.matchAll(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
        headings.push(...[...markup.matchAll(/class="page-section-title">[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1].trim()));
        headings.push(...[...markup.matchAll(/class="cf-row-label"[^>]*>([^<]+)</g)].map((m) => m[1].trim()));
        assert.ok(headings.length >= 3, `${partial}: headings found`);
        for (const h of headings) {
            if (/<%|\{/.test(h)) continue;
            // A multi-word proper name counts as one word ("Cat Bot options" -> "Cat_Bot options").
            const joined = PROPER_PHRASES.reduce((t, p) => t.split(p).join(p.replace(/\s+/g, '_')), h);
            const words = joined.split(/\s+/).slice(1).map((w) => w.replace(/^[("'#]+|[)"',.:;?]+$/g, ''));
            const caps = words.filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w.replace(/_/g, ' ')));
            assert.deepEqual(caps, [], `${partial}: "${h}" is sentence case`);
        }
        // No hype: exclamation marks in visible copy.
        // Discord message previews (cf-dc, cf-dc-*) quote the bot's real output, so they are not dashboard copy.
        const text = withoutContent(markup).replace(/<div class="cf-dc-(?:title|desc|text)"[^>]*>[\s\S]*?<\/div>/g, ' ')
            .replace(/<[^>]*>/g, ' ').replace(/<%[\s\S]*?%>/g, ' ');
        assert.ok(!/[a-z]!(\s|$)/i.test(text), `${partial}: no exclamation marks (${(text.match(/[^.!?]{0,40}[a-z]!/i) || [''])[0].trim()})`);
    }
});

test('rebuilt pages render under Classic and with empty lists', () => {
    for (const partial of checked(REBUILT)) {
        assert.match(renderPartial(partial, { classic: true }), /class="cf-rows[ "]/, `${partial} renders under Classic`);
        assert.match(renderPartial(partial, { empty: true }), /class="cf-rows[ "]/, `${partial} renders with empty lists`);
    }
    assert.equal(REBUILT.length, 29, `${REBUILT.length} partials rebuilt`);
});
