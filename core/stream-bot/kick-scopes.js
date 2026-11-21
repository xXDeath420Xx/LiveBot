/*
 * Stream bot: the Kick CHANNEL BOT sign-in and what each of its permissions lets the stream bot do, in plain words. Pure.
 *
 * Two different Kick sign-ins exist, which confused the owner (2026-11-19):
 *   - "Sign in with Kick" on Stream bot > Connections (/stream/connect/kick?for=bot, scope user:read, stored in
 *     stream_platform_accounts) only proves the channel is yours and links it. It cannot act on the channel.
 *   - The Kick channel bot sign-in (/tokes-bot/auth/kick, KICK_CHANNEL_BOT_SCOPES below, stored in
 *     tokes_platform_connections and read through services/certifried-bot/defender/channel-tokens.js resolveChannel)
 *     is what the stream bot's Kick actions use: chat messages, timers, title and category, message deletes.
 *
 *   KICK_CHANNEL_BOT_SCOPES              the scopes /tokes-bot/auth/kick asks for (dashboard/routes/auth-tokes-bot.js
 *                                        imports this list, so the page and the sign-in can never disagree)
 *   missingKickScopes(scopes)            [{ scope, label, text: 'Change title and category: needs permission' }]
 *   kickBotStatus(row)                   the Connections page's "Kick channel bot" row for one channel
 *   kickBotProblem(channel, scope?)      { code, message, href } when an action cannot run, else null
 *
 * Tested in tests/stream-bot-kick-bot.test.js.
 */

export const KICK_CHANNEL_BOT_SCOPES = Object.freeze([
    'user:read', 'chat:write', 'events:subscribe', 'channel:read', 'channel:write', 'moderation:ban', 'moderation:chat_message:manage',
    // Added 2026-11-20 (wave 2 group A): change channel rewards and accept or reject redemptions (docs.kick.com channel rewards).
    'channel:rewards:write',
]);

/** What each permission lets the stream bot (and Kick Defender) do. */
export const KICK_SCOPE_LABELS = Object.freeze({
    'user:read': 'Read your Kick account',
    'chat:write': 'Send chat messages and timers',
    'events:subscribe': 'Receive follows, subs and chat',
    'channel:read': 'Read your channel details',
    'channel:write': 'Change title and category',
    'moderation:ban': 'Ban and time out viewers',
    'moderation:chat_message:manage': 'Delete chat messages',
    'channel:rewards:write': 'Change channel rewards and redemptions',
});

export const KICK_BOT_RETURN_PATH = '/stream/bot/connections';
/** Same-origin path; /tokes-bot/auth/kick only accepts allow-listed return paths (sanitizeReturnTo). */
export const KICK_BOT_SIGNIN_PATH = `/tokes-bot/auth/kick?returnTo=${KICK_BOT_RETURN_PATH}`;

const baseUrl = () => (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
/** The full sign-in link, for messages that end up as plain text (run history, logs). */
export const kickBotSignInUrl = (base = baseUrl()) => `${String(base).replace(/\/+$/, '')}${KICK_BOT_SIGNIN_PATH}`;

export const kickScopeLabel = (scope) => KICK_SCOPE_LABELS[scope] || String(scope);
export const needsPermissionText = (scope) => `${kickScopeLabel(scope)}: needs permission`;

const scopeList = (scopes) => (Array.isArray(scopes) ? scopes : String(scopes || '').split(/[\s,]+/)).map(String).filter(Boolean);

/** Required scopes the sign-in lacks, in KICK_CHANNEL_BOT_SCOPES order. */
export function missingKickScopes(scopes) {
    const have = new Set(scopeList(scopes));
    return KICK_CHANNEL_BOT_SCOPES.filter((s) => !have.has(s)).map((scope) => ({ scope, label: kickScopeLabel(scope), text: needsPermissionText(scope) }));
}

/**
 * The Connections page's "Kick channel bot" row.
 * @param {object|null} row  { hasToken, needsRelink, defenderEnabled, scopes (string | string[] | null) }, or null when
 *                           no channel-bot sign-in exists for the channel
 * @returns {{ state: 'none'|'relink'|'unknown'|'missing'|'ok', label, tone, signedIn, needsRelink, defenderOff,
 *             missing: {scope,label,text}[], actionLabel: string|null, signInHref }}
 */
export function kickBotStatus(row) {
    const signedIn = !!(row && row.hasToken);
    const needsRelink = signedIn && !!row.needsRelink;
    const known = signedIn && scopeList(row.scopes).length > 0;
    const missing = known ? missingKickScopes(row.scopes) : [];
    const defenderOff = signedIn && !row.defenderEnabled;
    let state = 'ok';
    if (!signedIn) state = 'none';
    else if (needsRelink) state = 'relink';
    else if (!known) state = 'unknown';
    else if (missing.length) state = 'missing';
    const labels = {
        none: 'Not signed in',
        relink: 'Kick no longer accepts this sign-in: sign in again',
        unknown: 'Signed in; Kick did not say which permissions it gave',
        missing: `Signed in; ${missing.length} permission${missing.length === 1 ? '' : 's'} missing`,
        ok: 'Signed in with every permission',
    };
    const tones = { none: 'is-warn', relink: 'is-bad', unknown: 'is-warn', missing: 'is-warn', ok: 'is-ok' };
    const actions = { none: 'Sign in to Kick', relink: 'Sign in to Kick', unknown: 'Sign in to Kick', missing: 'Grant missing permissions', ok: null };
    return {
        state, label: labels[state], tone: tones[state], signedIn, needsRelink, defenderOff, missing,
        actionLabel: actions[state], signInHref: KICK_BOT_SIGNIN_PATH,
    };
}

/**
 * Why a stream bot Kick action cannot run, in the same plain words as the Connections page, with the sign-in link.
 * @param {object|null} channel  resolveChannel's answer ({ token, scopes[] }) or null (no sign-in, or Kick Defender off)
 * @param {string} [scope]       the scope the action needs
 * @returns {{ code: 'no_token'|'missing_scope', message: string, href: string, scope?: string }|null}
 */
export function kickBotProblem(channel, scope = null, { base } = {}) {
    const url = kickBotSignInUrl(base);
    if (!channel?.token) {
        return {
            code: 'no_token', href: KICK_BOT_SIGNIN_PATH,
            message: `Kick channel bot: not signed in, or Kick Defender is off for this channel. Sign in to Kick: ${url}`,
        };
    }
    // An empty scope list means Kick did not say (old sign-ins): let Kick decide rather than block the action.
    const have = scopeList(channel.scopes);
    if (scope && have.length && !have.includes(scope)) {
        return { code: 'missing_scope', scope, href: KICK_BOT_SIGNIN_PATH, message: `${needsPermissionText(scope)}. Grant it on Kick: ${url}` };
    }
    return null;
}

/** Kick answered 401: the stored sign-in is dead. */
export const kickBotRejectedMessage = (base) => `Kick channel bot: Kick no longer accepts the sign-in. Sign in to Kick again: ${kickBotSignInUrl(base)}`;

export default {
    KICK_CHANNEL_BOT_SCOPES, KICK_SCOPE_LABELS, KICK_BOT_RETURN_PATH, KICK_BOT_SIGNIN_PATH, kickBotSignInUrl, kickScopeLabel,
    needsPermissionText, missingKickScopes, kickBotStatus, kickBotProblem, kickBotRejectedMessage,
};
