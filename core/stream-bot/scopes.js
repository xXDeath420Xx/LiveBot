/*
 * Stream bot: the opt-in "Stream bot" Twitch grant and what each grant enables (design §2.1). Pure.
 *
 * Owner rule (2026-11-19): never request user:read:follows or any revenue scope. Existing grants are reused:
 * the server analytics grant (twitch_role_sync_config.token_scopes) and the server write grant
 * (tier_b_scopes). This grant adds what a streamer without those needs. scopeSatisfied() mirrors
 * core/twitch-eventsub-manager.js: a manage scope satisfies the matching read scope.
 */

export const STREAM_BOT_SCOPES = Object.freeze([
    'moderator:read:followers',
    'channel:read:subscriptions',
    'bits:read',
    'channel:read:redemptions',
    'channel:manage:redemptions',
    'channel:read:hype_train',
    'channel:manage:polls',
    'channel:manage:predictions',
    'channel:read:ads',
    'user:read:chat',
    'user:bot',
    'channel:manage:broadcast',
    'channel:manage:raids',
    'channel:edit:commercial',
    'clips:edit',
    'moderator:manage:announcements',
    // Added 2026-11-19 with the stream actions; a grant made before then needs re-approving for them (REAPPROVE).
    'moderator:manage:chat_messages',
    'moderator:manage:shoutouts',
    // Added 2026-11-19 (H-763): the Import page's "Add to Twitch blocked terms" for saved banned words (owner's button only).
    'moderator:manage:blocked_terms',
    // Added 2026-11-19 (H-747): the chatters list (GET /helix/chat/chatters), everyone in chat including lurkers, for viewer
    // watch time. It names who is connected to chat; it is not the follows list and reads no revenue.
    'moderator:read:chatters',
    // Added 2026-11-20: "Send a chat message as you" (stream.say, POST /helix/chat/messages with the streamer as sender). Imported
    // Firebot "chat as Streamer" and Streamer.bot "not as bot" lines that another bot acts on (!pokecatch, !roll …) must come
    // from the streamer's own account, or that bot acts for CertiFried's bot account instead.
    'user:write:chat',
    // Added 2026-11-20: timeout and ban from the OBS chat dock (POST /helix/moderation/bans, the streamer acting on their own channel).
    // A moderation scope only: it does not read follows or revenue. A grant made before then needs re-approving for it.
    'moderator:manage:banned_users',
    // Added 2026-11-20 (wave 2 group A, core/stream-bot/control). Moderation and channel tools only: none reads follows or revenue.
    // A grant made before then needs re-approving for them (REAPPROVE); until then those steps say "Reconnect Twitch to enable".
    'channel:moderate',                    // EventSub channel.ban / channel.unban: the Viewer banned, timed out and unbanned triggers
    'moderation:read',                     // EventSub channel.moderator.add / remove: the Moderator or VIP added or removed trigger
    'moderator:manage:automod',            // EventSub automod.message.hold: the AutoMod held a message trigger
    'moderator:read:suspicious_users',     // EventSub channel.suspicious_user.message: the Suspicious user chatted trigger
    'moderator:manage:chat_settings',      // Change a chat mode (PATCH /helix/chat/settings)
    'channel:manage:vips',                 // Add or remove a VIP; EventSub channel.vip.add / remove
    'channel:manage:moderators',           // Add or remove a moderator
    'moderator:manage:shield_mode',        // Turn shield mode on or off; EventSub channel.shield_mode.*
    'moderator:manage:warnings',           // Warn a viewer; EventSub channel.warning.send
    'channel:read:goals',                  // EventSub channel.goal.*: the Creator goal triggers
    'channel:manage:ads',                  // Snooze the next ad break (POST /helix/channels/ads/schedule/snooze)
]);

/** Scopes added after the first grants: what each turns on, for the Connections page's "Re-approve to enable". */
export const REAPPROVE = Object.freeze([
    { scope: 'moderator:manage:chat_messages', label: 'Clear chat, Delete messages' },
    { scope: 'moderator:manage:shoutouts', label: 'Shoutouts' },
    { scope: 'moderator:manage:blocked_terms', label: 'Twitch blocked terms from imported banned words' },
    { scope: 'moderator:read:chatters', label: 'Watch time for viewers who do not chat' },
    { scope: 'user:write:chat', label: 'Send chat messages as you' },
    { scope: 'moderator:manage:banned_users', label: 'Time out and ban from the chat dock' },
    { scope: 'channel:moderate', label: 'Ban, timeout and unban triggers' },
    { scope: 'moderation:read', label: 'Moderator added or removed trigger' },
    { scope: 'moderator:manage:automod', label: 'AutoMod held a message trigger' },
    { scope: 'moderator:read:suspicious_users', label: 'Suspicious user trigger' },
    { scope: 'moderator:manage:chat_settings', label: 'Change chat modes' },
    { scope: 'channel:manage:vips', label: 'Add or remove VIPs' },
    { scope: 'channel:manage:moderators', label: 'Add or remove moderators' },
    { scope: 'moderator:manage:shield_mode', label: 'Shield mode' },
    { scope: 'moderator:manage:warnings', label: 'Warn viewers' },
    { scope: 'channel:read:goals', label: 'Creator goal triggers' },
    { scope: 'channel:manage:ads', label: 'Snooze ads' },
]);

/** Labels of what a stored grant cannot do yet because it predates a scope (empty when nothing is missing). */
export function reapproveNeeded(grantScopes) {
    const have = new Set(grantScopes || []);
    return REAPPROVE.filter((r) => !have.has(r.scope)).map((r) => r.label);
}

/** Never requested by this grant (tests assert it). */
export const FORBIDDEN_SCOPES = Object.freeze(['user:read:follows', 'analytics:read:extensions', 'analytics:read:games', 'user:read:subscriptions', 'user:read:email']);

/**
 * What a Twitch grant can enable. `need` is a list of alternatives; each alternative is a list of scopes
 * that must all be present. `none: true` features need no user scope (app token).
 */
export const TWITCH_FEATURES = Object.freeze([
    { key: 'online', label: 'Live and offline', events: ['stream.online', 'stream.offline'], none: true },
    { key: 'raid', label: 'Raids', events: ['raid'], none: true },
    { key: 'follow', label: 'Follows', events: ['follow'], need: [['moderator:read:followers']] },
    { key: 'subs', label: 'Subs, resubs and gift subs', events: ['sub', 'resub', 'gift_sub'], need: [['channel:read:subscriptions']] },
    { key: 'cheer', label: 'Bits and power-ups', events: ['cheer', 'bits.used'], need: [['bits:read']] },
    { key: 'redemption', label: 'Channel points', events: ['redemption'], need: [['channel:read:redemptions']] },
    { key: 'hype', label: 'Hype train', events: ['hype_train.begin', 'hype_train.progress', 'hype_train.end'], need: [['channel:read:hype_train']] },
    { key: 'poll', label: 'Polls', events: ['poll.begin', 'poll.progress', 'poll.end'], need: [['channel:read:polls']] },
    { key: 'prediction', label: 'Predictions', events: ['prediction.begin', 'prediction.progress', 'prediction.lock', 'prediction.end'], need: [['channel:read:predictions']] },
    { key: 'ads', label: 'Ad breaks', events: ['ad_break'], need: [['channel:read:ads']] },
    // Watch streaks and charity donations arrive as chat notices (channel.chat.notification), on the same scopes as chat.
    { key: 'chat', label: 'Chat messages', events: ['chat', 'watch_streak', 'charity'], need: [['user:read:chat', 'user:bot']] },
    { key: 'manage', label: 'Title, category, raids, ads, clips and announcements', events: [],
        need: [['channel:manage:broadcast', 'channel:manage:raids', 'channel:edit:commercial', 'clips:edit', 'moderator:manage:announcements']] },
    { key: 'chatmod', label: 'Clear chat and delete messages', events: [], need: [['moderator:manage:chat_messages']] },
    { key: 'shoutout', label: 'Shoutouts', events: [], need: [['moderator:manage:shoutouts']] },
    { key: 'chatters', label: 'Watch time for everyone in chat (Viewers)', events: [], need: [['moderator:read:chatters']] },
    { key: 'sayasme', label: 'Send chat messages as you', events: [], need: [['user:write:chat']] },
    { key: 'banusers', label: 'Time out and ban from the chat dock', events: [], need: [['moderator:manage:banned_users']] },
    { key: 'redeem', label: 'Mark redemptions done or refund them', events: ['redemption.updated'], need: [['channel:manage:redemptions']] },
    { key: 'modevents', label: 'Ban, timeout and unban triggers', events: ['mod.ban', 'mod.timeout', 'mod.unban'], need: [['channel:moderate']] },
    { key: 'chatmodevents', label: 'Message deleted, chat cleared and chat mode triggers', events: ['mod.delete', 'mod.clear', 'mod.chat_mode'], need: [['user:read:chat', 'user:bot']] },
    { key: 'roles', label: 'Moderator and VIP changes', events: ['mod.role'], need: [['moderation:read', 'channel:manage:vips']] },
    { key: 'automod', label: 'AutoMod held a message', events: ['automod.held'], need: [['moderator:manage:automod']] },
    { key: 'suspicious', label: 'Suspicious users', events: ['mod.suspicious'], need: [['moderator:read:suspicious_users']] },
    { key: 'warnings', label: 'Warnings', events: ['mod.warning'], need: [['moderator:manage:warnings']] },
    { key: 'shield', label: 'Shield mode', events: ['mod.shield'], need: [['moderator:manage:shield_mode']] },
    { key: 'goals', label: 'Creator goals', events: ['goal.begin', 'goal.progress', 'goal.end'], need: [['channel:read:goals']] },
    { key: 'update', label: 'Title or category changed', events: ['stream.updated'], none: true },
    { key: 'chatmodes', label: 'Change chat modes', events: [], need: [['moderator:manage:chat_settings']] },
    { key: 'vipmod', label: 'Add or remove VIPs and moderators', events: [], need: [['channel:manage:vips', 'channel:manage:moderators']] },
    { key: 'snooze', label: 'Snooze ads', events: [], need: [['channel:manage:ads']] },
]);

export function scopeSatisfied(have, need) {
    if (have.has(need)) return true;
    const m = String(need).match(/^(moderator|channel):read:(.+)$/);
    return !!m && have.has(`${m[1]}:manage:${m[2]}`);
}

/**
 * Which features each grant covers.
 * @param {Record<string, string[]|Set<string>>} grants  e.g. { streamBot: [...], serverAnalytics: [...], serverWrite: [...] }
 * @returns {Array<{ key, label, events, later, covered: boolean, by: string[] }>}
 */
export function coverage(grants) {
    const sets = Object.entries(grants || {}).map(([name, s]) => [name, s instanceof Set ? s : new Set(s || [])]);
    const all = new Set(sets.flatMap(([, s]) => [...s]));
    return TWITCH_FEATURES.map((f) => {
        if (f.none) return { key: f.key, label: f.label, events: f.events, later: !!f.later, covered: true, by: ['app'] };
        const ok = (have) => f.need.some((alt) => alt.every((s) => scopeSatisfied(have, s)));
        const by = sets.filter(([, s]) => ok(s)).map(([n]) => n);
        // A feature can also be covered by scopes split across grants (same client id, Twitch honours either).
        return { key: f.key, label: f.label, events: f.events, later: !!f.later, covered: by.length > 0 || ok(all), by };
    });
}

export default { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES, TWITCH_FEATURES, REAPPROVE, reapproveNeeded, scopeSatisfied, coverage };
