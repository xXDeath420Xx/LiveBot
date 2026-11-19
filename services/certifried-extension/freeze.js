/**
 * CertiFried Tycoon freeze (overhaul phase 0, H-636).
 *
 * The old game is frozen until v2 replaces it. One switch: CFX_FROZEN.
 *   - Frozen unless CFX_FROZEN is exactly "0", so a restart with a missing or mistyped value can't
 *     silently unfreeze the game.
 *   - Read at call time, so every check sees the same value the process was started with.
 *
 * While frozen:
 *   - API: every POST/PUT/PATCH/DELETE answers 503 {code:'FROZEN', message}, except the sign-in and
 *     session routes under /auth. GETs keep working, apart from the few that tick the game or write
 *     rows (FROZEN_GETS below). GET /status tells the website and the panel to show the frozen screen.
 *   - No game jobs start (jobs/index.js); seasons neither roll over nor pay out (season-system.js).
 *   - GET /game/state is a pure read: no offline catch-up, quest assignment, achievement payouts,
 *     heat update, slot creation or "last online" touch.
 *   - Discord /arcade cfx and the Twitch/Kick !cfx commands only answer with FROZEN_MESSAGE.
 *   - The boot-time game data fix-up SQL is skipped and the retention sweeper leaves cfx_* tables
 *     alone, so nothing is changed or deleted before the phase 5 archive.
 */

export const FROZEN_MESSAGE = 'CertiFried Tycoon is being rebuilt. The new game is coming soon.';

export function isFrozen() {
    return String(process.env.CFX_FROZEN ?? '').trim() !== '0';
}

// Writes that keep working while frozen: sign-in, token refresh and the Twitch/Kick OAuth routes.
const ALLOWED_WRITES = [/^\/auth\//];

// GETs that are really ticks or writes (offline catch-up, rows created on read, war resolution,
// reputation awards). Found by tracing every GET handler to its SQL (2026-11-18). The website and the
// panel never call them while frozen; an old cached client gets the FROZEN answer.
const FROZEN_GETS = [
    /^\/game\/tick\/?$/,
    /^\/automation\/?$/,
    /^\/bits\/products\/?$/,
    /^\/dispensary\/?$/,
    /^\/extraction\/?$/,
    /^\/grow\/slots\/?$/,
    /^\/locations\/?$/,
    /^\/mutations\/?$/,
    /^\/raid\/status\/?$/,
    /^\/reputation\/[^/]+\/?$/,
    /^\/stats\/?$/,
    /^\/territories\/wars\/[^/]+\/?$/,
    /^\/vault\/?$/,
    /^\/workers\/logs\/?$/,
    /^\/workers\/config\/?$/
];

export function frozenBody() {
    return { code: 'FROZEN', message: FROZEN_MESSAGE };
}

function refuse(res) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).json(frozenBody());
}

/** Whether a request on the /api/v1 router is refused while frozen (path relative to /api/v1). */
export function isRefusedWhileFrozen(method, path) {
    const m = String(method || '').toUpperCase();
    const p = String(path || '/');
    if (m === 'OPTIONS') return false;
    if (m === 'GET' || m === 'HEAD') return FROZEN_GETS.some(re => re.test(p));
    return !ALLOWED_WRITES.some(re => re.test(p));
}

/** Mounted at the top of the /api/v1 router (server.js), before auth and the rate limiter. */
export function freezeMiddleware(req, res, next) {
    if (!isFrozen()) return next();
    if (isRefusedWhileFrozen(req.method, req.path)) return refuse(res);
    return next();
}

/** GET /api/v1/status (public, no auth): the one cheap check the website and the panel make first. */
export function statusHandler(req, res) {
    const frozen = isFrozen();
    res.set('Cache-Control', 'no-store');
    res.json({ frozen, message: frozen ? FROZEN_MESSAGE : null });
}

export default { FROZEN_MESSAGE, isFrozen, isRefusedWhileFrozen, freezeMiddleware, statusHandler, frozenBody };
