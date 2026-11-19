'use strict';
/*
 * CertiFried Studio: the Electron main process. It wires the pieces together:
 *
 *   engine-client.js  the CertiFried connection (pairing token from safeStorage)
 *   obs.js            OBS WebSocket v5          router.js   action → OBS / sound / key press
 *   sound.js          play queue + library      hotkeys.js  global hotkeys and key sending
 *   updater.js        electron-updater feed     logger.js   rotating, redacted log
 *
 * Windows: the main window (src/renderer/index.html) and a hidden audio window (src/renderer/audio.html) that plays
 * sounds with setSinkId. Closing the main window hides it to the tray; Quit is in the tray menu.
 *
 * Environment for testing only: CF_STUDIO_USER_DATA puts settings, logs and sounds in another folder.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, globalShortcut, shell, nativeImage, session, dialog, clipboard } = require('electron');

if (process.env.CF_STUDIO_USER_DATA) app.setPath('userData', path.resolve(process.env.CF_STUDIO_USER_DATA));
app.setAppUserModelId('com.certifried.studio');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { createLogger } = require('./logger');
const { createConfig } = require('./config');
const { exchangeCode, startLink, waitForLink, codeFromDeepLink, argvDeepLink, checkServer, wsUrlFor, normaliseCode } = require('./pairing');
const { obsConfigPath, obsConfigExists, readObsConfig } = require('./obs-config');
const { createEngineClient } = require('./engine-client');
const { createObs } = require('./obs');
const { createRouter } = require('./router');
const { createSoundPlayer, createLibrary } = require('./sound');
const { createHotkeys, createKeySender, validateBinding } = require('./hotkeys');
const { createUpdater } = require('./updater');
const { ACTION_LABELS, EVENT_LABELS, ENGINE_STATUS, OBS_STATUS, summarise } = require('./labels');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const { SITE, PAGES, SOURCE } = require('./site');
const { obsDir, locateDockConfig, readDocks, isObsRunning, addDocks, backupProfileIni, DOCK_PATH } = require('./obs-docks');
const { themesDirFor, themeInstalled, installTheme, planStarterScenes, createStarterScenes, STARTER_SCENES } = require('./obs-setup');
const { cleanOverlays, browserInputs, planOverlay, addOverlay } = require('./obs-overlays');
const { createVoice } = require('./voice');
const { createVodSafe } = require('./vod-safe');
const { parseKeys } = require('./hotkeys');
const SECURE_STORAGE_NOTICE = "Windows couldn't protect saved passwords on this PC, so you'll need to re-enter them each time the app starts.";
const LOCAL_KEY_NOTE = "Saved with a key stored in your Windows profile, because Windows' own password protection isn't working on this PC right now. It switches over automatically once it works again.";
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const isInstalled = app.isPackaged && !isPortable && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall CertiFried Studio.exe'));
const startedHidden = process.argv.includes('--hidden');

// ── single instance ──────────────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (_e, argv) => {
        const link = argvDeepLink(argv);
        if (link) handleDeepLink(link);
        showWindow();
    });
}

let log;
let config;
let mainWindow = null;
let audioWindow = null;
let tray = null;
let quitting = false;
let engine = null;
let obs;
let library;
let sound;
let keys;
let router;
let hotkeys;
let updater;
let pendingCode = null;
let automations = [];
let hotkeyFailures = [];
let lastSync = null;
const activity = [];
const audioWaiters = new Map();

// ── crash safety ─────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => { try { log?.error('uncaught error', { error: err?.message, stack: String(err?.stack || '').split('\n').slice(0, 6).join(' | ') }); } catch { /* ignore */ } });
process.on('unhandledRejection', (err) => { try { log?.error('unhandled rejection', { error: err?.message || String(err) }); } catch { /* ignore */ } });

// ── activity log (shown in the window; last 300 entries) ─────────────────────────────────────
function addActivity(entry) {
    const e = { t: Date.now(), ...entry };
    activity.push(e);
    if (activity.length > 300) activity.shift();
    send('activity', e);
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ── state for the window ─────────────────────────────────────────────────────────────────────
function uiState() {
    const s = config.get();
    if (!app.isPackaged && process.env.CF_STUDIO_DEMO) {
        // Screenshots for the guide: show the real service address and OBS's default port, not the local fakes.
        s.server = SITE;
        s.obs = { ...s.obs, port: 4455 };
    }
    return {
        version: app.getVersion(), isPortable, isInstalled,
        paired: config.hasSecret('deviceToken'), device: s.device, server: s.server, storage: storageView(),
        engine: { status: engine?.status || 'idle', label: ENGINE_STATUS[engine?.status || 'idle'] || engine?.status, features: engine?.features || [] },
        obs: { status: obs.status, label: OBS_STATUS[obs.status] || obs.status, detail: obs.detail, snapshot: obsSummary(), settings: s.obs, hasPassword: config.hasSecret('obsPassword'),
            // Offer "Use my OBS settings" when OBS wants a password and its settings file is there (only checked, not read).
            offerImport: obs.status === 'auth_failed' && obsConfigExists(obsConfigPath()) },
        link: linkView(),
        sound: { settings: s.sound, library: library.list().map(({ name, source }) => ({ name, source })), localDir: library.localDir, lastSync, playing: sound.state() },
        hotkeys: s.hotkeys, hotkeyFailures, automations,
        app: s.app, update: updater?.status || { state: 'idle' },
        keySending: keys.available,
        voice: voiceView(),
        vod: vodSafe ? { ...vodSafe.status(), kickMusic: s.music.kickMusic } : null,
        docks: { ready: !!dockUrls, titles: DOCKS.map((d) => d.title) },
        activity: activity.slice(-150),
        logFile: log.file,
    };
}

/** How secrets are kept: a banner only when something could not be saved at all; a quiet line in Settings for the local key. */
function storageView() {
    const mode = config.storageMode();
    return { mode, banner: mode === 'memory' ? SECURE_STORAGE_NOTICE : null, note: mode === 'local' ? LOCAL_KEY_NOTE : null };
}

function obsSummary() {
    const snap = obs.snapshot();
    return { connected: snap.connected, version: snap.version, currentScene: snap.currentScene, scenes: snap.scenes, sources: snap.sources, inputs: snap.inputs, filters: snap.filters, studioMode: snap.studioMode, streaming: snap.streaming, recording: snap.recording };
}

let pushTimer = null;
function pushState() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => send('state', uiState()), 80);
}

// ── what the engine is told about this PC (phase 2 servers) ─────────────────────────────────
function fitState(obsSnap, sounds) {
    const state = {
        obs: { connected: obsSnap.connected, version: obsSnap.version, studioMode: obsSnap.studioMode, currentScene: obsSnap.currentScene, scenes: obsSnap.scenes, sources: obsSnap.sources, inputs: obsSnap.inputs, filters: obsSnap.filters },
        sounds: sounds.slice(0, 500),
    };
    if (vodSafe) {
        const v = vodSafe.status();
        // The engine only sends songs while this says vodSafe: true (VOD-safe music).
        state.music = { vodSafe: !!v.vodSafe, reason: v.reason || null, vodTrack: v.vodTrack || null, liveTrack: v.liveTrack || null, sourceReady: !!v.sourceReady, live: !!v.live, checkedAt: v.checkedAt || null };
    }
    const size = () => Buffer.byteLength(JSON.stringify(state));
    if (size() > 58000) state.obs.filters = {};
    if (size() > 58000) for (const k of Object.keys(state.obs.sources)) state.obs.sources[k] = state.obs.sources[k].slice(0, 40);
    if (size() > 58000) state.obs.inputs = state.obs.inputs.slice(0, 150);
    if (size() > 58000) state.sounds = state.sounds.slice(0, 100);
    if (size() > 58000) state.obs.sources = {};
    return state;
}

let stateTimer = null;
function reportState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
        if (!engine) return;
        engine.sendState(fitState(obs.snapshot(), library.list().map((s) => s.name)));
    }, 1000);
}

// ── engine connection ────────────────────────────────────────────────────────────────────────
function buildEngine() {
    if (engine) { engine.removeAllListeners(); engine.stop(); engine = null; }
    if (!config.hasSecret('deviceToken')) { pushState(); return; }
    const s = config.get();
    let url;
    try { url = wsUrlFor(s.server); } catch { log.warn('the server address is not valid'); return; }
    engine = createEngineClient({
        url,
        getToken: () => config.getSecret('deviceToken'),
        clientInfo: { app: 'certifried-studio', version: app.getVersion() },
        capabilities: router.capabilities(),
        logger: log,
        onAction: async ({ action, params, runId }) => {
            const r = await router.run(action, params);
            addActivity({ kind: 'action', action, title: ACTION_LABELS[action] || action, detail: summarise(action, params), ok: r.ok, error: r.ok ? null : r.error, runId });
            return r;
        },
    });
    engine.on('status', (st, detail) => {
        log.info('CertiFried connection', { status: st, ...(detail || {}) });
        if (['auth_failed', 'revoked'].includes(st)) addActivity({ kind: 'info', title: st === 'revoked' ? 'This PC was removed on the dashboard. Pair it again.' : 'CertiFried did not accept this device. Pair it again.', ok: false });
        if (st === 'replaced') addActivity({ kind: 'info', title: 'Another copy of CertiFried Studio connected with this pairing. This one stopped.', ok: false });
        updateTray();
        pushState();
    });
    engine.on('sounds-changed', () => { if (config.get().sound.syncDashboard) syncSounds().catch((e) => log.warn('sound sync failed', { error: e.message })); });
    engine.on('automations-changed', () => { refreshAutomations().catch(() => {}); refreshVoicePhrases().catch(() => {}); });
    engine.on('welcome', () => {
        addActivity({ kind: 'info', title: 'Connected to CertiFried', ok: true });
        reportState();
        if (engine.supports('request')) {
            refreshAutomations().catch(() => {});
            refreshVoicePhrases().catch(() => {});
            if (config.get().sound.syncDashboard) syncSounds().catch(() => {});
        }
    });
    engine.start();
}

async function refreshAutomations() {
    if (!engine?.supports('request')) return automations;
    const r = await engine.request('automations.list', {});
    automations = (r?.automations || []).map((a) => ({ id: Number(a.id), name: String(a.name || ''), enabled: !!a.enabled })).filter((a) => a.id > 0);
    pushState();
    return automations;
}

async function syncSounds() {
    if (!engine?.supports('request')) return null;
    const origin = checkServer(config.get().server);
    const token = config.getSecret('deviceToken');
    const r = await library.syncDashboard({
        list: async () => (await engine.request('sounds.list', {}))?.sounds || [],
        download: async (rel) => {
            const u = new URL(rel, origin);
            if (u.origin !== origin) throw new Error('sound from another site');
            const res = await fetch(u.href, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        },
    });
    lastSync = { at: Date.now(), ...r };
    if (r.downloaded || r.removed) addActivity({ kind: 'info', title: `Dashboard sounds synced: ${r.total} in total`, ok: true });
    reportState();
    pushState();
    return r;
}

async function pairWith(code, name) {
    const s = config.get();
    const capabilities = router.capabilities();
    const r = await exchangeCode({ base: s.server, code, name: name || s.device.name || defaultDeviceName(), capabilities });
    adoptToken(r.token, r.deviceId, name || s.device.name || defaultDeviceName(), 'Paired with CertiFried');
    return { deviceId: r.deviceId };
}

/** Keep a device token from pairing or browser sign-in, and connect. */
function adoptToken(token, deviceId, name, title) {
    if (config.setSecret('deviceToken', token) === 'memory') addActivity({ kind: 'info', title: SECURE_STORAGE_NOTICE, ok: false });
    config.update({ device: { id: deviceId, name, pairedAt: new Date().toISOString() } });
    log.info('paired', { deviceId });
    addActivity({ kind: 'info', title, ok: true });
    buildEngine();
}

// ── "Sign in with CertiFried": approve in the browser ───────────────────────────────────────
// ── OBS docks, theme and starter scenes ("Set up OBS for CertiFried"; each change is its own click) ──────
const DOCKS = Object.freeze([
    { key: 'activity', title: 'CertiFried Activity' },
    { key: 'controls', title: 'CertiFried Controls' },
    { key: 'chat', title: 'CertiFried Chat' },
]);
let dockUrls = null;   // { activity, controls, chat } from the server, for this run (the dock key is not saved by Studio)

async function prepareDocks(regenerate = false) {
    if (dockUrls && !regenerate) return dockUrls;
    if (!engine?.supports('request')) throw new Error('Connect Studio to CertiFried first (and the server needs the dock update).');
    const r = await engine.request('docks.key', {}, 15000);
    const origin = checkServer(config.get().server);
    const urls = {};
    for (const d of DOCKS) {
        const u = new URL(String(r?.urls?.[d.key] || ''));
        // Only addresses on this app's own server, on a dock page, are ever written into OBS.
        if (u.origin !== origin && !(u.protocol === 'https:' && u.hostname === new URL(SITE).hostname)) throw new Error('CertiFried sent a dock address for another site.');
        if (!DOCK_PATH.test(u.pathname)) throw new Error('CertiFried sent an unexpected dock address.');
        urls[d.key] = u.href;
    }
    dockUrls = urls;
    log.info('dock addresses ready', { regenerated: regenerate });
    pushState();
    return dockUrls;
}

function setupStatus() {
    const dir = obsDir();
    let config_ = null;
    let ours = 0;
    try {
        config_ = locateDockConfig(dir);
        ours = readDocks(config_.file).filter((d) => DOCK_PATH.test(String(d.url || ''))).length;
    } catch { /* OBS not set up on this PC yet */ }
    const assets = path.join(ASSETS, 'obs-theme');
    return {
        obsDir: dir,
        obsRunning: isObsRunning(),
        dockConfig: config_ ? config_.kind : null,
        docksInObs: ours,
        docksReady: !!dockUrls,
        dockList: DOCKS.map((d) => ({ title: d.title, url: dockUrls ? dockUrls[d.key] : null })),
        themeInstalled: themeInstalled({ srcDir: assets, themesDir: themesDirFor(dir) }),
        starter: planStarterScenes(obs.snapshot().scenes || []).map((s) => s.name),
        starterAll: STARTER_SCENES.map((s) => s.name),
        obsConnected: obs.connected,
        overlayAvailable: !!engine?.supports('request'),   // the list itself comes from overlays:list (server Phase 3)
    };
}

// ── voice commands ─────────────────────────────────────────────────────────────────────────────
let vodSafe = null;
let musicUrl = null;
let overlayCache = new Map();   // overlay id -> { url, sourceName, … } from the last overlays:list (addresses stay in the main process)

/** The music player page for the CertiFried Music source, from the server once it offers one (music.overlay). */
async function getMusicUrl() {
    if (musicUrl) return musicUrl;
    if (!engine?.supports('request')) return null;
    let r;
    try { r = await engine.request('music.overlay', {}, 10000); } catch { return null; }
    try {
        const u = new URL(String(r?.url || ''));
        const origin = checkServer(config.get().server);
        if ((u.origin === origin || (u.protocol === 'https:' && u.hostname === new URL(SITE).hostname)) && /^\/stream\/bot\/overlay\/music\//.test(u.pathname)) musicUrl = u.href;
    } catch { /* not offered yet */ }
    return musicUrl;
}

let lastVodSafe = null;
function onVodChange(v) {
    if (lastVodSafe !== null && lastVodSafe !== v.vodSafe) {
        addActivity({ kind: 'info', title: v.vodSafe ? 'VOD-safe music: protected' : 'VOD-safe music: music paused', detail: v.vodSafe ? `Music stays off the VOD track (track ${v.vodTrack}).` : v.reason, ok: !!v.vodSafe });
    }
    for (const change of v.changes || []) addActivity({ kind: 'info', title: change, ok: true });
    lastVodSafe = v.vodSafe;
    reportState();
    pushState();
}

let voice = null;
let micState = 'off';
let micError = null;
let lastLevel = 0;
let levelTimer = null;
let ptt = null;        // { keycode } while the push-to-talk hook runs

function voiceView() {
    const v = config.get().voice;
    return { settings: v, status: voice ? voice.status() : { state: 'off' }, mic: micState, micError, level: lastLevel, phrases: (v.phrases || []).slice(0, 500), available: process.platform === 'win32', held: voice ? voice.held : false };
}

const MIC_ERRORS = {
    NotAllowedError: 'Windows blocked the microphone. In Windows Settings, Privacy and security, Microphone, turn on access for desktop apps.',
    NotFoundError: 'That microphone is not plugged in. Pick another one.',
    OverconstrainedError: 'That microphone is not plugged in. Pick another one.',
    NotReadableError: 'Another program is using the microphone in a way that blocks it, or Windows could not open it.',
};

function startPtt() {
    stopPtt();
    const v = config.get().voice;
    if (v.mode !== 'ptt') return;
    try {
        const { uIOhook, UiohookKey } = require('uiohook-napi');
        const { key } = parseKeys(v.pttKey || 'F13', UiohookKey);
        const down = (e) => { if (e.keycode === key && !voice.held) { voice.setHeld(true); pushState(); } };
        const up = (e) => { if (e.keycode === key) { voice.setHeld(false); pushState(); } };
        uIOhook.on('keydown', down);
        uIOhook.on('keyup', up);
        uIOhook.start();
        ptt = { uIOhook, down, up };
    } catch (e) {
        log.warn('push-to-talk could not start', { error: e.message });
        addActivity({ kind: 'info', title: 'Push to talk could not start on this PC. Use always listening instead.', ok: false });
    }
}

function stopPtt() {
    if (!ptt) return;
    try { ptt.uIOhook.off('keydown', ptt.down); ptt.uIOhook.off('keyup', ptt.up); ptt.uIOhook.stop(); } catch { /* ignore */ }
    ptt = null;
    voice?.setHeld(false);
}

function applyVoice() {
    const v = config.get().voice;
    if (!voice) return;
    voice.setPhrases(v.phrases || []);
    if (v.enabled && process.platform === 'win32') {
        voice.start();
        if (audioWindow && !audioWindow.isDestroyed()) audioWindow.webContents.send('voice:start', { deviceId: v.inputDeviceId || 'default' });
        startPtt();
    } else {
        stopPtt();
        if (audioWindow && !audioWindow.isDestroyed()) audioWindow.webContents.send('voice:stop');
        voice.stop();
        lastLevel = 0;
    }
    pushState();
}

async function refreshVoicePhrases() {
    if (!engine?.supports('request')) return null;
    const r = await engine.request('voice.phrases', {});
    const list = [...new Set((r?.phrases || []).map((p) => String(p.text || '').trim()).filter(Boolean))].slice(0, 500);
    config.update({ voice: { phrases: list } });
    if (voice) voice.setPhrases(list);
    pushState();
    return list;
}

function onVoicePhrase({ text, confidence }) {
    const sent = engine?.supports('event') ? engine.sendEvent({ type: 'voice.phrase', metadata: { phrase: text, confidence } }) : false;
    addActivity({ kind: 'event', title: `Heard "${text}"`, detail: `${Math.round(confidence * 100)}% sure${sent ? '' : ' · not sent: not connected to CertiFried'}`, ok: !!sent });
}

let link = null;   // { check, url, status, error, cancelled }

function linkView() {
    return link ? { check: link.check, status: link.status, error: link.error || null } : null;
}

async function startBrowserSignIn(name) {
    if (config.hasSecret('deviceToken')) throw new Error('This PC is already paired.');
    if (link && link.status === 'waiting') return linkView();
    const s = config.get();
    const deviceName = String(name || '').trim().slice(0, 100) || require('node:os').hostname().slice(0, 100);
    const r = await startLink({ base: s.server, name: deviceName, capabilities: router.capabilities() });
    const mine = { check: r.check, url: r.url, status: 'waiting', error: null, cancelled: false };
    link = mine;
    shell.openExternal(r.url);
    log.info('browser sign-in started');
    pushState();
    waitForLink({ base: s.server, request: r.request, secret: r.secret, pollMs: r.pollMs, expiresAt: r.expiresAt, isCancelled: () => mine.cancelled })
        .then((out) => {
            if (link !== mine) return;
            if (out.status === 'approved') {
                adoptToken(out.token, out.deviceId, deviceName, 'Signed in with CertiFried');
                link = null;
            } else if (out.status === 'cancelled') {
                link = { ...mine, status: 'ended', error: 'Cancelled in the browser. Nothing was connected.' };
            } else if (out.status === 'expired') {
                link = { ...mine, status: 'ended', error: 'The sign-in expired after 10 minutes. Start again when you are ready.' };
            } else {
                link = null;
            }
            pushState();
        })
        .catch((e) => {
            log.warn('browser sign-in failed', { error: e.code || e.message });
            if (link === mine) { link = { ...mine, status: 'ended', error: 'The sign-in could not finish. Try again, or use a pairing code.' }; pushState(); }
        });
    return linkView();
}

function defaultDeviceName() {
    return `CertiFried Studio on ${require('node:os').hostname()}`.slice(0, 100);
}

function handleDeepLink(link) {
    const code = codeFromDeepLink(link);
    if (!code) return;
    pendingCode = code;
    send('pair-code', code);
    showWindow();
}

// ── hotkeys ──────────────────────────────────────────────────────────────────────────────────
async function triggerBinding(b) {
    if (b.action.kind === 'automation') {
        try {
            const r = await engine?.request('automations.run', { automationId: b.action.automationId }, 15000);
            if (!engine) throw Object.assign(new Error('not_connected'), { code: 'not_connected' });
            addActivity({ kind: 'hotkey', title: `Hotkey ${b.accelerator}: run ${b.action.automationName || `automation ${b.action.automationId}`}`, detail: r?.status ? `run ${r.status}` : '', ok: true });
        } catch (e) {
            const why = e.code === 'not_supported' ? 'the CertiFried server needs an update for this' : e.code === 'not_connected' ? 'not connected to CertiFried' : (e.code || e.message);
            addActivity({ kind: 'hotkey', title: `Hotkey ${b.accelerator}: run ${b.action.automationName || 'automation'}`, ok: false, error: why });
        }
        return;
    }
    const r = await router.run(b.action.type, b.action.params || {});
    addActivity({ kind: 'hotkey', title: `Hotkey ${b.accelerator}: ${ACTION_LABELS[b.action.type] || b.action.type}`, detail: summarise(b.action.type, b.action.params), ok: r.ok, error: r.ok ? null : r.error });
}

function applyHotkeys() {
    const r = hotkeys.apply(config.get().hotkeys);
    hotkeyFailures = r.failed;
    pushState();
    return r;
}

// ── audio window ─────────────────────────────────────────────────────────────────────────────
function createAudioWindow() {
    audioWindow = new BrowserWindow({
        show: false, width: 200, height: 100, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, '..', 'preload', 'audio-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    audioWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'audio.html'));
    // (re)start the microphone for voice commands once the audio window is ready, also after it restarts
    audioWindow.webContents.once('did-finish-load', () => { if (voice) applyVoice(); });
    audioWindow.webContents.on('render-process-gone', (_e, d) => {
        log.error('the audio player stopped; restarting it', { reason: d?.reason });
        sound.reset();
        try { audioWindow.destroy(); } catch { /* gone */ }
        setTimeout(createAudioWindow, 500);
    });
}

const soundBackend = {
    play(cmd) { if (!audioWindow || audioWindow.isDestroyed()) throw new Error('audio player not ready'); audioWindow.webContents.send('audio:play', cmd); },
    stop(id) { if (audioWindow && !audioWindow.isDestroyed()) audioWindow.webContents.send('audio:stop', id); },
};

function audioRequest(kind, payload, timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!audioWindow || audioWindow.isDestroyed()) return resolve(null);
        const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const t = setTimeout(() => { audioWaiters.delete(id); resolve(null); }, timeoutMs);
        audioWaiters.set(id, (v) => { clearTimeout(t); resolve(v); });
        audioWindow.webContents.send(`audio:${kind}`, { id, ...payload });
    });
}

// ── main window and tray ─────────────────────────────────────────────────────────────────────
const BG = { dark: '#0e0f11', light: '#f6f7f8', sand: '#faf6ef' };

function createMainWindow({ show = true } = {}) {
    const theme = config.get().app.theme;
    mainWindow = new BrowserWindow({
        width: 980, height: 660, minWidth: 780, minHeight: 540, show: false, title: 'CertiFried Studio',
        backgroundColor: BG[theme] || BG.dark, icon: path.join(ASSETS, 'icon.png'), autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    mainWindow.removeMenu();
    mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => { if (show) mainWindow.show(); });
    mainWindow.on('close', (e) => {
        if (quitting) return;
        e.preventDefault();
        mainWindow.hide();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); openExternal(url); } });
    mainWindow.webContents.on('render-process-gone', (_e, d) => {
        log.error('the window stopped; reloading it', { reason: d?.reason });
        setTimeout(() => { try { mainWindow.reload(); } catch { /* ignore */ } }, 500);
    });
}

function openExternal(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'https:' && /(^|\.)certifriedmultitool\.com$/.test(u.hostname)) shell.openExternal(u.href);
    } catch { /* ignore */ }
}

function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function trayImage(on) {
    const img = nativeImage.createFromPath(path.join(ASSETS, on ? 'tray.png' : 'tray-off.png'));
    return img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 }) : img.resize({ width: 16, height: 16 });
}

function updateTray() {
    if (!tray) return;
    const on = engine?.status === 'connected';
    tray.setImage(trayImage(on));
    const line = `CertiFried: ${ENGINE_STATUS[engine?.status || 'idle'] || '-'} · OBS: ${OBS_STATUS[obs.status] || obs.status}`;
    tray.setToolTip(`CertiFried Studio\n${line}`);
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open CertiFried Studio', click: showWindow },
        { label: line, enabled: false },
        { type: 'separator' },
        { label: 'Stop all sounds', click: () => sound.stopAll() },
        { label: 'Reconnect', click: () => { buildEngine(); obs.reconnect(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
}

// ── IPC from the window ──────────────────────────────────────────────────────────────────────
function handle(channel, fn) {
    ipcMain.handle(channel, async (event, payload) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'not allowed' };
        try { return { ok: true, ...(await fn(payload ?? {})) }; } catch (e) { return { ok: false, error: e?.message || 'Something went wrong', code: e?.code }; }
    });
}

function registerIpc() {
    handle('state:get', async () => ({ state: uiState(), pendingCode: pendingCode ? (() => { const c = pendingCode; pendingCode = null; return c; })() : null }));

    handle('pair', async ({ code, name }) => {
        const c = normaliseCode(code);
        if (!c) throw Object.assign(new Error('Enter the code from the Devices page, like ABCD-EFGH.'), { code: 'invalid_code' });
        const n = String(name || '').trim().slice(0, 100) || null;
        return pairWith(c, n);
    });
    handle('unpair', async () => {
        if (engine) { engine.removeAllListeners(); engine.stop(); engine = null; }
        config.setSecret('deviceToken', null);
        config.update({ device: { id: null, pairedAt: null } });
        automations = [];
        addActivity({ kind: 'info', title: 'Unpaired. Remove the device on the dashboard too.', ok: true });
        updateTray();
        pushState();
        return {};
    });
    handle('server:set', async ({ server }) => {
        if (config.hasSecret('deviceToken')) throw new Error('Unpair first to change the server.');
        config.update({ server: checkServer(server) });
        pushState();
        return {};
    });
    handle('engine:reconnect', async () => { buildEngine(); return {}; });

    handle('obs:save', async ({ host, port, password, enabled, clearPassword }) => {
        const h = String(host || '').trim();
        if (!/^[A-Za-z0-9.-]{1,253}$/.test(h)) throw new Error('Enter the OBS address, for example 127.0.0.1.');
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('The port is a number from 1 to 65535.');
        if (clearPassword) config.setSecret('obsPassword', null);
        else if (typeof password === 'string' && password.length) {
            if (password.length > 200) throw new Error('That password is too long.');
            if (config.setSecret('obsPassword', password) === 'memory') addActivity({ kind: 'info', title: SECURE_STORAGE_NOTICE, ok: false });
        }
        config.update({ obs: { host: h, port: p, enabled: enabled !== false } });
        obs.configure(config.get().obs);
        if (obs.status === 'auth_failed' || obs.status === 'unreachable') obs.reconnect();
        pushState();
        return {};
    });
    handle('obs:reconnect', async () => { obs.reconnect(); return {}; });
    handle('obs:import', async () => {
        // Read only now, because the person clicked. The password goes straight to the secrets store.
        const c = readObsConfig(obsConfigPath());
        if (!c.enabled) {
            throw Object.assign(new Error("OBS's WebSocket server is turned off. In OBS open Tools, then WebSocket Server Settings, tick Enable WebSocket server, choose Apply, and try again."), { code: 'obs_ws_off' });
        }
        if (c.authRequired) config.setSecret('obsPassword', c.password);
        else config.setSecret('obsPassword', null);
        config.update({ obs: { host: '127.0.0.1', port: c.port, enabled: true } });
        obs.configure(config.get().obs);
        obs.reconnect();
        log.info('OBS settings taken from OBS', { port: c.port, authRequired: c.authRequired });
        addActivity({ kind: 'info', title: `Found OBS on port ${c.port}`, ok: true });
        pushState();
        return { port: c.port, authRequired: c.authRequired };
    });
    handle('link:start', async ({ name }) => ({ link: await startBrowserSignIn(name) }));
    handle('link:open', async () => { if (link?.url && link.status === 'waiting') shell.openExternal(link.url); return {}; });
    handle('link:cancel', async () => { if (link) link.cancelled = true; link = null; pushState(); return {}; });

    handle('sound:settings', async ({ outputDeviceId, masterVolume, defaultMode, syncDashboard }) => {
        const patch = {};
        if (typeof outputDeviceId === 'string' && outputDeviceId.length <= 200) patch.outputDeviceId = outputDeviceId || 'default';
        if (masterVolume !== undefined) { const v = Number(masterVolume); if (Number.isFinite(v)) patch.masterVolume = Math.max(0, Math.min(100, Math.round(v))); }
        if (defaultMode === 'queue' || defaultMode === 'overlap') patch.defaultMode = defaultMode;
        if (syncDashboard !== undefined) patch.syncDashboard = !!syncDashboard;
        config.update({ sound: patch });
        pushState();
        return {};
    });
    handle('sound:devices', async () => {
        const devices = (await audioRequest('devices', {})) || [];
        log.debug('audio outputs listed', { count: devices.length, named: devices.filter((d) => d.label && !/^Output \d+$/.test(d.label)).length });
        return { devices };
    });
    handle('sound:test', async ({ name }) => {
        const r = await router.run('sound.play', { sound: name, volume: 100, mode: config.get().sound.defaultMode });
        addActivity({ kind: 'info', title: `Test sound: ${name}`, ok: r.ok, error: r.ok ? null : r.error });
        if (!r.ok) throw new Error(r.error);
        return {};
    });
    handle('sound:stop', async () => sound.stopAll());
    handle('sound:openFolder', async () => { await shell.openPath(library.localDir); return {}; });
    handle('sound:sync', async () => {
        if (!engine?.supports('request')) throw new Error('Syncing needs a connection to CertiFried (and a server that has the sound library).');
        return { result: await syncSounds() };
    });

    handle('hotkeys:save', async ({ bindings }) => {
        const list = [];
        for (const b of Array.isArray(bindings) ? bindings.slice(0, 100) : []) {
            const v = validateBinding(b);
            if (!v.ok) throw new Error(v.error);
            list.push(v.value);
        }
        config.replace('hotkeys', list);
        return { result: applyHotkeys(), hotkeys: list };
    });
    handle('hotkeys:pause', async ({ paused }) => {
        // While the person is recording a new combination, existing hotkeys must not fire.
        if (paused) hotkeys.clear(); else applyHotkeys();
        return {};
    });
    handle('hotkeys:run', async ({ id }) => {
        const b = config.get().hotkeys.find((x) => x.id === id);
        if (!b) throw new Error('That hotkey does not exist.');
        await triggerBinding(b);
        return {};
    });
    handle('automations:refresh', async () => ({ automations: await refreshAutomations() }));

    handle('app:settings', async ({ startWithWindows, startMinimised, theme, checkUpdates }) => {
        const patch = {};
        if (theme && ['dark', 'light', 'sand'].includes(theme)) patch.theme = theme;
        if (startMinimised !== undefined) patch.startMinimised = !!startMinimised;
        if (checkUpdates !== undefined) patch.checkUpdates = !!checkUpdates;
        if (startWithWindows !== undefined) {
            patch.startWithWindows = !!startWithWindows;
            setLoginItem(!!startWithWindows);
        }
        config.update({ app: patch });
        if (patch.theme && mainWindow) mainWindow.setBackgroundColor(BG[patch.theme]);
        pushState();
        return {};
    });
    handle('app:checkUpdates', async () => ({ update: await updater.check() }));
    handle('app:installUpdate', async () => { quitting = true; updater.installNow(); return {}; });
    handle('app:openLogs', async () => { await shell.openPath(path.dirname(log.file)); return {}; });
    handle('app:openPage', async ({ page }) => {
        const url = PAGES[page] || SOURCE[page];
        if (url) shell.openExternal(url);
        return {};
    });
    handle('app:registerLinks', async () => {
        const target = isPortable ? process.env.PORTABLE_EXECUTABLE_FILE : process.execPath;
        const ok = app.isPackaged ? app.setAsDefaultProtocolClient('certifried-studio', target, []) : false;
        return { registered: ok };
    });
    handle('app:quit', async () => { quitting = true; setTimeout(() => app.quit(), 50); return {}; });
    handle('app:copy', async ({ text }) => { clipboard.writeText(String(text || '').slice(0, 2000)); return {}; });

    // VOD-safe music
    handle('vod:check', async () => ({ vod: await vodSafe.ensure('manual') }));
    handle('vod:keepOut', async ({ name }) => ({ vod: await vodSafe.keepOutOfVod(String(name || '').slice(0, 256)) }));
    handle('vod:record', async ({ on }) => ({ vod: await vodSafe.setRecordWithoutMusic(!!on) }));
    handle('vod:kick', async ({ choice }) => {
        if (['unknown', 'live', 'vod'].includes(choice)) config.update({ music: { kickMusic: choice } });
        pushState();
        return {};
    });

    // OBS setup checklist
    handle('setup:status', async () => ({ setup: setupStatus() }));
    handle('docks:prepare', async ({ regenerate }) => ({ urls: await prepareDocks(!!regenerate) }));
    handle('docks:add', async () => {
        const urls = await prepareDocks(false);
        const r = addDocks({ dir: obsDir(), docks: DOCKS.map((d) => ({ title: d.title, url: urls[d.key] })), running: isObsRunning() });
        log.info('docks added to OBS', { kind: r.kind, added: r.added, kept: r.kept, replaced: r.replaced });
        addActivity({ kind: 'info', title: `Added ${r.added} CertiFried docks to OBS`, detail: `Backup saved as ${path.basename(r.backup)}`, ok: true });
        return { result: { added: r.added, kept: r.kept, replaced: r.replaced, kind: r.kind, backup: path.basename(r.backup) } };
    });
    handle('theme:install', async () => {
        const r = installTheme({ srcDir: path.join(ASSETS, 'obs-theme'), themesDir: themesDirFor(obsDir()) });
        addActivity({ kind: 'info', title: 'CertiFried theme copied to OBS', detail: 'In OBS: Settings, Appearance, Style CertiFried', ok: true });
        return { result: { copied: r.copied, backups: r.backups } };
    });
    // CertiFried overlays: the server's list (request overlays.list), each added to the scene on air on its own click.
    handle('overlays:list', async () => {
        let r;
        try { r = await engine.request('overlays.list', {}, 10000); } catch (e) {
            if (e.code === 'unknown_method') throw new Error('Your CertiFried server does not offer overlays yet.');
            if (e.code === 'not_connected' || e.code === 'not_supported') throw new Error('Connect Studio to CertiFried first.');
            throw new Error('CertiFried did not answer. Try again in a moment.');
        }
        const list = cleanOverlays(r?.overlays, { origin: checkServer(config.get().server), siteHost: new URL(SITE).hostname });
        overlayCache = new Map(list.map((o) => [o.id, o]));
        const inputs = obs.connected ? await browserInputs(obs).catch(() => []) : [];
        const snap = obs.snapshot();
        return { obsConnected: obs.connected, overlays: list.map((o) => ({ id: o.id, type: o.type, label: o.label, name: o.name, sourceName: o.sourceName, audio: o.audio, plan: planOverlay(snap, o, inputs) })) };
    });
    handle('overlays:add', async ({ id }) => {
        const o = overlayCache.get(Number(id));
        if (!o) throw new Error('Refresh the list first.');
        const r = await addOverlay(obs, o);
        log.info('overlay source added', { type: o.type, action: r.action });
        if (r.action !== 'there') addActivity({ kind: 'info', title: `${r.sourceName} is in ${r.scene}`, detail: r.action === 'update' ? 'Its address was updated' : 'Browser source, 1920 × 1080', ok: true });
        obs.refresh().catch(() => {});
        return { result: r };
    });
    handle('scenes:create', async ({ names }) => {
        const r = await createStarterScenes(obs, Array.isArray(names) ? names.map(String) : []);
        if (r.created.length) addActivity({ kind: 'info', title: `Created OBS scenes: ${r.created.join(', ')}`, ok: true });
        obs.refresh().catch(() => {});
        return { result: r };
    });

    // voice commands
    handle('voice:settings', async (p) => {
        const patch = {};
        if (p.enabled !== undefined) patch.enabled = !!p.enabled;
        if (typeof p.inputDeviceId === 'string' && p.inputDeviceId.length <= 200) patch.inputDeviceId = p.inputDeviceId || 'default';
        if (p.mode === 'always' || p.mode === 'ptt') patch.mode = p.mode;
        if (typeof p.pttKey === 'string') {
            const { UiohookKey } = (() => { try { return require('uiohook-napi'); } catch { return { UiohookKey: null }; } })();
            if (UiohookKey) { try { parseKeys(p.pttKey, UiohookKey); } catch { throw new Error('Pick a single key, such as F13 or Num 0.'); } }
            patch.pttKey = p.pttKey.slice(0, 30);
        }
        if (p.threshold !== undefined) { const t = Number(p.threshold); if (Number.isFinite(t)) patch.threshold = Math.max(0.5, Math.min(0.95, Math.round(t * 100) / 100)); }
        config.update({ voice: patch });
        if (patch.enabled !== undefined || patch.inputDeviceId !== undefined || patch.mode !== undefined || patch.pttKey !== undefined) applyVoice();
        pushState();
        return {};
    });
    handle('voice:devices', async () => ({ devices: (await audioRequest('devices', { kind: 'audioinput' })) || [] }));
    handle('voice:refresh', async () => {
        const list = await refreshVoicePhrases();
        if (!list) throw new Error('Connect Studio to CertiFried to fetch your voice commands.');
        return { phrases: list };
    });
    ipcMain.on('voice:pcm', (e, buf) => { if (audioWindow && e.sender === audioWindow.webContents && buf) voice?.feed(Buffer.from(buf)); });
    ipcMain.on('voice:level', (e, level) => {
        if (!audioWindow || e.sender !== audioWindow.webContents) return;
        lastLevel = Math.max(0, Math.min(1, Number(level) || 0));
        if (!levelTimer) levelTimer = setTimeout(() => { levelTimer = null; send('voice-level', { level: lastLevel, held: voice ? voice.held : false }); }, 200);
    });
    ipcMain.on('voice:mic', (e, state, reason) => {
        if (!audioWindow || e.sender !== audioWindow.webContents) return;
        micState = state === 'on' ? 'on' : state === 'error' ? 'error' : 'off';
        micError = micState === 'error' ? (MIC_ERRORS[reason] || 'The microphone could not be opened.') : null;
        if (micState === 'error') log.warn('microphone could not start', { reason });
        pushState();
    });

    // audio window → main
    ipcMain.on('audio:started', (e, id) => { if (audioWindow && e.sender === audioWindow.webContents) sound.onStarted(String(id)); });
    ipcMain.on('audio:ended', (e, id) => { if (audioWindow && e.sender === audioWindow.webContents) { sound.onEnded(String(id)); pushState(); } });
    ipcMain.on('audio:error', (e, id, reason) => { if (audioWindow && e.sender === audioWindow.webContents) { sound.onError(String(id), String(reason || '').slice(0, 100)); pushState(); } });
    ipcMain.on('audio:reply', (e, id, value) => {
        if (!audioWindow || e.sender !== audioWindow.webContents) return;
        const w = audioWaiters.get(String(id));
        if (w) { audioWaiters.delete(String(id)); w(value); }
    });
}

function setLoginItem(on) {
    const opts = { openAtLogin: on, args: ['--hidden'] };
    if (isPortable && process.env.PORTABLE_EXECUTABLE_FILE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
    try { app.setLoginItemSettings(opts); } catch (e) { log.warn('could not change start with Windows', { error: e.message }); }
}

// ── start ────────────────────────────────────────────────────────────────────────────────────
/** Run one start-up step; a failure is logged and the app carries on without that piece. */
function step(label, fn) {
    try { return fn(); } catch (err) {
        try { log?.error(`start-up step failed: ${label}`, { error: err?.message, stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') }); } catch { /* ignore */ }
        return undefined;
    }
}

/**
 * Development and tests only: CF_STUDIO_FAKE_SAFESTORAGE=unavailable|throws stands in for a PC where Windows secure
 * storage (DPAPI) does not work, so the start-up path can be tested on any machine.
 */
function storageForThisRun() {
    const mode = !app.isPackaged ? process.env.CF_STUDIO_FAKE_SAFESTORAGE : null;
    if (mode === 'unavailable') return { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Encryption is not available.'); }, decryptString: () => { throw new Error('Decryption is not available.'); } };
    if (mode === 'throws') return { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('Error while encrypting the text provided to safeStorage.encryptString.'); }, decryptString: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); } };
    return safeStorage;
}

app.whenReady().then(() => {
    const userData = app.getPath('userData');
    log = createLogger({ dir: path.join(userData, 'logs') });
    log.info('CertiFried Studio starting', { version: app.getVersion(), portable: isPortable, installed: isInstalled, electron: process.versions.electron });
    config = createConfig({ dir: userData, safeStorage: storageForThisRun(), logger: log });
    if (!config.secureStorageAvailable()) log.warn('Windows secure storage (DPAPI) is not available; secrets are saved with the local key instead');
    step('secret upgrade', () => {
        const up = config.upgradeSecrets();
        if (up.moved || up.dropped || up.keyRemoved) log.info('secrets moved to Windows secure storage', up);
    });

    // Microphone/camera are never used; media permission only lets the audio window list output devices by name.
    step('permissions', () => {
        session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && String(origin || '').startsWith('file://'));
        session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
            const audioOnly = !details?.mediaTypes || details.mediaTypes.every((t) => t === 'audio');
            cb(permission === 'media' && audioOnly && !!audioWindow && wc === audioWindow.webContents && !!config.get().voice.enabled);
        });
    });

    library = createLibrary({ localDir: path.join(userData, 'Sounds'), dashboardDir: path.join(userData, 'Dashboard sounds'), logger: log });
    sound = createSoundPlayer({ backend: soundBackend, getSettings: () => config.get().sound, logger: log });
    keys = createKeySender({ logger: log });
    obs = createObs({ logger: log, getPassword: () => config.getSecret('obsPassword') });
    vodSafe = createVodSafe({
        obs, logger: log, getSettings: () => config.get().music, saveSettings: (p) => config.update({ music: p }), getMusicUrl,
        backupProfile: async () => {
            const pl = await obs.call('GetProfileList');
            return backupProfileIni({ dir: obsDir(), profileName: pl.currentProfileName });
        },
    });
    vodSafe.onChange(onVodChange);
    router = createRouter({ extra: { 'music.prepare': () => vodSafe.prepare() }, obs, sound, library, keys, screenshotDir: process.env.CF_STUDIO_USER_DATA ? path.join(userData, 'Screenshots') : path.join(app.getPath('pictures'), 'CertiFried Studio'), logger: log, defaultSoundMode: () => config.get().sound.defaultMode });
    hotkeys = createHotkeys({ globalShortcut, onTrigger: triggerBinding, logger: log });
    voice = createVoice({
        // The helper script must be a real file for PowerShell: it is unpacked next to app.asar in the installed app.
        helperPath: path.join(__dirname, '..', 'voice', 'speech-helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
        tmpDir: path.join(userData, 'voice'), logger: log, getSettings: () => config.get().voice,
        onPhrase: onVoicePhrase, onStatus: () => pushState(),
    });
    updater = createUpdater({ app, logger: log, isPortable, onStatus: () => pushState() });

    obs.on('status', (st, d) => {
        log.info('OBS', { status: st, ...(d || {}) });
        if (st === 'connected') {
            addActivity({ kind: 'info', title: `OBS connected${d?.version ? ` (${d.version})` : ''}`, ok: true });
            vodSafe.ensure('connect').catch(() => {});
        }
        if (st !== 'connected') vodSafe.ensure('obs gone').catch(() => {});
        if (st === 'auth_failed') addActivity({ kind: 'info', title: 'OBS did not accept the password. Check it in Settings.', ok: false });
        updateTray();
        pushState();
        reportState();
    });
    obs.on('state', () => { reportState(); pushState(); });
    obs.on('obs-event', (name, data) => vodSafe.onObsEvent(name, data));
    obs.on('event', (ev) => {
        addActivity({ kind: 'event', title: EVENT_LABELS[ev.type] || ev.type, detail: ev.metadata?.scene || ev.metadata?.file || '', ok: true });
        engine?.sendEvent(ev);
    });

    registerIpc();
    const dev = !app.isPackaged;
    step('demo token', () => { if (dev && process.env.CF_STUDIO_DEMO_TOKEN && !config.hasSecret('deviceToken')) config.setSecret('deviceToken', process.env.CF_STUDIO_DEMO_TOKEN); });
    step('test OBS password', () => { if (dev && process.env.CF_STUDIO_TEST_OBS_PASSWORD && !config.hasSecret('obsPassword')) config.setSecret('obsPassword', process.env.CF_STUDIO_TEST_OBS_PASSWORD); });
    step('demo activity', () => { if (dev && process.env.CF_STUDIO_DEMO) require('./dev-capture').demoActivity(addActivity); });
    if (config.storageMode() === 'memory') addActivity({ kind: 'info', title: SECURE_STORAGE_NOTICE, ok: false });
    step('audio window', createAudioWindow);
    createMainWindow({ show: !(startedHidden && config.get().app.startMinimised) });
    step('tray', () => {
        tray = new Tray(trayImage(false));
        tray.on('click', showWindow);
        updateTray();
    });

    step('OBS', () => obs.configure(config.get().obs));
    step('hotkeys', applyHotkeys);
    step('CertiFried connection', buildEngine);
    step('pairing links', () => { if (isInstalled && !app.isDefaultProtocolClient('certifried-studio')) app.setAsDefaultProtocolClient('certifried-studio'); });
    step('updates', () => { if (config.get().app.checkUpdates) updater.start(); });
    step('deep link', () => { const link = argvDeepLink(process.argv); if (link) handleDeepLink(link); });

    if (dev && (process.env.CF_STUDIO_CAPTURE_DIR || process.env.CF_STUDIO_SMOKE)) {
        mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
            try {
                if (process.env.CF_STUDIO_CAPTURE_DIR) log.info('captured', { files: (await require('./dev-capture').captureAll(mainWindow, process.env.CF_STUDIO_CAPTURE_DIR)).length });
                if (process.env.CF_STUDIO_SMOKE) {
                    let importCheck = null;
                    if (process.env.CF_STUDIO_SMOKE_IMPORT) {
                        // Test only: wait for OBS to ask for a password, see the offer, click "Use my OBS settings" through the window.
                        for (let i = 0; i < 50 && obs.status !== 'auth_failed'; i++) await new Promise((r) => setTimeout(r, 100));
                        await new Promise((r) => setTimeout(r, 300));
                        const offered = await mainWindow.webContents.executeJavaScript("!document.getElementById('obs-import-status').hidden");
                        const answer = await mainWindow.webContents.executeJavaScript("window.studio.call('obs:import')");
                        for (let i = 0; i < 50 && !obs.connected; i++) await new Promise((r) => setTimeout(r, 100));
                        importCheck = { statusBefore: 'auth_failed', offered, answer, obsStatus: obs.status, port: config.get().obs.port };
                    }
                    const shown =await mainWindow.webContents.executeJavaScript("({ banner: document.getElementById('storage-banner').hidden ? null : document.getElementById('storage-banner').textContent, note: document.getElementById('storage-note').hidden ? null : document.getElementById('storage-note').textContent, pairShown: !document.getElementById('pair-card').hidden })");
                    fs.writeFileSync(process.env.CF_STUDIO_SMOKE, JSON.stringify({ started: true, secureStorage: config.secureStorageAvailable(), storageMode: config.storageMode(), paired: config.hasSecret('deviceToken'), hasObsPassword: config.hasSecret('obsPassword'), keyFile: fs.existsSync(config.paths.keyFile), keySending: keys.available, importCheck, ...shown }));
                }
            } catch (e) { log.error('capture failed', { error: e.message }); }
            quitting = true;
            app.quit();
        }, Number(process.env.CF_STUDIO_CAPTURE_WAIT || 3000)));
    }
    // While idle, keep VOD-safe music checked every minute (OBS settings can change without an event).
    setInterval(() => { if (obs.connected) vodSafe.ensure('timer').catch(() => {}); }, 60 * 1000).unref?.();
    // Keep the dashboard's lists fresh: automations every 5 minutes, sounds every 15.
    setInterval(() => { refreshAutomations().catch(() => {}); refreshVoicePhrases().catch(() => {}); }, 5 * 60 * 1000).unref?.();
    setInterval(() => { if (config.get().sound.syncDashboard) syncSounds().catch(() => {}); }, 15 * 60 * 1000).unref?.();
}).catch((err) => {
    // Only reached when settings cannot be read or the window cannot be made at all.
    try { log?.error('the app could not start', { error: err?.message }); } catch { /* ignore */ }
    try { dialog.showErrorBox('CertiFried Studio', `The app could not start: ${err?.message}`); } catch { /* ignore */ }
    app.exit(1);
});

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
    try { stopPtt(); voice?.stop(); } catch { /* ignore */ }
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
    try { engine?.stop(); } catch { /* ignore */ }
    try { obs?.stop(); } catch { /* ignore */ }
    log?.info('CertiFried Studio closed');
});
