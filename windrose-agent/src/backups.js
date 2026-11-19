// World backups.
//
// DESIGN NOTE — read before "simplifying" this into a tar of the save profile.
//
// The world is a RocksDB (.sst files, MANIFEST, LOCK, live compaction). Copying
// that tree while the server runs yields a torn and possibly unrestorable
// snapshot: tar has no concept of a consistent RocksDB checkpoint.
//
// The game already solves this. It writes internally-consistent zip snapshots
// every ~10 minutes to RocksDB_v2_Backups/Worlds/<world-id>/, named
// <world-id>_<version>_<YYYYMMDD-HHMMSS>.zip, plus a rolling _Latest.zip. The
// engine quiesces the DB before sealing each one.
//
// So we COPY the game's zips rather than archiving the live directory. That is
// why snapshots are safe while the server is running, and why they cost
// kilobytes instead of gigabytes. Restore still requires a stopped server,
// because it replaces the live RocksDB underneath a process that has it open.

import { readdir, copyFile, stat, mkdir, unlink, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const SAVE_ROOT = ['R5', 'Saved', 'SaveProfiles', 'Default'];

// Ledger sidecar: <backup>.zip.meta.json records WHO took the snapshot and WHY (kind + label).
// The agent has no database; the dashboard copies this into windrose_backups when it lists
// backups, which is how snapshots it never saw being taken (the scheduler's, auto-update's,
// another panel's) still show their author.
export const META_SUFFIX = '.meta.json';

export function createBackups({
    serverFiles = config.serverFiles,
    backupDir = config.backupDir,
    docker,
    logger = console,
} = {}) {
    const gameBackupRoot = path.join(serverFiles, ...SAVE_ROOT, 'RocksDB_v2_Backups', 'Worlds');
    const liveRoot = path.join(serverFiles, ...SAVE_ROOT, 'RocksDB_v2');

    /** The single world directory the server is running. */
    async function worldId() {
        const desc = JSON.parse(
            await readFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), 'utf8'),
        );
        const id = desc?.ServerDescription_Persistent?.WorldIslandId;
        if (!id) throw new Error('backups: WorldIslandId missing from ServerDescription.json');
        return id;
    }

    /** Newest game-written zip, excluding the rolling _Latest alias. */
    async function newestGameZip(id) {
        const dir = path.join(gameBackupRoot, id);
        let names;
        try {
            names = await readdir(dir);
        } catch {
            throw new Error(`backups: no game backup directory at ${dir}`);
        }

        // _Latest.zip is a moving target the engine rewrites in place; taking a
        // timestamped file gives a stable artefact that cannot change under us
        // mid-copy.
        const timestamped = names.filter((n) => n.endsWith('.zip') && !n.endsWith('_Latest.zip'));
        if (!timestamped.length) {
            throw new Error('backups: no timestamped game snapshot yet — the engine writes one every ~10 minutes');
        }

        const withTimes = await Promise.all(
            timestamped.map(async (n) => ({ name: n, mtime: (await stat(path.join(dir, n))).mtimeMs })),
        );
        withTimes.sort((a, b) => b.mtime - a.mtime);
        return path.join(dir, withTimes[0].name);
    }

    const metaPath = (filename) => path.join(backupDir, `${filename}${META_SUFFIX}`);

    async function readMeta(filename) {
        try {
            const meta = JSON.parse(await readFile(metaPath(filename), 'utf8'));
            return meta && typeof meta === 'object' ? meta : null;
        } catch (err) {
            if (err.code !== 'ENOENT') logger.warn?.(`backups: unreadable ledger for ${filename}: ${err.message}`);
            return null;
        }
    }

    return {
        /**
         * Copy the newest engine snapshot into our backup directory.
         * Safe while running — that is the whole point of sourcing from the
         * engine's zips rather than the live RocksDB.
         *
         * `kind` is recorded for the UI: manual | scheduled | pre-restore.
         */
        async snapshot({ kind = 'manual', createdBy = null, label = null } = {}) {
            await mkdir(backupDir, { recursive: true });
            const id = await worldId();
            const src = await newestGameZip(id);

            // Name from the SOURCE snapshot's timestamp, not from now(): the zip
            // may be up to ten minutes old, and stamping it with the current
            // time would misrepresent which world state it actually holds.
            const srcName = path.basename(src, '.zip');
            const suffix = label ? `_${label.replace(/[^a-zA-Z0-9-]/g, '')}` : '';
            const filename = `${srcName}_${kind}${suffix}.zip`;
            const dest = path.join(backupDir, filename);

            await copyFile(src, dest);
            const { size } = await stat(dest);

            const meta = {
                filename,
                kind,
                createdBy: createdBy || null,
                label: label ? label.replace(/[^a-zA-Z0-9-]/g, '') || null : null,
                sourceSnapshot: path.basename(src),
                createdAt: new Date().toISOString(),
            };
            try {
                await writeFile(metaPath(filename), JSON.stringify(meta));
            } catch (err) {
                // The snapshot itself succeeded; only the "who/why" is lost. Say so, don't fail it.
                logger.warn?.(`backups: could not write ledger for ${filename}: ${err.message}`);
            }

            return { filename, path: dest, sizeBytes: size, kind, createdBy: meta.createdBy, label: meta.label, sourceSnapshot: meta.sourceSnapshot };
        },

        async list() {
            await mkdir(backupDir, { recursive: true });
            const names = (await readdir(backupDir)).filter((n) => n.endsWith('.zip'));
            const rows = await Promise.all(names.map(async (name) => {
                const s = await stat(path.join(backupDir, name));
                const meta = await readMeta(name);
                return {
                    filename: name,
                    sizeBytes: s.size,
                    createdAt: new Date(s.mtimeMs).toISOString(),
                    kind: meta?.kind ?? null,
                    createdBy: meta?.createdBy ?? null,
                    label: meta?.label ?? null,
                    sourceSnapshot: meta?.sourceSnapshot ?? null,
                };
            }));
            return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },

        /** Keep the newest N, delete the rest. Returns what was removed. */
        async prune({ keep = 30 } = {}) {
            const all = await this.list();
            const doomed = all.slice(keep);
            for (const b of doomed) {
                await unlink(path.join(backupDir, b.filename));
                await unlink(metaPath(b.filename)).catch((err) => {
                    if (err.code !== 'ENOENT') logger.warn?.(`backups: could not remove ledger for ${b.filename}: ${err.message}`);
                });
            }
            return { removed: doomed.map((b) => b.filename), kept: Math.min(all.length, keep) };
        },

        /**
         * Restore a snapshot over the live world.
         *
         * DESTRUCTIVE and irreversible for whatever is currently live, hence:
         *   - refuses unless the container is stopped (we would otherwise be
         *     swapping files under a process holding the DB open), and
         *   - takes a pre-restore snapshot first, so a mistaken restore is
         *     itself undoable.
         */
        async restore({ filename, createdBy = null }) {
            if (!docker) throw new Error('backups: restore requires a docker handle to verify the server is stopped');

            const state = await docker.state();
            if (state.running) {
                throw new Error('backups: refusing to restore while the server is running — stop it first');
            }

            // Reject anything that is not a plain filename in our backup dir.
            const safe = path.basename(filename);
            if (safe !== filename) throw new Error('backups: invalid backup filename');
            const src = path.join(backupDir, safe);
            await stat(src); // throws if absent

            const id = await worldId();

            // Snapshot the current world before destroying it. Sourced from the
            // engine's zips like any other, so it is consistent even though the
            // server just stopped.
            let priorSnapshot = null;
            try {
                priorSnapshot = await this.snapshot({ kind: 'pre-restore', createdBy });
            } catch (err) {
                // A brand-new world may have no engine snapshot yet. Surface it
                // rather than silently restoring with no undo available.
                priorSnapshot = { error: err.message };
            }

            const destDir = path.join(gameBackupRoot, id);
            await mkdir(destDir, { recursive: true });

            // Hand the zip back to the engine as _Latest.zip and let its own
            // recovery path load it. ServerDescription sets
            // AutoLoadLatestBackupIfHasBroken: true, so the engine already
            // knows how to rehydrate a world from this file — far safer than us
            // unpacking RocksDB internals by hand.
            const latest = path.join(destDir, `${id}_0.10.0_Latest.zip`);
            await copyFile(src, latest);

            return {
                restored: safe,
                appliedTo: latest,
                priorSnapshot,
                note: 'Start the server to load the restored world.',
            };
        },

        // Exposed for tests and diagnostics.
        _paths: { gameBackupRoot, liveRoot, backupDir },
        _worldId: worldId,
    };
}
