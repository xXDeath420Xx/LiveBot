/*
 * Stream bot, YouTube Live (H-741, design §13): the switch, the OAuth scopes and the quota price list. Pure.
 *
 * The feature is on when the server has a Google OAuth client (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, the
 * same names the multicast YouTube connect already reads, dashboard/services/platforms/youtube.js) and STREAM_BOT_YOUTUBE is
 * not '0'. Without them the Connections page explains that YouTube is not set up yet and nothing polls.
 *
 * Scopes: one, youtube.force-ssl. It covers reading the channel's live broadcasts and live chat, sending a chat message as the
 * channel, deleting a message and banning or timing out a viewer (liveBroadcasts, liveChatMessages, liveChatBans all accept it).
 * A channel connected for multicast holds the broader `youtube` scope, which covers the same calls.
 */

export const YT_SCOPE = Object.freeze({
    forceSsl: 'https://www.googleapis.com/auth/youtube.force-ssl',
    full: 'https://www.googleapis.com/auth/youtube',
    readonly: 'https://www.googleapis.com/auth/youtube.readonly',
});

/** What "Link YouTube" asks Google for. */
export const BOT_SCOPES = Object.freeze([YT_SCOPE.forceSsl]);
/** What the /privacy/viewer YouTube sign-in asks for: enough to read which channel is theirs (channels.list mine=true). */
export const VIEWER_SCOPES = Object.freeze([YT_SCOPE.readonly]);

const scopeSet = (scopes) => new Set((Array.isArray(scopes) ? scopes : String(scopes || '').split(/[\s,]+/)).filter(Boolean));
/** Reading broadcasts and chat. */
export const canRead = (scopes) => { const s = scopeSet(scopes); return s.has(YT_SCOPE.forceSsl) || s.has(YT_SCOPE.full) || s.has(YT_SCOPE.readonly); };
/** Sending, deleting, banning. */
export const canWrite = (scopes) => { const s = scopeSet(scopes); return s.has(YT_SCOPE.forceSsl) || s.has(YT_SCOPE.full); };

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

export default { YT_SCOPE, BOT_SCOPES, VIEWER_SCOPES, canRead, canWrite, QUOTA_COST, CHANNEL_ID, CHAT_MAX, youtubeBotConfig, DISABLED_TEXT };
