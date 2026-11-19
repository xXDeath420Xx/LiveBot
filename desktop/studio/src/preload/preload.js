'use strict';
/* The main window's bridge: a fixed list of calls into the main process, and three pushed updates. */
const { contextBridge, ipcRenderer } = require('electron');

const CALLS = new Set([
    'state:get', 'pair', 'unpair', 'link:start', 'link:open', 'link:cancel', 'obs:import', 'app:copy', 'setup:status', 'docks:prepare', 'docks:add', 'theme:install', 'scenes:create', 'overlays:list', 'overlays:add', 'voice:settings', 'voice:devices', 'voice:refresh', 'vod:check', 'vod:keepOut', 'vod:record', 'vod:kick', 'server:set', 'engine:reconnect', 'obs:save', 'obs:reconnect',
    'sound:settings', 'sound:devices', 'sound:test', 'sound:stop', 'sound:openFolder', 'sound:sync',
    'hotkeys:save', 'hotkeys:pause', 'hotkeys:run', 'automations:refresh',
    'app:settings', 'app:checkUpdates', 'app:installUpdate', 'app:openLogs', 'app:openPage', 'app:registerLinks', 'app:quit',
]);
const PUSHES = new Set(['state', 'activity', 'pair-code', 'voice-level']);

contextBridge.exposeInMainWorld('studio', {
    call: (channel, payload) => (CALLS.has(channel) ? ipcRenderer.invoke(channel, payload) : Promise.resolve({ ok: false, error: 'unknown call' })),
    on: (channel, fn) => {
        if (!PUSHES.has(channel)) return () => {};
        const h = (_e, v) => fn(v);
        ipcRenderer.on(channel, h);
        return () => ipcRenderer.removeListener(channel, h);
    },
});
