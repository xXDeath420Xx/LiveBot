// Jailed filesystem access under server-files.
//
// This is the highest-risk surface in the agent. The control API is reachable
// from dashboard/server.js, which is a 10k-line public-facing app; if a request
// can talk a path out of the jail, it can read the RCON password, drop a DLL
// that Wine will load, or overwrite the game binary. So the jail is enforced
// here, once, rather than at each call site.
//
// The jail resolves symlinks before comparing. A plain `startsWith` on the
// unresolved path is the classic broken version: `server-files/evil -> /etc`
// passes that check and then reads /etc/shadow.

import { readdir, stat, readFile, writeFile, unlink, mkdir, rm, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class FileError extends Error {}

// Writing any of these into the tree gets them executed by Wine or PowerShell
// on the next boot, which turns "file manager" into "remote code execution in
// the container". The owner can already restart and restore, but that is a
// bounded set of actions — arbitrary code is not, so it stays blocked.
const BLOCKED_WRITE_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.com', '.scr', '.pak', '.utoc', '.ucas', '.so']);

// Reading these leaks credentials to anyone who reaches the file browser.
const BLOCKED_READ = [/windrose_plus\.json$/i, /dashboard_session\.key$/i, /ServerDescription\.json$/i];

const MAX_READ_BYTES = 512 * 1024;

export function createFiles({ root = config.serverFiles } = {}) {
    let jailRoot = null;

    async function resolvedRoot() {
        // Resolve once and cache — the root itself may be a symlink (it is a
        // bind mount here), and every comparison must be against its real path.
        if (!jailRoot) jailRoot = await realpath(root);
        return jailRoot;
    }

    /**
     * Resolve `relPath` inside the jail, following symlinks.
     * Throws FileError on any escape. `mustExist: false` resolves the parent
     * instead, so new files can be created without existing first.
     */
    async function resolveInside(relPath, { mustExist = true } = {}) {
        const base = await resolvedRoot();

        if (typeof relPath !== 'string') throw new FileError('path must be a string');
        // Reject absolute paths and NUL bytes outright rather than normalising
        // them into something surprising.
        if (relPath.includes('\0')) throw new FileError('invalid path');
        if (path.isAbsolute(relPath)) throw new FileError('path must be relative to server-files');

        const joined = path.resolve(base, relPath);

        let real;
        if (mustExist) {
            try {
                real = await realpath(joined);
            } catch (err) {
                if (err.code === 'ENOENT') throw new FileError(`no such path: ${relPath}`);
                throw err;
            }
        } else {
            // The target may not exist; its PARENT must, and must be inside.
            const parent = path.dirname(joined);
            let realParent;
            try {
                realParent = await realpath(parent);
            } catch {
                throw new FileError(`parent directory does not exist: ${path.dirname(relPath)}`);
            }
            if (!isInside(realParent, base)) throw new FileError('path escapes server-files');
            return { abs: path.join(realParent, path.basename(joined)), rel: path.relative(base, path.join(realParent, path.basename(joined))) };
        }

        if (!isInside(real, base)) throw new FileError('path escapes server-files');
        return { abs: real, rel: path.relative(base, real) };
    }

    function isInside(target, base) {
        if (target === base) return true;
        // The separator matters: without it, /srv/windrose/server-files-evil
        // would pass as inside /srv/windrose/server-files.
        return target.startsWith(base + path.sep);
    }

    return {
        resolveInside,

        async list(relPath = '.') {
            const { abs, rel } = await resolveInside(relPath);
            const st = await stat(abs);
            if (!st.isDirectory()) throw new FileError('not a directory');

            const names = await readdir(abs, { withFileTypes: true });
            const entries = await Promise.all(names.map(async (d) => {
                const child = path.join(abs, d.name);
                let size = 0;
                let mtime = null;
                try {
                    const s = await stat(child);
                    size = s.size;
                    mtime = new Date(s.mtimeMs).toISOString();
                } catch { /* broken symlink — report it, don't crash the listing */ }
                return {
                    name: d.name,
                    type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
                    sizeBytes: size,
                    modifiedAt: mtime,
                };
            }));

            entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
            return { path: rel || '.', entries };
        },

        async read(relPath) {
            const { abs, rel } = await resolveInside(relPath);

            if (BLOCKED_READ.some((re) => re.test(rel))) {
                throw new FileError('this file holds credentials and cannot be read through the file browser');
            }

            const st = await stat(abs);
            if (st.isDirectory()) throw new FileError('is a directory');
            if (st.size > MAX_READ_BYTES) {
                throw new FileError(`file is ${st.size} bytes; the browser limit is ${MAX_READ_BYTES}`);
            }
            return { path: rel, sizeBytes: st.size, content: await readFile(abs, 'utf8') };
        },

        async write(relPath, content) {
            const { abs, rel } = await resolveInside(relPath, { mustExist: false });

            const ext = path.extname(abs).toLowerCase();
            if (BLOCKED_WRITE_EXT.has(ext)) {
                throw new FileError(`writing ${ext} files is blocked — they are executed by Wine or the launcher on next boot`);
            }
            if (typeof content !== 'string') throw new FileError('content must be a string');
            if (Buffer.byteLength(content) > MAX_READ_BYTES) throw new FileError('content too large');

            await writeFile(abs, content, 'utf8');
            return { path: rel, sizeBytes: Buffer.byteLength(content) };
        },

        async remove(relPath) {
            const { abs, rel } = await resolveInside(relPath);
            const base = await resolvedRoot();
            if (abs === base) throw new FileError('refusing to delete the server-files root');

            const st = await stat(abs);
            if (st.isDirectory()) await rm(abs, { recursive: true });
            else await unlink(abs);
            return { removed: rel };
        },


        /**
         * Absolute path for a download, still inside the jail.
         * Returned rather than streamed so the caller can pipe it without this
         * module needing to know about HTTP.
         */
        async downloadPath(relPath) {
            const { abs, rel } = await resolveInside(relPath);
            if (BLOCKED_READ.some((re) => re.test(rel))) {
                throw new FileError('this file holds credentials and cannot be downloaded');
            }
            const st = await stat(abs);
            if (st.isDirectory()) throw new FileError('cannot download a directory');
            return { abs, rel, sizeBytes: st.size };
        },

        /**
         * Target path for an upload. Same jail and same extension denylist as
         * write() — an uploaded .dll is exactly as dangerous as a written one.
         */
        async uploadPath(relDir, filename) {
            const safeName = path.basename(filename || '').replace(/[^A-Za-z0-9._-]/g, '_');
            if (!safeName || safeName.startsWith('.')) throw new FileError('invalid filename');

            const ext = path.extname(safeName).toLowerCase();
            if (BLOCKED_WRITE_EXT.has(ext)) {
                throw new FileError(`uploading ${ext} files is blocked — they are executed by Wine or the launcher on next boot`);
            }
            const { abs } = await resolveInside(path.posix.join(relDir || '.', safeName), { mustExist: false });
            return { abs, name: safeName };
        },

        async rename(fromPath, toName) {
            const src = await resolveInside(fromPath);
            const safeName = path.basename(toName || '').replace(/[^A-Za-z0-9._-]/g, '_');
            if (!safeName) throw new FileError('invalid name');
            const ext = path.extname(safeName).toLowerCase();
            if (BLOCKED_WRITE_EXT.has(ext)) throw new FileError(`renaming to ${ext} is blocked`);

            const dest = await resolveInside(path.posix.join(path.posix.dirname(src.rel) || '.', safeName), { mustExist: false });
            await rename(src.abs, dest.abs);
            return { from: src.rel, to: path.relative(await resolvedRoot(), dest.abs) };
        },

        async mkdirp(relPath) {
            const { abs, rel } = await resolveInside(relPath, { mustExist: false });
            await mkdir(abs, { recursive: true });
            return { path: rel };
        },
    };
}

/**
 * Lua mod management. Mods are folders under windrose_plus_mods/ containing
 * mod.json and init.lua; Windrose+ hot-reloads them on change, so installing
 * one needs no restart.
 */
export function createMods({ files, root = 'windrose_plus_mods' } = {}) {
    return {
        async list() {
            try {
                const { entries } = await files.list(root);
                const dirs = entries.filter((e) => e.type === 'dir');
                return Promise.all(dirs.map(async (d) => {
                    let manifest = null;
                    try {
                        manifest = JSON.parse((await files.read(`${root}/${d.name}/mod.json`)).content);
                    } catch { /* a folder without a readable mod.json is reported as unloadable */ }
                    return { name: d.name, manifest, valid: Boolean(manifest) };
                }));
            } catch (err) {
                if (err instanceof FileError) return []; // directory not created yet
                throw err;
            }
        },

        async install({ name, manifest, initLua }) {
            // The name becomes a directory; anything path-like in it would
            // escape the mods folder even though the jail would catch it later.
            if (!/^[a-zA-Z0-9._-]+$/.test(name || '')) {
                throw new FileError('mod name may contain only letters, numbers, dot, dash and underscore');
            }
            if (typeof initLua !== 'string' || !initLua.trim()) throw new FileError('init.lua is required');

            await files.mkdirp(`${root}/${name}`);
            await files.write(`${root}/${name}/mod.json`, JSON.stringify(manifest ?? { name, version: '1.0.0' }, null, 2));
            await files.write(`${root}/${name}/init.lua`, initLua);
            return { name, note: 'Windrose+ hot-reloads mods on change — no restart needed.' };
        },

        async remove(name) {
            if (!/^[a-zA-Z0-9._-]+$/.test(name || '')) throw new FileError('invalid mod name');
            return files.remove(`${root}/${name}`);
        },
    };
}
