/**
 * Residential music resolvers, shared by the yt-dlp extractor and the music health monitor.
 * Read lazily on every call: index.js runs dotenv.config() after imports.
 *
 *   MUSIC_RESOLVERS   ordered resolvers, each a group of tunnels to the SAME resolver:
 *                       server2=http://127.0.0.1:49998|http://127.0.0.1:49999;workstation=http://127.0.0.1:49997
 *   MUSIC_RESOLVER_SECRET_FILE_<NAME>   bearer secret per resolver (re-read when the file changes)
 *
 * Legacy single-resolver form still works: MUSIC_RESOLVER_URL (comma-separated tunnels) with
 * MUSIC_RESOLVER_SECRET_FILE / MUSIC_RESOLVER_SECRET, treated as one resolver named "server2".
 */
import { readFileSync, statSync } from 'node:fs';

/** @returns {{ name: string, bases: string[] }[]} in priority order */
export function resolverGroups() {
    const spec = (process.env.MUSIC_RESOLVERS || '').trim();
    if (spec) {
        return spec.split(';').map(part => {
            const eq = part.indexOf('=');
            const name = eq < 0 ? '' : part.slice(0, eq).trim();
            if (!name) return null; // a nameless group would look up MUSIC_RESOLVER_SECRET_FILE_ and always 401
            const bases = part.slice(eq + 1).split('|').map(s => s.trim()).filter(Boolean);
            return bases.length ? { name, bases } : null;
        }).filter(Boolean);
    }
    const legacy = (process.env.MUSIC_RESOLVER_URL || '').split(',').map(s => s.trim()).filter(Boolean);
    return legacy.length ? [{ name: 'server2', bases: legacy }] : [];
}

/** Every tunnel base across all resolvers, in priority order. */
export function resolverBases() {
    return resolverGroups().flatMap(g => g.bases);
}

const secretCache = new Map(); // path -> { mtimeMs, value }

function readSecretFile(file) {
    try {
        const st = statSync(file);
        const hit = secretCache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
        const value = readFileSync(file, 'utf8').trim();
        secretCache.set(file, { mtimeMs: st.mtimeMs, value });
        return value;
    } catch { return ''; }
}

export function resolverSecret(name = 'server2') {
    const file = process.env[`MUSIC_RESOLVER_SECRET_FILE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
        || (name === 'server2' ? process.env.MUSIC_RESOLVER_SECRET_FILE : '');
    return (file && readSecretFile(file)) || (name === 'server2' ? process.env.MUSIC_RESOLVER_SECRET || '' : '');
}
