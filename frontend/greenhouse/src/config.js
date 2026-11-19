// Where the game talks to. The build sets __GH_TARGET__ to 'web' (the /greenhouse page on the site) or
// 'panel' (the Twitch panel, served by Twitch from <client id>.ext-twitch.tv).
//
// Fetched URLs (Twitch guideline 2.12):
//   https://certifriedmultitool.com/gh-api/api/v2/...   the game API
//   wss://certifriedmultitool.com/gh-api/ws              live update hints (optional; polling works without)
// The Geist font ships with the game (no font host is contacted).
// When the page itself is served from 127.0.0.1 or localhost (the Developer Rig, local tests), the API is
// taken from that same origin instead.

/* global __GH_TARGET__ */
export const TARGET = typeof __GH_TARGET__ === 'string' ? __GH_TARGET__ : 'web';
export const IS_PANEL = TARGET === 'panel';

export const SITE_ORIGIN = 'https://certifriedmultitool.com';

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

function apiOrigin() {
    if (!IS_PANEL) return location.origin;
    return LOOPBACK.test(location.hostname) ? location.origin : SITE_ORIGIN;
}

export const API_BASE = `${apiOrigin()}/gh-api/api/v2`;
export const WS_URL = `${apiOrigin().replace(/^http/, 'ws')}/gh-api/ws`;

// Dashboard route that hands a logged-in Discord user a signed assertion (same origin as /greenhouse).
export const DISCORD_SESSION_PATH = '/greenhouse/session/discord';

export const POLL_VISIBLE_MS = 15_000;
export const POLL_HIDDEN_MS = 60_000;
export const AUTH_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;
