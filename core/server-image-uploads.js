/**
 * Server images in dashboard/public/uploads that a newer upload replaces (register H-706): bot avatars
 * (Appearance page), welcome banners (Welcome page and /manage welcome set-welcome) and schedule images
 * (Twitch schedule backgrounds, side art, example posters and the backdrops generated from them).
 *
 * Replacing one used to leave the old file on disk, publicly reachable, for good. Now:
 *   - a save that replaces one calls discardReplacedUpload(oldUrl), which deletes the old file unless
 *     something still points at it;
 *   - the nightly retention sweep (jobs/retention-sweeper.js) calls pruneServerImageFiles(), which deletes
 *     any such file nothing points at, older than a day (the same rule as the greeting-card media prune).
 *
 * "Something points at it" means any of REF_COLUMNS, including the server backups (a restore puts the
 * old avatar or banner back, so its file must stay while the backup exists).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dashboard/public/uploads');

/**
 * The file names this module manages, as the code writes them:
 *   avatar_<guild>_<ms>.png (and the _orig upload, removed after resizing)   dashboard/server.js update-bot-appearance
 *   welcome_<guild>_<ms>.<png|jpg|jpeg>                                       update-welcome, core/welcome-background.js
 *   schedule_<guild>_<ms>_<n>.<png|jpg|jpeg|webp>                             saveScheduleUpload
 *   schedule_bg_<ms>_<random>.<png|jpg|webp>                                  utils/schedule-background.js (generated)
 */
export const SERVER_IMAGE_FILE = /^(?:avatar_\d+_\d+(?:_orig)?\.(?:png|jpe?g|gif|webp)|welcome_\d+_\d+\.(?:png|jpe?g)|schedule_\d+_\d+_\d+\.(?:png|jpe?g|webp)|schedule_bg_\d+_[a-z0-9]+\.(?:png|jpe?g|webp))$/;

/** Every column that can hold a link to one of these files. Fixed list; never from input. */
export const REF_COLUMNS = Object.freeze([
    ['guild_config', 'bot_avatar_url'],
    ['welcome_settings', 'card_background_url'],
    ['twitch_schedule_sync_config', 'background_url'],
    ['twitch_schedule_sync_config', 'background_cache_url'],
    ['twitch_schedule_sync_config', 'side_art_url'],
    ['schedule_templates', 'source_url'],
    ['schedule_templates', 'cache_url'],
    ['server_backups', 'snapshot_json'],
]);

export const GRACE_MS = 24 * 60 * 60 * 1000;   // a file written moments before the row that points at it

/** The managed upload file name a URL points at, or null (another file, another site, or not a link). */
export function serverImageName(url) {
    const m = String(url ?? '').match(/\/uploads\/([^?#\s"'<>\\/]+)/);
    return m && SERVER_IMAGE_FILE.test(m[1]) ? m[1] : null;
}

/** Every managed file name mentioned in a set of values (a backup's JSON can mention several). */
export function serverImageNamesIn(values) {
    const names = new Set();
    for (const v of values) {
        for (const m of String(v ?? '').matchAll(/\/uploads\/([^?#\s"'<>\\/]+)/g)) {
            if (SERVER_IMAGE_FILE.test(m[1])) names.add(m[1]);
        }
    }
    return names;
}

async function columnExists(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
        [table, column]);
    return rows.length > 0;
}

/** Whether any REF_COLUMNS value links to this file. A column that does not exist is skipped. */
export async function isServerImageReferenced(name, { db = pool } = {}) {
    const like = `%/uploads/${String(name).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    for (const [table, column] of REF_COLUMNS) {
        if (!(await columnExists(db, table, column))) continue;
        const [rows] = await db.query(`SELECT 1 FROM \`${table}\` WHERE \`${column}\` LIKE ? LIMIT 1`, [like]);
        if (rows.length) return true;
    }
    return false;
}

/** All managed file names any REF_COLUMNS value links to. */
export async function collectServerImageRefs({ db = pool } = {}) {
    const names = new Set();
    for (const [table, column] of REF_COLUMNS) {
        if (!(await columnExists(db, table, column))) continue;
        const [rows] = await db.query(
            `SELECT \`${column}\` AS v FROM \`${table}\` WHERE \`${column}\` LIKE '%/uploads/%'`);
        for (const n of serverImageNamesIn(rows.map((r) => r.v))) names.add(n);
    }
    return names;
}

/**
 * Delete the file a replaced link pointed at, after the new link is saved. Does nothing when the old link
 * is not one of our managed uploads, when it is the same file as `newUrl`, or when anything still links to
 * it. Never throws: a file that cannot be removed now is left for the nightly sweep.
 * @returns {Promise<boolean>} whether a file was deleted
 */
export async function discardReplacedUpload(oldUrl, newUrl = null, { dir = UPLOAD_DIR, db = pool } = {}) {
    const name = serverImageName(oldUrl);
    if (!name || name === serverImageName(newUrl)) return false;
    try {
        if (await isServerImageReferenced(name, { db })) return false;
        await fs.promises.unlink(path.join(dir, name));
        logger.info(`[Uploads] Removed replaced image ${name}`);
        return true;
    } catch (error) {
        if (error.code !== 'ENOENT') logger.warn(`[Uploads] Could not remove replaced image ${name}: ${error.message}`);
        return false;
    }
}

/**
 * Nightly: delete managed images nothing links to, older than GRACE_MS. `dir`, `refs` and `now` are for tests.
 * @returns {Promise<{deleted: number}>}
 */
export async function pruneServerImageFiles({ dir = UPLOAD_DIR, refs, now = Date.now(), db = pool } = {}) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return { deleted: 0 }; }
    const candidates = names.filter((n) => SERVER_IMAGE_FILE.test(n));
    if (!candidates.length) return { deleted: 0 };
    const linked = refs ?? await collectServerImageRefs({ db });
    let deleted = 0;
    for (const name of candidates) {
        if (linked.has(name)) continue;
        const file = path.join(dir, name);
        try {
            const st = await fs.promises.stat(file);
            if (st.isFile() && now - st.mtimeMs > GRACE_MS) { await fs.promises.unlink(file); deleted++; }
        } catch { /* gone already, or unreadable: leave it */ }
    }
    return { deleted };
}

export default { serverImageName, serverImageNamesIn, discardReplacedUpload, pruneServerImageFiles, collectServerImageRefs, isServerImageReferenced };
