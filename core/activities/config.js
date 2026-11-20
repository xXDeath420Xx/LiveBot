/*
 * Discord Activities (docs/activities.md): Watch Together and Greenhouse Tycoon inside Discord. Settings from .env.
 *
 *   ACTIVITIES_ENABLED=1        the switch. Without it /movie keeps using the old Go Live stream and the Activity page
 *                               says Activities are not switched on. Set it only after the Developer Portal steps.
 *   ACTIVITY_APP_ID             the Discord application that has Activities on. Default: DISCORD_CLIENT_ID (the bot).
 *   ACTIVITY_CLIENT_SECRET      its OAuth2 client secret. Default: DASHBOARD_CLIENT_SECRET when the dashboard signs in
 *                               with the same application (it does today), else DISCORD_CLIENT_SECRET.
 *   ACTIVITY_BOT_TOKEN          a bot token of that application, for Discord's activity-instance check. Default:
 *                               DISCORD_TOKEN when the application is the bot's.
 *   ACTIVITY_PUBLIC_KEY         that application's public key (proxy signature check). Default: DISCORD_PUBLIC_KEY.
 *   ACTIVITY_SESSION_SECRET     signs Activity sessions and media links (32+ characters). Default: derived from
 *                               SESSION_SECRET, so nothing new is needed.
 *   WATCH_MAX_SESSIONS          films playing at once across every server (default 2). Each one is a stream (and,
 *                               for HEVC files, a transcode) on the PC that runs Jellyfin.
 *   WATCH_MAX_VIEWERS           people in one Watch Together session (default 25)
 *   WATCH_MAX_BITRATE_KBPS      the stream's ceiling (default 6000). Files above it are transcoded down.
 *   WATCH_SEGMENT_CACHE_MB      memory for video pieces shared by everyone in a session (default 512)
 *   JELLYFIN_USER_ID            the Jellyfin user PlaybackInfo runs as. Default: the first administrator.
 *
 * Never logged and never sent to a browser: the client secret, the bot token, the session secret, the Jellyfin key.
 */
import crypto from 'node:crypto';

const int = (raw, fallback, min, max) => {
    const n = Number.parseInt(String(raw ?? ''), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const SNOWFLAKE = /^\d{17,20}$/;

export function activityConfig(env = process.env) {
    const botApp = String(env.DISCORD_CLIENT_ID || '').trim();
    const appId = String(env.ACTIVITY_APP_ID || botApp).trim();
    const sameAsBot = !!appId && appId === botApp;
    const sameAsDashboard = !!appId && String(env.DASHBOARD_CLIENT_ID || '').trim() === appId;
    const clientSecret = env.ACTIVITY_CLIENT_SECRET
        || (sameAsDashboard ? env.DASHBOARD_CLIENT_SECRET : '')
        || (sameAsBot ? env.DISCORD_CLIENT_SECRET : '')
        || '';
    let sessionSecret = String(env.ACTIVITY_SESSION_SECRET || '');
    if (sessionSecret.length < 32) {
        sessionSecret = env.SESSION_SECRET
            ? crypto.createHmac('sha256', String(env.SESSION_SECRET)).update('certifried-activity-session-v1').digest('base64url')
            : '';
    }
    const site = String(env.CFX2_PUBLIC_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
    return Object.freeze({
        enabled: env.ACTIVITIES_ENABLED === '1',
        appId: SNOWFLAKE.test(appId) ? appId : '',
        clientSecret: String(clientSecret),
        botToken: String(env.ACTIVITY_BOT_TOKEN || (sameAsBot ? env.DISCORD_TOKEN || '' : '')),
        publicKey: String(env.ACTIVITY_PUBLIC_KEY || (sameAsBot ? env.DISCORD_PUBLIC_KEY || '' : '')).toLowerCase(),
        sessionSecret,
        siteUrl: site,
        sessionTtlSec: 4 * 3600,
        watch: Object.freeze({
            maxSessions: int(env.WATCH_MAX_SESSIONS, 2, 1, 20),
            maxViewers: int(env.WATCH_MAX_VIEWERS, 25, 2, 200),
            maxBitrateKbps: int(env.WATCH_MAX_BITRATE_KBPS, 6000, 1000, 40000),
            cacheMb: int(env.WATCH_SEGMENT_CACHE_MB, 512, 32, 4096),
            // Nobody connected for this long: the session ends and Jellyfin's transcode is stopped.
            idleEndSec: int(env.WATCH_IDLE_END_SEC, 120, 30, 3600),
            // The host has been gone this long: the longest-connected viewer becomes host.
            hostHandoverSec: 60,
        }),
        jellyfin: Object.freeze({
            base: String(env.JELLYFIN_URL || '').replace(/\/+$/, ''),
            apiKey: String(env.JELLYFIN_API_KEY || ''),
            userId: /^[0-9a-f-]{32,36}$/i.test(String(env.JELLYFIN_USER_ID || '')) ? String(env.JELLYFIN_USER_ID) : '',
        }),
    });
}

/** What the Activity page and the bot may know (no secrets). */
export function publicActivityInfo(cfg = activityConfig()) {
    return { enabled: cfg.enabled, appId: cfg.appId };
}

/** Why the Activity cannot run, or null. Said to the owner (logs, /movie) — never contains a secret. */
export function activityProblem(cfg = activityConfig()) {
    if (!cfg.enabled) return 'Activities are not switched on (ACTIVITIES_ENABLED=1 in .env, after the Developer Portal steps in docs/activities.md).';
    if (!cfg.appId) return 'No Discord application id (DISCORD_CLIENT_ID or ACTIVITY_APP_ID).';
    if (!cfg.clientSecret) return 'No OAuth2 client secret for the Activity application (ACTIVITY_CLIENT_SECRET).';
    if (!cfg.sessionSecret) return 'No session secret (SESSION_SECRET or ACTIVITY_SESSION_SECRET).';
    return null;
}
