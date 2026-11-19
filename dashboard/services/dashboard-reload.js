/**
 * No-restart dashboard reloads: a request file the running dashboard watches.
 *
 * The dashboard lives in the same process as every bot, so a pm2 restart for a template or
 * stylesheet change dropped all bots for about a minute. Templates and static files need no
 * new code, only fresh caches, so:
 *
 *   scripts/reload-dashboard.mjs  writes REQUEST_FILE ({ id, reason, at }), mode 0600
 *   the dashboard (server.js)     polls that one file's stat (fs.watchFile, 1 s), debounces,
 *                                 runs the reload (view-engine reload(): compiled templates,
 *                                 include paths, asset ?v= hashes, classic CSS map, ejs cache)
 *                                 and writes ACK_FILE ({ id, ok, generation, cleared, at })
 *   the script                    waits for the ack with its id, so "reloaded" is confirmed by
 *                                 the server, not assumed
 *
 * Only requests written by the user the dashboard runs as are honoured (the file's owner uid
 * must match the process), and the request carries no instructions beyond "reload" — the
 * worst a forged one could do is make the next page views recompile. JS modules (routes, core/)
 * are NOT reloaded; a change there still needs a restart (run-deploy-views.sh refuses those).
 *
 * Pure helpers (parseRequest, makeRequest) are unit-tested in tests/dashboard-reload.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const REQUEST_FILE = path.join(DATA_DIR, '.reload-request');
export const ACK_FILE = path.join(DATA_DIR, '.reload-ack');

const ID_RE = /^[a-z0-9-]{8,64}$/;

/** A fresh request body. */
export function makeRequest(reason = '', now = Date.now()) {
    return {
        id: `${now.toString(36)}-${crypto.randomBytes(6).toString('hex')}`,
        reason: cleanReason(reason),
        at: now,
    };
}

function cleanReason(reason) {
    return String(reason ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

/** The request in a file's text, or null when it is not one (wrong shape, bad id). */
export function parseRequest(text) {
    let body;
    try {
        body = JSON.parse(String(text ?? ''));
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object' || !ID_RE.test(String(body.id ?? ''))) return null;
    return { id: body.id, reason: cleanReason(body.reason), at: Number(body.at) || 0 };
}

/** Write JSON atomically (temp file + rename) so a reader never sees half a file. */
export function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

/**
 * Watch REQUEST_FILE and run `onReload(request)` for each new request; returns stop().
 * onReload returns what goes in the ack ({ generation, cleared, ... }).
 */
export function watchReloadRequests({
    onReload, logger = console, requestFile = REQUEST_FILE, ackFile = ACK_FILE,
    intervalMs = 1000, debounceMs = 300, uid = process.getuid?.(),
} = {}) {
    let timer = null;
    let lastId = null;

    const handle = () => {
        timer = null;
        let stat;
        let text;
        try {
            stat = fs.statSync(requestFile);
            text = fs.readFileSync(requestFile, 'utf8');
        } catch {
            return;   // removed again before we got to it
        }
        if (uid !== undefined && stat.uid !== uid) {
            logger.warn(`[DashboardReload] ignored a request file owned by uid ${stat.uid}`);
            return;
        }
        const request = parseRequest(text);
        if (!request) {
            logger.warn('[DashboardReload] ignored an unreadable request file');
            return;
        }
        if (request.id === lastId) return;
        lastId = request.id;
        let ack;
        try {
            ack = { id: request.id, ok: true, ...onReload(request), at: Date.now() };
            logger.info(`[DashboardReload] reloaded views and static assets (${request.reason || 'no reason given'}): generation ${ack.generation}, ${ack.cleared} compiled templates dropped`);
        } catch (error) {
            ack = { id: request.id, ok: false, error: String(error?.message || error).slice(0, 300), at: Date.now() };
            logger.error(`[DashboardReload] reload failed: ${ack.error}`);
        }
        try {
            writeJsonAtomic(ackFile, ack);
        } catch (error) {
            logger.error(`[DashboardReload] could not write the ack: ${error.message}`);
        }
    };

    const listener = (curr, prev) => {
        // The script replaces the file (rename), so a new inode is a new request even in the same ms.
        if (!curr.mtimeMs || (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino)) return;
        clearTimeout(timer);
        timer = setTimeout(handle, debounceMs);
        timer.unref?.();
    };
    fs.watchFile(requestFile, { interval: intervalMs, persistent: false }, listener);
    return () => {
        clearTimeout(timer);
        fs.unwatchFile(requestFile, listener);
    };
}
