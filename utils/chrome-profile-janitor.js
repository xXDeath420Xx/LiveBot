/*
 * Deletes temporary Chrome profile folders that no running Chrome is using.
 *
 * Puppeteer and Playwright each give every launched browser a throwaway profile in the temp dir
 * (puppeteer_dev_profile-*, playwright_chromiumdev_profile-*) and remove it on a clean close().
 * They do NOT remove it when Chrome crashes, disconnects mid-scrape (the Throne scraper runs through
 * Tor), or is killed with the bot on a PM2 restart. Those leftovers are 10–500 MB each: on
 * 2026-09-17 6,707 of them (86 GB) filled the root disk, MariaDB could no longer write temporary
 * tables, and the dashboard's streamers list and Edit on End stopped working for 2.5 hours.
 *
 * A folder is only removed when it is ALL of:
 *   - one of the known browser temp-folder patterns, directly inside a temp dir we scan
 *   - owned by this user
 *   - not named in any running process's --user-data-dir (the authoritative "in use" check)
 *   - untouched for MIN_AGE_MS (covers a browser launching right now, before its process shows up)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from './logger.js';

const PATTERNS = [
    /^puppeteer_dev_profile-/,
    /^puppeteer_dev_chrome_profile-/,
    /^playwright_chromiumdev_profile-/,
    /^playwright-artifacts-/,
    /^com\.google\.Chrome\./,
    /^\.org\.chromium\.Chromium\./,
];
const MIN_AGE_MS = 60 * 60_000;
const INTERVAL_MS = 15 * 60_000;

let timer = null;

/** Every --user-data-dir currently passed to a running process. */
async function profilesInUse() {
    const inUse = new Set();
    let pids = [];
    try {
        pids = (await fs.readdir('/proc')).filter(n => /^\d+$/.test(n));
    } catch {
        return null;                                    // can't tell what's in use: delete nothing
    }
    await Promise.all(pids.map(async pid => {
        try {
            const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
            for (const a of args) {
                if (a.startsWith('--user-data-dir=')) inUse.add(path.resolve(a.slice('--user-data-dir='.length)));
            }
        } catch { /* process exited while we looked */ }
    }));
    return inUse;
}

function tempDirs() {
    // os.tmpdir() is where the running process's browsers actually go; /tmp covers anything that
    // was launched with a different TMPDIR (see the note on the 2026-09-17 incident above).
    return [...new Set([os.tmpdir(), '/tmp'].map(d => path.resolve(d)))];
}

export async function sweepChromeProfiles({ dryRun = false, dirs = tempDirs() } = {}) {
    const inUse = await profilesInUse();
    if (!inUse) return { removed: 0, bytes: 0, skippedInUse: 0 };
    const uid = process.getuid?.();
    const now = Date.now();
    let removed = 0, skippedInUse = 0;

    for (const dir of dirs) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch { continue; }

        for (const entry of entries) {
            if (!entry.isDirectory() || !PATTERNS.some(re => re.test(entry.name))) continue;
            const full = path.join(dir, entry.name);
            try {
                const st = await fs.stat(full);
                if (uid !== undefined && st.uid !== uid) continue;
                if (inUse.has(full)) { skippedInUse++; continue; }
                if (now - st.mtimeMs < MIN_AGE_MS) continue;
                if (!dryRun) await fs.rm(full, { recursive: true, force: true });
                removed++;
            } catch (err) {
                logger.debug(`[ChromeJanitor] Could not remove ${full}: ${err.message}`);
            }
        }
    }
    if (removed) logger.info(`[ChromeJanitor] ${dryRun ? 'Would remove' : 'Removed'} ${removed} leftover browser profile folder(s) (${skippedInUse} in use, kept)`);
    return { removed, skippedInUse };
}

/** Once per process. Sweeps shortly after boot (a restart is exactly when browsers get killed), then every 15 minutes. */
export function startChromeProfileJanitor() {
    if (timer) return;
    const run = () => sweepChromeProfiles().catch(err => logger.warn(`[ChromeJanitor] Sweep failed: ${err.message}`));
    setTimeout(run, 2 * 60_000).unref?.();
    timer = setInterval(run, INTERVAL_MS);
    timer.unref?.();
}

export default { sweepChromeProfiles, startChromeProfileJanitor };
