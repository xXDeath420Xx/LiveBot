// Reads Windrose+'s on-disk state files from the container's bind mount.
//
// Why this exists alongside the HTTP client: the RCON API costs 1 req/s of a
// budget shared by every friend on the panel, but Windrose+ also writes its
// state to plain JSON in windrose_plus_data/. Reading those files costs nothing
// and gives us status, live map, and console history for free — so the HTTP
// budget stays reserved for actual commands.
//
// It also answers a question HTTP cannot. /api/health is served by the
// PowerShell web layer; rcon_status.json is written by the Lua module running
// INSIDE the game process. If health is ok but the heartbeat has gone stale,
// the web UI is alive and the game is wedged — a state the panel must be able
// to distinguish from "everything is fine".
//
// Strictly read-only. We never write cmd_*.json here: the spool is internal IPC
// that may change between releases, whereas the HTTP API is the documented
// contract. See spec §2b.

import { readFile } from 'node:fs/promises';
import { spoolPaths } from './config.js';

// The Lua module rewrites these files in place while we may be reading them, so
// a torn read is normal rather than exceptional. Callers get null and retry on
// the next poll instead of an exception.
async function readJson(file) {
    try {
        const raw = await readFile(file, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function createSpool({ paths = spoolPaths, now = () => Date.now() } = {}) {
    return {
        /**
         * Liveness as seen from inside the game process.
         * `ts` is a unix seconds heartbeat refreshed every ~5s by rcon.lua.
         */
        async heartbeat({ staleAfterMs = 30_000 } = {}) {
            const data = await readJson(paths.rconStatus);
            if (!data) return { alive: false, reason: 'no heartbeat file' };

            const ageMs = now() - (data.ts ?? 0) * 1000;
            return {
                alive: ageMs < staleAfterMs && data.state === 'running',
                state: data.state ?? 'unknown',
                detail: data.detail ?? '',
                version: data.version ?? null,
                ageMs,
                lastError: data.last_error || null,
            };
        },

        /** Player list, multipliers, invite code, server name — no RCON spent. */
        serverStatus() { return readJson(paths.serverStatus); },

        livemap() { return readJson(paths.livemap); },

        /** Rolling console buffer — powers the join/leave feed. */
        consoleHistory() { return readJson(paths.consoleHistory); },

        /** Live command catalog; drives console autocomplete and the allowlist. */
        commands() { return readJson(paths.commands); },
    };
}
