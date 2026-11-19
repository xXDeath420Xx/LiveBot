// Greenhouse Tycoon (cfx v2), phase 5: the cutover switch. One environment flag, GREENHOUSE_LIVE.
//
// Without it (anything other than exactly "1") nothing changes: the bot starts the old game's server and jobs as
// before (frozen, register H-636), /game and /cfx keep going to it and /arcade cfx answers as it does today.
//
// With GREENHOUSE_LIVE=1 (read when asked, so tests can switch it):
//   - index.js does not start the old game server (port 4020), and the old game's jobs refuse to start;
//   - the dashboard answers /game, /game/*, /cfx, /cfx/* and /cfx-api/* itself (oldGameRoutes, mounted before the
//     old proxy): pages get a 301 to /greenhouse, API calls and files a 410 with the new address, and WebSocket
//     upgrades on those paths a 410;
//   - the old game server, if it is started anyway, answers every request that way (scope 'all'), so it cannot
//     serve an old page or the old API from behind LiteSpeed;
//   - /arcade cfx and the !cfx chat commands answer with one line saying where the game went.
// The runbook is docs/greenhouse-cutover.md.
import { oldGameMoved } from '../config/copy.js';
import { DEFAULT_PUBLIC_URL } from '../config/env.js';

export const GREENHOUSE_PATH = '/greenhouse';

// Browsers keep a 301 for as long as its Cache-Control allows. One day keeps a rollback (flag off) from being
// stuck in browsers for long.
const REDIRECT_CACHE = 'public, max-age=86400';

export function isGreenhouseLive(env = process.env) {
    return String(env.GREENHOUSE_LIVE ?? '').trim() === '1';
}

/** The public address of the new game, e.g. https://certifriedmultitool.com/greenhouse. */
export function greenhouseUrl(env = process.env) {
    return `${String(env.CFX2_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')}${GREENHOUSE_PATH}`;
}

/** The one line the old game's commands answer with once Greenhouse Tycoon is live. */
export function oldGameMovedMessage(env = process.env) {
    return oldGameMoved(greenhouseUrl(env));
}

function pathOf(url) {
    const s = String(url || '/');
    const q = s.indexOf('?');
    return q === -1 ? s : s.slice(0, q);
}

// The old game's public paths on the dashboard. Nothing else on the site starts with these (/games is not one).
const OLD_PATHS = /^\/(game|cfx|cfx-api)(\/|$)/;

// Old pages: the game page under each of its addresses, the old /cfx/*.html files and the bare prefixes.
const OLD_PAGE = /^\/(?:game(?:\/.*)?|cfx\/?|cfx\/[^/]+\.html|cfx-api\/?|cfx-api\/game\/?)$/;

/**
 * What an old-game request gets once the new game is live: { status: 301, location } for a page, else
 * { status: 410 }. scope 'dashboard' only answers the old paths (null for anything else); scope 'all' answers
 * every path (the old game server, where '/' and '/game' are pages and everything else is API or files).
 */
export function oldGameAnswer(method, url, { scope = 'dashboard' } = {}) {
    const p = pathOf(url);
    if (scope === 'dashboard' && !OLD_PATHS.test(p)) return null;
    const page = (method === 'GET' || method === 'HEAD') && (OLD_PAGE.test(p) || (scope === 'all' && p === '/'));
    return page ? { status: 301, location: GREENHOUSE_PATH } : { status: 410 };
}

/** Express middleware. A no-op (next()) unless GREENHOUSE_LIVE=1. */
export function oldGameRoutes({ scope = 'dashboard', env = process.env } = {}) {
    return (req, res, next) => {
        if (!isGreenhouseLive(env)) return next();
        const answer = oldGameAnswer(req.method, req.originalUrl || req.url, { scope });
        if (!answer) return next();
        if (answer.status === 301) {
            res.set('Cache-Control', REDIRECT_CACHE);
            return res.redirect(301, answer.location);
        }
        res.set('Cache-Control', 'no-store');
        const url = greenhouseUrl(env);
        return res.status(410).json({ error: { code: 'MOVED', message: oldGameMovedMessage(env), url } });
    };
}

/**
 * For a server's 'upgrade' event: refuses an old-game WebSocket with 410 and returns true when it did.
 * Returns false (and leaves the socket alone) unless GREENHOUSE_LIVE=1 and the path is the old game's.
 */
export function refuseOldGameUpgrade(req, socket, { scope = 'dashboard', env = process.env } = {}) {
    if (!isGreenhouseLive(env)) return false;
    const p = pathOf(req?.url);
    if (scope === 'dashboard' && !OLD_PATHS.test(p)) return false;
    try {
        socket.write('HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } finally {
        socket.destroy();
    }
    return true;
}
