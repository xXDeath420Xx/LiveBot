// Thin client for windrose-agent's localhost control API.
//
// Mirrors services/relay-client.js: the dashboard never talks to Docker or the
// game filesystem directly, it asks the agent. Keeping that boundary sharp is
// the reason the agent exists — see the spec's §3 on why the Docker socket must
// never be reachable from this process.
//
// Like relay-client, an unreachable agent must NOT throw into the request path.
// The panel's job when the backend is down is to say so calmly, not to 500 the
// whole dashboard.

import logger from '../../utils/logger.js';

const AGENT_URL = process.env.WINDROSE_AGENT_URL || 'http://127.0.0.1:4091';
const AGENT_SECRET = process.env.WINDROSE_AGENT_SECRET || '';

// Lifecycle and RCON calls are slow by nature: RCON round-trips through the
// Lua spool at ~4s, and a graceful restart warns players for 5 minutes before
// it returns. A single short timeout would abort them mid-flight.
const DEFAULT_TIMEOUT_MS = 8_000;
const SLOW_TIMEOUT_MS = 30_000;

async function call(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!AGENT_SECRET) {
        return { ok: false, agentUnreachable: true, error: 'WINDROSE_AGENT_SECRET is not configured' };
    }

    try {
        const res = await fetch(`${AGENT_URL}${path}`, {
            method,
            headers: {
                'x-agent-secret': AGENT_SECRET,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            // 400s carry messages written for humans (jail errors, validation);
            // pass them through rather than flattening to "something failed".
            return { ok: false, status: res.status, error: data.error || `agent returned ${res.status}` };
        }
        return { ok: true, data };
    } catch (err) {
        const unreachable = err.name === 'TimeoutError' || err.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message);
        if (unreachable) {
            logger.warn(`windrose-agent unreachable at ${AGENT_URL}: ${err.message}`);
            return { ok: false, agentUnreachable: true, error: 'The Windrose agent is not responding.' };
        }
        logger.error(`windrose-agent call ${path} failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

export const windroseAgent = {
    status: () => call('/status'),
    livemap: () => call('/livemap'),
    commands: () => call('/commands'),
    consoleHistory: () => call('/console'),
    stats: () => call('/stats'),
    logs: (tail = 200) => call(`/logs?tail=${encodeURIComponent(tail)}`),
    config: () => call('/config'),
    backups: () => call('/backups'),
    schedule: () => call('/schedule'),

    rcon: (command) => call('/rcon', { method: 'POST', body: { command }, timeoutMs: SLOW_TIMEOUT_MS }),

    start: () => call('/lifecycle/start', { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS }),
    stop: () => call('/lifecycle/stop', { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS }),
    // Graceful by default — warns players at T-5m and T-1m and snapshots first.
    // That takes minutes, so it is fired and not awaited by the route.
    restart: (immediate = false) => call('/lifecycle/restart', { method: 'POST', body: { immediate }, timeoutMs: SLOW_TIMEOUT_MS }),

    snapshot: (opts) => call('/backups', { method: 'POST', body: opts, timeoutMs: SLOW_TIMEOUT_MS }),
    pruneBackups: (keep) => call('/backups/prune', { method: 'POST', body: { keep } }),
    restoreBackup: (filename) => call('/backups/restore', { method: 'POST', body: { filename }, timeoutMs: SLOW_TIMEOUT_MS }),

    setMultipliers: (multipliers) => call('/config/multipliers', { method: 'POST', body: { multipliers } }),
    setWorldSettings: (settings) => call('/config/world', { method: 'POST', body: { settings } }),

    scheduleDaily: (hour, minute) => call('/schedule/daily', { method: 'POST', body: { hour, minute } }),
    cancelSchedule: () => call('/schedule/cancel', { method: 'POST' }),

    listFiles: (p) => call(`/files?path=${encodeURIComponent(p || '.')}`),
    readFile: (p) => call(`/file?path=${encodeURIComponent(p)}`),
    writeFile: (p, content) => call('/file', { method: 'POST', body: { path: p, content } }),
    deleteFile: (p) => call('/file', { method: 'DELETE', body: { path: p } }),

    watchdog: () => call('/watchdog'),

    iniSummary: () => call('/ini'),
    // entities alone is 1,401 keys; give the parse room.
    iniFile: (name) => call(`/ini/file?name=${encodeURIComponent(name)}`, { timeoutMs: 20_000 }),
    iniSearch: (q) => call(`/ini/search?q=${encodeURIComponent(q)}`, { timeoutMs: 30_000 }),
    iniSet: (name, patch) => call('/ini/file', { method: 'POST', body: { name, patch }, timeoutMs: 20_000 }),
    iniReset: (name) => call('/ini/reset', { method: 'POST', body: { name } }),

    serverSettings: () => call('/settings'),
    saveSettings: (patch) => call('/settings', { method: 'POST', body: { patch } }),
    applySettings: () => call('/settings/apply', { method: 'POST', timeoutMs: 10 * 60_000 }),

    listPlayers: (positions) => call(`/players${positions ? '?positions=1' : ''}`, { timeoutMs: positions ? 30_000 : 8_000 }),
    bans: () => call('/players/bans'),
    moderationStatus: () => call('/players/moderation-status'),
    // Moderation double-checks execution after issuing, so allow for that.
    moderate: (action, target, reason) => call('/players/moderate', { method: 'POST', body: { action, target, reason }, timeoutMs: 40_000 }),
    clearPendingModeration: () => call('/players/clear-pending', { method: 'POST' }),

    renameFile: (p, name) => call('/files/rename', { method: 'POST', body: { path: p, name } }),
    mkdir: (p) => call('/files/mkdir', { method: 'POST', body: { path: p } }),

    // Used by the /windrose Discord command only — the web panel deliberately
    // never fetches this, so the password never reaches a browser session.
    joinSecret: () => call('/connection/secret'),

    listSaves: () => call('/saves'),
    inspectSave: (p) => call('/saves/inspect', { method: 'POST', body: { path: p } }),
    // Import rehydrates a RocksDB checkpoint; give it room.
    importSave: (p, activate, createdBy) => call('/saves/import', { method: 'POST', body: { path: p, activate, createdBy }, timeoutMs: 10 * 60_000 }),
    activateWorld: (islandId) => call('/saves/activate', { method: 'POST', body: { islandId } }),
    discardUpload: (p) => call('/saves/discard', { method: 'POST', body: { path: p } }),

    currentImage: () => call('/update'),
    // Pulling a ~1GB image and recreating the container both take minutes.
    checkUpdate: () => call('/update/check', { method: 'POST', timeoutMs: 15 * 60_000 }),
    applyUpdate: () => call('/update/apply', { method: 'POST', timeoutMs: 10 * 60_000 }),
    // The game download can be gigabytes and the agent polls for the new build
    // afterwards, so this one genuinely needs 20 minutes.
    updateGame: () => call('/update/game', { method: 'POST', timeoutMs: 20 * 60_000 }),

    autoUpdate: () => call('/autoupdate', { timeoutMs: 20_000 }),
    autoUpdateCheck: (force) => call('/autoupdate/check', { method: 'POST', body: { force }, timeoutMs: 20 * 60_000 }),
    setAutoUpdate: (enabled) => call('/autoupdate/enabled', { method: 'POST', body: { enabled } }),

    listMods: () => call('/mods'),
    installMod: (mod) => call('/mods', { method: 'POST', body: mod }),
    removeMod: (name) => call('/mods', { method: 'DELETE', body: { name } }),
};

/**
 * Stream a world save to the agent as a raw body.
 *
 * Deliberately not routed through `call`: a save is up to 512MB and
 * JSON-encoding it would buffer the whole thing in this process's heap — the
 * same process running 41 Discord bots with a 3GB restart ceiling.
 */
export async function uploadSave(buffer, filename) {
    if (!AGENT_SECRET) return { ok: false, agentUnreachable: true, error: 'WINDROSE_AGENT_SECRET is not configured' };
    try {
        const res = await fetch(`${AGENT_URL}/saves/upload`, {
            method: 'POST',
            headers: {
                'x-agent-secret': AGENT_SECRET,
                'x-filename': filename || 'upload.zip',
                'Content-Type': 'application/octet-stream',
            },
            body: buffer,
            signal: AbortSignal.timeout(10 * 60_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, status: res.status, error: data.error || `upload failed (${res.status})` };
        return { ok: true, data };
    } catch (err) {
        logger.error(`windrose save upload failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/** Stream a file into server-files. Raw body, same reasoning as uploadSave. */
export async function uploadFile(buffer, dir, filename) {
    if (!AGENT_SECRET) return { ok: false, agentUnreachable: true, error: 'WINDROSE_AGENT_SECRET is not configured' };
    try {
        const res = await fetch(`${AGENT_URL}/files/upload`, {
            method: 'POST',
            headers: {
                'x-agent-secret': AGENT_SECRET,
                'x-dir': dir || '.',
                'x-filename': filename || 'upload.bin',
                'Content-Type': 'application/octet-stream',
            },
            body: buffer,
            signal: AbortSignal.timeout(5 * 60_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, status: res.status, error: data.error || `upload failed (${res.status})` };
        return { ok: true, data };
    } catch (err) {
        logger.error(`windrose file upload failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/** Node stream for a file download; caller pipes it to the response. */
export function downloadFileUrl(relPath) {
    return { url: `${AGENT_URL}/files/download?path=${encodeURIComponent(relPath)}`, secret: AGENT_SECRET };
}

export default windroseAgent;
