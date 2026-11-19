'use strict';
/* The hidden audio window's bridge: play/stop commands in, started/ended/error out. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioBridge', {
    onPlay: (fn) => ipcRenderer.on('audio:play', (_e, cmd) => fn(cmd)),
    onStop: (fn) => ipcRenderer.on('audio:stop', (_e, id) => fn(id)),
    onDevices: (fn) => ipcRenderer.on('audio:devices', (_e, req) => fn(req)),
    started: (id) => ipcRenderer.send('audio:started', id),
    ended: (id) => ipcRenderer.send('audio:ended', id),
    error: (id, reason) => ipcRenderer.send('audio:error', id, reason),
    reply: (id, value) => ipcRenderer.send('audio:reply', id, value),
    // voice commands: microphone on/off, and audio + level out (audio never leaves the PC; main pipes it to the helper)
    onVoiceStart: (fn) => ipcRenderer.on('voice:start', (_e, req) => fn(req)),
    onVoiceStop: (fn) => ipcRenderer.on('voice:stop', () => fn()),
    voicePcm: (buf) => ipcRenderer.send('voice:pcm', buf),
    voiceLevel: (level) => ipcRenderer.send('voice:level', level),
    voiceState: (state, reason) => ipcRenderer.send('voice:mic', state, reason),
});
