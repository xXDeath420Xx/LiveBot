/*
 * What each guide screenshot shows (the shot builders are in shots.mjs). Text inside Discord messages
 * follows what the bot really posts; the file each format comes from is named next to it.
 */
import { discordScenes } from './scenes-discord.mjs';
import { guideScenes } from './guide-scenes/index.mjs';

export async function scenes({ manage, page, discord, image, ctx, demo }) {
    await discordScenes({ discord, image, page, ctx, demo });
    await guideScenes({ manage, page, discord, image, ctx, demo });
    const { guild, roles, role, channels, channel, voiceChannels, categories, member: M, streamers: S, D } = demo;
    const u = (k) => M[k].id;

    const consolidatedStreamers = [
        { name: S.rowan.name, platforms: ['twitch'], discord_user_id: u('rowan'), is_blacklisted: 0, is_live: 1,
            subscriptions: [{ id: 11, subscription_id: 11, platform: 'twitch', edit_on_end: 1, announcement_channel_id: channel['stream-alerts'].id, live_role_id: role.live.id }] },
        { name: S.sorrel.name, platforms: ['youtube'], discord_user_id: u('sorrel'), is_blacklisted: 0, is_live: 1,
            subscriptions: [{ id: 12, subscription_id: 12, platform: 'youtube', edit_on_end: 1, announcement_channel_id: channel['stream-alerts'].id, live_role_id: role.live.id }] },
        { name: S.bramble.name, platforms: ['kick', 'twitch'], discord_user_id: u('bramble'), is_blacklisted: 0, is_live: 0,
            subscriptions: [{ id: 13, subscription_id: 13, platform: 'kick', edit_on_end: 0 }, { id: 14, subscription_id: 14, platform: 'twitch', edit_on_end: 0 }] },
        { name: 'hazelmarsh_tv', platforms: ['twitch'], discord_user_id: u('hazel'), is_blacklisted: 0, is_live: 0,
            subscriptions: [{ id: 15, subscription_id: 15, platform: 'twitch', edit_on_end: 1 }] },
    ];

    // ── Getting started ──
    page('getting-started-servers', 'servers-tailwind', () => {
        const gs = [guild.name, ...demo.otherGuilds].map((name, i) => ({
            id: `10000000000000010${i}`, name, icon: null, memberCount: [1284, 312, 96, 58][i], botCount: 3, liveCount: i === 0 ? 2 : 0, ownerName: 'juniper.vale',
            botJoinedAt: D(2026, 3 + i, 4), securityFeatures: i === 0 ? ['Raid protection', 'Scam links'] : [], hasAnySecurity: i === 0,
        }));
        return { guilds: gs, manageableGuilds: gs, totalMembers: 1750, totalHumanMembers: 1690, totalBots: 60, totalLiveStreams: 2, totalStreamersTracked: 6 };
    }, { alt: 'The dashboard server picker: Maple Hollow and three other servers, each card opening that server\'s settings.', guides: ['getting-started'] });

    manage('getting-started-overview', 'overview', { consolidatedStreamers }, {
        alt: 'The Maple Hollow overview on the dashboard: member and stream counts, then the setup checklist with two steps left.', guides: ['getting-started'],
    });

    // ── Stream alerts ──
    manage('go-live-streamers', 'streamers', {
        consolidatedStreamers,
        teamSubscriptions: [], twitchScheduleSyncs: [], scheduleTemplates: [], autoTrackConfigs: [], streamEndedSubs: [],
        settings: { default_edit_on_end: 1, default_delete_on_end: 0 },
    }, { alt: 'The Streamers page: four tracked streamers with their platforms, and the form for adding another.', guides: ['go-live-alerts'] });

    // ── Feeds ──
    manage('feeds-page', 'feeds', {
        guildId: guild.id,
        redditFeeds: [],
        youtubeFeeds: [{ id: 2, youtube_channel_id: 'UCdemoMapleHollow0000001', channel_name: 'Sorrel Quinn Art', channel_id: channel['new-videos'].id }],
        twitterFeeds: [{ id: 3, twitter_username: 'maplehollowhq', channel_id: channel.announcements.id }],
        blueskyFeeds: [{ id: 4, handle: 'maplehollow.bsky.social', channel_id: channel.announcements.id }],
    }, { alt: 'The Social feeds page: the YouTube section with one channel posting to #new-videos, and the X section below it.', guides: ['social-feeds'], scrollTo: '[aria-labelledby="fd-youtube-title"]' });

    // ── Levels ──
    manage('levels-page', 'leveling', {
        settings: { leveling_enabled: 1, leveling_xp_rate: 15, leveling_xp_cooldown: 60, level_up_channel_id: channel['level-ups'].id, leveling_ignored_channels: [channel['bot-commands'].id], leveling_ignored_roles: [], monthly_reset_enabled: 0, reset_interval_days: 30 },
        roleRewards: [{ id: 3, level: 5, role_id: role.seedling.id }, { id: 4, level: 15, role_id: role.sapling.id }, { id: 5, level: 30, role_id: role.old.id }],
    }, { alt: 'The Leveling page: XP settings, the level-up channel and three role rewards at levels 5, 15 and 30.', guides: ['levels'] });

    image('levels-rank-card', () => ctx.rankCard(ctx.root, M.sorrel, ctx.avatars, { rank: 3, level: 18, xp: 1240, xpForNextLevel: 2100, totalXP: 24860, totalVoiceMinutes: 0, voiceXP: 0 }), {
        alt: 'A rank card for sorrelq: rank 3, level 18, 1240 of 2100 XP to the next level with the bar at 59 percent, and 24,860 XP in total.', guides: ['levels'], outWidth: 934,
    });

    // ── Welcome ──
    manage('welcome-page', 'welcome', {
        welcomeSettings: { channel_id: channel.welcome.id, message: 'Welcome to {server}, {user}! Start in <#' + channel.rules.id + '> and grab some roles in <#' + channel.roles.id + '>.', banner_enabled: 1, card_title_text: '{user} just joined the server', card_subtitle_text: 'Member #{memberCount}', card_background_url: '', goodbye_enabled: 1, goodbye_channel_id: channel.welcome.id, goodbye_message: '**{user}** left the server.' },
    }, { alt: 'The Welcome page: the welcome channel, the message with placeholders, and the welcome card settings.', guides: ['welcome'] });

    // ── Reaction roles ──
    manage('reaction-roles-page', 'reaction-roles', {
        reactionRolePanels: [
            { id: 1, panel_name: 'Pick your roles', message_id: '100700000000000001', channel_id: channel.roles.id, description: 'Choose the roles you want. Click again to remove one.', embed_color: '#3f8f6b', image_url: '', thumbnail_url: '', interaction_type: 'buttons', panel_mode: 'normal', max_selections: 0, placeholder_text: '', posted: 1,
                mappings: [{ id: 9, emoji: '🦉', role_id: role.night.id, label: 'Night owls', description: '' }, { id: 10, emoji: '🎨', role_id: role.artists.id, label: 'Artists', description: '' }, { id: 11, emoji: '🎮', role_id: role.gamers.id, label: 'Gamers', description: '' }, { id: 12, emoji: '📣', role_id: role.stream.id, label: 'Stream pings', description: '' }] },
        ],
        get panels() { return this.reactionRolePanels; },
    }, { alt: 'The Reaction roles page with one panel, Pick your roles, giving four roles with buttons.', guides: ['reaction-roles'] });

    // ── Moderation ──
    manage('moderation-page', 'moderation', {
        moderationConfig: { mod_log_channel_id: channel['mod-log'].id, muted_role_id: role.muted.id },
        recentInfractions: [
            { type: 'Warn', reason: 'Spoilers outside #spoilers', created_at: D(2026, 11, 17, 18, 5), user_id: u('fennel'), moderator_id: u('hazel'),
                user: { id: u('fennel'), username: M.fennel.username, displayName: M.fennel.displayName, avatar: null, inServer: true },
                moderator: { id: u('hazel'), username: M.hazel.username, displayName: M.hazel.displayName, avatar: null, inServer: true } },
            { type: 'Ban', reason: 'Scam links', created_at: D(2026, 11, 16, 9, 30), user_id: u('spam'), moderator_id: demo.BOT_ID,
                user: { id: u('spam'), username: M.spam.username, displayName: M.spam.displayName, avatar: null, inServer: false },
                moderator: { id: demo.BOT_ID, username: 'CertiFried', displayName: 'CertiFried', avatar: null, inServer: true } },
            { type: 'Timeout', reason: 'Flooding #general', created_at: D(2026, 11, 14, 21, 0), user_id: u('pip'), moderator_id: u('rowan'),
                user: { id: u('pip'), username: M.pip.username, displayName: M.pip.displayName, avatar: null, inServer: true },
                moderator: { id: u('rowan'), username: M.rowan.username, displayName: M.rowan.displayName, avatar: null, inServer: true } },
        ],
        escalationRules: [{ id: 7, infraction_count: 3, time_period_hours: 24, action: 'timeout', action_duration_minutes: 60 }],
    }, { alt: 'The Moderation page: the mod log channel, an escalation rule and the latest warnings, bans and timeouts.', guides: ['moderation'] });

    manage('automod-page', 'automod', {
        heatConfig: {},
        automodRules: [
            { id: 1, filter_type: 'antiSpam', action: 'mute', action_duration_minutes: 10, config: '{"messageLimit":5,"timePeriod":10}' },
            { id: 2, filter_type: 'bannedWords', action: 'delete', config: { words: ['free nitro', 'steam gift', 'claim your prize'] } },
        ],
    }, { alt: 'The AutoMod page with two rules: an anti-spam rule that times members out and a banned words rule that deletes the message.', guides: ['moderation'] });

    manage('logging-page', 'logging', {
        auditLogs: [], channelSettingsMap: new Map(),
        logConfig: {
            log_channel_id: channel['server-log'].id, enabled_logs: '["messageDelete","messageUpdate","memberJoin","memberLeave","ban"]', log_categories: JSON.stringify({ ban: channel['mod-log'].id }),
            action_color_rows: {
                messageDelete: { actions: [{ key: 'messageDelete', label: 'Deleted', value: '#ef4444', custom: false, fallback: '#ef4444' }] },
                ban: { actions: [{ key: 'ban', label: 'Ban', value: '#991b1b', custom: false, fallback: '#991b1b' }] },
                system: { notPosted: 'Not posted in a log channel' },
            },
        },
    }, { alt: 'The Logging page: the server log channel and which events are logged.', guides: ['moderation'] });

    // ── Raid protection ──
    manage('raid-page', 'advanced-protection', {
        raidConfig: { enabled: 1, join_threshold: 10, join_timeframe_seconds: 10, new_account_age_hours: 72, new_account_ratio: 0.5, action: 'mute', mute_duration_minutes: 60, purge_messages: 1, alert_channel_id: channel['mod-log'].id },
        selfbotConfig: { enabled: 0, action: 'log', alert_channel_id: '', message_burst_threshold: 5, message_burst_window_ms: 2000, min_response_time_ms: 300, pattern_threshold: 3 },
        adaptiveSpamConfig: { enabled: 0, action: 'delete', alert_channel_id: '', cross_channel_threshold: 3, cross_channel_timeframe_minutes: 5, deviation_multiplier: 3, exempt_channels: '[]', new_account_multiplier_hours: 24 },
        inviteFilterConfig: { enabled: 1, action: 'delete', log_channel_id: channel['mod-log'].id, use_whitelist: 0 },
        inviteFilterEntries: { users: [], roles: [], channels: [], invites: [] },
        raidIncidents: [{ id: 1, started_at: D(2026, 11, 2, 3, 14), ended_at: D(2026, 11, 2, 3, 44), join_count: 23, action_taken: 'lockdown' }],
        selfbotDetections: [],
    }, { alt: 'The Raid lockdown panel on the dashboard: no lockdown running, and the form to start one with the action for every join, how long it lasts and whether to pause invites.', guides: ['raid-protection'], scrollTo: '#raid-lockdown' });
    const yes = { kick: true, ban: true, timeout: true, quarantine: true, log: true };
    ctx.stub(/^\/api\/guilds\/\d+\/raid-lockdown\/?$/, () => ({
        actions: [{ value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }, { value: 'timeout', label: 'Timeout' }, { value: 'quarantine', label: 'Quarantine' }, { value: 'log', label: 'Log only' }],
        actor: { canConfigure: true, may: yes }, botPerms: yes, quarantineReady: true, active: null,
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        settings: { lockdownAction: 'kick', lockdownDurationMinutes: 60, lockdownPauseInvites: true, lockdownLockChannels: false, lockdownDm: true, lockdownChannelIds: [channel.general.id],
            alertChannelId: channel['mod-log'].id, autoEnabled: true, autoJoins: 20, autoWindowSeconds: 10, autoDurationMinutes: 60, autoAction: 'kick', autoPauseInvites: true, autoLockChannels: false,
            sameNameEnabled: true, sameNameCount: 5, sameNameWindowSeconds: 300, sameNameAction: 'ban', keepDmsDisabled: false, keepInvitesDisabled: false },
        incidents: { botCanManage: true, checkedAt: new Date().toISOString(), invitesUntil: null, dmsUntil: null, invitesOurs: false, dmsOurs: false, raidDetectedAt: null, dmSpamDetectedAt: null, error: null },
        history: [{ id: 4, status: 'ended', startedAt: D(2026, 11, 2, 3, 14).toISOString(), endsAt: D(2026, 11, 2, 4, 14).toISOString(), endedAt: D(2026, 11, 2, 4, 14).toISOString(), trigger: 'auto', triggerDetail: '22 joins in 10 seconds', actionLabel: 'Kick', counts: { blocked: 19, held: 3, failed: 0 }, users: [], endReason: 'expired', reason: null }],
    }));

    // ── Tickets ──
    manage('tickets-page', 'tickets', {
        data: { ticketStats: null, activeTickets: [] },
        ticketConfig: { panel_channel_id: channel.support.id, support_role_id: role.moderators.id, ticket_category_id: categories[2].id },
        ticketFormsList: [{ form_id: 'f1', form_name: 'Report a member' }],
        ticketPanels: [
            { panel_id: 'p1', panel_name: 'Help desk', panel_channel_id: channel.support.id, panel_message_id: '100800000000000002', ticket_category_id: categories[2].id, support_role_id: role.moderators.id, log_channel_id: channel['mod-log'].id, embed_title: 'Need a hand?', embed_description: 'Open a ticket and a moderator will reply here in private.', embed_color: '#3f8f6b', button_text: 'Open a ticket', button_emoji: '', ticket_name_format: 'ticket-{number}', save_transcripts: 1 },
        ],
    }, { alt: 'The Tickets page with one panel, Help desk, posting in #support and opening tickets in the Support tickets category.', guides: ['support-tickets'] });

    // ── Music ──
    manage('music-page', 'music', {
        musicConfig: { enabled: 1, ai_dj_enabled: 1, dj_voice: 'kokoro_bf_emma', dj_role_id: role.regulars.id, autoplay_enabled: 0, twenty_four_seven: 0, vote_skip_enabled: 1, vote_skip_percentage: 50, max_playlists_per_user: 10, max_songs_per_playlist: 200, default_volume: 50, enabled_filters: '["bassboost","nightcore"]', announce_channel_id: channel['music-requests'].id },
        availableDJVoices: [{ value: 'kokoro_bf_emma', label: 'Emma, female', category: 'Kokoro · British English', engine: 'kokoro' }, { value: 'kokoro_am_michael', label: 'Michael, male', category: 'Kokoro · US English', engine: 'kokoro' }],
    }, { alt: 'The Music page: DJ role, vote skip at 50 percent, playlist limits and the AI DJ voice.', guides: ['music'] });

    // ── Economy ──
    manage('economy-page', 'economy', {
        economyConfig: { currency_name: 'acorns', currency_symbol: '🌰', daily_amount: 100, work_min: 10, work_max: 50, starting_balance: 0, enabled: 1 },
        shopItems: [
            { id: 51, item_name: 'Regulars role', item_description: 'The Regulars role, for good', item_type: 'role', item_emoji: null, price: 2500, stock: null, role_id: role.regulars.id },
            { id: 52, item_name: 'Custom colour', item_description: 'Pick a name colour for a month', item_type: 'item', item_emoji: null, price: 800, stock: 20, role_id: null },
        ],
        economyStats: { totalUsers: 212, totalCurrency: 318400, avgBalance: 1502 },
        topUsers: [{ user_id: u('pip'), username: M.pip.username, wallet: 4200, bank: 12800 }, { user_id: u('wren'), username: M.wren.username, wallet: 900, bank: 9100 }, { user_id: u('thistle'), username: M.thistle.username, wallet: 3100, bank: 4400 }],
    }, { alt: 'The Economy page: the currency is acorns, the daily reward and work pay, and two items in the shop.', guides: ['economy'] });

    // ── Community ──
    manage('starboard-page', 'starboard', {
        starboardConfig: { enabled: 1, channel_id: channel.starboard.id, emoji: '⭐', threshold: 3, self_star: 0, nsfw_allowed: 0 },
    }, { alt: 'The Starboard page: posts to #starboard once a message has 3 star reactions.', guides: ['community'] });
    manage('birthday-page', 'birthday', {
        birthdayUsers: [
            { user_id: u('wren'), username: M.wren.username, month: 11, day: 21, year: null, timezone: 'Europe/London' },
            { user_id: u('pip'), username: M.pip.username, month: 12, day: 2, year: null, timezone: 'America/Chicago' },
            { user_id: u('hazel'), username: M.hazel.username, month: 1, day: 9, year: null, timezone: 'Australia/Sydney' },
        ],
        birthdayStats: { total: 3, thisMonth: 1, today: 0 },
        birthdayConfig: { enabled: 1, announcement_channel_id: channel.birthdays.id, role_id: role.birthday.id, message: 'Happy birthday {user}!', announce_hour: 9 },
        birthdayCards: [],
    }, { alt: 'The Birthdays page: announcements in #birthdays with a Birthday role, and three saved birthdays.', guides: ['community'] });
    manage('suggestions-page', 'suggestions', {
        suggestions: [
            { id: 41, suggestion_id: 41, user_id: u('wren'), content: 'A weekly screenshot contest channel', suggestion: 'A weekly screenshot contest channel', status: 'pending', upvotes: 0, downvotes: 0, created_at: D(2026, 11, 15), tags: [{ id: 2, tag_name: 'Events', tag_color: '#22c55e' }] },
            { id: 40, suggestion_id: 40, user_id: u('pip'), content: 'Move movie night to Fridays', suggestion: 'Move movie night to Fridays', status: 'approved', upvotes: 22, downvotes: 3, created_at: D(2026, 11, 9), tags: [] },
        ],
        suggestionConfig: { enabled: 1, suggestions_channel_id: channel.suggestions.id, require_approval: 1, staff_review_channel_id: channel['mod-log'].id, approved_role_id: role.moderators.id, allow_anonymous: 1 },
        suggestionStats: { total: 2, pending: 1, approved: 1, rejected: 0, implemented: 0 },
        suggestionTags: [{ id: 1, tag_name: 'Channels', tag_color: '#3b82f6', tag_emoji: null }, { id: 2, tag_name: 'Events', tag_color: '#22c55e', tag_emoji: null }],
        suggestionFilters: {},
    }, { alt: 'The Suggestions page: approval required with a staff review channel, one suggestion waiting for approval and one approved with its votes.', guides: ['community'] });

    // ── Greenhouse (dashboard/views/partials/manage/greenhouse.ejs loads /api/guilds/:id/greenhouse) ──
    const DAY = 86400000, now = Date.UTC(2026, 10, 18, 19);
    ctx.stub(/^\/api\/guilds\/\d+\/greenhouse$/, () => ({
        ready: true, botInServer: true, partial: false, gameUrl: '/greenhouse', playersTotal: 6,
        season: { number: 3, endsAtMs: now + 12 * DAY },
        challenge: { week: 2, title: 'Harvest 40 Frostbells', status: 'active', endsAtMs: now + 4 * DAY },
        globalTop: [
            { rank: 1, displayName: 'Mossy Gardener', level: 31, score: 41200 }, { rank: 2, displayName: 'Fernwick', level: 29, score: 38760 },
            { rank: 3, displayName: 'Petal Pusher', level: 27, score: 35110 }, { rank: 4, displayName: 'Glasshouse Gil', level: 26, score: 33020 },
        ],
        players: [
            { communityRank: 1, displayName: M.thistle.displayName, level: 14, prestige: 0, gameName: 'Thistle', lastSeenAtMs: now - DAY, seasonScore: 8940 },
            { communityRank: 2, displayName: M.wren.displayName, level: 11, prestige: 0, gameName: 'Wren', lastSeenAtMs: now - 2 * DAY, seasonScore: 6120 },
            { communityRank: 3, displayName: M.pip.displayName, level: 9, prestige: 1, gameName: 'Pip', lastSeenAtMs: now - DAY, seasonScore: 4410 },
            { communityRank: 4, displayName: M.hazel.displayName, level: 6, prestige: 0, gameName: 'Hazel', lastSeenAtMs: now - 5 * DAY, seasonScore: 1980 },
        ],
    }));
    manage('greenhouse-page', 'greenhouse', {}, { alt: 'The Greenhouse Tycoon page on the dashboard: the current season, this week\'s challenge and the Maple Hollow members who play, ranked by season points.', guides: ['greenhouse'] });

    // ── Schedules (dashboard/views/partials/manage/schedule.ejs loads its events) ──
    const ev = { id: 7, name: 'Maple Hollow Charity Marathon', slug: 'mh-marathon-2026', description: '12 hours of community runs for the local animal shelter.', is_active: 1, created_at: D(2026, 11, 1) };
    ctx.stub(/^\/manage\/\d+\/schedule\/events$/, () => ({ success: true, events: [ev, { id: 6, name: 'Spring Speedrun Jam', slug: 'spring-jam', description: 'Our first marathon.', is_active: 0, created_at: D(2026, 4, 2) }] }));
    ctx.stub(/^\/manage\/\d+\/schedule\/events\/\d+\/schedules$/, () => ({ success: true, schedules: [{ id: 21, name: 'Saturday', slug: 'saturday', start_time: D(2026, 12, 19, 12) }] }));
    manage('schedule-page', 'schedule', {}, { alt: 'The Schedules page on the dashboard with the Maple Hollow Charity Marathon event and an older one.', guides: ['schedules'] });

    const runs = [
        ['Celeste', 'Any%', M.bramble.displayName, 1980, 300, 'completed'], ['Stardew Valley', 'Community Center%', M.rowan.displayName, 5400, 600, 'in_progress'],
        ['Spyro the Dragon', '120%', M.fennel.displayName, 6900, 600, 'pending'], ['Hollow Knight', 'Any% No Major Glitches', `${M.thistle.displayName}, ${M.pip.displayName}`, 4200, 600, 'pending'],
        ['Tetris Effect', 'Journey Mode', M.hazel.displayName, 2700, 300, 'pending'], ['Portal 2', 'Co-op', `${M.wren.displayName}, ${M.sorrel.displayName}`, 3000, 600, 'pending'],
    ];
    let t = D(2026, 12, 19, 12).getTime();
    const items = runs.map(([game_name, category, runners, est, setup, status], i) => {
        const it = { id: 100 + i, position: i + 1, game_name, category, runners, estimate_seconds: est, setup_seconds: setup, status, estimated_start: new Date(t) };
        t += (est + setup) * 1000;
        return it;
    });
    page('schedules-public', 'public-schedule', {
        error: null, twitchUser: null,
        event: { ...ev, twitch_channel: null, twitter: null, website_url: null },
        schedules: [{ id: 21, name: 'Saturday', slug: 'saturday', start_time: D(2026, 12, 19, 12) }],
        currentSchedule: { id: 21, name: 'Saturday', slug: 'saturday', start_time: D(2026, 12, 19, 12) },
        items,
    }, { alt: 'The public schedule page for the Maple Hollow Charity Marathon: a table of runs with the game, runners, estimate and status, and the run that is live now.', guides: ['schedules'], height: 1080 });

    // ── Kick Defender (dashboard/views/kick/panel.ejs) ──
    ctx.stub(/^\/kick\/api\/bot-health$/, () => ({ connected: true, channels: [{ channelId: 'demo1', chatSubscribed: true, lastChatAt: new Date(Date.now() - 4 * 60000).toISOString() }] }));
    page('kick-defender-panel', 'kick/panel', {
        user: { id: 'demo', username: 'maplehollow_kick' },
        channels: [{ channelId: 'demo1', channelName: 'maplehollow_kick', enabled: true, hasBanScope: true, hasManageScope: true, chatSubscribed: true, lastChatAt: new Date(Date.now() - 4 * 60000), missingEvents: [], stats: { banned: 37, deleted: 112, dormant: 0 } }],
        isManager: false, isAdmin: false, reauthHref: '/tokes-bot/auth/kick',
    }, { alt: 'The Kick Defender page for one channel: the defender switch on, chat connected, ban length, scam-link strikes and the warning message.', guides: ['kick-defender'], height: 900 });

    // ── Stream bot (dashboard/views/stream-bot/; locals from stream-bot-demo.mjs, built with the route's own view helpers) ──
    const { streamBotPages } = await import('./stream-bot-demo.mjs');
    const sb = await streamBotPages(demo, { root: ctx.root, editId: 31 });
    page('stream-bot-overview', sb['stream-bot-overview'].template, sb['stream-bot-overview'].locals, {
        alt: 'The Stream bot overview: a Twitch and a Kick channel linked with the Twitch one live, today\'s follows, subs, bits, raids and tips, and the live feed of recent events.',
        guides: ['stream-bot'], height: 1000,
        // The live feed's state line as it reads with the feed connected (the shot server has no feed to connect to).
        prepare: { fn: () => { const s = document.getElementById('sb-feed-state'); if (s) { s.textContent = 'Live'; s.className = 'cf-status-line is-ok'; } } },
    });
    page('stream-bot-editor', sb['stream-bot-automation-edit'].template, sb['stream-bot-automation-edit'].locals, {
        alt: 'The automation editor for Thank followers in chat: the trigger is Follow, a cooldown is counted for each person, and a Send a chat message action thanks the follower by name.',
        guides: ['stream-bot'], height: 1150,
    });
    page('stream-bot-connections', sb['stream-bot-connections'].template, sb['stream-bot-connections'].locals, {
        alt: 'The Connections page: the linked Twitch channel with its Stream bot grant, its event subscriptions and the events it can send, and the linked Kick channel.',
        guides: ['stream-bot'], height: 1000,
    });
    page('stream-bot-editor-flow', sb['stream-bot-automation-edit-flow'].template, sb['stream-bot-automation-edit-flow'].locals, {
        alt: 'The automation editor with an If step that mutes the microphone on the Starting Soon, Be right back and Ending scenes and unmutes it otherwise, then Create a clip, a chat announcement with the clip link, and a title change on Twitch and Kick.',
        guides: ['stream-bot'], height: 1400,
    });
    page('stream-bot-devices', sb['stream-bot-devices'].template, sb['stream-bot-devices'].locals, {
        alt: 'The Devices page: lights CertiFried Studio found (an Elgato Key Light, Philips Hue lamp and room, a Govee strip, a Nanoleaf waiting to be paired and a Logitech Litra), the Govee cloud key with a floor lamp, light presets Live and Be right back, Voicemeeter Banana running with its strips and buses, and the Stream Deck plugin connected.',
        guides: ['stream-bot'], height: 2700,
    });
    page('stream-bot-timers', sb['stream-bot-timers'].template, sb['stream-bot-timers'].locals, {
        alt: 'The Timers page: a Socials timer with two messages taking turns every 20 minutes on Twitch and Kick, only while live and after 10 chat lines, a Stretch break timer that is off, and a timer from the Kick channel page.',
        guides: ['stream-bot'], height: 900,
    });

    // ── Stream bot Viewers (views/stream-bot/viewers.ejs, viewer.ejs, viewers-settings.ejs; locals from stream-bot-viewers-demo.mjs) ──
    const { viewersDemo } = await import('./stream-bot-viewers-demo.mjs');
    const vw = await viewersDemo({ root: ctx.root });
    page('stream-bot-viewers', vw.list.template, vw.list.locals, {
        alt: 'The Viewers tab: 1,223 viewers recorded, watch time counted for everyone in the Twitch chat and for Kick chatters, the last count while live, and the table of viewers sorted by Leaves with their watch time, messages, last seen and rank.',
        guides: ['stream-bot'], height: 1050,
    });
    page('stream-bot-viewer', vw.viewer.template, vw.viewer.locals, {
        alt: 'One viewer\'s page: MapleFan_88 with 18,420 Leaves, 248 hours watched and the rank Old growth, a form to add, remove or set Leaves with a note, their Twitch and linked Kick accounts, their subs, gift subs, Bits and tips, and the history of bonuses, gifts, gambles and rank-ups.',
        guides: ['stream-bot'], height: 1700,
    });
    page('stream-bot-viewers-settings', vw.settings.template, vw.settings.locals, {
        alt: 'Viewer settings: tracking on, the points named Leaves, 10 Leaves every 10 minutes while live, subscribers earn 1.5 times, bonuses for follows, subs, gift subs, Bits and raids, four ranks by hours watched, giving on and gambling off, and the six chat commands with their automations.',
        guides: ['stream-bot'], height: 2300,
    });

    // ── Stream bot overlays (views/stream-bot/overlays.ejs, overlay-edit.ejs, overlay.ejs; locals and frames from stream-bot-overlays-demo.mjs) ──
    // The OBS page runs in demo mode (no server): prepare() hands it the frames the overlay service would send.
    const { overlayDemo } = await import('./stream-bot-overlays-demo.mjs');
    const ov = await overlayDemo({ root: ctx.root });
    // No image, sound or read-aloud file in the shot: the shot server has none of the streamer's files to serve.
    const liveFrames = [...ov.frames('alerts').map(([e, d]) => (e === 'alert' ? [e, { ...d, media: null, sound: null, tts: null }] : [e, d])), ['action', { id: 'd_000000000000000000000000', action: 'overlay.text', params: { text: 'Deaths: 13', position: 'top-right', size: 'medium', durationMs: 60000, animation: 'none' } }]];
    function feedOverlay(frames) {
        const bg = document.createElement('div');
        bg.style.cssText = 'position:fixed;inset:0;z-index:-1;background:linear-gradient(135deg,#4b6b52 0%,#2b3442 45%,#8a7356 100%)';
        document.body.prepend(bg);
        for (const [e, d] of frames) window.__sboFeed(e, d);
    }
    async function feedPreview(frames) {
        const f = document.getElementById('sbo-frame');
        for (let i = 0; i < 50 && !(f.contentWindow && f.contentWindow.__sboFeed); i++) await new Promise((r) => setTimeout(r, 100));
        const w = f.contentWindow;
        const bg = w.document.createElement('div');
        bg.style.cssText = 'position:fixed;inset:0;z-index:-1;background:linear-gradient(135deg,#4b6b52 0%,#2b3442 45%,#8a7356 100%)';
        w.document.body.prepend(bg);
        for (const [e, d] of frames) w.__sboFeed(e, d);
    }
    page('stream-bot-overlays', ov.list.template, ov.list.locals, {
        alt: 'The Overlays tab: an alert box, a chat overlay, a follower goal at 64 of 100, a Deaths counter and a recent events list, each with whether it is open in OBS, the kinds of overlay to add, and the images and videos uploaded for alerts.',
        guides: ['stream-bot'], height: 1150,
    });
    const editShot = ov.edit('alerts', { previewSrc: '/__shot/stream-bot-overlay-live' });
    page('stream-bot-overlay-alerts', editShot.template, editShot.locals, {
        alt: 'An alert box\'s page: its private browser-source address with Copy and New address, a live preview showing a Bits alert, and a Test button for each alert type.',
        guides: ['stream-bot'], height: 1100,
        prepare: { fn: feedPreview, arg: liveFrames },
    });
    const liveShot = ov.page('alerts', { demo: true });
    page('stream-bot-overlay-live', liveShot.template, liveShot.locals, {
        alt: 'The alert box in OBS over a scene: MapleFan_88 threw 1,000 Bits, with an image and the viewer\'s message under it, and a Deaths: 13 text in the top right corner from an automation.',
        guides: ['stream-bot'], width: 1920, height: 1080, outWidth: 1200,
        prepare: { fn: feedOverlay, arg: liveFrames },
    });

    await activityScenes({ manage, page, ctx, demo });
}

/**
 * Discord Activities (docs/activities.md): the Activity page (views/activity.ejs) with its real built script and styles
 * (frontend/activities/dist, copied in as demo assets) and invented demo data in the page (demo mode: no Discord, no
 * network), and the Cinema settings page.
 */
async function activityScenes({ manage, page, ctx, demo }) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { FEATURE_SPECS } = await import(pathToFileURL(path.join(ctx.root, 'core/feature-config-spec.js')).href);
    const dist = path.join(ctx.root, 'frontend/activities/dist');
    let man = null;
    try { man = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')); } catch { man = null; }
    if (!man) throw new Error('frontend/activities is not built (node frontend/activities/build.mjs)');
    const jsUrl = ctx.asset('activity-app.js', fs.readFileSync(path.join(dist, 'assets', man.js)));
    ctx.asset('activity-app.css', fs.readFileSync(path.join(dist, 'assets', man.css)));
    ctx.asset(man.font, fs.readFileSync(path.join(dist, 'assets', man.font)));
    const M = demo.member;
    const now = Date.UTC(2026, 10, 18, 20, 30);
    const viewer = (k, extra = {}) => ({ id: M[k].id, name: M[k].displayName, avatar: null, buffering: false, controller: false, ...extra });
    const film = { gen: 1, itemId: 'demo', name: 'The Lantern Keepers', label: 'The Lantern Keepers (2019)', type: 'Movie', runtimeSec: 6420, remux: true, src: '',
        subtitles: [{ index: 3, label: 'English', language: 'eng', src: '' }, { index: 4, label: 'Français', language: 'fre', src: '' }], burnedSubtitle: null };
    const state = {
        id: 'demo', rev: 4, serverNow: now, ended: false, host: { id: M.thistle.id, name: M.thistle.displayName },
        viewers: [viewer('thistle', { controller: true }), viewer('wren'), viewer('pip', { buffering: true }), viewer('hazel'), viewer('bramble')],
        media: film, playback: { paused: false, position: 2735, at: now },
        queue: [{ label: film.label, current: true }], queueIndex: 0, limits: { maxViewers: 25 },
    };
    const titles = [['The Lantern Keepers', 2019, 'Movie'], ['Copper Kettle Mysteries', 2021, 'Series'], ['Paper Moons Over Harbour', 2016, 'Movie'], ['Seven Quiet Rivers', 2022, 'Movie'],
        ['Little Orchard', 2018, 'Series'], ['The Clockmaker\'s Garden', 2014, 'Movie'], ['Marsh Lights', 2020, 'Movie'], ['Northbound', 2023, 'Movie'], ['Saltwind', 2017, 'Series'],
        ['Under the Pines', 2015, 'Movie'], ['The Long Field', 2012, 'Movie'], ['Harbour Lane', 2024, 'Series']];
    const library = { items: titles.map(([name, year, type], i) => ({ id: `demo${i}`, type, name, year, image: null })), total: 48, page: 0, pages: 2 };
    const locals = (data) => () => {
        const assetBase = jsUrl().replace(/\/activity-app\.js$/, '');
        return { appId: '100000000000000999', assetBase, js: 'activity-app.js', css: 'activity-app.css', demoJson: JSON.stringify(data), problem: null };
    };
    const user = { id: M.thistle.id, name: M.thistle.displayName, avatar: null };
    page('activity-launcher', 'activity', locals({ view: 'launcher', user, me: { watch: { available: true, reason: null, active: true }, greenhouse: { available: true } } }), {
        alt: 'The CertiFried Activity in a voice channel: Watch Together, with a film playing now, and Greenhouse Tycoon.', guides: ['greenhouse', 'watch-together'], width: 1000, height: 560,
    });
    page('watch-together-player', 'activity', locals({ view: 'watch', user, you: { canStart: true, canControl: true }, state, tab: 'people', library }), {
        alt: 'Watch Together playing The Lantern Keepers, 45 minutes in: the player with its controls, and the People tab listing five people watching, with Thistle as host and one still loading.', guides: ['watch-together'], width: 1280, height: 720,
    });
    page('watch-together-library', 'activity', locals({ view: 'watch', user, you: { canStart: true, canControl: true }, state, tab: 'library', library }), {
        alt: 'The Library tab in Watch Together: a search box, All, Films and Shows, and the server\'s films and shows in a grid.', guides: ['watch-together'], width: 1280, height: 720,
    });
    ctx.stub(/^\/api\/guilds\/\d+\/feature-config\/cinema$/, () => {
        const s = FEATURE_SPECS.cinema;
        const libs = [{ value: '', label: 'Every video library' }, { value: 'demo-films', label: 'Films' }, { value: 'demo-shows', label: 'Shows' }];
        return {
            success: true, rows: [],
            config: { enabled: 1, control_role_id: null, default_vc_id: null, watch_mode: 'activity', jellyfin_library_id: 'demo-films' },
            spec: { key: 'cinema', label: s.label, icon: s.icon, iconPack: s.iconPack || 'fas', colour: s.colour, blurb: s.blurb, commands: s.commands || [], category: s.category || null, note: s.note || null, unwired: null,
                fields: s.fields.map((f) => ({ ...f, ...(f.key === 'jellyfin_library_id' ? { options: libs } : {}), wired: f.wired !== false })), hasList: false, listTitle: null, listLabels: null },
        };
    });
    manage('watch-together-setup', 'cinema', {}, { alt: 'The Cinema page on the dashboard: Cinema on, How films play set to Watch Together (Discord Activity), and the Library the server watches from.', guides: ['watch-together'], height: 1040 });
}
