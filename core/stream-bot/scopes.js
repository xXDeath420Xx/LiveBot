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
]);

/** Scopes added after the first grants: what each turns on, for the Connections page's "Re-approve to enable". */
export const REAPPROVE = Object.freeze([
    { scope: 'moderator:manage:chat_messages', label: 'Clear chat, Delete messages' },
    { scope: 'moderator:manage:shoutouts', label: 'Shoutouts' },
    { scope: 'moderator:manage:blocked_terms', label: 'Twitch blocked terms from imported banned words' },
    { scope: 'moderator:read:chatters', label: 'Watch time for viewers who do not chat' },
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
    { key: 'chat', label: 'Chat messages', events: ['chat'], need: [['user:read:chat', 'user:bot']] },
    { key: 'manage', label: 'Title, category, raids, ads, clips and announcements', events: [],
        need: [['channel:manage:broadcast', 'channel:manage:raids', 'channel:edit:commercial', 'clips:edit', 'moderator:manage:announcements']] },
    { key: 'chatmod', label: 'Clear chat and delete messages', events: [], need: [['moderator:manage:chat_messages']] },
    { key: 'shoutout', label: 'Shoutouts', events: [], need: [['moderator:manage:shoutouts']] },
    { key: 'chatters', label: 'Watch time for everyone in chat (Viewers)', events: [], need: [['moderator:read:chatters']] },
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
