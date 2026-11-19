// The agent's control surface — localhost only, shared-secret authed.
//
// Mirrors stream-relay's :4090 status API in shape and intent: a small, fixed
// HTTP surface that the dashboard proxies, so the dashboard never needs the
// Docker socket or filesystem access itself.
//
// Built on node:http rather than Express deliberately. This process is
// root-equivalent; every dependency added here is another package that can
// reach the Docker socket through a supply-chain compromise. The routing need
// is a dozen fixed paths, which is not worth that exposure.

import http from 'node:http';
import path from 'node:path';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { FileError } from './files.js';
import { ConfigError } from './configwriter.js';
import { SaveError, MAX_SAVE_BYTES } from './saves.js';
import { PlayerError } from './players.js';
import { SettingsError } from './settings.js';
import { IniError } from './inifiles.js';

const MAX_BODY_BYTES = 1024 * 1024;

function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Nothing here should ever be cached by an intermediary.
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/** Constant-time compare so the secret can't be recovered by timing. */
function secretMatches(provided, expected) {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export function createControlApi({
    docker,
    backups,
    configWriter,
    files,
    mods,
    spool,
    client,
    queue,
    cache,
    scheduler,
    updater,
    saves,
    players,
    settings,
    ini,
    autoUpdate,
    secret = config.agentSecret,
    logger = console,
} = {}) {
    // Status is served from the spool, not from RCON: the spool is free and
    // RCON costs ~4s per call against a budget shared by every friend.
    const status = () => cache.get('status', config.statusCacheTtlMs, async () => {
        const [state, heartbeat, server, world, connection] = await Promise.all([
            docker.state(),
            spool.heartbeat(),
            spool.serverStatus(),
            // Cheap: one small JSON read off the bind mount.
            saves.activeWorld().catch(() => null),
            saves.connectionInfo().catch(() => null),
        ]);
        return {
            container: state,
            heartbeat,
            server: server?.server ?? null,
            // The world's own name, which is what players recognise after an
            // import — distinct from the server name, which is a container env var.
            world,
            players: server?.players ?? [],
            multipliers: server?.multipliers ?? {},
            connectAddress: config.connectAddress,
            // Invite code read from ServerDescription.json — the value the
            // server actually resolved to, not what the env asked for.
            connection,
            // "Container up but heartbeat stale" means the web layer is alive
            // and the game is wedged — a state a single boolean would hide.
            healthy: state.running && heartbeat.alive,
        };
    });

    const routes = {
        'GET /health': async () => ({ ok: true, agent: 'windrose-agent' }),
        // Written by scripts/windrose-watch.sh from cron. Read from disk rather
        // than computed here on purpose: the watchdog's job includes noticing
        // that this agent is dead, so it cannot live inside it.
        'GET /watchdog': async () => {
            const { readFile } = await import('node:fs/promises');
            const p = `${config.backupDir}/watchdog.json`;
            try {
                return JSON.parse(await readFile(p, 'utf8'));
            } catch {
                return { checkedAt: null, warnings: ['watchdog has not run yet'], stale: true };
            }
        },
        'GET /status': status,
        'GET /livemap': () => cache.get('livemap', config.statusCacheTtlMs, () => spool.livemap()),
        'GET /commands': () => cache.get('commands', config.commandsCacheTtlMs, () => spool.commands()),
        'GET /console': () => spool.consoleHistory(),
        'GET /stats': () => docker.stats(),
        'GET /logs': (_b, url) => docker.logs({ tail: Math.min(Number(url.searchParams.get('tail')) || 200, 1000) }),
        'GET /config': () => configWriter.readAll(),
        'GET /backups': () => backups.list(),
        'GET /schedule': () => scheduler.status(),
        'GET /files': (_b, url) => files.list(url.searchParams.get('path') || '.'),
        'GET /file': (_b, url) => files.read(url.searchParams.get('path')),
        'GET /mods': () => mods.list(),

        'POST /rcon': async (body) => {
            if (!body.command || typeof body.command !== 'string') throw new ConfigError('command is required');
            // Through the queue, always — this is the single place the 1 req/s
            // budget and command ordering are enforced.
            const out = await queue.push(() => client.rcon(body.command));
            cache.invalidate('status');
            return out;
        },

        'POST /lifecycle/start': async () => { const r = await docker.start(); cache.invalidate('status'); return r; },
        'POST /lifecycle/stop': async () => { const r = await docker.stop(); cache.invalidate('status'); return r; },
        'POST /lifecycle/restart': async (body) => {
            // The graceful path warns players and snapshots first; the blunt one
            // exists for when the server is already wedged and nobody is on.
            const r = body.immediate ? await docker.restart() : await scheduler.restartNow();
            cache.invalidate('status');
            return r;
        },

        'POST /config/multipliers': (body) => configWriter.setMultipliers(body.multipliers ?? {}),
        'POST /config/world': (body) => configWriter.setWorldSettings(body.settings ?? {}),
        'POST /config/rcon': (body) => configWriter.setRcon({ enabled: body.enabled }),

        'POST /backups': (body) => backups.snapshot({ kind: body.kind ?? 'manual', createdBy: body.createdBy ?? null, label: body.label ?? null }),
        'POST /backups/prune': (body) => backups.prune({ keep: Number(body.keep) || 30 }),
        'POST /backups/restore': (body) => backups.restore({ filename: body.filename, createdBy: body.createdBy ?? null }),

        'POST /schedule/daily': (body) => scheduler.scheduleDaily({ hour: Number(body.hour) ?? 5, minute: Number(body.minute) || 0 }),
        'POST /schedule/cancel': () => { scheduler.cancel(); return scheduler.status(); },

        'POST /file': (body) => files.write(body.path, body.content),
        'POST /files/mkdir': (body) => files.mkdirp(body.path),
        'POST /files/rename': (body) => files.rename(body.path, body.name),
        'DELETE /file': (body) => files.remove(body.path),

        'POST /mods': (body) => mods.install(body),
        'DELETE /mods': (body) => mods.remove(body.name),

        'GET /players': (_b, url) => players.list({ withPositions: url.searchParams.get('positions') === '1' }),
        'GET /players/bans': () => players.bans(),
        'GET /players/moderation-status': () => players.moderationAvailable(),
        'POST /players/moderate': (body) => players.moderate(body.action, body.target, body.reason),
        'POST /players/clear-pending': () => players.clearPending(),

        // Separate from /status on purpose — see saves.joinSecret().
        'GET /connection/secret': () => saves.joinSecret(),

        'GET /saves': () => saves.list(),
        // Validate an upload without committing to it, so the UI can show what
        // the archive actually contains before anything is replaced.
        'POST /saves/inspect': (body) => saves.inspect(body.path),
        'POST /saves/import': (body) => saves.importSave({
            zipPath: body.path, activate: body.activate !== false, backups, createdBy: body.createdBy ?? null,
        }),
        'POST /saves/activate': (body) => saves.activate(body.islandId),
        'POST /saves/discard': async (body) => { await saves.discardUpload(body.path); return { discarded: true }; },

        'GET /ini': () => ini.summary(),
        'GET /ini/file': (_b, url) => ini.describe(url.searchParams.get('name')),
        'GET /ini/search': (_b, url) => ini.search(url.searchParams.get('q')),
        'POST /ini/file': (body) => ini.setOverrides(body.name, body.patch ?? {}),
        'POST /ini/reset': (body) => ini.resetFile(body.name),

        'GET /settings': () => settings.read(),
        'POST /settings': (body) => settings.write(body.patch ?? {}),
        'POST /settings/apply': () => settings.applyRecreate(),

        'GET /update': () => updater.current(),
        // Pull is safe while running — nothing is recreated until /update/apply.
        'POST /update/check': () => updater.check(),
        'POST /update/apply': () => updater.apply(),
        // The one that fixes a DeploymentId mismatch. Separate route because it
        // is a different operation from pulling the wrapper image.
        'POST /update/game': () => updater.updateGame(),

        'GET /autoupdate': () => autoUpdate.status(),
        'POST /autoupdate/check': (body) => autoUpdate.runCheck({ force: Boolean(body.force) }),
        'POST /autoupdate/enabled': (body) => autoUpdate.setEnabled(body.enabled),
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const key = `${req.method} ${url.pathname}`;

        try {
            // Auth before routing, so an unauthenticated caller cannot even
            // probe which paths exist.
            if (!secretMatches(req.headers['x-agent-secret'], secret)) {
                return send(res, 401, { error: 'unauthorized' });
            }

            // Stream a file out of the jail. Not JSON — a 400KB ini or a mod
            // archive should not be base64'd through the control plane.
            if (key === 'GET /files/download') {
                const info = await files.downloadPath(url.searchParams.get('path'));
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': info.sizeBytes,
                    'Content-Disposition': `attachment; filename="${path.basename(info.rel).replace(/"/g, '')}"`,
                });
                await pipeline(createReadStream(info.abs), res);
                return;
            }

            // Stream a file into the jail. Same denylist as write(): an
            // uploaded .dll is exactly as dangerous as a written one.
            if (key === 'POST /files/upload') {
                const target = await files.uploadPath(req.headers['x-dir'] || '.', req.headers['x-filename']);
                const declared = Number(req.headers['content-length'] || 0);
                if (declared > MAX_SAVE_BYTES) return send(res, 413, { error: 'file too large' });
                await pipeline(req, createWriteStream(target.abs));
                return send(res, 200, { uploaded: target.name });
            }

            // Raw upload path, handled before JSON routing: a world save is up
            // to 512MB and must never be buffered into memory as a JSON string.
            // Streamed straight to disk, then validated as a separate step.
            if (key === 'POST /saves/upload') {
                const declared = Number(req.headers['content-length'] || 0);
                if (declared > MAX_SAVE_BYTES) {
                    return send(res, 413, { error: `save exceeds the ${MAX_SAVE_BYTES} byte limit` });
                }

                const target = await saves.uploadTarget(req.headers['x-filename']);
                let written = 0;
                req.on('data', (c) => {
                    written += c.length;
                    // Content-Length can lie; enforce on the actual stream too.
                    if (written > MAX_SAVE_BYTES) req.destroy(new Error('upload too large'));
                });

                try {
                    await pipeline(req, createWriteStream(target));
                } catch (err) {
                    await saves.discardUpload(target).catch(() => {});
                    return send(res, 413, { error: err.message || 'upload failed' });
                }

                try {
                    // Validate immediately and bin anything that is not a world
                    // save, so junk cannot accumulate in the upload directory.
                    const info = await saves.inspect(target);
                    return send(res, 200, { path: target, ...info });
                } catch (err) {
                    await saves.discardUpload(target).catch(() => {});
                    return send(res, 400, { error: err.message });
                }
            }

            const handler = routes[key];
            if (!handler) return send(res, 404, { error: `no route for ${key}` });

            const body = req.method === 'GET' ? {} : await readBody(req);
            const result = await handler(body, url);
            return send(res, 200, result ?? {});
        } catch (err) {
            // Validation and jail errors are the caller's fault and carry
            // messages meant to be shown; everything else is ours and must not
            // leak internals to the dashboard.
            if (err instanceof FileError || err instanceof ConfigError || err instanceof SaveError || err instanceof PlayerError || err instanceof SettingsError || err instanceof IniError) {
                return send(res, 400, { error: err.message });
            }
            logger.error?.(`control-api ${key}: ${err.stack || err.message}`);
            return send(res, 500, { error: err.message || 'internal error' });
        }
    });

    return {
        server,
        listen(port = config.agentPort) {
            return new Promise((resolve) => {
                // Loopback bind is not negotiable: this API can stop the
                // container and write to the game tree.
                //
                // Resolve with the ACTUAL bound port, not the requested one —
                // port 0 means "pick an ephemeral port", so echoing the request
                // back would report 0 and leave the caller unable to connect.
                server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port }));
            });
        },
        close() {
            return new Promise((resolve) => server.close(resolve));
        },
        _routes: Object.keys(routes),
    };
}
