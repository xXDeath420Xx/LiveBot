/**
 * Greenhouse Tycoon (the v2 game, services/cfx/) on the website: the dashboard serves its page and the
 * Discord hand-off. The game API itself is a separate process (127.0.0.1:4021), reached publicly at
 * /gh-api/... through the front server, never through the dashboard.
 *
 *   GET /greenhouse                    the game page (frontend/greenhouse/dist/web/index.html), no-store,
 *                                      with its own strict CSP (no inline script or style)
 *   GET /greenhouse/assets/<file>      its built JS, CSS, icon and Geist fonts (font/woff2) with the font
 *                                      licence (Geist-OFL.txt); content-hashed names, cached a year
 *   GET /greenhouse/session/discord    a 60-second signed assertion for the Discord user logged in to
 *                                      the dashboard; the page posts it to /gh-api/api/v2/auth/discord.
 *                                      GET because the dashboard's CSRF check covers POST; JSON that only
 *                                      same-origin scripts can read; no side effect. (The old game keeps
 *                                      /game/session/discord until phase 5.)
 *
 * Assets come from the dashboard rather than the game service so the page, its files and its CSP have one
 * origin and one owner, and nothing new is needed in LiteSpeed: everything outside /cfx* and /gh-api* already
 * reaches the dashboard. Build the files with `node frontend/greenhouse/build.mjs --web`.
 *
 * Shared secret: CFX2_DASHBOARD_SECRET (32+ characters, read by the dashboard and the game service).
 * Mounted after passport (the Discord route needs req.user).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GREENHOUSE_DIST = path.resolve(HERE, '../../frontend/greenhouse/dist/web');
const PUBLIC_URL = () => (process.env.CFX2_PUBLIC_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');

/** CSP for the game page: its own files (the Geist font ships with them), the game API and its WebSocket on this site. */
export function greenhouseCsp(publicUrl = PUBLIC_URL()) {
    let ws = "'self'";
    try { ws = `wss://${new URL(publicUrl).host}`; } catch { /* keep 'self' */ }
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self' ${ws}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/** GET /greenhouse/session/discord */
export function greenhouseDiscordAssertion() {
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user?.id) {
            return res.status(401).json({
                error: { code: 'LOGIN_REQUIRED', message: 'Log in with Discord first' },
                loginUrl: '/auth/discord?returnTo=' + encodeURIComponent('/greenhouse?signin=discord')
            });
        }
        const secret = process.env.CFX2_DASHBOARD_SECRET || '';
        if (secret.length < 32) {
            return res.status(503).json({ error: { code: 'SIGNIN_UNAVAILABLE', message: 'Discord sign-in is not set up yet.' } });
        }
        if (!/^\d{17,20}$/.test(String(req.user.id))) {
            return res.status(400).json({ error: { code: 'SIGNIN_FAILED', message: 'Sign-in did not work. Please try again.' } });
        }
        const now = Math.floor(Date.now() / 1000);
        const name = String(req.user.globalName || req.user.global_name || req.user.username || '').slice(0, 64) || undefined;
        const assertion = jwt.sign(
            { name, iat: now, exp: now + 60, jti: crypto.randomBytes(18).toString('base64url') },
            secret,
            { algorithm: 'HS256', issuer: 'certifried-dashboard', audience: 'cfx2-discord', subject: String(req.user.id) });
        res.json({ assertion, exchangeUrl: '/gh-api/api/v2/auth/discord' });
    };
}

const NOT_BUILT = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Greenhouse Tycoon</title><link rel="stylesheet" href="/css/cf-ui.css"></head>
<body><main><h1>Greenhouse Tycoon</h1><p>The game is not available right now. Please try again later.</p></main></body></html>`;

/**
 * The site's colour theme on the game page's <html>, so it paints in the visitor's theme with no flash.
 * Dark (the default) and the other dark themes leave the page as built. Light and Sand use the game's light set
 * (the one the Twitch panel uses for Twitch's light theme); Sand adds its warm values (styles/web.css); Auto is
 * resolved in the browser (styles/web.css, src/web-theme.js). Website only: the panel never comes through here.
 */
const GAME_THEMES = Object.freeze({
    light: { attrs: ' data-theme="light"', scheme: 'light' },
    sand: { attrs: ' data-theme="light" data-theme-variant="sand"', scheme: 'light' },
    auto: { attrs: ' data-theme-mode="auto"', scheme: 'light dark' },
});
export function themedGreenhouseHtml(html, theme) {
    const t = Object.prototype.hasOwnProperty.call(GAME_THEMES, theme) ? GAME_THEMES[theme] : null;
    if (!t) return html;
    return String(html)
        .replace('<html lang="en">', `<html lang="en"${t.attrs}>`)
        .replace('<meta name="color-scheme" content="dark">', `<meta name="color-scheme" content="${t.scheme}">`);
}

/** Signed in: the theme saved in Settings. Signed out: the footer theme switch's choice (cookie ui-theme). */
async function siteThemeFor(req, loadPreferences) {
    if (req.user?.id) {
        try {
            const load = loadPreferences || (await import('../../core/user-preferences.js')).getPreferences;
            return (await load(req.user.id))?.theme || 'dark';
        } catch {
            return 'dark';
        }
    }
    const c = req.cookies?.['ui-theme'];
    return typeof c === 'string' && /^[a-z]{3,12}$/.test(c) ? c : 'dark';
}

/** GET /greenhouse: the built page, or a plain "not available" page (503) when it has not been built. */
export function greenhousePage({ dist = GREENHOUSE_DIST, loadPreferences = null } = {}) {
    const file = path.join(dist, 'index.html');
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Content-Security-Policy', greenhouseCsp());
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'same-origin');
        fs.readFile(file, 'utf8', async (err, html) => {
            if (err) return res.status(503).type('html').send(NOT_BUILT);
            const theme = await siteThemeFor(req, loadPreferences);
            res.type('html').send(themedGreenhouseHtml(html, theme));
        });
    };
}

export default function greenhouseRouter({ dist = GREENHOUSE_DIST } = {}) {
    const router = express.Router();
    router.get('/greenhouse/session/discord', greenhouseDiscordAssertion());
    router.use('/greenhouse/assets', express.static(path.join(dist, 'assets'), {
        index: false, redirect: false, dotfiles: 'deny', immutable: true, maxAge: '365d', fallthrough: true
    }));
    router.use('/greenhouse/assets', (req, res) => res.status(404).type('text/plain').send('Not found'));
    router.get(['/greenhouse', '/greenhouse/'], greenhousePage({ dist }));
    return router;
}
