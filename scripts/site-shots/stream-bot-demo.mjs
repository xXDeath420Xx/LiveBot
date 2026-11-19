/*
 * Stream bot pages (/stream/bot) filled with invented Maple Hollow data, for the theme audit
 * (scripts/theme-audit/pages.mjs), the guide screenshots (scenes.mjs) and tests/stream-bot-pages.test.js.
 *
 * Every name here is made up (the channel maplehollow_tv, the viewers from demo-data.mjs, MapleFan_88 from the
 * stream bot's own sample events). The locals are built with the same view-model helpers the route uses
 * (dashboard/services/stream-bot-view.js), so a page that renders here renders the way the route renders it.
 *
 *   streamBotPages(demo, { root, editId }) -> Promise<{ [id]: { template, locals } }>   (editId: the automation the editor shows)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STREAM_BOT_IDS = Object.freeze([
    'stream-bot-overview', 'stream-bot-events', 'stream-bot-automations', 'stream-bot-automation-edit',
    'stream-bot-runs', 'stream-bot-run', 'stream-bot-connections', 'stream-bot-devices',
    // 2026-11-19 stream actions: an automation with an If step and stream actions, and the Timers page.
    'stream-bot-automation-edit-flow', 'stream-bot-timers',
]);

export async function streamBotPages(demo, { root, editId = 32 }) {
    const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
    const [view, events, scopes] = await Promise.all([
        imp('dashboard/services/stream-bot-view.js'), imp('core/stream-bot/events.js'), imp('core/stream-bot/scopes.js'),
    ]);
    const { guild, channel, channels, member: M, D } = demo;
    const iso = (...a) => D(...a).toISOString();
    const profile = { id: 7, displayName: M.juniper.displayName, storeChat: false, webhookAllowHosts: ['hooks.maplehollow.example'] };
    const TW = { id: 1, platform: 'twitch', platform_user_id: '700000001', login: 'maplehollow_tv', display_name: 'maplehollow_tv' };
    const KK = { id: 2, platform: 'kick', platform_user_id: '700000002', login: 'maplehollow_kick', display_name: 'maplehollow_kick' };
    const fan = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };
    const who = (k, roles = []) => ({ id: `9000${M[k].id.slice(-6)}`, login: M[k].username.replace(/[^a-z0-9_]/g, ''), name: M[k].displayName, roles });

    // ── events (newest first) ──
    const raw = [
        { id: 412, platform: 'twitch', type: 'cheer', channelId: TW.platform_user_id, user: fan, amount: 500, currency: 'bits', message: 'Cheer500 good luck on the boss', occurredAt: D(2026, 11, 18, 20, 41) },
        { id: 411, platform: 'twitch', type: 'follow', channelId: TW.platform_user_id, user: who('wren'), occurredAt: D(2026, 11, 18, 20, 37) },
        { id: 410, platform: 'kick', type: 'sub', channelId: KK.platform_user_id, user: who('pip', ['subscriber']), metadata: { months: 1, isGift: false }, occurredAt: D(2026, 11, 18, 20, 30) },
        { id: 409, platform: 'streamelements', type: 'tip', channelId: null, user: { id: null, login: null, name: M.hazel.displayName, roles: [] }, amount: 5, currency: 'USD', message: 'Coffee is on me', occurredAt: D(2026, 11, 18, 20, 22) },
        { id: 408, platform: 'twitch', type: 'redemption', channelId: TW.platform_user_id, user: who('thistle'), amount: 500, currency: 'points', message: 'Play the sad trombone', metadata: { reward: 'Sound alert' }, occurredAt: D(2026, 11, 18, 20, 15) },
        { id: 407, platform: 'twitch', type: 'raid', channelId: TW.platform_user_id, user: { id: '100000002', login: 'bramblebyte_live', name: 'BrambleByte_Live', roles: [] }, amount: 42, currency: 'viewers', metadata: { viewers: 42 }, occurredAt: D(2026, 11, 18, 20, 2) },
        { id: 406, platform: 'twitch', type: 'follow', channelId: TW.platform_user_id, user: who('fennel'), occurredAt: D(2026, 11, 18, 19, 51) },
        { id: 405, platform: 'twitch', type: 'stream.online', channelId: TW.platform_user_id, user: null, occurredAt: D(2026, 11, 18, 19, 30) },
        { id: 404, platform: 'test', type: 'follow', channelId: TW.platform_user_id, user: fan, occurredAt: D(2026, 11, 18, 18, 12), test: true },
        { id: 403, platform: 'kick', type: 'stream.offline', channelId: KK.platform_user_id, user: null, occurredAt: D(2026, 11, 17, 23, 5) },
    ].map((e) => ({ amount: null, currency: null, message: null, metadata: {}, test: false, ...e }));
    const eventList = raw.map(view.eventView);

    // ── automations ──
    const automations = [
        { id: 31, name: 'Thank followers in chat', enabled: true, trigger_type: 'follow', trigger_config: {},
            conditions: [{ type: 'cooldown', scope: 'user', seconds: 3600 }],
            actions: [{ type: 'chat.send', platform: 'event', text: 'Thanks for the follow, {user.name}! Welcome to the grove.' }], last_run_at: D(2026, 11, 18, 20, 37) },
        { id: 32, name: 'Big cheers', enabled: true, trigger_type: 'cheer', trigger_config: { platforms: ['twitch'] },
            conditions: [{ type: 'amount', min: 500, max: null, currency: 'bits' }],
            actions: [{ type: 'chat.send', platform: 'event', text: '{user.name} cheered {amount} bits. Thank you!' },
                { type: 'overlay.alert', title: '{user.name} cheered {amount} bits', message: '{message}', durationMs: 6000, style: 'default', queueSeconds: 120 }],
            last_run_at: D(2026, 11, 18, 20, 41) },
        { id: 33, name: '!discord command', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!discord', caseSensitive: false } },
            conditions: [{ type: 'cooldown', scope: 'global', seconds: 60 }],
            actions: [{ type: 'chat.send', platform: 'event', text: 'Join Maple Hollow on Discord: the link is in the panels below.' }], last_run_at: D(2026, 11, 17, 21, 3) },
        { id: 34, name: 'Going-live post', enabled: true, trigger_type: 'stream.online', trigger_config: {},
            conditions: [],
            actions: [{ type: 'discord.post', guildId: guild.id, channelId: channel['stream-alerts'].id, text: '{channel.name} is live on {event.platform}.' }], last_run_at: D(2026, 11, 18, 19, 30) },
        { id: 35, name: 'BRB scene', enabled: false, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!brb', caseSensitive: false } },
            conditions: [{ type: 'role', roles: ['broadcaster', 'moderator'], mode: 'any' }],
            actions: [{ type: 'obs.scene', scene: 'Be right back', queueSeconds: 120 }], last_run_at: null },
    ];
    const offline = { studio: false, overlay: false };
    const editing = automations.find((a) => a.id === editId) || automations[1];
    // Not in the list above (the list and guide shots stay as they were): the editor with an If step and stream actions.
    const flow = { id: 36, name: 'Scene audio and clips', enabled: false, trigger_type: 'obs.scene_changed', trigger_config: {}, conditions: [],
        actions: [
            { type: 'if', check: { type: 'metadata', path: 'scene', op: 'in', value: 'Starting Soon|Be right back|Ending' },
                then: [{ type: 'obs.mute', input: 'Mic/Aux', state: 'mute', queueSeconds: 120 }],
                else: [{ type: 'obs.mute', input: 'Mic/Aux', state: 'unmute', queueSeconds: 120 }] },
            { type: 'stream.clip' },
            { type: 'stream.announce', text: 'New clip: {clip.url}', color: 'purple' },
            { type: 'stream.title', platform: 'all', title: 'Maple Hollow: {args.topic}' },
        ], last_run_at: null };
    const timerOwn = [
        { id: 3, kind: 'stream_bot', name: 'Socials', messages: ['Maple Hollow is on Bluesky too: maplehollow.example', 'The Discord link is in the panels below.'], rotation: 'rotate',
            intervalMin: 20, enabled: true, onlyLive: true, minChatLines: 10, automationId: null, automationName: null, platforms: 'all', channelName: null, lastSentAt: iso(2026, 11, 18, 20, 40), sendCount: 31 },
        { id: 4, kind: 'stream_bot', name: 'Stretch break', messages: ['Stretch and drink some water. Live for {stream.uptime} so far.'], rotation: 'rotate',
            intervalMin: 60, enabled: false, onlyLive: true, minChatLines: 0, automationId: null, automationName: null, platforms: 'twitch', channelName: null, lastSentAt: null, sendCount: 0 },
    ];
    const timerKick = [{ id: 1, kind: 'kick_page', name: null, messages: ['Welcome to {{channel_name}}, grab a seat.'], rotation: 'rotate', intervalMin: 30, enabled: true,
        onlyLive: false, minChatLines: 0, automationId: null, automationName: null, platforms: 'kick', channelName: KK.login, lastSentAt: iso(2026, 11, 18, 20, 10), sendCount: 12 }];

    // ── runs ──
    const runRows = [
        { id: 902, automationId: 32, automationName: 'Big cheers', eventId: 412, source: 'event', parentRunId: null, depth: 0, dryRun: false, status: 'partial', skipReason: null,
            input: events.publicEvent(raw[0], 412), checks: [{ type: 'amount', ok: true, detail: '500 in range' }],
            steps: [{ at: '1', type: 'chat.send', status: 'ok', detail: 'twitch/maplehollow_tv: sent: MapleFan_88 cheered 500 bits. Thank you!', ms: 184 },
                { at: '2', type: 'overlay.alert', status: 'queued', detail: 'Needs an overlay: queued for 120 s', ms: 6, dispatchId: 'd_demo1' }],
            error: null, startedAt: D(2026, 11, 18, 20, 41), finishedAt: new Date(D(2026, 11, 18, 20, 41).getTime() + 190) },
        { id: 901, automationId: 31, automationName: 'Thank followers in chat', eventId: 411, source: 'event', parentRunId: null, depth: 0, dryRun: false, status: 'ok', skipReason: null,
            input: events.publicEvent(raw[1], 411), checks: [{ type: 'cooldown', ok: true, detail: 'per person cooldown 3600 s' }],
            steps: [{ at: '1', type: 'chat.send', status: 'ok', detail: 'twitch/maplehollow_tv: sent: Thanks for the follow, Wren Alder! Welcome to the grove.', ms: 171 }],
            error: null, startedAt: D(2026, 11, 18, 20, 37), finishedAt: new Date(D(2026, 11, 18, 20, 37).getTime() + 175) },
        { id: 899, automationId: 34, automationName: 'Going-live post', eventId: 405, source: 'event', parentRunId: null, depth: 0, dryRun: false, status: 'ok', skipReason: null,
            input: events.publicEvent(raw[7], 405), checks: [], steps: [{ at: '1', type: 'discord.post', status: 'ok', detail: 'posted: maplehollow_tv is live on twitch.', ms: 240 }],
            error: null, startedAt: D(2026, 11, 18, 19, 30), finishedAt: new Date(D(2026, 11, 18, 19, 30).getTime() + 244) },
        { id: 897, automationId: 31, automationName: 'Thank followers in chat', eventId: 404, source: 'test', parentRunId: null, depth: 0, dryRun: true, status: 'ok', skipReason: null,
            input: events.publicEvent(raw[8], 404), checks: [{ type: 'cooldown', ok: true, detail: 'per person cooldown 3600 s' }],
            steps: [{ at: '1', type: 'chat.send', status: 'dry', detail: 'would say in twitch/maplehollow_tv: Thanks for the follow, MapleFan_88! Welcome to the grove.', ms: 3 }],
            error: null, startedAt: D(2026, 11, 18, 18, 12), finishedAt: new Date(D(2026, 11, 18, 18, 12).getTime() + 4) },
        { id: 896, automationId: 33, automationName: '!discord command', eventId: null, source: 'event', parentRunId: null, depth: 0, dryRun: false, status: 'skipped',
            skipReason: 'cooldown: cooling down, 41 s left', input: events.publicEvent({ platform: 'twitch', type: 'chat', user: who('pip'), message: '!discord', occurredAt: D(2026, 11, 17, 21, 4) }), checks: [{ type: 'cooldown', ok: false, detail: 'cooling down, 41 s left' }],
            steps: [], error: null, startedAt: D(2026, 11, 17, 21, 4), finishedAt: D(2026, 11, 17, 21, 4) },
    ];

    // ── connections ──
    const grantScopes = [...scopes.STREAM_BOT_SCOPES];
    const twitchHealth = {
        ok: true, grants: { streamBot: { status: 'active', grantedAt: D(2026, 11, 18, 17, 0), scopes: grantScopes.length }, serverAnalytics: null, serverWrite: null },
        eventsub: { total: 17, enabled: 17, failing: 0 }, coverage: scopes.coverage({ streamBot: grantScopes }), webhook: null, lastChatAt: null, chatSend: null,
    };
    const kickHealth = { ok: true, grants: null, eventsub: null, coverage: null, webhook: { known: true, chat: true, missing: [], error: null }, lastChatAt: iso(2026, 11, 18, 20, 39), chatSend: true };

    const common = { profile };
    return {
        'stream-bot-overview': { template: 'stream-bot/overview', locals: { ...common, active: 'overview', pageTitle: 'Overview',
            channels: [
                { id: 1, platform: 'twitch', platformLabel: 'Twitch', login: TW.login, displayName: TW.display_name, live: true, liveSince: iso(2026, 11, 18, 19, 30), ok: true },
                { id: 2, platform: 'kick', platformLabel: 'Kick', login: KK.login, displayName: KK.display_name, live: false, liveSince: iso(2026, 11, 17, 23, 5), ok: true },
            ],
            devicesOnline: [],
            counts: [{ type: 'follow', label: 'Follow', n: 14, total: null }, { type: 'sub', label: 'Subscription', n: 3, total: null }, { type: 'cheer', label: 'Bits (cheer)', n: 2, total: 1200 },
                { type: 'raid', label: 'Raid', n: 1, total: 42 }, { type: 'tip', label: 'Tip', n: 1, total: 5 }],
            events: eventList.slice(0, 8), automationCount: automations.length, enabledCount: automations.filter((a) => a.enabled).length,
            grant: { login: TW.login, status: 'active' } } },
        'stream-bot-events': { template: 'stream-bot/events', locals: { ...common, active: 'events', pageTitle: 'Events',
            events: eventList, filters: { q: '', type: '', platform: '', before: null },
            types: events.EVENT_TYPES.map((t) => ({ type: t.type, label: t.label })), platforms: events.PLATFORMS.map((p) => ({ id: p, label: view.PLATFORM_LABEL[p] || p })),
            olderHref: '/stream/bot/events?before=403', newestHref: null } },
        'stream-bot-automations': { template: 'stream-bot/automations', locals: { ...common, active: 'automations', pageTitle: 'Automations',
            automations: automations.map((a) => view.automationSummary(a, offline)).sort((a, b) => a.name.localeCompare(b.name)), max: 200 } },
        'stream-bot-automation-edit': { template: 'stream-bot/automation-edit', locals: { ...common, active: 'automations', pageTitle: editing.name, automation: editing,
            editorData: {
                automation: { id: editing.id, name: editing.name, enabled: editing.enabled, trigger_type: editing.trigger_type, trigger_config: editing.trigger_config, conditions: editing.conditions, actions: editing.actions },
                catalog: view.catalog(offline), automations: automations.map((a) => ({ id: a.id, name: a.name })),
                guilds: [{ id: guild.id, name: guild.name }], guildChannels: { [guild.id]: channels.slice(0, 8).map((c) => ({ id: c.id, name: c.name })) },
                linkedPlatforms: ['twitch', 'kick'], atLimit: false, max: 200,
            } } },
        'stream-bot-runs': { template: 'stream-bot/runs', locals: { ...common, active: 'runs', pageTitle: 'Run history',
            runs: runRows.map(view.runView), filters: { status: '', automation: null, before: null }, statuses: ['ok', 'partial', 'failed', 'skipped', 'running'],
            automations: automations.map((a) => ({ id: a.id, name: a.name })), olderHref: null, newestHref: null } },
        'stream-bot-run': { template: 'stream-bot/run', locals: { ...common, active: 'runs', pageTitle: 'Run 902',
            run: view.runView(runRows[0]),
            dispatches: [view.dispatchView({ id: 'd_demo1', actionType: 'overlay.alert', target: 'overlay', status: 'expired', attempts: 0, deviceId: null, error: null,
                createdAt: D(2026, 11, 18, 20, 41), sentAt: null, ackedAt: null, expiresAt: D(2026, 11, 18, 20, 43) })],
            automationExists: true,
            stepLabels: Object.fromEntries(view.catalog(offline).actions.map((a) => [a.type, a.label]).concat([['random', 'Pick one at random']])),
            conditionLabels: Object.fromEntries(view.catalog(offline).conditions.map((c) => [c.type, c.label])) } },
        'stream-bot-connections': { template: 'stream-bot/connections', locals: { ...common, active: 'connections', pageTitle: 'Connections',
            notice: null,
            channels: [
                { id: 1, platform: 'twitch', platformLabel: 'Twitch', login: TW.login, displayName: TW.display_name, verifiedVia: 'stream_bot_grant', linkedAt: iso(2026, 11, 18, 17, 0), health: twitchHealth },
                { id: 2, platform: 'kick', platformLabel: 'Kick', login: KK.login, displayName: KK.display_name, verifiedVia: 'stream_platform_accounts', linkedAt: iso(2026, 11, 18, 17, 5), health: kickHealth },
            ],
            linkable: [],
            // A grant from before the chat moderation and shoutout scopes: the page asks to re-approve.
            grant: { login: TW.login, status: 'active', grantedAt: iso(2026, 11, 18, 17, 0), scopes: grantScopes.filter((s) => !['moderator:manage:chat_messages', 'moderator:manage:shoutouts'].includes(s)) },
            reapprove: scopes.reapproveNeeded(grantScopes.filter((s) => !['moderator:manage:chat_messages', 'moderator:manage:shoutouts'].includes(s))),
            scopes: view.scopeRows(),
            tipSources: [
                view.tipSourceView({ id: 1, source: 'streamelements', ref: '', enabled: true, status: 'listening', last_error: null, last_event_at: D(2026, 11, 18, 20, 22), has_secret: true }, new Map()),
                view.tipSourceView({ id: 2, source: 'kofi', ref: guild.id, enabled: true, status: 'new', last_error: null, last_event_at: null, has_secret: false }, new Map([[guild.id, guild.name]])),
            ],
            tipOptions: { kofi: [{ id: guild.id, name: guild.name }], fourthwall: [], throne: null, bmac: false },
            botSettings: { storeChat: profile.storeChat, webhookAllowHosts: profile.webhookAllowHosts } } },
        'stream-bot-automation-edit-flow': { template: 'stream-bot/automation-edit', locals: { ...common, active: 'automations', pageTitle: flow.name, automation: flow,
            editorData: {
                automation: { id: flow.id, name: flow.name, enabled: flow.enabled, trigger_type: flow.trigger_type, trigger_config: flow.trigger_config, conditions: flow.conditions, actions: flow.actions },
                catalog: view.catalog(offline), automations: automations.map((a) => ({ id: a.id, name: a.name })),
                guilds: [{ id: guild.id, name: guild.name }], guildChannels: {}, linkedPlatforms: ['twitch', 'kick'], atLimit: false, max: 200,
            } } },
        'stream-bot-timers': { template: 'stream-bot/timers', locals: { ...common, active: 'timers', pageTitle: 'Timers', schemaReady: true,
            own: timerOwn, kick: timerKick, linked: [{ platform: 'twitch', login: TW.login }, { platform: 'kick', login: KK.login }],
            pageData: { own: timerOwn, kick: timerKick, automations: automations.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled })),
                limits: { perProfile: 50, messages: 10, messageMax: 500, intervalMin: 1, intervalMax: 1440, linesMax: 1000, nameMax: 100 }, linkedPlatforms: ['twitch', 'kick'] } } },
        'stream-bot-devices': { template: 'stream-bot/devices', locals: { ...common, active: 'devices', pageTitle: 'Devices',
            devices: [view.deviceView({ id: 4, kind: 'overlay', name: 'Alerts overlay', tokenHint: 'x7Qa', capabilities: [], clientInfo: null, createdAt: D(2026, 11, 18, 17, 20), lastSeenAt: null, revokedAt: null }, new Set())],
            wsUrl: 'wss://certifriedmultitool.com/stream/bot/ws' } },
    };
}
