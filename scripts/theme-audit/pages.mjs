/*
 * The pages the theme audit renders (scripts/theme-audit/run.mjs, tests/theme-render.test.js).
 *
 * Every page is a REAL dashboard template rendered through the dashboard's own view engine with the
 * invented "Maple Hollow" demo data from scripts/site-shots/demo-data.mjs. Nothing reads the database
 * or calls Discord. A template that needs a local the stubs below do not give gets it filled in as an
 * empty list (fillMissing), so a page renders its empty state rather than failing the run.
 *
 *   buildPages({ root }) -> { pages: [{ id, group, html(theme) }], api(pathname), greenhouse }
 *
 * `theme` is what the preferences middleware would put in res.locals.uiTheme ('dark' | 'light' |
 * 'sand' | 'auto'). Groups: public, docs, manage, sub (sub-sites and account pages), error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildPages({ root }) {
    const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
    const views = path.join(root, 'dashboard/views');
    const publicDir = path.join(root, 'dashboard/public');
    const [{ createViewEngine }, nav, spec, prefs, help, guides, demo, kitA] = await Promise.all([
        imp('dashboard/services/view-engine.js'),
        imp('core/manage-nav.js'),
        imp('core/feature-config-spec.js'),
        imp('core/user-preferences.js'),
        imp('core/page-help.js'),
        imp('dashboard/content/guides/index.js'),
        imp('scripts/site-shots/demo-data.mjs'),
        imp('tests/fixtures/kit-rollout-a-stubs.js'),
    ]);
    const engine = createViewEngine({ viewsDir: views, publicDir, cache: true });
    const { guild, user, roles, role, channels, channel, voiceChannels, categories, member: M, D } = demo;
    const manageNav = nav.buildManageNav(spec.FEATURE_SPECS);
    const siteGuides = Object.freeze({ GUIDES: guides.GUIDES, AREAS: guides.AREAS, getGuide: guides.getGuide, guideImage: guides.guideImage, inline: guides.inline });

    const common = (theme, signedIn) => ({
        user: signedIn ? user : null,
        uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable', uiLayout: 'grid',
        userPrefs: signedIn ? { pinnedPages: [], recentPages: ['leveling', 'streamers'], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' } : undefined,
        csrfToken: 'theme-audit', clientId: demo.BOT_ID, siteGuides,
    });

    /** Render, filling any local the template reads but was not given with an empty list. */
    const filled = new Map();   // template -> names learned on earlier renders
    function fillMissing(template, locals) {
        const file = path.join(views, `${template}.ejs`);
        const learned = filled.get(template) || new Set();
        for (let tries = 0; tries < 80; tries++) {
            const data = { ...locals };
            for (const k of learned) if (!(k in data)) data[k] = [];
            try {
                return engine.renderFile(file, { ...data, settings: data.settings || {}, _locals: {} });
            } catch (error) {
                const m = String(error.message).match(/\b([A-Za-z_$][\w$]*) is not defined/);
                if (!m || learned.has(m[1])) throw error;
                learned.add(m[1]);
                filled.set(template, learned);
            }
        }
        throw new Error(`${template}: too many missing locals`);
    }

    const pages = [];
    const add = (id, group, template, locals, { signedIn = true } = {}) => pages.push({
        id, group, template,
        html: (theme) => fillMissing(template, { ...common(theme, signedIn), ...(typeof locals === 'function' ? locals() : locals) }),
    });

    // ── manage pages: every page in core/manage-nav.js through manage-tailwind.ejs ──
    const stubA = kitA.stubs();
    const consolidatedStreamers = [
        { name: 'rowanpike_plays', platforms: ['twitch'], discord_user_id: M.rowan.id, is_blacklisted: 0, is_live: 1,
            subscriptions: [{ id: 11, subscription_id: 11, platform: 'twitch', edit_on_end: 1, announcement_channel_id: channel['stream-alerts'].id, live_role_id: role.live.id }] },
        { name: 'bramblebyte_live', platforms: ['kick', 'twitch'], discord_user_id: M.bramble.id, is_blacklisted: 0, is_live: 0,
            subscriptions: [{ id: 13, subscription_id: 13, platform: 'kick', edit_on_end: 0 }, { id: 14, subscription_id: 14, platform: 'twitch', edit_on_end: 0 }] },
    ];
    const manageBase = {
        classicCss: false, siteStyles: prefs.STYLES.map((s) => ({ value: s.value, label: s.label })),
        guild, manageNav, settingsIndexVersion: 1, featureConfigKeys: spec.FEATURE_KEYS, featureConfigSpecs: spec.FEATURE_SPECS,
        roles, channels, voiceChannels, categories, guildMembers: [], consolidatedStreamers, teamSubscriptions: [], channelsData: {},
        totalSubscriptions: 3, prefixConfig: { prefix: '!' }, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
        moderationConfig: {}, recentInfractions: [], escalationRules: [], channelSettingsMap: new Map(), auditLogs: [],
        logConfig: { enabled_logs: '[]', log_categories: '{}', action_color_rows: {} },
        twitchScheduleSyncs: [], scheduleTemplates: [], autoTrackConfigs: [], streamEndedSubs: [], suggestionTags: [], suggestionStats: {},
        welcomeSettings: {}, reactionRolePanels: [], panels: [], starboardConfig: {}, starboardBoards: [], starboardNew: {}, starboardEmojis: [],
        roleRewards: [], giveaways: [], polls: [], suggestions: [], suggestionConfig: {}, customEmbeds: [], purgeConfigs: [], purgeRules: [],
        tiktokSubs: [], tiktokConfig: {}, recentTiktokVideos: [], prefixAliases: [], channelSettings: [], throneNotifications: [],
        checklistHidden: false, serverAccentCss: '',
    };
    const seen = new Set();
    for (const sec of manageNav) {
        for (const it of sec.items) {
            if (seen.has(it.page)) continue;
            seen.add(it.page);
            add(`manage-${it.page}`, 'manage', 'manage-tailwind', () => ({
                ...manageBase, ...(stubA[it.page] || {}), guild, page: it.page,
                relatedPages: nav.relatedPages(it.page, manageNav), pageHelp: help.pageHelp(it.page),
            }));
        }
    }
    add('manage-overview', 'manage', 'manage-tailwind', () => ({ ...manageBase, page: 'overview', relatedPages: [], pageHelp: null }));
    add('manage-classic-overview', 'manage', 'manage-classic', () => ({ ...manageBase, classicCss: true, uiStyle: 'classic', page: 'overview', relatedPages: [], pageHelp: null }));
    add('manage-classic-leveling', 'manage', 'manage-classic', () => ({ ...manageBase, classicCss: true, uiStyle: 'classic', page: 'leveling', relatedPages: [], pageHelp: help.pageHelp('leveling') }));

    // ── public pages (signed out: what most visitors see) ──
    const pub = { signedIn: false };
    add('home', 'public', 'landing-chooser', { discordLoggedIn: false, kickLoggedIn: false, discordHref: '/auth/discord', kickHref: '/tokes-bot/auth/kick', discordServers: 1284, discordUsers: 210345, customBotServers: 12, kickChannels: 40, kickEnrolled: 31, phishingBlocked: 52310, discoveryUrl: null }, pub);
    add('commands', 'public', 'commands-catalog', {
        catalog: { commands: [
            { name: 'rank', description: 'Show your rank card.', category: 'Levels', slash: true, prefix: true, options: [], examples: [] },
            { name: 'ban', description: 'Ban a member.', category: 'Moderation', slash: true, prefix: true, options: [], examples: [] },
        ], prefixes: ['!'], mentionForm: '@CertiFried help', stats: { total: 2, slash: 2, prefix: 2, categories: 2 } },
        categories: ['Levels', 'Moderation'],
    }, pub);
    add('compare', 'public', 'feature-matrix-tailwind', {}, pub);
    add('changelog', 'public', 'changelog-tailwind', {}, pub);
    add('status', 'public', 'status-tailwind', {}, pub);
    add('privacy', 'public', 'privacy-tailwind', {}, pub);
    add('terms', 'public', 'terms-tailwind', {}, pub);
    add('eula', 'public', 'eula-tailwind', {}, pub);
    add('donate', 'public', 'donate-tailwind', {}, pub);
    add('report', 'public', 'report-tailwind', {}, pub);
    add('appeal', 'public', 'appeal-tailwind', {}, pub);
    // CertiFried Studio pages and the legal hub (dashboard/routes/legal-pages.js).
    const legalInv = await imp('dashboard/content/legal/data-inventory.js');
    add('studio', 'public', 'studio-overview', { facts: legalInv.STUDIO_FACTS }, pub);
    add('studio-how-it-works', 'public', 'studio-how-it-works', { facts: legalInv.STUDIO_FACTS }, pub);
    add('studio-privacy', 'public', 'studio-privacy', { facts: legalInv.STUDIO_FACTS }, pub);
    add('studio-faq', 'public', 'studio-faq', { facts: legalInv.STUDIO_FACTS }, pub);
    add('legal', 'public', 'legal-hub', { docs: legalInv.LEGAL_DOCS }, pub);
    add('legal-data', 'public', 'legal-data', { categories: legalInv.CATEGORIES, retention: (r) => legalInv.retentionText(r, null), liveRetention: false }, pub);
    add('studio-download', 'public', 'studio-download', { release: { version: '0.2.4', releaseDate: '2026-11-19T12:00:00.000Z', sums: true, builds: [
        { kind: 'setup', label: 'Installer', file: 'CertiFried-Studio-Setup-0.2.4.exe', size: 90000000, sha256: 'a'.repeat(64) },
        { kind: 'portable', label: 'Portable (no install)', file: 'CertiFried-Studio-Portable-0.2.4.exe', size: 89000000, sha256: 'b'.repeat(64) }] } }, pub);
    add('leaderboard', 'public', 'public-leaderboard', { guild, leaderboard: [], guildName: guild.name }, pub);
    add('community-support', 'public', 'community-support-leaderboard', {}, pub);
    add('stream-team', 'public', 'stream-team-tailwind', {}, pub);
    add('api-overview', 'public', 'api-overview', {}, pub);
    add('discord-native', 'sub', 'discord-native', {
        channels: [], guildId: guild.id, guildName: guild.name, activeTab: 'welcome-screen', isSuperAdmin: false,
        tabs: [{ key: 'welcome-screen', label: 'Welcome Screen', icon: 'fa-hand-sparkles' }, { key: 'onboarding', label: 'Onboarding', icon: 'fa-door-open' }],
    });
    add('cards-landing', 'public', 'cards-landing', {}, pub);
    add('schedule-list', 'public', 'public-schedule-list', { guild }, pub);
    add('tools-jwt', 'public', 'tools-jwt', {}, pub);

    // ── docs and guides ──
    add('docs', 'docs', 'docs-tailwind', {}, pub);
    add('docs-rpg', 'docs', 'docs-rpg', {}, pub);
    add('guides', 'docs', 'docs-guides', { guide: null, guides: guides.GUIDES, areas: guides.AREAS, guideImage: guides.guideImage, inline: guides.inline }, pub);
    for (const slug of ['getting-started', 'go-live-alerts', 'moderation']) {
        add(`guide-${slug}`, 'docs', 'docs-guides', { guide: guides.getGuide(slug), guides: guides.GUIDES, areas: guides.AREAS, guideImage: guides.guideImage, inline: guides.inline }, pub);
    }

    // ── account pages and sub-sites (signed in) ──
    const gs = [guild.name, ...demo.otherGuilds].map((name, i) => ({ id: `10000000000000010${i}`, name, icon: null, memberCount: [1284, 312, 96, 58][i], botCount: 3, liveCount: i === 0 ? 2 : 0, ownerName: 'juniper.vale', botJoinedAt: D(2026, 3 + i, 4), securityFeatures: i === 0 ? ['Raid protection'] : [], hasAnySecurity: i === 0 }));
    add('servers', 'sub', 'servers-tailwind', { guilds: gs, manageableGuilds: gs, totalMembers: 1750, totalHumanMembers: 1690, totalBots: 60, totalLiveStreams: 2, totalStreamersTracked: 6 });
    add('settings', 'sub', 'settings-tailwind', { themes: prefs.THEMES, densities: prefs.DENSITIES, layouts: prefs.LAYOUTS, styles: prefs.STYLES, sections: prefs.SECTIONS });
    add('profile', 'sub', 'profile-tailwind', {});
    add('my-schedules', 'sub', 'my-schedules', {});
    add('cards-create', 'sub', 'cards-create', {});
    add('cards-my-cards', 'sub', 'cards-my-cards', { cards: [] });
    add('vault', 'sub', 'vault', {});
    add('stream', 'sub', 'stream', { ingestUrl: 'rtmp://stream.example.invalid:1935/live/demo-key', streamKey: 'demo-key', destinations: [], platforms: [], isGuest: false, connections: [], connectable: [], notice: { ok: null, error: null, platform: null } });
    add('twitch-analytics', 'sub', 'twitch-analytics', { guildId: guild.id, guildName: guild.name, range: '30d', ranges: {}, broadcaster: null, data: null, isSuperAdmin: false, shareMode: false });
    add('twitch-known-bots', 'sub', 'twitch-known-bots', { list: { accounts: [], summary: { total: 0, listed: 0, newest: null }, generatedAt: new Date('2026-11-18T12:00:00Z') }, tz: 'UTC', guildId: guild.id, bid: '1', days: 90, login: 'rowanpike_plays', batchDays: 7, onlyNew: false, base: '/manage/x/twitch-analytics/integrity/known-bots', isSuperAdmin: false });
    const fmtN = (n) => (!n ? '0' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
    add('tiktok-analytics', 'sub', 'tiktok-analytics', { username: 'sorrelquinnart', avatar: null, videos: [], schedule: [], stats: { totalViews: 12400, totalLikes: 980, totalComments: 41, totalShares: 12, videoCount: 6 }, formatNumber: fmtN, formatDate: () => 'Nov 18, 2026' });
    add('bot-management', 'sub', 'bot-management-tailwind', {});
    add('cah-lobby', 'sub', 'cah-lobby', { lobbies: [], decks: [] });
    add('cah-packs', 'sub', 'cah-packs', {});
    add('cah-leaderboard', 'sub', 'cah-leaderboard', {});
    add('kick-panel', 'sub', 'kick/panel', {});
    add('kick-features', 'sub', 'kick/features', {});
    add('kick-managers', 'sub', 'kick/managers', {});
    add('windrose', 'sub', 'windrose', {});
    // More sub-site and account pages (empty states unless a local is given).
    add('my-schedules-event', 'sub', 'my-schedules-event', {});
    add('cards-edit', 'sub', 'cards-edit', { card: { id: 7, card_name: 'For Juniper', card_type: 'birthday', slug: 'demo-card', share_token: 'demo-share', recipient_name: 'Juniper Vale', board_bg_color: '#f4efe6', board_bg_image_url: '', card_background_url: '', background_music_url: '', wishlist_url: '', is_frozen: 0, password_hash: null, created_at: D(2026, 11, 1) }, entries: [] });
    add('birthday-card', 'sub', 'birthday-card', {});
    add('vault-share', 'sub', 'vault-share', {}, { signedIn: false });
    add('wrmanager', 'sub', 'wrmanager', {});
    add('cah-game', 'sub', 'cah-game', { game: { id: 'MAPLE1', code: 'MAPLE1', state: 'lobby', phase: 'lobby', hostId: user.id, players: [], round: 0, settings: { maxPlayers: 8, pointsToWin: 7, handSize: 10, decks: [] }, blackCard: null, submissions: [] } });
    add('cah-admin', 'sub', 'cah-admin', { active: [], recent: [], deployState: [], deckCount: { n: 4 }, allDeckCount: { n: 9 } });
    add('cah-deck-edit', 'sub', 'cah-deck-edit', { deck: { id: 3, name: 'Maple Hollow in-jokes', description: 'Cards about the server.', is_public: 0, nsfw: 0, share_code: 'demo', blackCards: [{ id: 1, text: 'The grove keepers banned ____.', pick: 1 }], whiteCards: [{ id: 2, text: 'Another greenhouse.' }] } });
    add('cah-my-decks', 'sub', 'cah-my-decks', {});
    add('cah-my-history', 'sub', 'cah-my-history', {});
    add('cah-guild-config', 'sub', 'cah-guild-config', {});
    add('kick-admin', 'sub', 'kick/admin', {});
    add('kick-channel', 'sub', 'kick/channel', {});
    add('kick-channel-commands', 'sub', 'kick/channel-commands', {});
    add('kick-message', 'sub', 'kick/message', {});
    add('bot-assignment', 'sub', 'bot-assignment', {});
    add('audit-bot', 'sub', 'audit-bot', { guild: { id: guild.id, name: guild.name, icon: null, memberCount: 1284 }, bot: { label: 'Audit', tag: 'Audit#0001', avatar: null }, status: {}, channels, roles, watchChannels: [], watchRoles: [], missingRoles: [], spam: null, exempt: [], recent: [], totals: { total: 0, last30: 0, unattributed: 0 }, categoryLabels: {}, categories: ['auto'] });
    add('link-twitch', 'sub', 'link-twitch', {});
    add('buymeacoffee', 'sub', 'buymeacoffee-tailwind', {});
    add('super-admin', 'sub', 'super-admin-tailwind', {});
    add('super-admin-command-usage', 'sub', 'super-admin-command-usage', {});
    add('super-admin-feature-adoption', 'sub', 'super-admin-feature-adoption', {});
    add('super-admin-music-activity', 'sub', 'super-admin-music-activity', {});
    add('super-admin-music-health', 'sub', 'super-admin-music-health', {});
    add('twitch-analytics-compare', 'sub', 'twitch-analytics-compare', {});
    add('twitch-analytics-audit', 'sub', 'twitch-analytics-audit', {});
    add('twitch-analytics-mod-queue', 'sub', 'twitch-analytics-mod-queue', {});
    add('twitch-analytics-ai-usage', 'sub', 'twitch-analytics-ai-usage', {});
    add('public-schedule', 'public', 'public-schedule', { guild }, pub);
    add('reconnecting', 'error', 'reconnecting', { retrySeconds: 5, maxRetries: 10, realError: null }, pub);

    // ── stream bot (/stream/bot): invented Maple Hollow data from scripts/site-shots/stream-bot-demo.mjs ──
    const streamBot = await (await imp('scripts/site-shots/stream-bot-demo.mjs')).streamBotPages(demo, { root });
    for (const [id, p] of Object.entries(streamBot)) add(id, 'sub', p.template, p.locals);
    const importDemo = await imp('scripts/site-shots/stream-bot-import-demo.mjs');
    { const p = await importDemo.importPage(demo, { root }); add(importDemo.IMPORT_PAGE_ID, 'sub', p.template, p.locals); }
    { const p = importDemo.channelCommandsPage(); add(importDemo.CHANNEL_COMMANDS_PAGE_ID, 'sub', p.template, p.locals); }

    // ── pages built as strings and rendered through the shared frame (views/site-frame.ejs) ──
    // The Sprite Tracker (its frame, section bar and the sign-in / account pages live in
    // dashboard/services/sprites-pages.js; the collection pages need a synced Epic account) and the
    // small public pages: scam lookup, status page, holiday countdown, Linked Roles, showcase,
    // transcript viewer, schedule share page.
    const spPages = await imp('dashboard/services/sprites-pages.js');
    const spReq = { baseUrl: '/sprites', path: '/' };
    const spFrame = (page, p = '/') => spPages.framedOptions({ baseUrl: '/sprites', path: p }, page[spPages.FRAMED_PAGE]);
    add('sprites-login', 'sub', 'site-frame', () => spPages.framedOptions(spReq, spPages.renderLogin()[spPages.FRAMED_PAGE]), pub);
    add('sprites-login-error', 'sub', 'site-frame', () => spFrame(spPages.renderLogin({ error: 'Username or password is incorrect.' })), pub);
    add('sprites-account', 'sub', 'site-frame', () => spFrame(spPages.renderAccount({ displayName: 'JuniperVale', currentUsername: 'juniper', hasPassword: true, passwordSetAt: D(2026, 10, 2), success: 'Credentials saved.' }), '/account'), pub);
    const sfScams = await imp('dashboard/routes/public/scams.js');
    const sfStatus = await imp('dashboard/routes/public/status.js');
    const sfCd = await imp('dashboard/routes/public/countdown.js');
    const sfLr = await imp('dashboard/services/linked-role-pages.js');
    const sfSc = await imp('dashboard/routes/showcase.js');
    const sfTt = await imp('core/ticket-transcripts.js');
    const sfSs = await imp('dashboard/services/schedule-share-page.js');
    const cdInfo = { slug: 'christmas', label: 'Christmas', emoji: '', daysRemaining: 36, isToday: false, nextDate: new Date('2026-12-25T00:00:00Z') };
    add('scams', 'public', 'site-frame', () => sfScams.scamsPage(), pub);
    add('status-public-page', 'public', 'site-frame', () => sfStatus.publicStatusPage(), pub);
    add('countdown', 'public', 'site-frame', () => sfCd.countdownPage(cdInfo, { host: 'certifriedmultitool.com', slug: 'christmas' }), pub);
    add('countdown-unknown', 'error', 'site-frame', () => sfCd.unknownHolidayPage('not-a-holiday'), pub);
    add('linked-role', 'sub', 'site-frame', () => sfLr.linkedRolePage({ fieldCount: 4 }));
    add('linked-role-error', 'error', 'site-frame', () => sfLr.linkedRoleErrorPage('This sign-in link was already used or has expired. Start again from your server.'));
    add('showcase-upload', 'sub', 'site-frame', () => sfSc.showcaseUploadPage(), pub);
    add('showcase-player', 'sub', 'site-frame', () => sfSc.showcasePlayerPage({ rawTitle: 'Night drive', src: JSON.stringify('/showcase/0123456789abcdef/playlist.m3u8?t=x') }), pub);
    add('showcase-message', 'error', 'site-frame', () => sfSc.showcaseMessagePage('This upload link has expired', 'Upload links work for a short time only.'), pub);
    add('transcript', 'sub', 'site-frame', () => sfTt.transcriptPage({ title: 'Ticket #128', _meta: { userId: '100000000000000001', msgCount: 3 }, messages: [
        { author_tag: 'juniper.vale', author_type: 'user', timestamp: '2026-11-18T12:00:00Z', content: 'Hi, the welcome message posts twice.' },
        { author_tag: 'rowan', author_type: 'staff', timestamp: '2026-11-18T12:03:00Z', content: 'Checking now.', attachments: ['shot.png'] },
        { author_tag: 'CertiFried', author_type: 'system', timestamp: '2026-11-18T12:10:00Z', content: 'Ticket closed.' }] }, { guildName: guild.name, guildId: guild.id, kind: 'ticket', title: 'Ticket #128' }));
    add('schedule-share', 'public', 'site-frame', () => sfSs.scheduleSharePage('rowanpike_plays'), pub);
    // The OBS builder page for the 4:20 clock (the /420 overlay itself is a fixed-look OBS source).
    add('fourtwenty-obs-builder', 'public', 'fourtwenty-obs-builder', {}, pub);

    // ── error pages ──
    add('error', 'error', 'error-tailwind', { error: 'That page does not exist.' }, pub);
    add('error-signed-in', 'error', 'error-tailwind', { error: 'You do not have permission to manage this server.' });

    // ── Greenhouse: the built website page, served as-is (the route adds the theme) ──
    const ghIndex = path.join(root, 'frontend/greenhouse/dist/web/index.html');
    const greenhouse = fs.existsSync(ghIndex) ? { index: ghIndex, assets: path.join(root, 'frontend/greenhouse/dist/web/assets') } : null;

    return { pages, greenhouse, demo };
}

/** Clean up a temp dir made by a caller. */
export function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
