'use strict';
/*
 * Updates.
 *
 * Installed copies (NSIS) use electron-updater with the generic feed https://certifriedmultitool.com/downloads/studio/
 * (latest.yml). The app is not code-signed; electron-updater still checks the download against the sha512 in
 * latest.yml before installing it. Updates download in the background and install when the app quits, or at once
 * with "Restart to update".
 *
 * The portable copy cannot replace itself, so it only reads latest.yml and says when a newer version is on the
 * download page.
 *
 * No install ID (H-767, 0.2.5): electron-updater would send a random per-install UUID (x-user-staging-id, kept in
 * userData/.updaterId) for staged roll-outs, which CertiFried does not use. blankStagingId() makes every copy send the nil
 * UUID and removes the file older versions wrote.
 *
 *   createUpdater({ app, logger, isPortable, feedUrl, fetchImpl, onStatus })
 *     check()          status: { state: 'idle'|'checking'|'none'|'available'|'downloading'|'ready'|'error'|'portable-available', version?, percent? }
 *     installNow()     quit and install a downloaded update
 *     start(everyMs)   check soon after start, then every `everyMs`
 */
const fs = require('node:fs');
const path = require('node:path');
const { FEED } = require('./site');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Every copy sends the same nil staging ID; no .updaterId file is made, and one from an older version is deleted. */
function blankStagingId(au, userDataDir) {
    au.stagingUserIdPromise = { value: Promise.resolve(NIL_UUID) };
    if (userDataDir) { try { fs.unlinkSync(path.join(userDataDir, '.updaterId')); } catch { /* none */ } }
    return au;
}

function newer(a, b) {
    const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
    return false;
}

function versionFromYml(text) {
    const m = String(text).match(/^version:\s*['"]?([0-9][0-9A-Za-z.-]*)/m);
    return m ? m[1] : null;
}

function createUpdater({ app, logger = null, isPortable = false, feedUrl = FEED, fetchImpl = globalThis.fetch, onStatus = () => {} }) {
    let status = { state: 'idle' };
    let timer = null;
    let au = null;
    const set = (s) => { status = s; try { onStatus(s); } catch { /* ignore */ } };

    function updater() {
        if (au) return au;
        ({ autoUpdater: au } = require('electron-updater'));
        au.logger = { info: (m) => logger?.info?.(`[update] ${m}`), warn: (m) => logger?.warn?.(`[update] ${m}`), error: (m) => logger?.warn?.(`[update] ${m}`), debug() {} };
        au.autoDownload = true;
        au.autoInstallOnAppQuit = true;
        au.allowPrerelease = false;
        au.setFeedURL({ provider: 'generic', url: feedUrl, channel: 'latest' });
        let userData = null;
        try { userData = app.getPath('userData'); } catch { /* tests */ }
        blankStagingId(au, userData);
        au.on('checking-for-update', () => set({ state: 'checking' }));
        au.on('update-not-available', () => set({ state: 'none' }));
        au.on('update-available', (i) => set({ state: 'downloading', version: i?.version, percent: 0 }));
        au.on('download-progress', (p) => set({ state: 'downloading', version: status.version, percent: Math.round(p?.percent || 0) }));
        au.on('update-downloaded', (i) => set({ state: 'ready', version: i?.version }));
        au.on('error', (e) => { logger?.warn?.('[update] check failed', { error: e?.message }); set({ state: 'error' }); });
        return au;
    }

    async function checkPortable() {
        set({ state: 'checking' });
        try {
            const res = await fetchImpl(new URL('latest.yml', feedUrl).href, { redirect: 'error' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const v = versionFromYml(await res.text());
            if (v && newer(v, app.getVersion())) set({ state: 'portable-available', version: v });
            else set({ state: 'none' });
        } catch (e) {
            logger?.info?.('[update] could not read the update feed', { error: e.message });
            set({ state: 'error' });
        }
    }

    async function check() {
        if (!app.isPackaged) { set({ state: 'none', dev: true }); return status; }
        if (isPortable) { await checkPortable(); return status; }
        try { await updater().checkForUpdates(); } catch (e) { logger?.warn?.('[update] check failed', { error: e?.message }); set({ state: 'error' }); }
        return status;
    }

    return {
        check,
        start(everyMs = 6 * 60 * 60 * 1000) {
            clearInterval(timer);
            setTimeout(() => check().catch(() => {}), 15000).unref?.();
            timer = setInterval(() => check().catch(() => {}), everyMs);
            timer.unref?.();
        },
        stop() { clearInterval(timer); },
        installNow() { if (status.state === 'ready' && au) au.quitAndInstall(false, true); },
        get status() { return status; },
    };
}

module.exports = { createUpdater, newer, versionFromYml, blankStagingId, NIL_UUID, FEED };
