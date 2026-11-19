/*
 * Stub data for the wave 21a "kit-rollout-a" pages (tests/kit-rollout-a.test.js): the locals each
 * page partial is rendered with, shaped like what the manage route passes. Shared by the field
 * fixture capture (kit-rollout-a-fields.json), the page tests and the headless screenshot run.
 */

export const PAGES = [
    // Setup
    'initialize', 'catalog', 'takeover', 'core', 'appearance', 'theme', 'language', 'commands', 'command-center',
    'permissions', 'emoji-manager', 'backups', 'csv',
    // Protection
    'protection-settings', 'security', 'advanced-protection', 'quarantine', 'global-ban', 'name-filters',
    'avatar-protection', 'nsfw-protection', 'message-threats', 'phishing', 'link-filter', 'domain-reports',
    // Moderation, joining, roles
    'commission-filter', 'mass', 'join-requests', 'rejoin',
    'role-manager', 'reaction-roles', 'bulk-roles', 'stat-roles', 'channel-access',
];

export function stubs() {
    const guild = { id: '222222222222222222', name: 'Acme Gaming', icon: null, memberCount: 1234, ownerId: '111111111111111111' };
    const roles = ['Admin', 'Moderator', 'Member', 'Muted', 'Verified'].map((name, i) => ({ id: `30000000000000000${i}`, name, color: 0x5865f2, hexColor: '#5865f2', position: 5 - i, managed: false, memberCount: 3 }));
    const channels = ['general', 'rules', 'mod-log', 'welcome', 'bot-commands'].map((name, i) => ({ id: `40000000000000000${i}`, name, type: 0, parentId: null }));
    const voiceChannels = [{ id: '500000000000000000', name: 'Lounge', type: 2 }];
    const categories = [{ id: '600000000000000000', name: 'Community', type: 4 }];
    const when = new Date(Date.UTC(2026, 9, 12, 14, 5));
    const base = { guild, roles, channels, voiceChannels, categories };
    return {
        initialize: { ...base },
        catalog: {
            ...base,
            catalog: new Map([
                ['Moderation', [{ key: 'moderation', name: 'Moderation', active: true, description: 'Warnings, timeouts, kicks and bans.', command: '/warn', page: 'moderation' }]],
                ['Community', [{ key: 'leveling', name: 'Leveling', active: false, description: 'XP and level rewards.', command: null, page: 'leveling' }]],
            ]),
        },
        takeover: { ...base },
        core: { ...base, settings: { prefix: '!', language: 'en', timezone: 'UTC' }, prefixConfig: { prefix: '!', enabled: 1 } },
        appearance: {
            ...base, settings: { embed_color: '#5865f2' },
            customBotInfo: { bot_id: '900000000000000001', bot_name: 'Acme Bot', avatar_url: '', owner_user_id: '111111111111111111', status: 'online', activity_type: 'PLAYING', activity_text: 'with stars' },
        },
        theme: { ...base, theme: { primary: '#5865f2', accent: '#b4e04f' }, defaultTheme: { primary: '#5865f2', accent: '#b4e04f' } },
        language: { ...base, locales: [{ locale: 'en', name: 'English', nativeName: 'English' }, { locale: 'de', name: 'German', nativeName: 'Deutsch' }], guildLocale: 'en' },
        commands: {
            ...base,
            commands: [{ name: 'ban', category: 'moderation', description: 'Ban a member', enabled: true }, { name: 'rank', category: 'leveling', description: 'Show your rank', enabled: false }],
            commandRestrictions: { ban: { allowed_roles: [roles[0].id], denied_channels: [] } },
            prefixAliases: [{ alias: 'b', command_name: 'ban', created_by: '111111111111111111' }],
            guildId: guild.id,
        },
        'command-center': { ...base },
        permissions: { ...base, permissionOverrides: [{ id: 1, command_name: 'ban', role_id: roles[1].id, channel_id: null, allowed: 1 }] },
        'emoji-manager': { ...base },
        backups: { ...base, backups: [{ id: 5, name: 'Before the raid', created_at: when, size: 20480, created_by: '111111111111111111' }] },
        csv: { ...base, consolidatedStreamers: [{ name: 'acme', platforms: ['twitch', 'kick'], subscriptions: [{ id: 1 }] }] },
        'protection-settings': { ...base },
        security: {
            ...base,
            joinGate: { enabled: 1, min_account_age_days: 7, action: 'kick' },
            antiRaid: { enabled: 1, join_threshold: 10, time_window: 10, action: 'lockdown' },
            antiNuke: { enabled: 0, ban_threshold: 3, kick_threshold: 3, channel_delete_threshold: 2, role_delete_threshold: 2, time_window: 60 },
            quarantine: { enabled: 1, role_id: roles[3].id },
            joinGateConfig: { enabled: 1, verify_mode: 'button', role_id: roles[4].id, min_account_age_days: 7, rejoin_limit_enabled: 1, spammer_check_enabled: 1 },
            antiRaidConfig: { enabled: 1, same_name: 1, raid_detection: 1, auto_lockdown: 0 },
            antiNukeConfig: { enabled: 0, alert_channel_id: channels[2].id },
            quarantineConfig: { enabled: 1, role_id: roles[3].id },
        },
        'advanced-protection': {
            ...base,
            raidConfig: { enabled: 1, join_threshold: 10, join_timeframe_seconds: 10, new_account_age_hours: 72, new_account_ratio: 0.5, action: 'lockdown', mute_duration_minutes: 60, purge_messages: 1, alert_channel_id: channels[2].id },
            selfbotConfig: { enabled: 1, action: 'log', alert_channel_id: channels[2].id, message_burst_threshold: 5, message_burst_window_ms: 2000, min_response_time_ms: 300, pattern_threshold: 3 },
            adaptiveSpamConfig: { enabled: 0, action: 'delete', alert_channel_id: '', cross_channel_threshold: 3, cross_channel_timeframe_minutes: 5, deviation_multiplier: 3, exempt_channels: '[]', new_account_multiplier_hours: 24 },
            inviteFilterConfig: { enabled: 1, action: 'delete', log_channel_id: channels[2].id, use_whitelist: 0 },
            inviteFilterEntries: { users: [{ id: 11, target_id: '800000000000000001', created_at: when }], roles: [{ id: 12, target_id: roles[1].id, created_at: when }], channels: [{ id: 13, target_id: channels[4].id, created_at: when }], invites: [{ id: 14, target_id: 'acme', created_at: when }] },
            raidIncidents: [{ id: 1, started_at: when, ended_at: null, join_count: 25, action_taken: 'lockdown' }],
            selfbotDetections: [{ id: 2, user_id: '800000000000000001', detected_at: when, confidence: 0.9, reason: 'Embed spam' }],
        },
        quarantine: {
            ...base,
            quarantineConfig: { enabled: 1, role_id: roles[3].id, log_channel_id: channels[2].id },
            quarantinedUsers: [{ user_id: '800000000000000001', username: 'pixelpal', reason: 'Raid', moderator_id: '111111111111111111', moderator_tag: 'tester', quarantined_at: when, created_at: when }],
        },
        'global-ban': { ...base, globalBanConfig: { enabled: 1, mode: 'observe', confidence_threshold: 80, log_channel_id: channels[2].id }, globalBanStats: { activeEntries: 512, pendingReports: 3, enabledGuilds: 40 } },
        'name-filters': { ...base },
        'avatar-protection': { ...base },
        'nsfw-protection': { ...base },
        'message-threats': { ...base },
        phishing: { ...base, phishingConfig: { enabled: 1, action: 'delete', log_channel_id: channels[2].id } },
        'link-filter': {
            ...base,
            linkConfig: { enabled: 1, mode: 'allowlist', action: 'delete', log_channel_id: channels[2].id },
            linkDomains: [{ id: 1, domain: 'youtube.com', list_type: 'allow' }],
            linkQueue: [{ id: 3, user_id: '800000000000000001', url: 'https://example.com', created_at: when, channel_id: channels[0].id }],
            linkRemovals: [{ id: 4, user_id: '800000000000000002', url: 'https://bad.example', created_at: when, channel_id: channels[0].id, reason: 'blocked' }],
            linkDefaults: { social: ['twitter.com'], media: ['youtube.com'], blocked: ['grabify.link'], monetisation: ['patreon.com'] },
        },
        'domain-reports': { ...base },
        'commission-filter': {
            ...base,
            commissionConfig: { enabled: 1, deleted_count: 14, phrases: null, soft_sell_enabled: 1, soft_sell_delete_at: 6, channel_ids: JSON.stringify([channels[0].id]), action: 'delete', log_channel_id: channels[2].id },
            commissionGroups: [{ icon: 'x', title: 'Selling art', desc: 'Offers to draw for money.', phrases: ['open for commissions', 'taking commissions'] }],
            commissionGlobalStats: { enabledCount: 4, totalRemoved: 120 },
            commissionPending: [{ id: 7, user_id: '800000000000000001', content: 'open for commissions', created_at: when }],
            commissionExemptions: [{ id: 21, kind: 'member', value: '800000000000000003', created_at: when }],
            commissionSignals: [{ weight: 2, label: 'Price mentioned' }],
            commissionRemovals: [{ id: 8, user_id: '800000000000000002', content: 'cheap art', created_at: when }],
        },
        mass: { ...base },
        'join-requests': { ...base },
        rejoin: {
            ...base,
            rejoin: {
                config: { rejoin_limit_enabled: 1, rejoin_limit_count: 3, rejoin_limit_window_days: 30, rejoin_limit_action: 'ban', rejoin_limit_log_channel_id: channels[2].id },
                top: [{ userId: '800000000000000001', name: 'pixelpal', avatar: null, joins: 5, lastJoin: when }],
                recent: [{ user_id: '800000000000000002', name: 'alt_account', action: 'ban', created_at: when, joins: 4 }],
            },
        },
        'role-manager': { ...base },
        'reaction-roles': {
            ...base,
            reactionRolePanels: [{ id: 1, panel_name: 'Pick your roles', message_id: '700000000000000001', channel_id: channels[0].id, description: 'Choose below', embed_color: '#5865f2', image_url: '', thumbnail_url: '', interaction_type: 'buttons', panel_mode: 'normal', max_selections: 0, placeholder_text: '', posted: 1, mappings: [{ id: 9, emoji: ':star:', role_id: roles[2].id, label: 'Member', description: '' }] }],
            get panels() { return this.reactionRolePanels; },
        },
        'bulk-roles': { ...base },
        'stat-roles': {
            ...base,
            statroles: [{ id: 1, role_id: roles[2].id, stat: 'messages', threshold: 100, enabled: 1 }],
            statroleConfigs: [{ id: 1, role_id: roles[2].id, stat: 'messages', threshold: 100, enabled: 1 }],
            statroleGrantCounts: { 1: 12 },
        },
        'channel-access': { ...base },
    };
}
