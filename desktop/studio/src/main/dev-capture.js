'use strict';
/*
 * Development only (not packaged): CF_STUDIO_CAPTURE_DIR=<folder> takes a PNG of every tab in every theme after the
 * window has loaded, then quits. Used to check the layout and to make the guide's screenshots with demo data
 * (point the app at test/mock-obs.js and seed the activity with CF_STUDIO_DEMO=1).
 */
const fs = require('node:fs');
const path = require('node:path');

async function captureAll(win, dir, { themes = ['dark', 'light', 'sand'], tabs = ['status', 'activity', 'sounds', 'hotkeys', 'settings'], wait = 700 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const files = [];
    for (const theme of themes) {
        for (const tab of tabs) {
            await win.webContents.executeJavaScript(`window.studio.call('app:settings',{theme:${JSON.stringify(theme)}});document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-tab=${JSON.stringify(tab)}]').click();document.querySelector('.content').scrollTop=0;`);
            await sleep(wait);
            const img = await win.webContents.capturePage();
            const f = path.join(dir, `${theme}-${tab}.png`);
            fs.writeFileSync(f, img.toPNG());
            files.push(f);
        }
    }
    return files;
}

function demoActivity(add) {
    const now = Date.now();
    const items = [
        { kind: 'info', title: 'Connected to CertiFried', ok: true },
        { kind: 'info', title: 'OBS connected (OBS 31.0.0, WebSocket 5.5.0)', ok: true },
        { kind: 'action', title: 'Play sound', detail: 'Airhorn.mp3', ok: true },
        { kind: 'event', title: 'Scene changed', detail: 'Starting Soon', ok: true },
        { kind: 'action', title: 'Switch scene', detail: 'Main', ok: true },
        { kind: 'hotkey', title: 'Hotkey Ctrl+Shift+F1: run BRB', detail: 'run ok', ok: true },
        { kind: 'action', title: 'Show or hide source', detail: 'Webcam · hide', ok: false, error: 'source_not_found: No scene item was found.' },
        { kind: 'action', title: 'Set text', detail: 'Now Playing', ok: true },
    ];
    items.forEach((it, i) => add({ ...it, t: now - (items.length - i) * 47000 }));
}

module.exports = { captureAll, demoActivity };
