// World save import and export.
//
// The use case this exists for: adopting a world that was created somewhere
// else — a home server, a solo game, an old host — into this dedicated server.
//
// FORMAT, read off a live save on 2026-08-09. The engine's backup zips are
// RocksDB CHECKPOINTS, not directory copies:
//
//   Checkpoint/meta/1
//   Checkpoint/private/1/{CURRENT, MANIFEST-*, OPTIONS-*, *.log}
//   Checkpoint/shared_checksum/*.sst, *.blob
//   AdditionalRecordFiles/WorldDescription.json
//
// That last entry matters: WorldDescription.json — the world's name, preset and
// settings — travels INSIDE the save. So an import carries its own settings and
// its own islandId, and adopting a world means pointing ServerDescription.json
// at that id rather than renaming anything.
//
// Import strategy: hand the zip to the engine as the world's _Latest.zip and let
// its own recovery path rehydrate it. ServerDescription.json already sets
// AutoLoadLatestBackupIfHasBroken, so the engine knows how to do this. Unpacking
// a RocksDB checkpoint by hand would be inventing a second, worse importer.

import { readFile, writeFile, mkdir, copyFile, stat, readdir, rm, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

export class SaveError extends Error {}

const SAVE_ROOT = ['R5', 'Saved', 'SaveProfiles', 'Default'];
// Generous enough for a long-running world, small enough that a bad upload
// cannot fill the disk. Observed: a fresh world is ~16KB.
export const MAX_SAVE_BYTES = 512 * 1024 * 1024;

export function createSaves({
    serverFiles = config.serverFiles,
    uploadDir = path.join(config.backupDir, 'uploads'),
    docker,
    exec = run,
} = {}) {
    const serverDescPath = path.join(serverFiles, 'R5', 'ServerDescription.json');
    const backupsRoot = path.join(serverFiles, ...SAVE_ROOT, 'RocksDB_v2_Backups', 'Worlds');
    const liveRoot = path.join(serverFiles, ...SAVE_ROOT, 'RocksDB_v2');

    async function readServerDesc() {
        return JSON.parse(await readFile(serverDescPath, 'utf8'));
    }

    async function assertStopped(action) {
        if (!docker) throw new SaveError('saves need a docker handle to check server state');
        const state = await docker.state();
        if (state.running) {
            throw new SaveError(`refusing to ${action} while the server is running — stop it first`);
        }
    }

    /**
     * Inspect an uploaded zip without trusting it.
     *
     * Validation is the whole point: an arbitrary zip handed to the engine as a
     * world backup either fails obscurely at boot or, worse, half-loads. We
     * check the checkpoint layout and pull the embedded WorldDescription so the
     * UI can show what is actually being imported before anything is replaced.
     */
    async function inspect(zipPath) {
        const { size } = await stat(zipPath);
        if (size > MAX_SAVE_BYTES) throw new SaveError(`save is ${size} bytes; the limit is ${MAX_SAVE_BYTES}`);

        let listing;
        try {
            const { stdout } = await exec('unzip', ['-Z1', zipPath], { maxBuffer: 8 * 1024 * 1024 });
            listing = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        } catch {
            throw new SaveError('not a readable zip archive');
        }

        // Reject archives containing traversal or absolute paths outright. We
        // hand this file to the engine rather than extracting it, but a zip we
        // would refuse to extract is not one to trust the engine with either.
        const hostile = listing.find((n) => n.startsWith('/') || n.split('/').includes('..'));
        if (hostile) throw new SaveError(`archive contains an unsafe path: ${hostile}`);

        // Two archive shapes exist in the wild, and both are legitimate:
        //
        //  "checkpoint" — what the ENGINE writes into RocksDB_v2_Backups. A
        //    RocksDB checkpoint under Checkpoint/, with the description in
        //    AdditionalRecordFiles/. Internally consistent by construction.
        //
        //  "worlddir" — a copy of the live Worlds/<islandId>/ directory, which
        //    is what hand-rolled and third-party backup tools produce (and what
        //    the WSM-era backup of "The Pacific" turned out to be). The .sst
        //    files, CURRENT, MANIFEST and WorldDescription.json sit directly
        //    under a 32-hex directory named for the world.
        //
        // An earlier version accepted only the first and told people to go find
        // an engine zip. That was wrong: the directory copy is the format most
        // people actually have, and it restores fine as long as it was taken
        // with the server stopped.
        const hasCheckpoint = listing.some((n) => n.startsWith('Checkpoint/'));
        const worldDirMatch = listing
            .map((n) => n.match(/^([A-Fa-f0-9]{32})\//))
            .find(Boolean);

        let format = null;
        let worldDirPrefix = null;
        if (hasCheckpoint) {
            format = 'checkpoint';
        } else if (worldDirMatch) {
            format = 'worlddir';
            worldDirPrefix = worldDirMatch[1];
        }

        const hasCurrent = listing.some((n) => n.endsWith('/CURRENT') || n === 'CURRENT');
        if (!format || !hasCurrent) {
            throw new SaveError(
                'this does not look like a Windrose world save. Expected either an engine backup ' +
                '(a Checkpoint/ directory) or a copy of Worlds/<islandId>/ containing CURRENT, MANIFEST-* and .sst files.',
            );
        }

        // WorldDescription.json rides inside the archive and tells us the id.
        let description = null;
        const descEntry = listing.find((n) => n.endsWith('WorldDescription.json'));
        if (descEntry) {
            try {
                const { stdout } = await exec('unzip', ['-p', zipPath, descEntry], { maxBuffer: 4 * 1024 * 1024 });
                description = JSON.parse(stdout);
            } catch { /* malformed description is reported below, not fatal here */ }
        }

        // Prefer the description's id; fall back to the directory name, which
        // is authoritative for a worlddir archive.
        const islandId = description?.WorldDescription?.islandId ?? worldDirPrefix ?? null;

        // Some backup tools include a copy of the source ServerDescription.json.
        // We never apply it — it carries the old host's ports, password and
        // invite code — but reading the name is useful for the confirm screen.
        let sourceServerName = null;
        if (listing.includes('ServerDescription.json')) {
            try {
                const { stdout } = await exec('unzip', ['-p', zipPath, 'ServerDescription.json'], { maxBuffer: 1024 * 1024 });
                sourceServerName = JSON.parse(stdout.replace(/^﻿/, ''))?.ServerDescription_Persistent?.ServerName ?? null;
            } catch { /* optional */ }
        }

        return {
            format,
            worldDirPrefix,
            sizeBytes: size,
            entryCount: listing.length,
            islandId,
            worldName: description?.WorldDescription?.WorldName || null,
            presetType: description?.WorldDescription?.WorldPresetType || null,
            hasDescription: Boolean(description),
            sourceServerName,
        };
    }

    return {
        inspect,
        MAX_SAVE_BYTES,

        /**
         * The active world's own identity — name, preset, id.
         *
         * Distinct from the SERVER name, which is a container env var. The
         * world name lives in the save and travels with it, so after an import
         * it is what players actually recognise ("The Pacific"), while the
         * server name stays whatever this host calls itself ("CertiFried").
         */
        async activeWorld() {
            const desc = await readServerDesc().catch(() => null);
            const id = desc?.ServerDescription_Persistent?.WorldIslandId ?? null;
            if (!id) return null;

            const versions = (await readdir(liveRoot).catch(() => [])).sort().reverse();
            for (const version of versions) {
                const file = path.join(liveRoot, version, 'Worlds', id, 'WorldDescription.json');
                try {
                    const wd = JSON.parse(await readFile(file, 'utf8'))?.WorldDescription;
                    if (wd) {
                        return {
                            id,
                            // A world can legitimately have a blank name (the
                            // engine leaves it empty on worlds it generates);
                            // callers fall back to the server name in that case.
                            name: wd.WorldName || null,
                            presetType: wd.WorldPresetType || null,
                            version,
                        };
                    }
                } catch { /* try the next version directory */ }
            }
            return { id, name: null, presetType: null, version: null };
        },

        /**
         * How players are meant to connect, read from ServerDescription.json
         * rather than the container env.
         *
         * The env is what we ASKED for; ServerDescription is what the server
         * actually resolved to after its own start-up patch. When those differ
         * — which they do, since the game regenerates parts of this file — the
         * file is the truth, and showing the env value would hand people a code
         * that does not work.
         */
        async connectionInfo() {
            const d = (await readServerDesc().catch(() => null))?.ServerDescription_Persistent;
            if (!d) return null;
            // Split host from port. The game asks for them in two separate
            // boxes ("IP" and "Port"), so handing the UI a single
            // "host:port" string just makes every caller re-split it — and
            // get it wrong for IPv6 or a bare hostname with no port.
            const configured = String(config.connectAddress || '');
            const lastColon = configured.lastIndexOf(':');
            const looksPorted = lastColon > 0 && /^\d+$/.test(configured.slice(lastColon + 1));
            const host = looksPorted ? configured.slice(0, lastColon) : configured || null;

            // ServerDescription is authoritative for the port — it is what the
            // server actually bound, not what we typed into an env var.
            const port = d.DirectConnectionServerPort ?? (looksPorted ? Number(configured.slice(lastColon + 1)) : null);

            return {
                inviteCode: d.InviteCode || null,
                useDirectConnection: d.UseDirectConnection === true,
                host: host || null,
                port,
                passwordProtected: d.IsPasswordProtected === true,
                // The password itself is deliberately NOT returned.
            };
        },

        /**
         * The join password.
         *
         * Deliberately its own method behind its own route, NOT part of
         * connectionInfo(): /status is polled every few seconds by every open
         * panel and is logged and cached in several places. A secret that rides
         * along with routine telemetry leaks eventually. Callers must ask for
         * it explicitly, and the dashboard gates that ask on role.
         */
        async joinSecret() {
            const d = (await readServerDesc().catch(() => null))?.ServerDescription_Persistent;
            if (!d) return { passwordProtected: false, password: null };
            return {
                passwordProtected: d.IsPasswordProtected === true,
                password: d.IsPasswordProtected === true ? (d.Password || null) : null,
            };
        },

        /** Worlds the server currently knows about, and which one is active. */
        async list() {
            const desc = await readServerDesc().catch(() => null);
            const active = desc?.ServerDescription_Persistent?.WorldIslandId ?? null;

            const versions = await readdir(liveRoot).catch(() => []);
            const worlds = [];
            for (const version of versions) {
                const dir = path.join(liveRoot, version, 'Worlds');
                for (const id of await readdir(dir).catch(() => [])) {
                    let sizeBytes = 0;
                    for (const f of await readdir(path.join(dir, id)).catch(() => [])) {
                        sizeBytes += (await stat(path.join(dir, id, f)).catch(() => ({ size: 0 }))).size;
                    }
                    worlds.push({ islandId: id, version, sizeBytes, active: id === active });
                }
            }
            return { activeWorldId: active, worlds };
        },

        /**
         * Import an uploaded world and make it the active one.
         *
         * Destructive to whatever world is currently selected, so: stopped only,
         * validated first, and the current world is snapshotted before the
         * switch. The uploaded zip becomes the target world's _Latest.zip and
         * ServerDescription.json is pointed at its islandId.
         */
        async importSave({ zipPath, activate = true, backups = null, createdBy = null }) {
            await assertStopped('import a world');

            const info = await inspect(zipPath);
            if (!info.islandId) {
                throw new SaveError(
                    'the archive has no WorldDescription.json, so its world id is unknown and it cannot be activated safely',
                );
            }

            // Snapshot the world we are about to stop using, so this is undoable.
            let priorSnapshot = null;
            if (backups) {
                priorSnapshot = await backups.snapshot({ kind: 'pre-restore', createdBy, label: 'preimport' })
                    .catch((err) => ({ error: err.message }));
            }

            const version = (await readdir(liveRoot).catch(() => ['0.10.0'])).sort().reverse()[0] || '0.10.0';
            let appliedTo;

            if (info.format === 'checkpoint') {
                // Hand it to the engine as _Latest.zip and let its own recovery
                // path rehydrate the checkpoint.
                const destDir = path.join(backupsRoot, info.islandId);
                await mkdir(destDir, { recursive: true });
                appliedTo = path.join(destDir, `${info.islandId}_${version}_Latest.zip`);
                await copyFile(zipPath, appliedTo);

                // Clear any existing live directory for this world FIRST.
                //
                // Learned the hard way on 2026-08-09: leftover live files win.
                // The engine restores the checkpoint into the world directory,
                // but a pre-existing directory (e.g. from an earlier worlddir
                // import of the same island) can leave the world in a mixed
                // state — the checkpoint is silently not what ends up loaded.
                // Deleting it makes the restore authoritative. Safe because the
                // checkpoint we just staged contains the full world.
                await rm(path.join(liveRoot, version, 'Worlds', info.islandId), { recursive: true, force: true });
            } else {
                // worlddir: the archive already IS the world directory, so
                // extract it straight into place. The engine's _Latest.zip
                // recovery path only understands checkpoints, so routing this
                // through it would fail at load.
                const worldDir = path.join(liveRoot, version, 'Worlds', info.islandId);
                await mkdir(worldDir, { recursive: true });

                // -j flattens the leading <islandId>/ directory; -o overwrites.
                // LOCK is excluded deliberately: it is RocksDB's own lock file,
                // recreated on open, and shipping a stale one from another
                // machine is at best noise and at worst a refused open.
                await exec('unzip', ['-o', '-j', '-q', zipPath, `${info.worldDirPrefix}/*`, '-x', '*/LOCK', '-d', worldDir], {
                    maxBuffer: 8 * 1024 * 1024,
                });
                appliedTo = worldDir;
            }

            let activated = false;
            if (activate) {
                const desc = await readServerDesc();
                desc.ServerDescription_Persistent.WorldIslandId = info.islandId;
                const tmp = `${serverDescPath}.tmp`;
                await writeFile(tmp, JSON.stringify(desc, null, 4), 'utf8');
                await rename(tmp, serverDescPath);
                activated = true;
            }

            return {
                imported: info,
                appliedTo,
                activated,
                priorSnapshot,
                note: 'Start the server to load the imported world. First boot may take longer while it rehydrates.',
            };
        },

        /**
         * Switch the active world without importing anything — useful once
         * several worlds live side by side.
         */
        async activate(islandId) {
            await assertStopped('switch worlds');
            if (!/^[A-Fa-f0-9]{32}$/.test(islandId || '')) {
                throw new SaveError('islandId must be a 32-character hex world id');
            }
            const { worlds } = await this.list();
            if (!worlds.some((w) => w.islandId === islandId)) {
                throw new SaveError(`no world ${islandId} on this server`);
            }

            const desc = await readServerDesc();
            desc.ServerDescription_Persistent.WorldIslandId = islandId;
            const tmp = `${serverDescPath}.tmp`;
            await writeFile(tmp, JSON.stringify(desc, null, 4), 'utf8');
            await rename(tmp, serverDescPath);
            return { activeWorldId: islandId, note: 'Start the server to load it.' };
        },

        /** Absolute path of a snapshot, for download. Jailed to the backup dir. */
        async exportPath(filename) {
            const safe = path.basename(filename);
            if (safe !== filename) throw new SaveError('invalid filename');
            const full = path.join(config.backupDir, safe);
            await stat(full);
            return full;
        },

        /** Where uploads land before validation. */
        async uploadTarget(name) {
            await mkdir(uploadDir, { recursive: true });
            const safe = path.basename(name || 'upload.zip').replace(/[^A-Za-z0-9._-]/g, '_');
            return path.join(uploadDir, `${Date.now()}_${safe}`);
        },

        async discardUpload(p) {
            if (!path.resolve(p).startsWith(path.resolve(uploadDir))) return;
            await rm(p, { force: true });
        },

        _paths: { backupsRoot, liveRoot, uploadDir, serverDescPath },
    };
}
