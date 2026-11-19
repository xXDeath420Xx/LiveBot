// Windrose friend panel.
//   GET  /windrose                    — join page + live panel (Discord-authed)
//   GET  /windrose/api/status         — cached status (2s TTL in the agent)
//   GET  /windrose/api/livemap        — sea chart data
//   GET  /windrose/api/console        — join/leave + console feed
//   GET  /windrose/api/commands       — autocomplete catalog (admin+)
//   POST /windrose/api/rcon           — run a command (admin+, allowlisted)
//   POST /windrose/api/lifecycle/:op  — start | stop | restart (admin+)
//   POST /windrose/api/backup         — take a snapshot (admin+)
//
// Everything privileged goes through requireRole and is written to
// windrose_audit. Windrose+ itself has one shared password and no identity;
// this route group is where actions become attributable.
import express from 'express';
import rateLimit from 'express-rate-limit';
import windroseAgent from '../services/windrose-client.js';
import {
    requireRole, getRole, audit, isCommandAllowed, catalogNames, roleAtLeast,
} from '../services/windrose-perms.js';
import logger from '../../utils/logger.js';

const router = express.Router();

// Tighter than the global apiLimiter: every call here fans out to the agent,
// and RCON in particular is serialised at ~1/s upstream. Letting a tab hammer
// it would starve everyone else on the panel.
const panelLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down.' },
});

const actionLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many actions — slow down.' },
});

/** Send an agent result as JSON, mapping the unreachable case to 503. */
function respond(res, result) {
    if (result.ok) return res.json(result.data);
    if (result.agentUnreachable) {
        // 503 rather than 500: the panel shows "backend offline" instead of a
        // generic error, and the browser knows to keep polling.
        return res.status(503).json({ error: result.error, agentOffline: true });
    }
    return res.status(result.status || 500).json({ error: result.error });
}

// ---------------------------------------------------------------- page

router.get('/windrose', requireRole('viewer'), async (req, res) => {
    const result = await windroseAgent.status();

    res.render('windrose', {
        user: req.user,
        role: req.windroseRole,
        canAdmin: roleAtLeast(req.windroseRole, 'admin'),
        canOwn: roleAtLeast(req.windroseRole, 'owner'),
        // Render with whatever we have; the page polls and self-corrects, so a
        // cold or offline agent still produces a usable page rather than a 500.
        initialStatus: result.ok ? result.data : null,
        agentOffline: Boolean(result.agentUnreachable),
    });
});

// ---------------------------------------------------------------- read APIs

router.get('/windrose/api/status', panelLimiter, requireRole('viewer'), async (req, res) => {
    respond(res, await windroseAgent.status());
});

router.get('/windrose/api/livemap', panelLimiter, requireRole('viewer'), async (req, res) => {
    respond(res, await windroseAgent.livemap());
});

router.get('/windrose/api/console', panelLimiter, requireRole('viewer'), async (req, res) => {
    respond(res, await windroseAgent.consoleHistory());
});

router.get('/windrose/api/stats', panelLimiter, requireRole('admin'), async (req, res) => {
    respond(res, await windroseAgent.stats());
});

router.get('/windrose/api/commands', panelLimiter, requireRole('admin'), async (req, res) => {
    const result = await windroseAgent.commands();
    if (!result.ok) return respond(res, result);
    // Hand the browser only what this role may actually run, so autocomplete
    // never suggests a command the server will refuse.
    const names = catalogNames(result.data);
    res.json({ commands: names.filter((n) => isCommandAllowed(req.windroseRole, n, names).allowed) });
});

// ---------------------------------------------------------------- actions

router.post('/windrose/api/rcon', actionLimiter, requireRole('admin'), async (req, res) => {
    const { command } = req.body || {};

    // Authorise against the live catalog. Fetching it costs nothing — the agent
    // caches it for 60s and it comes off disk, not RCON.
    const catalogResult = await windroseAgent.commands();
    const names = catalogResult.ok ? catalogNames(catalogResult.data) : null;

    const verdict = isCommandAllowed(req.windroseRole, command, names);
    if (!verdict.allowed) {
        await audit(req.user.id, 'rcon.denied', { command, reason: verdict.reason }, 'denied');
        return res.status(403).json({ error: verdict.reason });
    }

    const result = await windroseAgent.rcon(command);
    await audit(req.user.id, 'rcon', { command: verdict.command }, result.ok ? 'ok' : 'error');
    respond(res, result);
});

const LIFECYCLE = { start: 'start', stop: 'stop', restart: 'restart' };

router.post('/windrose/api/lifecycle/:op', actionLimiter, requireRole('admin'), async (req, res) => {
    const op = LIFECYCLE[req.params.op];
    if (!op) return res.status(400).json({ error: 'unknown lifecycle operation' });

    const immediate = Boolean(req.body?.immediate);
    await audit(req.user.id, `lifecycle.${op}`, { immediate }, 'ok');

    if (op === 'restart' && !immediate) {
        // The graceful path warns players at T-5m and T-1m, so it runs for
        // minutes. Fire and acknowledge — holding the request open would just
        // time out somewhere in the proxy chain.
        windroseAgent.restart(false).catch((err) => logger.error(`windrose restart failed: ${err.message}`));
        return res.json({ started: true, graceful: true, note: 'Players are being warned; restart in ~5 minutes.' });
    }

    const result = op === 'restart' ? await windroseAgent.restart(true) : await windroseAgent[op]();
    respond(res, result);
});

router.post('/windrose/api/backup', actionLimiter, requireRole('admin'), async (req, res) => {
    const result = await windroseAgent.snapshot({ kind: 'manual', createdBy: req.user.id, label: null });
    await audit(req.user.id, 'backup.snapshot', result.ok ? result.data : null, result.ok ? 'ok' : 'error');
    respond(res, result);
});

export default router;
