// Greenhouse Tycoon (cfx v2): environment settings. All names start with CFX2_ so they never collide with
// the old game's CFX_* variables. See services/cfx/README.md for the list.
//
// Sign-in secrets fall back to the names the bot already uses (TWITCH_EXT_SECRET, TWITCH_CLIENT_ID, ...),
// so the owner only sets CFX2_* to override them.
import { assertPrefix, DEFAULT_PREFIX } from '../store/schema.js';

// The Twitch panel extension (console client id). Its hosted files run on https://<id>.ext-twitch.tv.
export const DEFAULT_TWITCH_EXT_CLIENT_ID = '7k7fn5nym3jx13sdl4d56yxlu0cytp';
export const DEFAULT_PUBLIC_URL = 'https://certifriedmultitool.com';
// Public path prefix the front server (LiteSpeed) sends to this service; see README "Public paths".
export const PUBLIC_PREFIX = '/gh-api';

function intEnv(env, name, fallback, min, max) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be a whole number`);
    const n = Number(raw);
    if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return n;
}

function pick(env, ...names) {
    for (const n of names) if (env[n]) return String(env[n]);
    return '';
}

/** The extension secret is shown base64-encoded in the Twitch console; JWTs are signed with the raw bytes. */
function extSecret(raw) {
    if (!raw) return null;
    const buf = Buffer.from(raw, 'base64');
    return buf.length >= 16 ? buf : null;
}

export function loadConfig(env = process.env) {
    const host = env.CFX2_HOST || '127.0.0.1';
    const port = intEnv(env, 'CFX2_PORT', 4021, 1, 65535);
    const tablePrefix = assertPrefix(env.CFX2_TABLE_PREFIX || DEFAULT_PREFIX);
    const jwtSecret = env.CFX2_JWT_SECRET || '';
    if (jwtSecret.length < 32) throw new Error('CFX2_JWT_SECRET must be set (at least 32 characters)');
    const sessionTtlSec = intEnv(env, 'CFX2_SESSION_TTL_SEC', 3600, 60, 86_400);
    const refreshTtlSec = intEnv(env, 'CFX2_REFRESH_TTL_SEC', 30 * 86_400, 3600, 90 * 86_400);
    let publicUrl = env.CFX2_PUBLIC_URL || DEFAULT_PUBLIC_URL;
    let publicOrigin;
    try {
        const u = new URL(publicUrl);
        if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1') throw new Error('not https');
        publicOrigin = u.origin;
        publicUrl = u.origin;
    } catch {
        throw new Error('CFX2_PUBLIC_URL must be an https origin, e.g. https://certifriedmultitool.com');
    }
    const gamePath = env.CFX2_GAME_PATH || '/greenhouse';
    if (!/^\/[A-Za-z0-9/_-]{0,63}$/.test(gamePath)) throw new Error('CFX2_GAME_PATH must be a path like /greenhouse');
    const dashboardSecret = env.CFX2_DASHBOARD_SECRET || '';
    return Object.freeze({
        host,
        port,
        tablePrefix,
        jwtSecret,
        sessionTtlSec,
        refreshTtlSec,
        publicUrl,
        publicOrigin,
        publicPrefix: PUBLIC_PREFIX,
        gamePath,
        jobsDisabled: env.CFX2_JOBS_DISABLED || '',
        allowDevPlatform: env.CFX2_ALLOW_DEV_SIGNIN === '1' && (host === '127.0.0.1' || host === '::1'),
        twitchExt: Object.freeze({
            clientId: env.CFX2_TWITCH_EXT_CLIENT_ID || DEFAULT_TWITCH_EXT_CLIENT_ID,
            secret: extSecret(pick(env, 'CFX2_TWITCH_EXT_SECRET', 'TWITCH_EXT_SECRET'))
        }),
        twitchOAuth: Object.freeze({
            clientId: pick(env, 'CFX2_TWITCH_CLIENT_ID', 'TWITCH_CLIENT_ID'),
            clientSecret: pick(env, 'CFX2_TWITCH_CLIENT_SECRET', 'TWITCH_CLIENT_SECRET')
        }),
        kickOAuth: Object.freeze({
            clientId: pick(env, 'CFX2_KICK_CLIENT_ID', 'KICK_CLIENT_ID'),
            clientSecret: pick(env, 'CFX2_KICK_CLIENT_SECRET', 'KICK_CLIENT_SECRET')
        }),
        // Shared with the dashboard, which signs a 60-second assertion for its logged-in Discord user.
        dashboardSecret: dashboardSecret.length >= 32 ? dashboardSecret : ''
    });
}
