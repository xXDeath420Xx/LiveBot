#!/usr/bin/env node
/**
 * Visual smoke check for the dashboard templates, run by the deploy scripts as a gate.
 *
 *   node scripts/visual-check.mjs [--root DIR] [--pages a,b] [--styles a,b] [--themes a,b]
 *                                 [--concurrency 4] [--shots DIR] [--json] [--serve] [--self-test]
 *                                 [--max-seconds 150]
 *
 * Renders key pages straight from the templates in --root (default: this repo) with realistic
 * stub data, through the real view engine (dashboard/services/view-engine.js), serves them with
 * dashboard/public on a throwaway local port, and loads each in headless Chrome (the installed
 * puppeteer) for every site style x theme, at 1440 px and again at 390 px. It FAILS (exit 1) on:
 *
 *   - a JavaScript error on the page (uncaught exception / unhandled rejection)
 *   - an unresolved CSS custom property on a key element (var(--x) with no fallback where --x is
 *     not defined), or a transparent page background / key surface (a token that did not resolve)
 *   - horizontal overflow at 390 px (the page scrolls sideways on a phone)
 *   - an empty <main> (no text: the page body failed to render)
 *   - the manage overview's card grid not laid out as several columns (cards style, grid layout,
 *     1440 px)
 *   - wave 17 navigation (overview, 1440 px): the sidebar server switcher does not open or lists
 *     no servers; the setup checklist does not render its steps; typing a setting name in the
 *     overview search lists no matching settings; a feature page shows no "Related pages"
 *   - the Auto theme not following the OS: overview and settings are also loaded with
 *     data-theme="auto" under an emulated light and dark prefers-color-scheme, and <html> must
 *     resolve to "light" / "dark" respectively (data-theme-mode stays "auto")
 *   - wave 18 settings-row kit, on the six pilot pages (moderation, automod, verification, welcome,
 *     logging, leveling) in every style and theme: the "What this does" block is missing or not
 *     under the page title, the page has no kit rows, a kit row or the help block is wider than
 *     the page at 390 px, or (desktop, first theme) "Recommended settings" does not fill in and
 *     list its changes, or does not raise the unsaved-changes bar on a page whose forms post
 *   - wave 22 kit polish: a few pages rebuilt on the kit in waves 21a-c (tickets, economy,
 *     streamers, global ban, a generated feature page), in every style with the first theme: no
 *     kit panel, a missing help block, or a kit element wider than the page at 390 px; and on
 *     EVERY page at 390 px, a stacked table (.cf-table--stack) whose cells are still indented
 *     from their row (desktop side padding left over) or padded
 *   - an empty inline status line (.cf-status-line) that still draws something (a box or a dot)
 *   - kokoro-voices wave: the voice pickers (Text to Speech default voice on a generated page, the
 *     AI DJ voice on Music) not grouped by engine — a Piper group and a Kokoro group must both be
 *     there, with the saved Kokoro voice selected — or the generated page has no preview button
 *
 * No database reads (importing core/ only opens the pool), no Discord, no network beyond the CDNs
 * the pages load (fonts, Font Awesome,
 * Bootstrap); low-contrast navigation/headings/buttons are reported as warnings (WARN lines,
 * not failures; colours are composited through translucent layers, color-mix() results included).
 * Page-side fetches to /api get a JSON 503 like a reconnecting server, except the stubs the wave 17
 * UI needs (/api/me/servers, .../insight/checklist, /api/settings-index, .../users/resolve). Exit 0 = all
 * passed, 1 = failures (listed), 2 = could not run (browser/template). Runtime ~30-60 s.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

const ROOT = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const VIEWS = path.join(ROOT, 'dashboard/views');
const PUBLIC = path.join(ROOT, 'dashboard/public');
const STYLES = list(opt('styles', 'cards,compact,classic'));
const THEMES = list(opt('themes', 'dark,amoled,light,forest'));
// Auto theme: these pages are loaded again with theme=auto under each emulated OS colour scheme.
const AUTO_PAGES = ['overview', 'settings'];
const SCHEMES = ['light', 'dark'];
const WIDTHS = [1440, 390];
const SHOTS = opt('shots', null);
// Screenshots from several tabs at once wedge headless Chrome's software compositor: one tab then.
const CONCURRENCY = SHOTS ? 1 : Math.max(1, Number(opt('concurrency', 4)) || 4);
const JSON_OUT = args.includes('--json');
const GUILD_ID = '222222222222222222';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
// --self-test: each of these must make the check fail (proves the gate can fail).
const BREAKAGES = {
    jserror: '<script>throw new Error("visual-check self-test")</script>',
    token: '<style>html, body, :root, [data-theme] { --cf-bg: initial !important; --cf-surface: initial !important; --cf-text: initial !important; }</style>',
    overflow: '<div style="width:1600px;height:4px;background:red"></div>',
    empty: '<script>document.addEventListener("DOMContentLoaded",function(){var m=document.querySelector("main");if(m)m.replaceChildren();});</script>',
    grid: '<style>.module-grid { display: block !important; }</style>',
    // Wave 22: a stacked table whose first cell keeps desktop padding, and an empty status line that paints.
    stack: '<div class="cf-rows"><table class="cf-table cf-table--stack"><tbody><tr><td data-label="Name" style="padding-left:20px !important">x</td><td data-label="Value">y</td></tr></tbody></table></div>',
    statusline: '<span class="cf-status-line" style="border:1px solid red;padding:0 6px"></span>',
    nav17: '<script>document.addEventListener("DOMContentLoaded",function(){["cfSwitcher","cfChecklist"].forEach(function(id){var n=document.getElementById(id);if(n)n.remove();});});</script>',
};
const SELF_TEST = args.includes('--self-test');
// Wave 18: the pages rebuilt on the settings-row kit (cf-settings.css), checked for its layout and help.
const KIT_PAGES = ['moderation', 'automod', 'verification', 'welcome', 'logging', 'leveling'];
// Wave 22: representative pages from each kit rollout group (support, economy, streams, protection,
// a generated feature-config page). Checked in every style with the first theme only (runtime).
const KIT_EXTRA = ['tickets', 'economy', 'streamers', 'global-ban', 'qotd', 'tts', 'music'];
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

const MAX_SECONDS = Math.max(30, Number(opt('max-seconds', 150)) || 150);
const withTimeout = (promise, ms, what) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000}s`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// ── stub data ───────────────────────────────────────────────────────────────

async function loadPages() {
    const [{ createViewEngine }, { manageTemplateFor }, nav, spec, prefs, checklist, settingsIndex, accent, help, { default: voiceLogic }] = await Promise.all([
        imp('dashboard/services/view-engine.js'),
        imp('dashboard/services/classic-style.js'),
        imp('core/manage-nav.js'),
        imp('core/feature-config-spec.js'),
        imp('core/user-preferences.js'),
        imp('core/setup-checklist.js'),
        imp('core/settings-index.js'),
        imp('core/accent-tint.js'),
        imp('core/page-help.js'),
        imp('utils/kokoro-logic.cjs'),
    ]);
    // TTS voices as the server lists them: a few Piper voices plus the 28 Kokoro ones.
    const installedVoices = voiceLogic.mergeVoices({
        ryan: { locale: 'en_US', quality: 'high', gender: 'male', description: 'en US ryan voice', flag: '' },
        amy: { locale: 'en_US', quality: 'medium', gender: 'female', description: 'en US amy voice', flag: '' },
        alan: { locale: 'en_GB', quality: 'medium', gender: 'male', description: 'en GB alan voice', flag: '' },
        thorsten: { locale: 'de_DE', quality: 'medium', gender: 'male', description: 'de DE thorsten voice', flag: '' },
    }, true);
    const voiceGroups = voiceLogic.voiceOptionGroups(installedVoices);
    const djVoices = Object.entries(installedVoices).map(([value, v]) => (v.engine === 'kokoro'
        ? { value, label: `${v.displayName}, ${v.gender}`, category: `Kokoro · ${v.locale === 'en_GB' ? 'British English' : 'US English'}`, engine: 'kokoro' }
        : { value, label: `${voiceLogic.voiceLabel(value, v)} (${v.quality}, ${v.gender})`, category: { en_US: 'US English', en_GB: 'British English' }[v.locale] || 'German' }));
    const engine = createViewEngine({ viewsDir: VIEWS, publicDir: PUBLIC, cache: true });
    const user = { id: '111111111111111111', username: 'tester', globalName: 'Tester', avatar: null, isSuperAdmin: false, canCreateBots: false, guilds: [] };
    const guild = { id: GUILD_ID, name: 'Acme Gaming', icon: null, memberCount: 1234, ownerId: '111111111111111111' };
    const roles = ['Admin', 'Moderator', 'Member', 'Muted', 'Verified'].map((name, i) => ({ id: `30000000000000000${i}`, name, color: 0x5865f2, hexColor: '#5865f2', position: 5 - i }));
    const channels = ['general', 'rules', 'mod-log', 'welcome', 'announcements'].map((name, i) => ({ id: `40000000000000000${i}`, name, type: 0, parentId: null }));
    const voiceChannels = [{ id: '500000000000000000', name: 'Lounge', type: 2 }];
    const categories = [{ id: '600000000000000000', name: 'Community', type: 4 }];
    const guilds = Array.from({ length: 9 }, (_, i) => ({
        id: `7000000000000000${String(i).padStart(2, '0')}`,
        name: ['Acme Gaming', 'Night Owls', 'The Den', 'Pixel Pals', 'Speedrun Club', 'Cozy Corner', 'Raid Squad', 'Art Hub', 'Study Hall'][i],
        icon: null, memberCount: 120 * (i + 1), botCount: 3, liveCount: i % 3, ownerName: 'owner', botJoinedAt: new Date(Date.UTC(2025, i, 1)),
        securityFeatures: i % 2 ? ['Global Ban'] : [], hasAnySecurity: i % 2 === 1,
    }));

    const common = (style, theme) => ({
        user,
        uiTheme: theme, uiStyle: style, uiDensity: 'comfortable', uiLayout: 'grid',
        userPrefs: { pinnedPages: [], recentPages: [], siteStyle: style, theme, dashboardLayout: 'grid', density: 'comfortable' },
        csrfToken: 'visual-check',
        clientId: '999999999999999999',
    });

    const manageNav = nav.buildManageNav(spec.FEATURE_SPECS);
    const manage = (page, extra = {}) => (style, theme) => {
        const template = manageTemplateFor(style);
        return {
            template,
            locals: {
                ...common(style, theme),
                classicCss: template === 'manage-classic',
                siteStyles: prefs.STYLES.map((s) => ({ value: s.value, label: s.label })),
                guild, page,
                manageNav,
                relatedPages: page === 'overview' ? [] : nav.relatedPages(page, manageNav),
                settingsIndexVersion: 1,
                featureConfigKeys: spec.FEATURE_KEYS,
                featureConfigSpecs: spec.FEATURE_SPECS,
                roles, channels, voiceChannels, categories,
                prefixConfig: {}, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
                moderationConfig: {}, recentInfractions: [], escalationRules: [],
                ...extra,
            },
        };
    };

    const pages = {
        landing: () => ({
            template: 'landing-chooser',
            locals: {
                discordLoggedIn: true, kickLoggedIn: false, discordHref: '/dashboard', kickHref: '/tokes-bot/auth/kick',
                discordServers: 412, discordUsers: 98000, customBotServers: 61, kickChannels: 37, kickEnrolled: 12,
                phishingBlocked: 25000, discoveryUrl: null,
            },
        }),
        servers: () => ({
            template: 'servers-tailwind',
            locals: { guilds, manageableGuilds: guilds, totalMembers: 5400, totalHumanMembers: 5100, totalBots: 300, totalLiveStreams: 3, totalStreamersTracked: 40 },
        }),
        overview: manage('overview'),
        // Recent infractions with resolved people (core/user-display.js userBits): a member, someone
        // who left (name from the bot's cache), someone who left named only by the resolve endpoint's
        // Discord lookup (answered "pending" first, then found: core/user-lookup.js), and an id
        // nothing resolves (drawn with a copy button).
        moderation: manage('moderation', {
            pageHelp: help.pageHelp('moderation'),
            recentInfractions: [
                { type: 'Warn', reason: 'Spam in #general', created_at: new Date(Date.UTC(2026, 9, 12, 14, 5)), user_id: '800000000000000001', moderator_id: '111111111111111111',
                    user: { id: '800000000000000001', username: 'pixelpal', displayName: 'Pixel Pal', avatar: null, inServer: true },
                    moderator: { id: '111111111111111111', username: 'tester', displayName: 'Tester', avatar: null, inServer: true } },
                { type: 'Ban', reason: 'Scam links', created_at: new Date(Date.UTC(2026, 9, 11, 9, 30)), user_id: '800000000000000002', moderator_id: '111111111111111111',
                    user: { id: '800000000000000002', username: 'freenitro_drop', displayName: 'freenitro_drop', avatar: null, inServer: false },
                    moderator: { id: '111111111111111111', username: 'tester', displayName: 'Tester', avatar: null, inServer: true } },
                { type: 'Timeout', reason: null, created_at: new Date(Date.UTC(2026, 9, 10, 18, 0)), user_id: '800000000000000003', moderator_id: '999999999999999999',
                    user: { id: '800000000000000003', username: null, displayName: null, avatar: null, inServer: false },
                    moderator: { id: '999999999999999999', username: 'CertiFried', displayName: 'CertiFried', avatar: null, inServer: true } },
                { type: 'Kick', reason: 'Alt account', created_at: new Date(Date.UTC(2026, 9, 9, 8, 0)), user_id: '800000000000000004', moderator_id: '999999999999999999',
                    user: { id: '800000000000000004', username: null, displayName: null, avatar: null, inServer: false },
                    moderator: { id: '999999999999999999', username: 'CertiFried', displayName: 'CertiFried', avatar: null, inServer: true } },
            ],
        }),
        // With "Use each server's colour" on (a pink embed colour), so the fitted accent is checked too.
        verification: manage('verification', { serverAccentCss: accent.serverAccentCss('#e91e63'), pageHelp: help.pageHelp('verification') }),
        // Wave 18 pilot pages on the settings-row kit, with a list each so tables and empty states both show.
        automod: manage('automod', {
            pageHelp: help.pageHelp('automod'), heatConfig: {},
            automodRules: [
                { id: 1, filter_type: 'antiSpam', action: 'mute', action_duration_minutes: 10, config: '{"messageLimit":5,"timePeriod":10}' },
                { id: 2, filter_type: 'bannedWords', action: 'delete', config: { words: ['freenitro', 'steamcommunity-gift', 'claim your prize', 'airdrop', 'giveaway-bonus', 'discord-nitro'] } },
            ],
        }),
        welcome: manage('welcome', {
            pageHelp: help.pageHelp('welcome'),
            welcomeSettings: { channel_id: channels[3].id, message: '', banner_enabled: 0, card_title_text: '', card_subtitle_text: '', card_background_url: '', goodbye_enabled: 1, goodbye_channel_id: channels[0].id, goodbye_message: 'Goodbye {user}.' },
        }),
        logging: manage('logging', {
            pageHelp: help.pageHelp('logging'), auditLogs: [], channelSettingsMap: new Map(),
            logConfig: {
                log_channel_id: '', enabled_logs: '["messageDelete","ban"]', log_categories: JSON.stringify({ ban: channels[2].id }),
                action_color_rows: {
                    messageDelete: { actions: [{ key: 'messageDelete', label: 'Deleted', value: '#ef4444', custom: false, fallback: '#ef4444' }] },
                    ban: { actions: [{ key: 'ban', label: 'Ban', value: '#991b1b', custom: true, fallback: '#7f1d1d' }] },
                    system: { notPosted: 'Not posted in a log channel' },
                },
            },
        }),
        leveling: manage('leveling', {
            pageHelp: help.pageHelp('leveling'),
            settings: { leveling_enabled: 0, leveling_xp_rate: 20, leveling_xp_cooldown: 30, level_up_channel_id: '', leveling_ignored_channels: [], leveling_ignored_roles: [], monthly_reset_enabled: 0, reset_interval_days: 30 },
            roleRewards: [{ id: 3, level: 10, role_id: roles[2].id }, { id: 4, level: 25, role_id: roles[0].id }],
        }),
        'message-threats': manage('message-threats'),
        // Wave 22 kit-polish: one page from each kit rollout group, with lists so tables stack at 390 px.
        tickets: manage('tickets', {
            pageHelp: help.pageHelp('tickets'), data: { ticketStats: null, activeTickets: [] },
            ticketConfig: { panel_channel_id: channels[0].id, support_role_id: roles[1].id, ticket_category_id: categories[0].id },
            ticketFormsList: [{ form_id: 'f1', form_name: 'Staff application' }],
            ticketPanels: [
                { panel_id: 'p1', panel_name: 'General support', panel_channel_id: channels[0].id, panel_message_id: '900000000000000002', ticket_category_id: categories[0].id, support_role_id: roles[1].id, log_channel_id: channels[2].id, embed_title: 'Need help?', embed_description: 'Open a ticket and a moderator will be with you shortly.', embed_color: '#3ba55d', button_text: 'Open a ticket', button_emoji: '', ticket_name_format: 'ticket-{number}', save_transcripts: 1 },
                { panel_id: 'p2', panel_name: 'Appeals', panel_channel_id: null, panel_message_id: null, ticket_category_id: categories[0].id, support_role_id: roles[0].id, log_channel_id: null, embed_title: '', embed_description: '', embed_color: null, button_text: '', button_emoji: '', ticket_name_format: 'appeal-{username}', save_transcripts: 0 },
            ],
        }),
        economy: manage('economy', {
            pageHelp: help.pageHelp('economy'),
            economyConfig: { currency_name: 'coins', currency_symbol: 'C', daily_amount: 100, work_min: 10, work_max: 50, starting_balance: 0, enabled: 1 },
            shopItems: [{ id: 51, item_name: 'VIP pass', item_description: 'A week of VIP', item_type: 'role', item_emoji: null, price: 500, stock: 10, role_id: roles[4].id }],
            economyStats: { totalUsers: 40, totalCurrency: 12000, avgBalance: 300 },
            topUsers: [{ user_id: '800000000000000001', username: 'pixelpal', wallet: 400, bank: 1200 }, { user_id: '800000000000000002', username: 'nightowl', wallet: 90, bank: 0 }],
        }),
        streamers: manage('streamers', {
            pageHelp: help.pageHelp('streamers'),
            consolidatedStreamers: [
                { name: 'pixelpal', platforms: ['twitch', 'youtube'], discord_user_id: '800000000000000001', is_blacklisted: 0,
                    subscriptions: [{ id: 11, subscription_id: 11, platform: 'twitch', edit_on_end: 1 }, { id: 12, subscription_id: 12, platform: 'youtube', edit_on_end: 0 }] },
                { name: 'nightowl', platforms: ['kick'], discord_user_id: null, is_blacklisted: 0, subscriptions: [{ id: 13, subscription_id: 13, platform: 'kick', edit_on_end: 0 }] },
            ],
            teamSubscriptions: [{ id: 5, team_name: 'speedrunners', announcement_channel_id: channels[4].id, live_role_id: roles[2].id, webhook_name: null, webhook_avatar_url: null }],
            twitchScheduleSyncs: [], scheduleTemplates: [], autoTrackConfigs: [], streamEndedSubs: [],
            settings: { default_edit_on_end: 0, default_delete_on_end: 1 },
        }),
        'global-ban': manage('global-ban', {
            pageHelp: help.pageHelp('global-ban'),
            globalBanConfig: { enabled: 1, mode: 'observe', confidence_threshold: 80, log_channel_id: channels[2].id },
            globalBanStats: { activeEntries: 512, pendingReports: 3, enabledGuilds: 40 },
        }),
        // A generated page (dashboard/views/partials/manage/feature-config.ejs): its fields come from
        // the feature-config API, stubbed below from core/feature-config-spec.js.
        qotd: manage('qotd', { pageHelp: help.pageHelp('qotd') }),
        // Voice pickers (kokoro-voices wave): a generated page with a voice field, and Music's DJ voice.
        tts: manage('tts', { pageHelp: help.pageHelp('tts') }),
        music: manage('music', {
            pageHelp: help.pageHelp('music'),
            musicConfig: { enabled: 1, dj_enabled: 1, dj_voice: 'kokoro_am_michael', dj_role_id: roles[1].id, autoplay_enabled: 0, twenty_four_seven: 0, vote_skip_enabled: 1, vote_skip_percentage: 50, max_playlists_per_user: 10, max_songs_per_playlist: 200, enabled_filters: '["bassboost","nightcore"]' },
            availableDJVoices: djVoices,
        }),
        settings: () => ({
            template: 'settings-tailwind',
            locals: { themes: prefs.THEMES, densities: prefs.DENSITIES, layouts: prefs.LAYOUTS, styles: prefs.STYLES, sections: nav.SECTIONS },
        }),
    };

    const render = (name, style, theme) => {
        const { template, locals } = pages[name](style, theme);
        const merged = { ...common(style, theme), ...locals, settings: locals.settings || {}, _locals: {} };
        return engine.renderFile(path.join(VIEWS, `${template}.ejs`), merged);
    };
    // Stubbed API answers for the wave 17 navigation UI (everything else under /api is a 503).
    const grid = [
        { key: 'raid', label: 'Raid detection', page: 'advanced-protection', on: true },
        { key: 'antiNuke', label: 'Anti-nuke', page: 'security', on: false },
        { key: 'spammer', label: 'Discord spammer check', page: 'security', on: true },
        { key: 'verification', label: 'Verification', page: 'verification', on: false },
        { key: 'phishing', label: 'Phishing links', page: 'phishing', on: true },
        { key: 'globalBan', label: 'Global ban network', page: 'global-ban', on: false },
    ];
    const index = settingsIndex.getSettingsIndex({ viewsDir: VIEWS, nav: manageNav, specs: spec.FEATURE_SPECS, generation: 1 });
    const titles = {};
    for (const sec of manageNav) for (const it of sec.items) if (index[it.page]) titles[it.page] = it.title;
    const resolvePolls = new Set();   // pages (by referer) that already had their "pending" answer
    const api = (pathname, req) => {
        if (pathname === '/api/me/servers') return { servers: guilds.map((g) => ({ id: g.id, name: g.name, icon: null })) };
        if (/^\/api\/guilds\/\d+\/insight\/checklist$/.test(pathname)) {
            return { ...checklist.buildChecklist({ grid, basics: { modLog: true, serverLog: false, welcome: true, automod: false } }), hidden: false };
        }
        if (pathname === '/api/settings-index') return { generation: 1, pages: index, titles };
        const fc = pathname.match(/^\/api\/guilds\/\d+\/feature-config\/([a-z-]+)$/);
        if (fc && spec.FEATURE_SPECS[fc[1]] && (!req || req.method === 'GET')) {
            // The generated page's GET: the spec, every field at its default, one list row.
            const s = spec.FEATURE_SPECS[fc[1]];
            const config = Object.fromEntries(s.fields.map((f) => [f.key, f.default ?? (f.type === 'toggle' ? 1 : f.type === 'voice' ? 'kokoro_bf_emma' : null)]));
            const rows = s.list ? [Object.fromEntries(s.list.columns.map((c, i) => [c, c.endsWith('_id') ? channels[0].id : (c === 'enabled' || c === 'active' ? 1 : `value ${i}`)]))] : undefined;
            return {
                success: true, config, rows,
                spec: { key: fc[1], label: s.label, icon: s.icon, iconPack: s.iconPack || 'fas', colour: s.colour, blurb: s.blurb, commands: s.commands || [], category: s.category || null, note: s.note || null, unwired: s.unwired || null,
                    fields: s.fields.map((f) => ({ ...f, wired: f.wired !== false })), hasList: !!s.list, listTitle: s.list?.title || null, listLabels: s.list?.labels || null,
                    voices: s.fields.some((f) => f.type === 'voice') ? voiceGroups : undefined },
            };
        }
        if (/^\/api\/guilds\/\d+\/users\/resolve$/.test(pathname)) {
            // A page's first answer is "still looking up" so cf-user.js's re-poll is exercised too.
            const page = String(req?.headers?.referer || '');
            const first = !resolvePolls.has(page);
            resolvePolls.add(page);
            const gone = { id: '800000000000000003', username: 'gone_user', displayName: 'Gone User', avatar: null, inServer: false, left: true };
            const nobody = { id: '800000000000000004', username: null, displayName: null, avatar: null, inServer: false };
            return first
                ? { users: { [nobody.id]: nobody }, pending: [gone.id], retryAfterMs: 300 }
                : { users: { [gone.id]: gone, [nobody.id]: nobody } };
        }
        return null;
    };
    return { pages: Object.keys(pages), render, api };
}

// ── local server ────────────────────────────────────────────────────────────

const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gif': 'image/gif' };
const SOCKET_STUB = 'window.io=function(){var s={on:function(){return s},off:function(){return s},once:function(){return s},emit:function(){return s},connect:function(){return s},disconnect:function(){return s},connected:false};return s};';

function startServer(renderPage, api = () => null) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        try {
            const m = url.pathname.match(/^\/__vc\/([a-z-]+)$/);
            if (m) {
                let html = renderPage(m[1], url.searchParams.get('style'), url.searchParams.get('theme'));
                const breakage = BREAKAGES[url.searchParams.get('break')];
                if (breakage) html = html.replace(/<\/body>/i, `${breakage}</body>`);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(html);
            }
            if (url.pathname === '/socket.io/socket.io.js') {
                res.writeHead(200, { 'content-type': 'text/javascript' });
                return res.end(SOCKET_STUB);
            }
            const stub = api(url.pathname, req);
            if (stub) {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify(stub));
            }
            const file = path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname));
            if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
                return fs.createReadStream(file).pipe(res);
            }
            // Anything the page fetches (API calls, saves): what a server answers while reconnecting.
            res.writeHead(url.pathname.startsWith('/api/') || req.headers.accept?.includes('json') ? 503 : 404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'visual-check stub server', reconnecting: true }));
        } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            return res.end(`render failed: ${error.message}`);
        }
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── in-page checks ──────────────────────────────────────────────────────────

/* eslint-disable no-undef */
function inspect({ width, isOverview, wantGrid, kit, kitExtra }) {
    const problems = [];
    const cs = (el) => getComputedStyle(el);
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = cs(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
    };
    const clear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
    const name = (el) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return cls ? `${s}.${cls}` : s;
    };

    // Page background: html or body must paint something.
    const root = cs(document.documentElement);
    const body = cs(document.body);
    if (clear(root.backgroundColor) && root.backgroundImage === 'none' && clear(body.backgroundColor) && body.backgroundImage === 'none') {
        problems.push('page background is transparent (unresolved background token?)');
    }
    if (clear(body.color)) problems.push('body text colour is transparent');

    // <main>: present, visible and with real content.
    const main = document.querySelector('main') || document.getElementById('main-content');
    if (!main) problems.push('no <main> element');
    else if ((main.innerText || '').replace(/\s+/g, ' ').trim().length < 20) problems.push('<main> is empty');

    // Unresolved custom properties on key elements: every same-origin rule that uses var(--x)
    // without a fallback, applied to visible key elements where --x has no value.
    const KEY = 'main, header, nav, aside, footer, .module-card, .modules-section, .cf-card, .card, .settings-card, .server-card, .cf-sidenav, .navbar, .cf-topbar, .cf-page-header, h1, h2, button, .btn';
    const keyEls = new Set([...document.querySelectorAll(KEY)].filter(visible).slice(0, 400));
    const unresolved = new Map();
    const varRe = /var\(\s*(--[\w-]+)\s*\)/g;
    const walk = (rules) => {
        for (const rule of rules) {
            if (rule.cssRules && !rule.selectorText) {
                if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
                walk(rule.cssRules);
                continue;
            }
            if (!rule.selectorText || !rule.style) continue;
            const used = [];
            for (let i = 0; i < rule.style.length; i++) {
                const prop = rule.style[i];
                const val = rule.style.getPropertyValue(prop);
                if (!val.includes('var(')) continue;
                for (const m of val.matchAll(varRe)) used.push([prop, m[1]]);
            }
            if (!used.length) continue;
            let els;
            try { els = document.querySelectorAll(rule.selectorText); } catch { continue; }
            for (const el of els) {
                if (!keyEls.has(el)) continue;
                const s = cs(el);
                for (const [prop, v] of used) {
                    if (s.getPropertyValue(v).trim() === '') {
                        const k = `${name(el)} { ${prop}: var(${v}) }`;
                        if (!unresolved.has(k)) unresolved.set(k, rule.selectorText);
                    }
                }
            }
        }
    };
    for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }   // cross-origin (CDN) sheets
        if (rules) walk(rules);
    }
    for (const k of [...unresolved.keys()].slice(0, 8)) problems.push(`unresolved custom property: ${k}`);

    // Surfaces: module cards must paint a background (or border) — an unresolved surface token
    // makes them transparent.
    const cards = [...document.querySelectorAll('.module-card')].filter(visible);
    const bare = cards.filter((el) => {
        const s = cs(el);
        return clear(s.backgroundColor) && s.backgroundImage === 'none' && (parseFloat(s.borderTopWidth) === 0 || clear(s.borderTopColor));
    });
    if (bare.length) problems.push(`${bare.length} of ${cards.length} .module-card have no background or border`);

    // Overview grid: in the cards style + grid layout at desktop width, the first section's cards
    // sit side by side.
    if (isOverview && wantGrid) {
        const grid = document.querySelector('.modules-section .module-grid, .module-grid');
        const items = grid ? [...grid.children].filter(visible) : [];
        const tops = new Set(items.slice(0, 6).map((el) => Math.round(el.getBoundingClientRect().top)));
        const cols = grid ? cs(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
        if (!grid) problems.push('overview: no .module-grid');
        else if (cs(grid).display !== 'grid' || cols < 2 || (items.length >= 2 && tops.size === items.slice(0, 6).length)) {
            problems.push(`overview: card grid is not multi-column (display ${cs(grid).display}, ${cols} column(s))`);
        }
    }

    // Settings-row kit pages: the help block sits under the page title, the page is built from kit
    // rows, and on a phone no kit row is wider than the screen (even inside a clipped container).
    if (kit) {
        const helpEl = document.getElementById('cfHelp');
        const head = document.querySelector('.page-content .page-section-header');
        if (!helpEl || !visible(helpEl)) problems.push('kit: no "What this does" block');
        else if (head && !(head.compareDocumentPosition(helpEl) & Node.DOCUMENT_POSITION_FOLLOWING)) problems.push('kit: the help block is above the page title');
        else if (head && helpEl.previousElementSibling !== head) problems.push('kit: the help block is not directly under the page title');
        const rows = [...document.querySelectorAll('.page-content .cf-rows .cf-row')].filter(visible);
        if (rows.length < 2) problems.push(`kit: ${rows.length} settings row(s) on the page`);
        if (width <= 400) {
            const vw = document.documentElement.clientWidth;
            const wide = [...document.querySelectorAll('.cf-help, .cf-section, .cf-rows, .cf-row, .cf-row-control > *, .cf-section-foot')]
                .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1).slice(0, 3).map(name);
            if (wide.length) problems.push(`kit: wider than the screen at ${vw}px: ${wide.join(', ')}`);
        }
    }

    // Wave 22 pages rebuilt on the kit: help block, at least one kit panel, nothing wider than a phone.
    if (kitExtra) {
        const helpEl = document.getElementById('cfHelp');
        if (!helpEl || !visible(helpEl)) problems.push('kit: no "What this does" block');
        const panels = [...document.querySelectorAll('.page-content .cf-rows')].filter(visible);
        if (!panels.length) problems.push('kit: no kit panels (.cf-rows) on the page');
        if (width <= 400) {
            const vw = document.documentElement.clientWidth;
            const wide = [...document.querySelectorAll('.cf-help, .cf-section, .cf-rows, .cf-row, .cf-row-control > *, .cf-section-foot, .cf-list-item, .cf-tabs, .cf-notice')]
                .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1).slice(0, 3).map(name);
            if (wide.length) problems.push(`kit: wider than the screen at ${vw}px: ${wide.join(', ')}`);
        }
    }

    // An empty inline status line (.cf-status-line, "Saved" before anything was saved) draws nothing.
    // (It may take room in a wrapping footer; it must not paint a box, a fill or a dot.)
    const paints = (el) => {
        const s = cs(el);
        const before = getComputedStyle(el, '::before');
        const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s[`border${side}Width`]) > 0 && !clear(s[`border${side}Color`]));
        const dot = before.content && before.content !== 'none' && before.display !== 'none' && (parseFloat(before.width) > 0 || parseFloat(before.borderTopWidth) > 0);
        return border || !clear(s.backgroundColor) || s.backgroundImage !== 'none' || dot;
    };
    const ghosts = [...document.querySelectorAll('.cf-status-line')]
        .filter((el) => !(el.textContent || '').trim() && visible(el) && paints(el));
    if (ghosts.length) problems.push(`empty status line drawn (${ghosts.length}): ${ghosts.slice(0, 3).map(name).join(', ')}`);

    // Stacked tables on a phone: each cell sits flush with its row's padding and has none of its
    // own (the desktop first/last-column padding must not leak through).
    if (width <= 400) {
        const indented = [];
        for (const td of document.querySelectorAll('.cf-rows table.cf-table--stack td')) {
            if (!visible(td)) continue;
            const tr = td.closest('tr');
            const rowLeft = tr.getBoundingClientRect().left + parseFloat(cs(tr).paddingLeft);
            const pad = parseFloat(cs(td).paddingLeft) + parseFloat(cs(td).paddingRight);
            if (Math.abs(td.getBoundingClientRect().left - rowLeft) > 1 || pad > 0.5) indented.push(name(td));
        }
        if (indented.length) problems.push(`stacked table: ${indented.length} cell(s) indented or padded at 390 px (${[...new Set(indented)].slice(0, 3).join(', ')})`);
    }

    // Horizontal overflow on a phone.
    if (width <= 400) {

        const vw = document.documentElement.clientWidth;
        const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        if (sw > vw + 1) {
            const wide = [...document.querySelectorAll('body *')]
                .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1)
                .filter((el) => cs(el).position !== 'fixed')
                .slice(0, 400)
                .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
                .slice(0, 3)
                .map((el) => `${name(el)} (right ${Math.round(el.getBoundingClientRect().right)})`);
            problems.push(`horizontal overflow at ${vw}px: page is ${sw}px wide; widest: ${wide.join(', ')}`);
        }
    }
    // Low contrast (a warning, not a failure): navigation, headings, buttons and the wave 17
    // navigation text whose colour is hard to read on what is actually behind it. Colours are
    // composited: a translucent background is laid over whatever is under it (down to the page),
    // and translucent text over that, so rgba() washes and color-mix() results judge correctly.
    const parse = (c) => {
        const str = String(c || '').trim();
        let m = str.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+%?))?\)$/);
        if (m) {
            const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]));
            return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, a];
        }
        m = str.match(/^rgba?\(([^)]+)\)$/);
        if (!m) return null;
        const v = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : Number(x)));
        return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
    };
    const over = (top, under) => {
        const a = top[3];
        return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
    };
    const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // The solid colour behind an element, or null when an image or gradient is in the way.
    const behind = (el) => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) {
            const st = cs(n);
            if (st.backgroundImage !== 'none' && !/^url\(/.test(st.backgroundImage)) return null;
            const c = parse(st.backgroundColor);
            if (c && c[3] > 0) {
                layers.push(c);
                if (c[3] >= 0.999) break;
            }
        }
        let base = [255, 255, 255, 1];
        for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
        return base;
    };
    const notes = [];
    const TEXT = 'nav a, header a, h1, h2, button, .btn, .category-tab, .cf-switcher-name, .cf-checklist-label, .cf-related-name, .cf-field-hit-label, .navbar-brand';
    for (const el of [...document.querySelectorAll(TEXT)].filter(visible).slice(0, 120)) {
        if (!(el.innerText || '').trim()) continue;
        const fill = cs(el).webkitTextFillColor;
        if (fill && fill !== cs(el).color) continue;   // gradient / clipped text: colour is not what shows
        const bg = behind(el);
        const fgRaw = parse(cs(el).color);
        if (!bg || !fgRaw || fgRaw[3] === 0) continue;
        const fg = over(fgRaw, bg);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        if (ratio < 2.5) notes.push(`low contrast ${ratio.toFixed(1)}:1 on ${name(el)} "${el.innerText.trim().slice(0, 24)}"`);
    }
    return { problems, notes: notes.slice(0, 3) };
}
/* eslint-enable no-undef */

// ── runner ──────────────────────────────────────────────────────────────────

async function main() {
    const started = Date.now();
    // Hard stop: a deploy gate must never hang (a wedged Chrome can ignore everything else).
    setTimeout(() => {
        console.error(`visual-check: gave up after ${MAX_SECONDS}s (Chrome stopped responding); not a page failure, re-run it`);
        process.exit(2);
    }, MAX_SECONDS * 1000).unref();
    let puppeteer;
    try {
        puppeteer = (await import('puppeteer')).default;
    } catch (error) {
        console.error(`visual-check: puppeteer is not installed (${error.message})`);
        process.exit(2);
    }
    const { pages: allPages, render, api } = await loadPages();
    const pages = list(opt('pages', allPages.join(',')));

    if (args.includes('--serve')) {
        // Debugging: serve the stub pages and keep running (open /__vc/<page>?style=&theme=).
        const server = await startServer(render, api);
        console.log(`serving http://127.0.0.1:${server.address().port}/__vc/<${allPages.join('|')}>?style=cards&theme=dark`);
        return;
    }

    // Render every combination up front: a template error is reported once, clearly.
    const htmlCache = new Map();
    for (const p of pages) for (const s of STYLES) for (const t of THEMES) {
        try {
            htmlCache.set(`${p}|${s}|${t}`, render(p, s, t));
        } catch (error) {
            console.error(`visual-check: ${p} (${s}/${t}) failed to render: ${error.message.split('\n').slice(0, 6).join(' | ')}`);
            process.exit(2);
        }
    }
    const server = await startServer((p, s, t) => htmlCache.get(`${p}|${s}|${t}`) ?? render(p, s, t), api);
    const base = `http://127.0.0.1:${server.address().port}`;

    const launch = () => puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
        userDataDir: path.join(os.tmpdir(), 'cf-visual-check-profile'),
    });
    let browser = await launch();
    let relaunches = 0;
    let relaunching = null;
    // Chrome itself can die on a heavily loaded machine; that is not a page failure. Relaunch it
    // (twice at most) and re-run the jobs it took down.
    const ensureBrowser = async () => {
        if (browser.connected) return browser;
        if (!relaunching) {
            if (++relaunches > 2) throw new Error('Chrome keeps exiting');
            relaunching = launch().then((b) => { browser = b; relaunching = null; return b; });
        }
        return relaunching;
    };
    const failures = [];
    const warnings = [];
    let checked = 0;

    const jobs = [];
    if (SELF_TEST) for (const b of Object.keys(BREAKAGES)) jobs.push({ p: 'overview', s: 'cards', t: 'dark', b });
    else {
        for (const p of pages) for (const s of STYLES) for (const t of THEMES) {
            if (KIT_EXTRA.includes(p) && t !== THEMES[0]) continue;   // layout checks; one theme is enough
            jobs.push({ p, s, t });
        }
        for (const p of AUTO_PAGES.filter((x) => pages.includes(x))) for (const s of STYLES) for (const scheme of SCHEMES) jobs.push({ p, s, t: 'auto', scheme });
    }

    // Wave 17 navigation, exercised at desktop width once per page/style. Driven with in-page
    // clicks and input events rather than puppeteer's mouse/keyboard, which wait for animation
    // frames that a background tab (concurrency > 1) never gets.
    async function interact(page, p, s) {
        const out = [];
        const count = (sel) => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length > 0).length).catch(() => 0);
        const waitFor = async (sel, min = 1, ms = 3000) => {
            const until = Date.now() + ms;
            let n = await count(sel);
            while (n < min && Date.now() < until) { await new Promise((r) => setTimeout(r, 100)); n = await count(sel); }
            return n;
        };
        if (p === 'overview') {
            if (!(await waitFor('#cfChecklist .cf-checklist-item'))) out.push('setup checklist: no steps rendered');
            if (!(await count('#cfSwitcherBtn'))) out.push('server switcher: no button');
            else {
                await page.$eval('#cfSwitcherBtn', (b) => b.click());
                const n = await waitFor('#cfSwitcherList .cf-switcher-item', 2);
                if (n < 2) out.push(`server switcher: opened with ${n} server(s) listed`);
                await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
            }
            if (await count('#overviewSearch')) {
                await page.$eval('#overviewSearch', (i) => { i.focus(); i.value = 'mute role'; i.dispatchEvent(new Event('input', { bubbles: true })); });
                if (!(await waitFor('#cfFieldResults .cf-field-hit'))) out.push('overview search: no settings listed for "mute role"');
                await page.$eval('#overviewSearch', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
            } else out.push('overview search: no search box');
        } else if (p !== 'settings' && p !== 'landing' && p !== 'servers') {
            const n = await count('.cf-related-item');
            if (n < 3) out.push(`related pages: ${n} shown (want 3-5)`);
        }
        if (KIT_PAGES.includes(p)) {
            // "Recommended settings" fills the form, lists what it changed and (cards/compact, pages whose
            // forms post) raises the unsaved-changes bar; nothing is saved. Undo puts it back.
            if (!(await count('#cfHelpRec'))) out.push('recommended settings: no button');
            else {
                await page.$eval('#cfHelpRec', (b) => b.click());
                const listed = await waitFor('#cfHelpPreview .cf-help-changes li', 1, 2000);
                const status = await page.$eval('#cfHelpPreview .cf-help-status', (e) => e.textContent).catch(() => '');
                if (!listed || !/filled in/.test(status)) out.push(`recommended settings: nothing filled in (${JSON.stringify(status)})`);
                if (s !== 'classic' && p !== 'verification' && !(await waitFor('.cf-savebar:not([hidden])', 1, 1500))) out.push('recommended settings: the unsaved-changes bar did not appear');
                const undo = await page.$$('#cfHelpPreview .cf-help-buttons .btn');
                if (undo.length >= 2) {
                    await page.evaluate(() => [...document.querySelectorAll('#cfHelpPreview .cf-help-buttons .btn')].find((b) => b.textContent === 'Undo').click());
                    if (s !== 'classic' && p !== 'verification' && (await count('.cf-savebar:not([hidden])'))) out.push('recommended settings: Undo left the unsaved-changes bar up');
                }
            }
        }
        if (p === 'tts' || p === 'music') {
            // Voice pickers grouped by engine, the saved Kokoro voice selected (optgroups have no
            // boxes of their own, so this reads the DOM rather than counting visible elements).
            const sel = p === 'tts' ? '#fc-f-default_voice' : '#f-music-djvoice';
            const want = p === 'tts' ? 'kokoro_bf_emma' : 'kokoro_am_michael';
            const until = Date.now() + 3000;
            let got = null;
            while (Date.now() < until) {
                got = await page.$eval(sel, (s) => ({ groups: [...s.querySelectorAll('optgroup')].map((g) => g.label), value: s.value })).catch(() => null);
                if (got && got.groups.length) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            if (!got) out.push(`voice picker: ${sel} not found`);
            else {
                if (!got.groups.some((g) => /^Kokoro/.test(g)) || !got.groups.some((g) => !/^Kokoro/.test(g))) out.push(`voice picker: not grouped by engine (groups ${JSON.stringify(got.groups)})`);
                if (got.value !== want) out.push(`voice picker: saved voice ${want} not selected (got ${JSON.stringify(got.value)})`);
            }
            if (p === 'tts' && !(await count('#fc-f-default_voice-preview'))) out.push('voice picker: no preview button');
        }
        if (p === 'moderation') {
            // Names, not raw ids, in Recent Infractions (wave 17 item 1).
            const names = await page.$$eval('.mod-user-info .cf-user-name', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
            if (!names.includes('Pixel Pal') || !names.includes('freenitro_drop')) out.push(`recent infractions: member names not shown (got ${JSON.stringify(names.slice(0, 4))})`);
            if (!(await waitFor('.mod-user-info .cf-user-copy'))) out.push('recent infractions: an unresolved id has no copyable cell');
            // Someone who left, named by the resolve endpoint after a "pending" answer, with the "left" tag.
            // (cf-user.js finds the guild in #cfNavData or a /manage/<id> path; the Classic template has
            // no #cfNavData and the stub URL no guild, so it makes no resolve call there.)
            const canResolve = await page.evaluate(() => !!document.getElementById('cfNavData')).catch(() => false);
            if (canResolve && !(await waitFor('.mod-user-info [data-user-id="800000000000000003"] .cf-user-left', 1, 5000))) {
                const got = await page.$$eval('.mod-user-info [data-user-id="800000000000000003"]', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
                out.push(`recent infractions: a member who left was not named with a "left" tag (got ${JSON.stringify(got)})`);
            }
        }
        return out;
    }

    async function runJob(page, { p, s, t, b, scheme }) {
        const label = b ? `${p} (break:${b})` : scheme ? `${p} (os:${scheme})` : p;
        const errors = [];
        const cdnFailed = [];
        const onError = (e) => errors.push(String(e?.message || e).split('\n')[0].slice(0, 200));
        const onFail = (r) => { if (!r.url().startsWith(base)) cdnFailed.push(new URL(r.url()).host); };
        page.on('pageerror', onError);
        page.on('requestfailed', onFail);
        try {
            await page.setViewport({ width: WIDTHS[0], height: 900 });
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme || 'dark' }]);
            await page.goto(`${base}/__vc/${p}?style=${s}&theme=${t}${b ? `&break=${b}` : ''}`, { waitUntil: 'load', timeout: 30000 });
            await new Promise((r) => setTimeout(r, 150));   // deferred scripts and first layout settle
            if (scheme) {
                const got = await page.evaluate(() => [document.documentElement.getAttribute('data-theme'), document.documentElement.getAttribute('data-theme-mode')]);
                if (got[0] !== scheme || got[1] !== 'auto') failures.push(`${label} [${s}/auto] Auto theme resolved to data-theme="${got[0]}" (mode ${got[1]}) under an OS ${scheme} scheme`);
            }
            if (!scheme && (!b || b === 'nav17') && t === THEMES[0]) {
                for (const pr of await interact(page, p, s)) failures.push(`${label} [${s}/${t} @${WIDTHS[0]}] ${pr}`);
            }
            for (const width of WIDTHS) {
                if (width !== WIDTHS[0]) {
                    // Plain narrow viewport (no mobile emulation, which zooms out to fit wide content
                    // and so hides the very overflow being checked for).
                    await page.setViewport({ width, height: 844 });
                    await new Promise((r) => setTimeout(r, 100));
                }
                const { problems, notes } = await page.evaluate(inspect, { width, isOverview: p === 'overview', wantGrid: s === 'cards' && width >= 1200, kit: KIT_PAGES.includes(p), kitExtra: KIT_EXTRA.includes(p) });
                checked++;
                const where = `${label} [${s}/${t} @${width}]`;
                // A CDN stylesheet that did not load (network) can blank surfaces: warn, don't fail.
                const soft = cdnFailed.length > 0;
                for (const pr of problems) (soft && /background|surface|module-card/.test(pr) ? warnings : failures).push(`${where} ${pr}`);
                if (width === WIDTHS[0]) for (const n of notes) warnings.push(`${where} ${n}`);
                if (SHOTS) {
                    fs.mkdirSync(SHOTS, { recursive: true });
                    const shot = path.join(SHOTS, `${label}-${s}-${t}-${width}.png`.replace(/[^\w.-]+/g, '_'));
                    await withTimeout(page.screenshot({ path: shot, fullPage: false }), 15000, 'screenshot')
                        .catch((error) => warnings.push(`${label} [${s}/${t} @${width}] ${error.message}`));
                }
            }
            for (const e of new Set(errors)) failures.push(`${label} [${s}/${t}] JS error: ${e}`);
            if (cdnFailed.length) warnings.push(`${label} [${s}/${t}] CDN request(s) failed: ${[...new Set(cdnFailed)].join(', ')}`);
        } catch (error) {
            if (!browser.connected) throw new Error('browser disconnected');
            failures.push(`${label} [${s}/${t}] could not be checked: ${error.message.split('\n')[0]}`);
        } finally {
            page.off('pageerror', onError);
            page.off('requestfailed', onFail);
        }
    }

    const openPage = async () => {
        const page = await (await ensureBrowser()).newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) return req.continue();
            let host = '';
            try { host = new URL(url).host; } catch { /* odd scheme */ }
            // Remote images (avatars, server icons) get a 1x1 PNG: aborting them would set off the
            // pages' onerror fallbacks, which point at another remote image, forever.
            if (req.resourceType() === 'image') return req.respond({ status: 200, contentType: 'image/png', body: PIXEL });
            if (ALLOWED_HOSTS.includes(host)) return req.continue();
            return req.abort('blockedbyclient');   // analytics, embeds: not needed to judge layout
        });
        return page;
    };
    const JOB_TIMEOUT_MS = 45000;
    const worker = async () => {
        let page = await openPage();
        for (let job = jobs.shift(); job; job = jobs.shift()) {
            // A fresh tab per page: no carried-over state, and a crashed or wedged tab (a page
            // script stuck in a loop) costs one job, not the run.
            let timer;
            const outcome = await Promise.race([
                runJob(page, job).then(() => 'done'),
                new Promise((r) => { timer = setTimeout(() => r('timeout'), JOB_TIMEOUT_MS); }),
            ]).catch((error) => `error: ${error.message}`);
            clearTimeout(timer);
            if (outcome !== 'done' && !browser.connected && !job.retried) {
                job.retried = true;
                jobs.push(job);
                warnings.push(`${job.p} [${job.s}/${job.t}] Chrome exited during the check; re-ran it`);
            } else if (outcome !== 'done') failures.push(`${job.p} [${job.s}/${job.t}] could not be checked: ${outcome === 'timeout' ? `no result in ${JOB_TIMEOUT_MS / 1000}s` : outcome}`);
            await withTimeout(page.close(), 10000, 'closing a tab').catch(() => {});
            page = await withTimeout(openPage(), 30000, 'opening a tab');
        }
        await withTimeout(page.close(), 10000, 'closing a tab').catch(() => {});
    };
    try {
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
        await browser.close().catch(() => {});
        server.close();
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (SELF_TEST) {
        let missed = 0;
        for (const b of Object.keys(BREAKAGES)) {
            const caught = failures.filter((f) => f.includes(`(break:${b})`));
            if (!caught.length) missed++;
            console.log(`${caught.length ? 'caught' : 'MISSED'} ${b}: ${caught[0] || 'no failure reported'}`);
        }
        console.log(`visual-check self-test: ${Object.keys(BREAKAGES).length - missed}/${Object.keys(BREAKAGES).length} deliberate breakages detected, ${secs}s`);
        process.exit(missed ? 1 : 0);
    }
    if (JSON_OUT) console.log(JSON.stringify({ checked, failures, warnings, seconds: Number(secs) }, null, 1));
    else {
        for (const w of warnings) console.log(`WARN ${w}`);
        for (const f of failures) console.log(`FAIL ${f}`);
        const autoJobs = AUTO_PAGES.filter((x) => pages.includes(x)).length * STYLES.length * SCHEMES.length;
        const extra = KIT_EXTRA.filter((x) => pages.includes(x)).length;
        console.log(`visual-check: ${checked} page views (${pages.length - extra} pages x ${STYLES.length} styles x ${THEMES.length} themes, ${extra} kit pages x ${STYLES.length} styles x 1 theme, x ${WIDTHS.length} widths, plus ${autoJobs} Auto-theme loads x ${WIDTHS.length} widths), ${failures.length} failure(s), ${warnings.length} warning(s), ${secs}s`);
    }
    process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
    console.error(`visual-check: ${error.stack || error.message}`);
    process.exit(2);
});
