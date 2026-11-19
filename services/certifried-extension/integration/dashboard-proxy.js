/**
 * Public access to the game through the dashboard (H-411).
 *
 * The dashboard is what the website serves, so it forwards:
 *   GET /game                 -> CFX /game        (the web app page)
 *   /cfx/api/*                -> CFX /api/*       (REST API, any method; the game's own JWT auth applies)
 *   /cfx/dist/*               -> CFX /dist/*      (built JS/CSS/images)
 *   /cfx/health               -> CFX /health
 *   /cfx/ws  (upgrade)        -> CFX /ws          (WebSocket; token in the query string as before)
 *   GET /cfx, /cfx/           -> 302 /game        (the old link in /arcade cfx play)
 *   /cfx-api/{api,dist,game,health,ws} -> CFX unchanged (the older public address; today the
 *                             site edge sends it straight to port 4020, but once the edge sends it
 *                             here the game server can listen on 127.0.0.1 only)
 * to 127.0.0.1:CFX_PORT, and adds
 *   GET /cfx/session/discord  game tokens for the Discord user logged in to the dashboard
 *                             (the same player the Discord commands use; H-407)
 *
 * The proxy is mounted before the dashboard's session, rate limiter and body
 * parsers, so request bodies stream through untouched and the dashboard's
 * cookie never reaches the game server. The Discord route is mounted after
 * passport (it needs req.user).
 */

import http from 'http';
import logger from '../../../utils/logger.js';
import { refuseOldGameUpgrade } from '../../cfx/integrations/cutover.js';

const cfxPort = () => parseInt(process.env.CFX_PORT || '4020', 10);

const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie'
]);

/**
 * Map a public URL (path + query) to the game server path. Pure; tested.
 * @returns {{ path: string } | { redirect: string } | null}  null = not ours
 */
export function mapCfxPath(url) {
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    const query = q === -1 ? '' : url.slice(q);
    if (pathname === '/game' || pathname === '/game/') return { path: `/game${query}` };
    if (pathname === '/cfx' || pathname === '/cfx/') return { redirect: '/game' };
    if (pathname.startsWith('/cfx-api/')) {
        const sub = pathname.slice(8);
        if (sub.includes('..') || sub.includes('\\')) return null;
        if (['/ws', '/health', '/game', '/game/'].includes(sub) || sub.startsWith('/api/') || sub.startsWith('/dist/')) {
            return { path: `${pathname}${query}` };
        }
        return null;
    }
    if (!pathname.startsWith('/cfx/')) return null;
    const rest = pathname.slice(4); // keeps the leading '/'
    if (rest.includes('..') || rest.includes('\\')) return null;
    if (rest === '/ws' || rest === '/health') return { path: `${rest}${query}` };
    if (rest.startsWith('/api/') || rest.startsWith('/dist/')) return { path: `${rest}${query}` };
    return null;
}

/** True for a mapped path that is the game's WebSocket endpoint. */
export function isWsPath(path) {
    return /^\/(cfx-api\/)?ws(\?|$)/.test(path || '');
}

function clientIp(req) {
    return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '').trim();
}

function forwardHeaders(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    }
    out.host = `127.0.0.1:${cfxPort()}`;
    out['x-forwarded-for'] = clientIp(req);
    out['x-forwarded-proto'] = 'https';
    out['x-forwarded-host'] = req.headers.host || '';
    return out;
}

/** Express middleware for the HTTP routes above. */
export function cfxProxy() {
    return (req, res, next) => {
        const mapped = mapCfxPath(req.originalUrl || req.url);
        if (!mapped) return next();
        if (mapped.redirect) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            return res.redirect(302, mapped.redirect);
        }
        if (/^\/(cfx-api\/)?game/.test(mapped.path) && req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (isWsPath(mapped.path)) return next(); // only as an upgrade

        const proxyReq = http.request({
            host: '127.0.0.1',
            port: cfxPort(),
            method: req.method,
            path: mapped.path,
            headers: forwardHeaders(req)
        }, (proxyRes) => {
            res.status(proxyRes.statusCode || 502);
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (k === 'connection' || k === 'transfer-encoding' || k === 'keep-alive') continue;
                // The game server's own security headers win for its responses, except that the
                // dashboard's CSP stays on the /game page (the page is built to work under it).
                if (k === 'content-security-policy') continue;
                res.setHeader(k, v);
            }
            proxyRes.pipe(res);
        });
        proxyReq.setTimeout(30_000, () => proxyReq.destroy(new Error('timeout')));
        proxyReq.on('error', (err) => {
            logger.debug('[CFX proxy] Upstream error', { path: mapped.path, error: err.message });
            if (!res.headersSent) {
                res.status(502).json({ error: 'The game server is not responding. Try again in a minute.', code: 'GAME_OFFLINE' });
            } else {
                res.destroy();
            }
        });
        req.on('aborted', () => proxyReq.destroy());
        req.pipe(proxyReq);
    };
}

/** WebSocket upgrades for /cfx/ws (and /cfx-api/ws). Other upgrade paths (Socket.io) are left alone. */
export function attachCfxUpgrade(server) {
    server.on('upgrade', (req, socket, head) => {
        const mapped = mapCfxPath(req.url || '');
        if (!mapped?.path || !isWsPath(mapped.path)) return;
        if (refuseOldGameUpgrade(req, socket)) return; // GREENHOUSE_LIVE=1: the old game is gone (410)

        const headers = forwardHeaders(req);
        headers.connection = 'Upgrade';
        headers.upgrade = req.headers.upgrade || 'websocket';
        const proxyReq = http.request({ host: '127.0.0.1', port: cfxPort(), method: 'GET', path: mapped.path, headers });

        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || 'Switching Protocols'}`];
            for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
                lines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
            }
            socket.write(lines.join('\r\n') + '\r\n\r\n');
            if (proxyHead?.length) socket.write(proxyHead);
            if (head?.length) proxySocket.write(head);
            proxySocket.on('error', () => socket.destroy());
            socket.on('error', () => proxySocket.destroy());
            proxySocket.pipe(socket);
            socket.pipe(proxySocket);
        });
        proxyReq.on('response', (proxyRes) => {
            // Upgrade refused (bad path or auth): pass the status on and close
            socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\nConnection: close\r\n\r\n`);
            socket.destroy();
        });
        proxyReq.on('error', () => {
            socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            socket.destroy();
        });
        socket.on('error', () => proxyReq.destroy());
        proxyReq.end();
    });
}

/**
 * GET /cfx/session/discord - game tokens for the dashboard's logged-in Discord user.
 * GET because the dashboard's CSRF check covers POST; the response is JSON that only
 * same-origin scripts can read, and the only side effect is creating the player.
 */
export function cfxDiscordSession() {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!req.user?.id) {
            return res.status(401).json({
                error: 'Log in with Discord first',
                code: 'LOGIN_REQUIRED',
                loginUrl: '/auth/discord?returnTo=' + encodeURIComponent('/game?signin=discord')
            });
        }
        try {
            const { createDiscordSession } = await import('../routes/auth.js');
            const session = await createDiscordSession(req.user);
            res.json({ success: true, ...session });
        } catch (error) {
            if (error.code === 'BANNED') return res.status(403).json({ error: 'This account is banned from the game', code: 'BANNED' });
            logger.error('[CFX proxy] Discord session failed', { error: error.message });
            res.status(500).json({ error: 'Could not sign you in. Try again.', code: 'ERROR' });
        }
    };
}

export default { cfxProxy, attachCfxUpgrade, cfxDiscordSession, mapCfxPath, isWsPath };
