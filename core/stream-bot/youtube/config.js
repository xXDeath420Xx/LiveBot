/*
 * Stream bot, YouTube Live (H-741, design §13): the switch, the OAuth scopes and the quota price list. Pure.
 *
 * The feature is on when the server has a Google OAuth client (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, the
 * same names the multicast YouTube connect already reads, dashboard/services/platforms/youtube.js) and STREAM_BOT_YOUTUBE is
 * not '0'. Without them the Connections page explains that YouTube is not set up yet and nothing polls.
 *
 * Scopes: CertiFried asks Google for two, and nothing else (Google OAuth verification, 2026-11-21):
 *   youtube.force-ssl   "Link YouTube" (stream bot) and the multicast YouTube connect: reading the channel's live broadcasts
 *                       and live chat, sending a chat message as the channel, deleting a message, banning or timing out a
 *                       viewer, changing the broadcast title, new subscribers (liveBroadcasts, liveChatMessages, liveChatBans,
 *                       subscriptions all accept it), and for multicast liveStreams.insert and liveBroadcasts.insert / bind.
 *   youtube.readonly    the /privacy/viewer YouTube sign-in: which channel is yours (channels.list mine=true), then revoked.
 * No openid, email or profile. assertAllowedScopes() refuses anything else before a sign-in URL is built.
 * The broad `youtube` scope is never asked for; a sign-in made before 2026-11-21 that holds it is still recognised as able to
 * read and write (LEGACY_FULL_SCOPE), so nobody has to link again.
 */

export const YT_SCOPE = Object.freeze({
    forceSsl: 'https://www.googleapis.com/auth/youtube.force-ssl',
    readonly: 'https://www.googleapis.com/auth/youtube.readonly',
});
/** Only recognised on old grants, never requested. */
export const LEGACY_FULL_SCOPE = 'https://www.googleapis.com/auth/youtube';
/** Every Google scope CertiFried may ask for. */
export const ALLOWED_GOOGLE_SCOPES = Object.freeze([YT_SCOPE.forceSsl, YT_SCOPE.readonly]);

/** Throws unless every scope in `scope` (a space-separated string or a list) is in ALLOWED_GOOGLE_SCOPES. Returns the list. */
export function assertAllowedScopes(scope) {
    const list = (Array.isArray(scope) ? scope : String(scope || '').split(/[\s,]+/)).filter(Boolean);
    if (!list.length) throw new Error('no Google scope given');
    const bad = list.filter((s) => !ALLOWED_GOOGLE_SCOPES.includes(s));
    if (bad.length) throw new Error(`Google scope not allowed: ${bad.join(' ')}`);
    return list;
}

/** What "Link YouTube" asks Google for. */
export const BOT_SCOPES = Object.freeze([YT_SCOPE.forceSsl]);
/** What the /privacy/viewer YouTube sign-in asks for: enough to read which channel is theirs (channels.list mine=true). */
export const VIEWER_SCOPES = Object.freeze([YT_SCOPE.readonly]);

const scopeSet = (scopes) => new Set((Array.isArray(scopes) ? scopes : String(scopes || '').split(/[\s,]+/)).filter(Boolean));
/** Reading broadcasts and chat. */
export const canRead = (scopes) => { const s = scopeSet(scopes); return s.has(YT_SCOPE.forceSsl) || s.has(LEGACY_FULL_SCOPE) || s.has(YT_SCOPE.readonly); };
/** Sending, deleting, banning. */
export const canWrite = (scopes) => { const s = scopeSet(scopes); return s.has(YT_SCOPE.forceSsl) || s.has(LEGACY_FULL_SCOPE); };

/** Quota units per call (developers.google.com/youtube/v3/determine_quota_cost, read 2026-11-20). */
export const QUOTA_COST = Object.freeze({
    'liveBroadcasts.list': 1,
    'videos.list': 1,
    'channels.list': 1,
    'liveChatMessages.list': 5,
    'liveChatMessages.streamList': 5,
    'liveChatMessages.insert': 20,
    'liveChatMessages.delete': 20,
    'liveChatBans.insert': 200,
    'subscriptions.list': 1,       // new subscribers while live (youtube/service.js, 2026-11-20)
    'liveBroadcasts.update': 50,   // "Change the YouTube title" (core/stream-bot/control, 2026-11-20)
});

/** A YouTube channel id (UC + 22). */
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
/** YouTube refuses chat messages over 200 characters. */
export const CHAT_MAX = 200;

export function youtubeBotConfig(env = process.env) {
    const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
    const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
    const off = String(env.STREAM_BOT_YOUTUBE || '').trim() === '0';
    const units = Number.parseInt(env.YOUTUBE_STREAM_BOT_DAILY_UNITS, 10);
    let reason = null;
    if (off) reason = 'switched_off';
    else if (!clientId || !clientSecret) reason = 'no_client';
    return {
        enabled: !reason,
        reason,
        clientId: clientId || null,
        clientSecret: clientSecret || null,
        dailyUnits: Number.isFinite(units) && units >= 100 ? units : 10_000,
    };
}

export const DISABLED_TEXT = Object.freeze({
    no_client: 'YouTube is not set up on this server yet: CertiFried is waiting for its Google sign-in to be approved.',
    switched_off: 'YouTube is switched off on this server for now.',
});

export default { YT_SCOPE, LEGACY_FULL_SCOPE, ALLOWED_GOOGLE_SCOPES, assertAllowedScopes, BOT_SCOPES, VIEWER_SCOPES, canRead, canWrite, QUOTA_COST, CHANNEL_ID, CHAT_MAX, youtubeBotConfig, DISABLED_TEXT };
