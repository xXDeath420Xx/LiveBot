// Windrose owner console — /wrmanager
//
// Mounted at the top level rather than under /windrose so the friend panel and
// the manager gate independently: /windrose is viewer+, everything here is
// owner-only, and no path-prefix accident can blur that.
//
// Every route is behind requireRole('owner') and every mutation is audited.
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { createReadStream } from 'node:fs';
import windroseAgent, { uploadSave, uploadFile, downloadFileUrl } from '../services/windrose-client.js';
import { requireRole, audit, listUsers, setRole, linkSteamId, recentAudit, ROLES } from '../services/windrose-perms.js';
import { stage, listPending, discard, applyPending } from '../services/windrose-staging.js';
import { recordBackup, forgetBackups, annotateBackups } from '../services/windrose-backups-ledger.js';
import logger from '../../utils/logger.js';

const router = express.Router();
const owner = requireRole('owner');

const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const actionLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

function respond(res, result) {
    if (result.ok) return res.json(result.data);
    if (result.agentUnreachable) return res.status(503).json({ error: result.error, agentOffline: true });
    return res.status(result.status || 500).json({ error: result.error });
}

/** Wrap a handler so a thrown error becomes JSON instead of an unhandled rejection. */
function guard(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            logger.error(`wrmanager ${req.method} ${req.path}: ${err.message}`);
            if (!res.headersSent) res.status(400).json({ error: err.message });
        }
    };
}

// ---------------------------------------------------------------- page

router.get('/wrmanager', owner, guard(async (req, res) => {
    const [status, config, backups, pending] = await Promise.all([
        windroseAgent.status(),
        windroseAgent.config(),
        windroseAgent.backups(),
        listPending(),
    ]);

    res.render('wrmanager', {
        user: req.user,
        role: req.windroseRole,
        roles: ROLES,
        initialStatus: status.ok ? status.data : null,
        agentOffline: Boolean(status.agentUnreachable),
        config: config.ok ? config.data : null,
        backups: backups.ok ? await annotateBackups(backups.data) : [],
        pending,
    });
}));

// ---------------------------------------------------------------- people

router.get('/wrmanager/api/users', limiter, owner, guard(async (req, res) => {
    res.json({ users: await listUsers() });
}));

router.post('/wrmanager/api/users/role', actionLimiter, owner, guard(async (req, res) => {
    const { discordId, role } = req.body || {};
    if (!/^\d{17,20}$/.test(discordId || '')) throw new Error('discordId must be a Discord snowflake');

    // Refusing self-demotion is not paternalism: owner is the only role that
    // can grant roles, so an owner demoting themselves with no other owner
    // present locks the server's controls away permanently.
    if (discordId === req.user.id && role !== 'owner') {
        const owners = (await listUsers()).filter((u) => u.role === 'owner');
        if (owners.length <= 1) throw new Error('you are the only owner — promote someone else before demoting yourself');
    }

    const out = await setRole(discordId, role, { grantedBy: req.user.id });
    await audit(req.user.id, 'role.grant', { target: discordId, role }, 'ok');
    res.json(out);
}));

router.post('/wrmanager/api/users/steam', actionLimiter, owner, guard(async (req, res) => {
    const { discordId, steamId } = req.body || {};
    const out = await linkSteamId(discordId, steamId);
    await audit(req.user.id, 'steam.link', { target: discordId, steamId }, 'ok');
    res.json(out);
}));

// ---------------------------------------------------------------- config staging

router.get('/wrmanager/api/config', limiter, owner, guard(async (req, res) => {
    const [config, pending] = await Promise.all([windroseAgent.config(), listPending()]);
    if (!config.ok) return respond(res, config);
    res.json({ ...config.data, pending });
}));

router.post('/wrmanager/api/config/stage', actionLimiter, owner, guard(async (req, res) => {
    const { target, patch } = req.body || {};
    const out = await stage(target, patch, req.user.id);
    await audit(req.user.id, 'config.stage', { target, patch }, 'ok');
    res.json(out);
}));

router.delete('/wrmanager/api/config/stage/:id', actionLimiter, owner, guard(async (req, res) => {
    const out = await discard(Number(req.params.id));
    await audit(req.user.id, 'config.discard', { id: req.params.id }, 'ok');
    res.json(out);
}));

router.post('/wrmanager/api/config/apply', actionLimiter, owner, guard(async (req, res) => {
    // Runs stop → write → start, so it takes a while and disconnects everyone.
    await audit(req.user.id, 'config.apply', null, 'ok');
    const out = await applyPending(req.user.id);
    res.json(out);
}));

// ---------------------------------------------------------------- backups

// Each entry carries kind, label, reason, createdBy and createdByName from the backup ledger
// (services/windrose-backups-ledger.js), so the list can say who took a snapshot and why.
router.get('/wrmanager/api/backups', limiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.backups();
    if (!out.ok) return respond(res, out);
    res.json(await annotateBackups(out.data));
}));

router.post('/wrmanager/api/backups', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.snapshot({ kind: 'manual', createdBy: req.user.id, label: req.body?.label ?? null });
    if (out.ok) await recordBackup({ ...out.data, createdBy: req.user.id });
    await audit(req.user.id, 'backup.snapshot', out.ok ? out.data : null, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/backups/prune', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.pruneBackups(Number(req.body?.keep) || 30);
    if (out.ok) await forgetBackups(out.data?.removed || []);
    await audit(req.user.id, 'backup.prune', { keep: req.body?.keep }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/backups/restore', actionLimiter, owner, guard(async (req, res) => {
    const { filename, confirm } = req.body || {};
    // Typed confirmation, server-side. A client-only confirm is a suggestion;
    // this is the last thing standing between a stray click and a destroyed world.
    if (confirm !== 'RESTORE') throw new Error('type RESTORE to confirm — this replaces the live world');

    const out = await windroseAgent.restoreBackup(filename);
    // The agent snapshots the outgoing world first; that snapshot is this owner's doing.
    const prior = out.ok ? out.data?.priorSnapshot : null;
    if (prior?.filename) await recordBackup({ ...prior, kind: 'pre-restore', createdBy: req.user.id });
    await audit(req.user.id, 'backup.restore', { filename }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

// ---------------------------------------------------------------- files & mods

router.get('/wrmanager/api/files', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.listFiles(req.query.path));
}));

router.get('/wrmanager/api/file', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.readFile(req.query.path));
}));

router.post('/wrmanager/api/file', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.writeFile(req.body?.path, req.body?.content);
    await audit(req.user.id, 'file.write', { path: req.body?.path }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.delete('/wrmanager/api/file', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.deleteFile(req.body?.path);
    await audit(req.user.id, 'file.delete', { path: req.body?.path }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.get('/wrmanager/api/mods', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.listMods());
}));

router.post('/wrmanager/api/mods', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.installMod(req.body || {});
    await audit(req.user.id, 'mod.install', { name: req.body?.name }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.delete('/wrmanager/api/mods', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.removeMod(req.body?.name);
    await audit(req.user.id, 'mod.remove', { name: req.body?.name }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

// ---------------------------------------------------------------- ops

router.get('/wrmanager/api/stats', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.stats());
}));

router.get('/wrmanager/api/logs', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.logs(Math.min(Number(req.query.tail) || 200, 1000)));
}));

router.get('/wrmanager/api/audit', limiter, owner, guard(async (req, res) => {
    res.json({ entries: await recentAudit({ limit: req.query.limit, action: req.query.action || null }) });
}));

// ---------------------------------------------------------------- watchdog

router.get('/wrmanager/api/watchdog', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.watchdog());
}));

// ---------------------------------------------------------------- advanced INI

router.get('/wrmanager/api/ini', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.iniSummary());
}));

router.get('/wrmanager/api/ini/file', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.iniFile(String(req.query.name || '')));
}));

router.get('/wrmanager/api/ini/search', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.iniSearch(String(req.query.q || '')));
}));

router.post('/wrmanager/api/ini/file', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.iniSet(req.body?.name, req.body?.patch ?? {});
    // Record the key names, not a 2,000-entry blob.
    await audit(req.user.id, 'ini.set', { file: req.body?.name, keys: Object.keys(req.body?.patch ?? {}) }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/ini/reset', actionLimiter, owner, guard(async (req, res) => {
    if (req.body?.confirm !== 'RESET') throw new Error('type RESET to confirm — this drops every override in the file');
    const out = await windroseAgent.iniReset(req.body?.name);
    await audit(req.user.id, 'ini.reset', { file: req.body?.name }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

// ---------------------------------------------------------------- server settings

router.get('/wrmanager/api/settings', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.serverSettings());
}));

router.post('/wrmanager/api/settings', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.saveSettings(req.body?.patch ?? {});
    // Log which keys changed, never the values — SERVER_PASSWORD is among them.
    await audit(req.user.id, 'settings.save', { keys: Object.keys(req.body?.patch ?? {}) }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/settings/apply', actionLimiter, owner, guard(async (req, res) => {
    if (req.body?.confirm !== 'APPLY') throw new Error('type APPLY to confirm — this recreates the container and disconnects everyone');
    const out = await windroseAgent.applySettings();
    await audit(req.user.id, 'settings.apply', null, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

// ---------------------------------------------------------------- players

router.get('/wrmanager/api/players', limiter, owner, guard(async (req, res) => {
    const [list, bans, mod] = await Promise.all([
        windroseAgent.listPlayers(req.query.positions === '1'),
        windroseAgent.bans(),
        windroseAgent.moderationStatus(),
    ]);
    if (!list.ok) return respond(res, list);
    res.json({
        ...list.data,
        bans: bans.ok ? bans.data : [],
        // Surfaced so the UI can disable moderation rather than pretend.
        moderation: mod.ok ? mod.data : { available: false, reason: 'unknown' },
    });
}));

router.post('/wrmanager/api/players/moderate', actionLimiter, owner, guard(async (req, res) => {
    const { action, target, reason } = req.body || {};
    const out = await windroseAgent.moderate(action, target, reason);
    await audit(req.user.id, `player.${action}`, { target, reason, executed: out.ok ? out.data?.executed : null }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/players/clear-pending', actionLimiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.clearPendingModeration());
}));

// ---------------------------------------------------------------- file transfer

const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

router.post('/wrmanager/api/files/upload', owner, fileUpload.single('file'), guard(async (req, res) => {
    if (!req.file) throw new Error('no file uploaded');
    const out = await uploadFile(req.file.buffer, req.body?.dir || '.', req.file.originalname);
    await audit(req.user.id, 'file.upload', { dir: req.body?.dir, name: req.file.originalname }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.get('/wrmanager/api/files/download', limiter, owner, guard(async (req, res) => {
    const { url, secret } = downloadFileUrl(String(req.query.path || ''));
    const upstream = await fetch(url, { headers: { 'x-agent-secret': secret } });
    if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({}));
        return res.status(upstream.status).json({ error: err.error || 'download failed' });
    }
    await audit(req.user.id, 'file.download', { path: req.query.path }, 'ok');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', upstream.headers.get('content-disposition') || 'attachment');
    // Stream through rather than buffering — this process runs 41 bots.
    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body).pipe(res);
}));

router.post('/wrmanager/api/files/rename', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.renameFile(req.body?.path, req.body?.name);
    await audit(req.user.id, 'file.rename', req.body, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/files/mkdir', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.mkdir(req.body?.path);
    await audit(req.user.id, 'file.mkdir', req.body, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

// ---------------------------------------------------------------- world saves

// Memory storage with a hard cap. 512MB is generous for a world (a fresh one is
// ~16KB) but this process also runs 41 Discord bots under a 3GB restart
// ceiling, so the cap is what stops one upload from recycling the whole thing.
const saveUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 * 1024, files: 1 },
});

router.get('/wrmanager/api/saves', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.listSaves());
}));

router.post('/wrmanager/api/saves/upload', owner, saveUpload.single('save'), guard(async (req, res) => {
    if (!req.file) throw new Error('no file uploaded');
    if (!/\.zip$/i.test(req.file.originalname || '')) throw new Error('upload must be a .zip world backup');

    // Upload and validate, but do NOT import — the UI shows what the archive
    // contains and asks for confirmation before anything is replaced.
    const out = await uploadSave(req.file.buffer, req.file.originalname);
    await audit(req.user.id, 'save.upload', out.ok ? { name: req.file.originalname, ...out.data } : { name: req.file.originalname }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/saves/import', actionLimiter, owner, guard(async (req, res) => {
    const { path: uploadPath, activate, confirm } = req.body || {};
    if (confirm !== 'IMPORT') throw new Error('type IMPORT to confirm — this switches the active world');

    const out = await windroseAgent.importSave(uploadPath, activate !== false, req.user.id);
    const prior = out.ok ? out.data?.priorSnapshot : null;
    if (prior?.filename) await recordBackup({ ...prior, kind: 'pre-restore', createdBy: req.user.id });
    await audit(req.user.id, 'save.import', out.ok ? out.data?.imported : { path: uploadPath }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/saves/activate', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.activateWorld(req.body?.islandId);
    await audit(req.user.id, 'save.activate', { islandId: req.body?.islandId }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/saves/discard', actionLimiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.discardUpload(req.body?.path));
}));

router.get('/wrmanager/api/saves/download', limiter, owner, guard(async (req, res) => {
    // Streamed, not buffered: same heap reasoning as the upload path.
    const listed = await windroseAgent.backups();
    if (!listed.ok) return respond(res, listed);

    const name = String(req.query.filename || '');
    const match = listed.data.find((b) => b.filename === name);
    if (!match) throw new Error('no such backup');

    await audit(req.user.id, 'save.download', { filename: name }, 'ok');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
    createReadStream(`${process.env.WINDROSE_BACKUP_DIR || '/srv/windrose/backups'}/${name}`)
        .on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'file missing on disk' }); })
        .pipe(res);
}));

router.get('/wrmanager/api/update', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.currentImage());
}));

router.post('/wrmanager/api/update/check', actionLimiter, owner, guard(async (req, res) => {
    // Pull only — nothing is recreated, so players are unaffected.
    const out = await windroseAgent.checkUpdate();
    await audit(req.user.id, 'update.check', out.ok ? out.data : null, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/update/apply', actionLimiter, owner, guard(async (req, res) => {
    if (req.body?.confirm !== 'UPDATE') throw new Error('type UPDATE to confirm — this recreates the container and disconnects everyone');

    // Snapshot first. A game update that breaks UE4SS/Windrose+ compatibility is
    // the single most likely way this server ends up unplayable, and rolling the
    // image back does not roll the world back.
    const snapshot = await windroseAgent.snapshot({ kind: 'manual', createdBy: req.user.id, label: 'preupdate' });
    if (snapshot.ok) await recordBackup({ ...snapshot.data, createdBy: req.user.id });
    else logger.warn(`windrose: pre-update snapshot failed: ${snapshot.error}`);

    const out = await windroseAgent.applyUpdate();
    await audit(req.user.id, 'update.apply', out.ok ? out.data : null, out.ok ? 'ok' : 'error');
    if (!out.ok) return respond(res, out);
    res.json({ ...out.data, snapshot: snapshot.ok ? snapshot.data : null });
}));

router.post('/wrmanager/api/update/game', actionLimiter, owner, guard(async (req, res) => {
    if (req.body?.confirm !== 'UPDATE') throw new Error('type UPDATE to confirm — this restarts the server and may download several GB');

    // Snapshot first. A game update is the single most likely way this server
    // ends up unplayable, and rolling the build back does not roll the world back.
    const snapshot = await windroseAgent.snapshot({ kind: 'manual', createdBy: req.user.id, label: 'pregameupdate' });
    if (snapshot.ok) await recordBackup({ ...snapshot.data, createdBy: req.user.id });
    else logger.warn(`windrose: pre-game-update snapshot failed: ${snapshot.error}`);

    const out = await windroseAgent.updateGame();
    await audit(req.user.id, 'update.game', out.ok ? out.data : null, out.ok ? 'ok' : 'error');
    if (!out.ok) return respond(res, out);
    res.json({ ...out.data, snapshot: snapshot.ok ? snapshot.data : null });
}));

router.get('/wrmanager/api/autoupdate', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.autoUpdate());
}));

router.post('/wrmanager/api/autoupdate/enabled', actionLimiter, owner, guard(async (req, res) => {
    const out = await windroseAgent.setAutoUpdate(Boolean(req.body?.enabled));
    await audit(req.user.id, 'autoupdate.toggle', { enabled: Boolean(req.body?.enabled) }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.post('/wrmanager/api/autoupdate/check', actionLimiter, owner, guard(async (req, res) => {
    // force skips the players-online and cooldown guards, so it is an explicit
    // owner decision rather than something the timer can do on its own.
    const out = await windroseAgent.autoUpdateCheck(Boolean(req.body?.force));
    await audit(req.user.id, 'autoupdate.check', { force: Boolean(req.body?.force), result: out.ok ? out.data?.action : null }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

router.get('/wrmanager/api/schedule', limiter, owner, guard(async (req, res) => {
    respond(res, await windroseAgent.schedule());
}));

router.post('/wrmanager/api/schedule', actionLimiter, owner, guard(async (req, res) => {
    const { hour, minute, cancel } = req.body || {};
    const out = cancel ? await windroseAgent.cancelSchedule() : await windroseAgent.scheduleDaily(Number(hour), Number(minute) || 0);
    await audit(req.user.id, cancel ? 'schedule.cancel' : 'schedule.set', { hour, minute }, out.ok ? 'ok' : 'error');
    respond(res, out);
}));

export default router;
