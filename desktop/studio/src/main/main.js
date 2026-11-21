'use strict';
/*
 * CertiFried Studio: the Electron main process. It wires the pieces together:
 *
 *   engine-client.js  the CertiFried connection (pairing token from safeStorage)
 *   obs.js            OBS WebSocket v5          router.js   action → OBS / sound / key press
 *   sound.js          play queue + library      hotkeys.js  global hotkeys and key sending
 *   updater.js        electron-updater feed     logger.js   rotating, redacted log
 *   lights/           Phase 5: Govee LAN, Hue, LIFX, Nanoleaf, Elgato, Litra (found on the LAN / USB only after Find lights)
 *   voicemeeter.js    Phase 5: Voicemeeter Remote API (off until turned on)
 *   heart-rate.js     0.2.14: heart rate from a watch or strap over Bluetooth LE (off until a device is chosen), sent to
 *                     CertiFried at most once a second for overlays and automations
 *   bridge-server.js  Phase 5: the Stream Deck plugin's connection, 127.0.0.1 only (off until turned on)
 *   sandbox.js        tests: CF_STUDIO_DEVICE_SANDBOX points every device at 127.0.0.1 mocks (never the real LAN or USB)
 *
 * Windows: the main window (src/renderer/index.html) and a hidden audio window (src/renderer/audio.html) that plays
 * sounds with setSinkId. Closing the main window hides it to the tray; Quit is in the tray menu.
 *
 * Environment for testing only: CF_STUDIO_USER_DATA puts settings, logs and sounds in another folder.
 */
// 0.2.13: onnxruntime (the voice detector) has Microsoft's 1DS telemetry built in; off for this process before anything loads it.
process.env.ORT_DISABLE_TELEMETRY = '1';
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
const { sourceHandlers } = require('./obs-sources');
const { createVoice, clampThreshold } = require('./voice');
// 0.2.12: Silero voice activity detection + Whisper (voice-vad.js, whisper-engine.js, voice-whisper.js); voice.js (System.Speech)
// is kept only as the last resort when Whisper cannot run on this PC.
const { createWhisperVoice, clampMatch } = require('./voice-whisper');
// 0.2.13: "Teach Studio how you say it" (voice-train.js) and learning from the voice log: "heard as" aliases and
// "not a command" examples, saved on the automation through CertiFried (voice.learn) and synced back through voice.phrases.
const { createVoiceTrainer, clampTakes } = require('./voice-train');
const { scorePhrase, normalise: normaliseWords } = require('./voice-match');
const { wavBytes } = require('./whisper-engine');
const { createWhisperEngine } = require('./whisper-engine');
const { createSileroVad } = require('./voice-vad');
const { readWav, playInto } = require('./voice-file');
const { createVodSafe } = require('./vod-safe');
const { createHeartRate, createSender } = require('./heart-rate');
const { createAlertAudio } = require('./alert-audio');
const { validateProgram, createProgramRunner, MAX_PROGRAMS } = require('./programs');
const { parseKeys } = require('./hotkeys');
const { createLights } = require('./lights');
const { loadSandbox, fakeHid } = require('./sandbox');
const { createVoicemeeter, fakeVoicemeeterBinding } = require('./voicemeeter');
const { createBridgeServer, generateBridgeToken } = require('./bridge-server');
const { SD_PLUGIN_FILE } = require('./site');
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
        alertAudio: alertAudio ? alertAudio.status() : null,
        programs: (s.programs || []).map((p) => ({ id: p.id, name: p.name, path: p.path, args: p.args || [] })),
        vod: vodSafe ? { ...vodSafe.status(), kickMusic: s.music.kickMusic } : null,
        docks: { ready: !!dockUrls, titles: DOCKS.map((d) => d.title) },
        lights: lightsView(),
        heart: heartView(),
        voicemeeter: vmView(),
        streamdeck: streamdeckView(),
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

// ── heart rate (0.2.14) ──────────────────────────────────────────────────────────────────────
function heartView() {
    const h = config.get().heart || {};
    const st = heart ? heart.status() : { state: 'off', device: null, bpm: null, lastAt: null, battery: null, history: [] };
    return { enabled: !!h.enabled, share: h.share !== false, ...st, device: st.device || h.device || null, sent: heartSentAt };
}
let heartSentAt = null;
function sendHeart(r) {
    if (config.get().heart?.share === false || !engine?.supports('request')) return;
    engine.request('heart.rate', { bpm: r.bpm, at: r.at, contact: r.contact, rr: r.rr, battery: r.battery }, 4000)
        .then(() => { heartSentAt = Date.now(); })
        .catch(() => { /* not connected or an older server: the next reading tries again */ });
}
function onHeartReading(r) {
    heartSender?.push(r);
    const t = Date.now();
    if (t - heartPushAt >= 900) { heartPushAt = t; send('heart', heartView()); }
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
    state.devices = devicesReport();
    if (alertAudio) state.alertAudio = alertAudio.status();
    // Voice commands: the switchover reads this to know whether Studio is listening before it lets Streamer.bot close.
    if (voice) {
        const vs = voice.status();
        const vc = config.get().voice;
        // 0.2.10: thresholdSet says whether the person (or the switchover) ever set the confidence, so the server can tell a
        // 0.7 default from a chosen value; voiceLog says this Studio sends its voice log (request voice.log).
        state.voice = { enabled: !!vc.enabled, state: vs.state, error: vs.error ? String(vs.error).slice(0, 200) : null, phrases: vs.phrases || 0, threshold: clampThreshold(vc.threshold),
            thresholdSet: !!vc.thresholdSetAt, thresholdSetAt: vc.thresholdSetAt || null, catchAll: vs.catchAll || null, voiceLog: true,
            engine: vs.engine || (voice === windowsVoice ? 'windows' : null) };
    }
    const size = () => Buffer.byteLength(JSON.stringify(state));
    if (size() > 58000) for (const l of state.devices.lights) { l.caps.scenes = []; l.caps.effects = []; }
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
        voiceLogServer = true;
        sendVoiceLog({ replace: true });
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
    // 0.2.6: VOD-safe music only while song requests are on. A server older than that sends no flag: keep its behaviour.
    const songRequests = typeof r?.songRequests === 'boolean' ? r.songRequests : true;
    if (config.get().music.songRequests !== songRequests) config.update({ music: { songRequests } });
    if (vodSafe && vodSafe.setEnforced(songRequests)) addActivity({ kind: 'info', title: songRequests ? 'Song requests are on: Studio keeps music off the Twitch VOD track' : 'Song requests are off: Studio leaves your OBS audio tracks alone', ok: true });
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

// ── lights, Voicemeeter and the Stream Deck (Phase 5) ────────────────────────────────────────────
let sandbox = null;
let lights = null;
let cloudMacs = new Map();   // Bluetooth address → { id, name } of the streamer's Govee cloud lights (0.2.11)
async function refreshCloudMacs() {
    if (!engine?.supports('request')) return cloudMacs;
    try {
        const { macFromCloudId } = require('./lights/govee-ble');
        const r = await engine.request('lights.cloud', {}, 15000);
        const m = new Map();
        for (const l of r?.lights || []) { const mac = macFromCloudId(l.id); if (mac) m.set(mac, { id: String(l.id), name: String(l.name || '').slice(0, 80) }); }
        cloudMacs = m;
    } catch (e) { log.info('cloud lights not read for Bluetooth matching', { error: e?.code || e?.message }); }
    return cloudMacs;
}
let lightsBusy = null;     // 'finding' | 'pairing' while one runs
let voicemeeter = null;
let heart = null;          // 0.2.14: the Bluetooth heart-rate reader (heart-rate.js)
let heartSender = null;
let heartPushAt = 0;
let vmInfo = null;         // the last detect()
let bridge = null;
let bridgeError = null;

/** What the engine is told: names and capabilities, never addresses, serials or tokens. */
function devicesReport() {
    const s = config.get();
    const lightList = s.lights.enabled && lights ? lights.list() : [];
    return {
        lights: lightList.slice(0, 200).map((d) => ({ id: d.id, driver: d.driver, name: d.name, model: d.model || null, online: !!d.online, needsPairing: !!d.needsPairing, kind: d.kind || 'light',
            caps: { power: d.caps?.power !== false, brightness: !!d.caps?.brightness, color: !!d.caps?.color, white: d.caps?.white || null, scenes: (d.caps?.scenes || []).slice(0, 100), effects: (d.caps?.effects || []).slice(0, 100) } })),
        voicemeeter: { enabled: !!s.voicemeeter.enabled, installed: !!vmInfo?.installed, running: !!vmInfo?.running, type: vmInfo?.type || null, version: vmInfo?.version || null,
            strips: (vmInfo?.strips || []).map((x) => ({ index: x.index, label: x.label || '' })), buses: (vmInfo?.buses || []).map((x) => ({ index: x.index, label: x.label || '' })),
            macroButtons: !!vmInfo?.macroButtons, profiles: vmInfo?.profiles || [] },
        streamdeck: { enabled: !!s.streamdeck.enabled, clients: bridge ? bridge.status().clients : 0 },
    };
}

function lightsView() {
    const s = config.get().lights;
    return { enabled: !!s.enabled, drivers: s.drivers, busy: lightsBusy, devices: lights ? lights.list() : [], notes: lights ? lights.notes() : [], sandbox: !!sandbox };
}
function vmView() {
    return { settings: config.get().voicemeeter, info: vmInfo ? { installed: vmInfo.installed, running: vmInfo.running, type: vmInfo.type, version: vmInfo.version, strips: vmInfo.strips, buses: vmInfo.buses, macroButtons: vmInfo.macroButtons, profiles: vmInfo.profiles } : null };
}
function streamdeckView() {
    const s = config.get().streamdeck;
    const st = bridge ? bridge.status() : null;
    return { settings: s, running: !!st?.running, clients: st?.clients || 0, clientList: st?.clientList || [], error: bridgeError, hasToken: config.hasSecret('streamdeckToken'), pluginBundled: fs.existsSync(sdPluginPath()) };
}

function lightsChanged() { reportState(); pushState(); }

async function findLights() {
    if (lightsBusy) throw new Error('Studio is already looking for lights.');
    lightsBusy = 'finding';
    await refreshCloudMacs();
    pushState();
    try {
        const list = await lights.discover({ timeoutMs: 4000 });
        log.info('lights found', { count: list.length });
        return list;
    } finally { lightsBusy = null; lightsChanged(); }
}

async function detectVoicemeeter() {
    try { vmInfo = await voicemeeter.detect(); } catch (e) { vmInfo = { installed: false, running: false, error: e.code || e.message }; }
    log.info('Voicemeeter checked', { installed: !!vmInfo.installed, running: !!vmInfo.running, type: vmInfo.type || null });
    reportState();
    pushState();
    return vmInfo;
}

/** The light actions: refused with lights_off until the person turns lights on (Find lights). */
function lightHandlers() {
    const out = {};
    for (const type of ['light.set', 'light.color', 'light.white', 'light.brightness', 'light.power', 'light.scene', 'light.flash', 'light.preset']) {
        out[type] = async (p) => {
            if (!config.get().lights.enabled) throw Object.assign(new Error('Lights are turned off in CertiFried Studio (Lights, Find lights)'), { code: 'lights_off' });
            const r = await lights.run(type, p);
            return { applied: r.applied.length, skipped: r.skipped.map((x) => `${x.id}: ${x.reason}`).slice(0, 10), notes: r.notes.map((x) => `${x.id}: ${x.reason}`).slice(0, 10) };
        };
    }
    return out;
}

// The Stream Deck plugin's connection (bridge-server.js): what each method does here.
const sdName = (v) => String(v ?? '').slice(0, 256);
function bridgeHandlers() {
    const need = (ok, code, message) => { if (!ok) throw Object.assign(new Error(message), { code }); };
    const engineCall = async (method, params) => {
        need(engine?.supports('request'), 'not_connected', 'Studio is not connected to CertiFried');
        return engine.request(method, params, 15000);
    };
    const obsCall = async (type, data) => { need(obs.connected, 'obs_off', 'OBS is not connected'); return obs.call(type, data); };
    return {
        status: async () => ({ studio: app.getVersion(), engine: engine?.status || 'idle', obs: { connected: obs.connected, currentScene: obs.snapshot().currentScene || null } }),
        // 0.2.12: push to talk from the Stream Deck (down/up while a button is held, or tap: listen for the next phrase)
        'voice.ptt': async (p) => {
            need(voice && config.get().voice.enabled, 'voice_off', 'Voice commands are off in Studio');
            const st = ['down', 'up', 'tap'].includes(p?.state) ? p.state : 'tap';
            if (st === 'down') voice.setHeld(true);
            else if (st === 'up') voice.setHeld(false);
            else { voice.setHeld(false); voice.tap?.(); }
            pushState();
            return { listening: !!voice.held };
        },
        'automations.list': async () => ({ automations: (automations.length ? automations : await refreshAutomations().catch(() => [])).filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name })) }),
        'automations.run': async (p) => {
            const id = Number(p?.automationId);
            need(Number.isInteger(id) && id > 0, 'bad_params', 'automationId is required');
            const r = await engineCall('automations.run', { automationId: id });
            addActivity({ kind: 'info', title: `Stream Deck: run ${automations.find((a) => a.id === id)?.name || `automation ${id}`}`, detail: r?.status ? `run ${r.status}` : '', ok: true });
            return { status: r?.status || null };
        },
        'obs.scenes': async () => { const snap = obs.snapshot(); return { current: snap.currentScene || null, scenes: snap.scenes || [] }; },
        'obs.scene': async (p) => { const r = await router.run('obs.scene', { scene: sdName(p?.scene) }); need(r.ok, r.error, r.error); return {}; },
        'obs.sources': async (p) => { const snap = obs.snapshot(); const scene = sdName(p?.scene) || snap.currentScene; return { scene, sources: (snap.sources || {})[scene] || [] }; },
        'obs.source': async (p) => {
            const state = ['show', 'hide', 'toggle'].includes(p?.state) ? p.state : 'toggle';
            const r = await router.run('obs.source', { scene: sdName(p?.scene), source: sdName(p?.source), visible: state });
            need(r.ok, r.error, r.error);
            return { visible: typeof r.result?.visible === 'boolean' ? r.result.visible : null };
        },
        'obs.sourceState': async (p) => {
            const scene = sdName(p?.scene) || obs.snapshot().currentScene;
            const { sceneItemId } = await obsCall('GetSceneItemId', { sceneName: scene, sourceName: sdName(p?.source) });
            const { sceneItemEnabled } = await obsCall('GetSceneItemEnabled', { sceneName: scene, sceneItemId });
            return { visible: !!sceneItemEnabled };
        },
        'obs.inputs': async () => ({ inputs: (obs.snapshot().inputs || []).map((i) => i.name) }),
        'obs.mute': async (p) => {
            const state = ['mute', 'unmute', 'toggle'].includes(p?.state) ? p.state : 'toggle';
            const r = await router.run('obs.mute', { input: sdName(p?.input), state });
            need(r.ok, r.error, r.error);
            const { inputMuted } = await obsCall('GetInputMute', { inputName: sdName(p?.input) });
            return { muted: !!inputMuted };
        },
        'obs.muteState': async (p) => ({ muted: !!(await obsCall('GetInputMute', { inputName: sdName(p?.input) })).inputMuted }),
        'counters.list': async () => ({ counters: ((await engineCall('counters.list', {}))?.counters || []).map((c) => ({ name: c.key, value: c.value })) }),
        'counters.add': async (p) => {
            const r = await engineCall('counters.add', { key: String(p?.counter ?? p?.key ?? ''), by: Number(p?.amount ?? p?.by ?? 1) });
            bridge?.broadcast({ type: 'state', counter: { name: r.key, value: String(r.value) } });
            return { value: r.value };
        },
        'sounds.list': async () => ({ sounds: library.list().map((x) => x.name) }),
        'sound.play': async (p) => { const r = await router.run('sound.play', { sound: sdName(p?.sound), volume: Number.isFinite(Number(p?.volume)) ? Number(p.volume) : 100 }); need(r.ok, r.error, r.error); return {}; },
        'lights.presets': async () => ({ presets: ((await engineCall('lights.presets', {}))?.presets || []).map((x) => ({ id: x.id, name: x.name })) }),
        'lights.apply': async (p) => {
            const r = await engineCall('lights.apply', { presetId: String(p?.preset ?? p?.presetId ?? '') });
            need(r?.status !== 'failed', 'failed', r?.detail || 'The preset did not apply');
            return { status: r?.status || null };
        },
    };
}
const BRIDGE_OBS_EVENTS = new Set(['CurrentProgramSceneChanged', 'InputMuteStateChanged', 'SceneItemEnableStateChanged']);
const sceneItemNames = new Map();   // `${scene}:${id}` -> source name, for SceneItemEnableStateChanged pushes

async function applyStreamdeck() {
    const s = config.get().streamdeck;
    if (bridge) { const b = bridge; bridge = null; await b.stop().catch(() => {}); }
    bridgeError = null;
    if (s.enabled) {
        if (!config.hasSecret('streamdeckToken')) config.setSecret('streamdeckToken', generateBridgeToken());
        bridge = createBridgeServer({ logger: log, port: s.port, getToken: () => config.getSecret('streamdeckToken'), handlers: bridgeHandlers(), version: app.getVersion() });
        try {
            await bridge.start();
            log.info('Stream Deck connection on', { port: s.port });
        } catch (e) {
            bridgeError = e.code === 'port_in_use' ? `Port ${s.port} is in use by another program. Pick another port.` : 'The Stream Deck connection could not start.';
            log.warn('Stream Deck connection could not start', { code: e.code || null });
            bridge = null;
        }
    }
    reportState();
    pushState();
}

function sdPluginPath() {
    // Packaged: resources\streamdeck\<file>; from source: the plugin's own dist folder (desktop/streamdeck-plugin).
    return app.isPackaged ? path.join(process.resourcesPath, 'streamdeck', SD_PLUGIN_FILE) : path.join(ROOT, '..', 'streamdeck-plugin', 'dist', SD_PLUGIN_FILE);
}

// ── voice commands ─────────────────────────────────────────────────────────────────────────────
let vodSafe = null;
let alertAudio = null;
let programRunner = null;
let musicUrl = null;
let overlayCache = new Map();   // overlay id -> { url, sourceName, … } from the last overlays:list (addresses stay in the main process)

/**
 * A CertiFried overlay's address by id, for obs.add_browser_source (0.2.7): always asked fresh from the server
 * (overlays.list, so a new key is picked up) and cleaned like the Set up OBS list, so only CertiFried overlay addresses
 * are ever put into OBS; the last list is the fallback when the server does not answer.
 */
async function resolveOverlay(id) {
    try {
        const r = await engine.request('overlays.list', {}, 10000);
        const list = cleanOverlays(r?.overlays, { origin: checkServer(config.get().server), siteHost: new URL(SITE).hostname });
        overlayCache = new Map(list.map((o) => [o.id, o]));
    } catch (e) {
        log.info('overlays.list failed for a source add', { error: e?.code || e?.message });
    }
    return overlayCache.get(Number(id)) || null;
}

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

let voice = null;            // the engine in use: whisperVoice, or windowsVoice (System.Speech) as the last resort
let whisperVoice = null;
let windowsVoice = null;
let voiceFallback = null;    // { reason, at } while Windows speech recognition stands in because Whisper could not start
let lastVoiceState = null;
let micState = 'off';
let micError = null;
let lastLevel = 0;
let levelTimer = null;
let ptt = null;        // { keycode } while the push-to-talk hook runs
let trainer = null;    // 0.2.13 voice-train.js

function voiceView() {
    const v = config.get().voice;
    const commands = (Array.isArray(v.commands) && v.commands.length ? v.commands : (v.phrases || []).map((text) => ({ text }))).slice(0, 500);
    return { settings: { ...v, commands: undefined, phrases: undefined }, status: voice ? voice.status() : { state: 'off' }, mic: micState, micError, level: lastLevel,
        engine: voice === windowsVoice ? 'windows' : 'whisper', fallback: voiceFallback, input: inputView, vadDropped,
        phrases: commands.map((c) => c.text),
        commands: commands.map((c) => ({ text: c.text, key: c.text.toLowerCase(), automationId: c.automationId || null, automationName: c.automationName || null, confidence: c.confidence ?? null, cooldownMs: c.cooldownMs ?? null,
            aliases: (c.aliases || []).map((a) => a.text).slice(0, 50), negatives: (c.negatives || []).length, trained: c.trained || null })),
        log: voiceLog.slice(0, VOICE_LOG_MAX), available: process.platform === 'win32', held: voice ? voice.held : false,
        training: trainer ? trainer.view() : null, canLearn: !!engine?.supports('request') };
}

const MIC_ERRORS = {
    NotAllowedError: 'Windows blocked the microphone. In Windows Settings, Privacy and security, Microphone, turn on access for desktop apps.',
    NotFoundError: 'That microphone is not plugged in. Pick another one.',
    OverconstrainedError: 'That microphone is not plugged in. Pick another one.',
    NotReadableError: 'Another program is using the microphone in a way that blocks it, or Windows could not open it.',
};

/*
 * Microphone safety (0.2.12). Studio never silently uses "default": on first use, or while the setting is still "default",
 * it picks the device that is Windows' default communications microphone and saves that device. A Voicemeeter bus, Stereo Mix
 * or a virtual cable carries game sound and music, which is what made commands fire by themselves; when the chosen input looks
 * like one, the Voice tab says so and offers the microphone with one click.
 */
const BUS_INPUT = /voicemeeter|vb-audio|stereo mix|what u hear|wave out|\bcable\b|virtual audio|virtual cable|loopback|\bline\b|\bmix\b/i;
const stripDefault = (l) => String(l || '').replace(/^(Default|Communications)\s*-\s*/i, '').trim();
let inputView = { id: null, label: null, bus: false, missing: false, suggestion: null, pickedBy: null };
let vadDropped = { count: 0, lastAt: null };

async function resolveVoiceInput() {
    const v = config.get().voice;
    const list = (await audioRequest('devices', { kind: 'audioinput' })) || [];
    const real = list.filter((d) => d && d.id && d.id !== 'default' && d.id !== 'communications');
    const comm = list.find((d) => d && d.id === 'communications');
    const commReal = comm ? (real.find((d) => comm.groupId && d.groupId === comm.groupId) || real.find((d) => stripDefault(d.label) === stripDefault(comm.label)) || null) : null;
    const isBus = (d) => !!d && BUS_INPUT.test(stripDefault(d.label));
    const mic = commReal && !isBus(commReal) ? commReal : (real.find((d) => !isBus(d) && /mic/i.test(d.label)) || real.find((d) => !isBus(d)) || null);
    let id = v.inputDeviceId;
    if (!id || id === 'default' || id === 'communications') {
        const pick = commReal || mic || null;
        if (pick) {
            config.update({ voice: { inputDeviceId: pick.id, inputDeviceLabel: stripDefault(pick.label), inputPickedBy: pick === commReal ? 'communications' : 'microphone', inputPickedAt: Date.now() } });
            id = pick.id;
            addActivity({ kind: 'info', title: `Voice commands use ${stripDefault(pick.label)}`, detail: pick === commReal ? "Your Windows communications microphone. Change it in Studio, Voice." : 'Change it in Studio, Voice.', ok: true });
            log.info('voice input picked', { by: pick === commReal ? 'communications' : 'microphone' });
        } else {
            id = 'communications';   // the device list is not available yet: still the communications device, never "default"
        }
    }
    const cur = real.find((d) => d.id === id);
    if (cur && stripDefault(cur.label) !== config.get().voice.inputDeviceLabel) config.update({ voice: { inputDeviceLabel: stripDefault(cur.label) } });
    const label = cur ? stripDefault(cur.label) : (config.get().voice.inputDeviceLabel || null);
    const bus = BUS_INPUT.test(label || '');
    inputView = { id, label, bus, missing: !cur && real.length > 0 && id !== 'communications', pickedBy: config.get().voice.inputPickedBy || null,
        suggestion: bus && mic && mic.id !== id ? { id: mic.id, label: stripDefault(mic.label) } : null };
    return id;
}

function startPtt() {
    stopPtt();
    const v = config.get().voice;
    if (v.mode !== 'ptt') return;
    try {
        const { uIOhook, UiohookKey } = require('uiohook-napi');
        const { key } = parseKeys(v.pttKey || 'F13', UiohookKey);
        let downAt = 0;
        const down = (e) => { if (e.keycode === key && !voice.held) { downAt = Date.now(); voice.setHeld(true); pushState(); } };
        // A press shorter than TAP_PRESS_MS (a Stream Deck Hotkey button sends a press, not a hold) listens for the next phrase.
        const up = (e) => { if (e.keycode === key) { voice.setHeld(false); if (Date.now() - downAt < TAP_PRESS_MS) voice.tap?.(); pushState(); } };
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

const TAP_PRESS_MS = 350;

/** Whisper unless the person chose Windows speech recognition, or Whisper could not start this session (the last resort). */
function pickVoice() {
    const next = config.get().voice.engine === 'windows' || voiceFallback ? windowsVoice : whisperVoice;
    if (voice && voice !== next) voice.stop();
    voice = next;
}

let applying = Promise.resolve();
let filePlay = null;
/** Voice on or off with the current settings. Calls are queued, so a burst of setting changes applies in order. */
function applyVoice() {
    applying = applying.then(applyVoiceNow).catch((e) => log.warn('voice settings could not be applied', { error: e?.message }));
    return applying;
}

async function applyVoiceNow() {
    if (!whisperVoice) return;
    pickVoice();
    const v = config.get().voice;
    voice.setPhrases(voiceCommands(v));
    if (v.enabled && process.platform === 'win32') {
        const deviceId = await resolveVoiceInput();
        voice.start();
        const file = process.env.CF_STUDIO_VOICE_FILE;
        if (file) {
            // testing only: a WAV file instead of the microphone, played once at the pace of real time
            if (!filePlay) {
                filePlay = new AbortController();
                const ctl = filePlay;
                const wait = async () => { for (let i = 0; i < 600 && voice.status().state !== 'listening' && !ctl.signal.aborted; i++) await new Promise((r) => setTimeout(r, 250)); };
                wait().then(() => playInto(readWav(file), (b) => voice?.feed(b), { signal: ctl.signal })).catch((e) => log.warn('voice file input failed', { error: e.message }));
            }
        } else if (audioWindow && !audioWindow.isDestroyed()) audioWindow.webContents.send('voice:start', { deviceId });
        startPtt();
    } else {
        stopPtt();
        filePlay?.abort();
        filePlay = null;
        if (audioWindow && !audioWindow.isDestroyed()) audioWindow.webContents.send('voice:stop');
        whisperVoice.stop();
        windowsVoice.stop();
        lastLevel = 0;
    }
    pushState();
}

/** Whisper could not start (no files, no download, no model): Windows speech recognition stands in for this session. */
function onWhisperFailed(e) {
    if (!config.get().voice.enabled || config.get().voice.engine === 'windows' || voiceFallback) return;
    voiceFallback = { reason: String(e?.message || 'Whisper could not start.').slice(0, 300), at: Date.now() };
    addActivity({ kind: 'info', title: 'Whisper could not start. Voice commands use Windows speech recognition for now.', detail: voiceFallback.reason, ok: false });
    log.warn('voice: falling back to Windows speech recognition', { error: e?.code || e?.message });
    applyVoice();
}

/** The commands to listen for: from the server's voice.phrases (0.2.10 sends each command's confidence and cooldown). */
function voiceCommands(v) {
    return Array.isArray(v.commands) && v.commands.length ? v.commands : (v.phrases || []);
}

async function refreshVoicePhrases() {
    if (!engine?.supports('request')) return null;
    const r = await engine.request('voice.phrases', {});
    const commands = [];
    const seen = new Set();
    for (const p of r?.phrases || []) {
        const text = String(p?.text || '').trim().slice(0, 100);
        if (!text || seen.has(text.toLowerCase()) || commands.length >= 500) continue;
        seen.add(text.toLowerCase());
        const conf = Number(p.confidence);
        const cd = Number(p.cooldownSec);
        // 0.2.13: the automation's "heard as" aliases and "not a command" examples (text only), and when it was taught
        const words = (list, withCount) => (Array.isArray(list) ? list : []).slice(0, withCount ? 50 : 100).map((x) => {
            const t = normaliseWords(typeof x === 'string' ? x : x?.text).slice(0, 100);
            if (!t) return null;
            const n = Number(x?.count);
            return withCount ? { text: t, count: Number.isInteger(n) && n > 0 ? Math.min(1000, n) : 1 } : { text: t };
        }).filter(Boolean);
        const tr = p.trained && typeof p.trained === 'object' ? { at: String(p.trained.at || '').slice(0, 40) || null, takes: Number(p.trained.takes) || null } : null;
        commands.push({ text, automationId: Number(p.automationId) || null, automationName: String(p.automationName || '').slice(0, 100),
            confidence: Number.isFinite(conf) && conf > 0 ? clampThreshold(conf) : null,
            cooldownMs: Number.isFinite(cd) && cd >= 0 ? Math.min(3600, cd) * 1000 : null,
            aliases: words(p.aliases, true), negatives: words(p.negatives, false), trained: tr });
    }
    const list = commands.map((c) => c.text);
    config.replace('voice', { ...config.get().voice, phrases: list, commands });
    if (voice) voice.setPhrases(commands);
    pushState();
    return list;
}

// ── voice log (0.2.10): every recognition with its outcome, like Streamer.bot's Speech-to-Text tab ────────────────────
// Newest first, the last 200, in memory only (gone when Studio closes). The server gets a summary (time, matched phrase,
// confidence, threshold, outcome), batched every few seconds; the words of speech that was not a command are only kept
// while "log all speech" is on, and only sent to CertiFried when "show the words on the dashboard" is on as well.
const VOICE_LOG_MAX = 200;
const voiceLog = [];
let voiceOutbox = [];
let voiceFlushTimer = null;
let voiceLogServer = true;   // false after a server answered unknown_method (older than 0.2.10); tried again at reconnect

// 0.2.12: 'short' (a burst the voice detector dropped) and 'wake' stay on this PC; 'nowake' is ordinary speech to the server.
const SERVER_OUTCOME = { fired: 'fired', below: 'below', cooldown: 'cooldown', noise: 'noise', disabled: 'disabled', nowake: 'noise' };

function voiceSummary(e) {
    const v = config.get().voice;
    const outcome = SERVER_OUTCOME[e.outcome];
    // 0.2.13: the id (so the dashboard can teach from a line), the closest command also for "not a command", and whether an
    // alias matched. The words go only with both "log all speech" and "show the words on the dashboard", for every outcome,
    // so the dashboard can learn from near misses and undo a wrong run.
    return { id: e.id || null, t: e.t, phrase: outcome === 'noise' ? null : (e.phrase || null), confidence: e.confidence ?? 0, threshold: e.threshold ?? null, outcome, automationId: e.automationId || null,
        heard: v.logAllSpeech && v.shareSpeechText ? (e.heard || null) : null,
        closest: e.closest || null, closestAutomationId: e.closestAutomationId || null, via: e.via || null, alias: e.via === 'alias' ? (e.alias || null) : null };
}

function onVoiceLog(entry) {
    const t = entry.t || Date.now();
    if (entry.outcome === 'short') {
        // clicks and keys come in bursts: one line that counts them, not two hundred
        vadDropped = { count: vadDropped.count + 1, lastAt: t };
        const top = voiceLog[0];
        if (top && top.outcome === 'short' && t - (top.lastT || top.t) < 15000) {
            top.count = (top.count || 1) + 1;
            top.lastT = t;
            send('voice-log', top);
            return;
        }
    }
    const e = { ...entry, id: `${t}-${Math.random().toString(36).slice(2, 7)}`, count: entry.outcome === 'short' ? 1 : undefined };
    if ((e.outcome === 'noise' || e.outcome === 'nowake' || e.outcome === 'below') && !config.get().voice.logAllSpeech && e.engine !== undefined) e.heard = null;
    if (e.outcome === 'noise' && !config.get().voice.logAllSpeech) e.heard = null;
    voiceLog.unshift(e);
    if (voiceLog.length > VOICE_LOG_MAX) voiceLog.length = VOICE_LOG_MAX;
    send('voice-log', e);
    if (!SERVER_OUTCOME[e.outcome]) return;
    voiceOutbox.push(voiceSummary(e));
    if (voiceOutbox.length > VOICE_LOG_MAX) voiceOutbox = voiceOutbox.slice(-VOICE_LOG_MAX);
    if (!voiceFlushTimer) voiceFlushTimer = setTimeout(() => { voiceFlushTimer = null; sendVoiceLog({}); }, 3000);
}

async function sendVoiceLog({ replace = false, clear = false }) {
    if (!engine?.supports('request') || !voiceLogServer) return;
    const entries = replace ? voiceLog.slice().reverse().filter((e) => SERVER_OUTCOME[e.outcome]).map(voiceSummary) : voiceOutbox;
    if (!replace && !clear && !entries.length) return;
    if (!replace) voiceOutbox = [];
    try {
        await engine.request('voice.log', { entries: entries.slice(-VOICE_LOG_MAX), replace: replace || clear }, 10000);
    } catch (e) {
        if (String(e?.code || '') === 'unknown_method') voiceLogServer = false;
        else log.info('voice log not sent', { error: e?.code || e?.message });
    }
}

// ── 0.2.13: learning ─────────────────────────────────────────────────────────────────────────────
/** Ask CertiFried to change an automation's aliases, "not a command" examples or its own threshold, then sync them back. */
async function voiceLearn(automationId, ops) {
    if (!engine?.supports('request')) throw new Error('Connect Studio to CertiFried first. What Studio learns is saved on your automation.');
    const id = Number(automationId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Click Refresh first, so Studio knows which automation this belongs to.');
    let r;
    try {
        r = await engine.request('voice.learn', { automationId: id, ...ops }, 10000);
    } catch (e) {
        if (String(e?.code || '') === 'unknown_method') throw new Error('CertiFried has not been updated for this yet. Try again later.');
        throw new Error(e?.message || 'CertiFried did not save it.');
    }
    await refreshVoicePhrases().catch((e) => log.info('voice phrases not refreshed after learning', { error: e?.message }));
    return r;
}

/** Things that were not this command, for calibration: "not a command" lines with words, and other commands' lines. */
function voiceNegatives(cmd) {
    const out = [];
    for (const e of voiceLog) {
        if (!e.heard || e.learned?.kind === 'alias') continue;
        if (e.outcome === 'noise' || e.outcome === 'nowake') out.push(e.heard);
        else if ((e.outcome === 'fired' || e.outcome === 'cooldown') && e.automationId && e.automationId !== cmd.automationId) out.push(e.heard);
    }
    return out.slice(0, 200);
}

const LEARN_ACTIONS = new Set(['alias', 'negative', 'wrong', 'undo']);
/** The voice log's buttons: "This was <command>", "Not a command", "Wrong, undo learning", and Undo of any of them. */
async function learnFromLog({ id, action, automationId }) {
    if (!LEARN_ACTIONS.has(action)) throw new Error('Unknown action');
    const e = voiceLog.find((x) => x.id === id);
    if (!e) throw new Error('That line is no longer in the list.');
    const words = normaliseWords(e.heard || '');
    const cmdFor = (aid) => voiceCommands(config.get().voice).find((c) => c.automationId === aid) || null;
    if (action === 'undo') {
        const l = e.learned;
        if (!l) throw new Error('Nothing was learned from this line.');
        const ops = { add: {}, remove: {} };
        if (l.kind === 'alias') ops.remove.aliases = [l.text];
        if (l.kind === 'negative') ops.remove.negatives = [l.text];
        if (l.kind === 'wrong') { if (l.negative) ops.remove.negatives = [l.negative]; if (l.removedAlias) ops.add.aliases = [l.removedAlias]; }
        await voiceLearn(l.automationId, ops);
        e.learned = null;
    } else if (action === 'alias') {
        const aid = Number(automationId) || e.closestAutomationId || e.automationId;
        if (!words) throw new Error('Studio did not keep the words of this line. Turn on "Log all speech" to teach Studio from the log.');
        if (!cmdFor(aid)) throw new Error('Pick one of your voice commands.');
        await voiceLearn(aid, { add: { aliases: [words] } });
        e.learned = { kind: 'alias', automationId: aid, text: words, phrase: cmdFor(aid)?.text || null };
    } else if (action === 'negative') {
        const aid = e.automationId || e.closestAutomationId;
        if (!words) throw new Error('Studio did not keep the words of this line. Turn on "Log all speech" to teach Studio from the log.');
        const c = cmdFor(aid);
        if (!c) throw new Error('This line is not close to any of your commands, so there is nothing to learn.');
        if (scorePhrase(words, c.text).score >= 0.97) throw new Error(`These are the words of "${c.text}" itself, so they cannot be marked as not a command.`);
        await voiceLearn(aid, { add: { negatives: [words] } });
        e.learned = { kind: 'negative', automationId: aid, text: words, phrase: c.text };
    } else {
        // a command that ran but should not have: forget the alias that matched, and remember these words as not it
        if (e.outcome !== 'fired' && e.outcome !== 'cooldown') throw new Error('Only a command that ran can be undone.');
        const c = cmdFor(e.automationId);
        if (!c) throw new Error('That command is no longer in Studio\'s list.');
        const removedAlias = e.via === 'alias' && e.alias ? normaliseWords(e.alias) : null;
        const negative = words && scorePhrase(words, c.text).score < 0.97 ? words : null;
        if (!removedAlias && !negative) throw new Error(words ? `Studio heard the words of "${c.text}" itself. Raise its "how sure" setting on the dashboard if it runs when you did not say it.` : 'Studio did not keep the words of this line. Turn on "Log all speech" to undo from the log.');
        await voiceLearn(e.automationId, { add: negative ? { negatives: [negative] } : {}, remove: removedAlias ? { aliases: [removedAlias] } : {} });
        e.learned = { kind: 'wrong', automationId: e.automationId, removedAlias, negative, phrase: c.text };
    }
    send('voice-log', e);
    pushState();
    return { learned: e.learned };
}

function clearVoiceLog() {
    voiceLog.length = 0;
    voiceOutbox = [];
    sendVoiceLog({ clear: true }).catch(() => {});
    pushState();
}

/** The switchover's voice.enable: voice on, phrases fetched, listening (or the reason it is not), within a few seconds. */
async function enableVoice(p) {
    if (process.platform !== 'win32') { const e = new Error('Voice commands need Windows'); e.code = 'not_windows'; throw e; }
    const patch = { enabled: true };
    if (p.threshold !== undefined && p.threshold !== null && Number.isFinite(Number(p.threshold))) { patch.threshold = clampThreshold(p.threshold); patch.thresholdSetAt = Date.now(); }
    config.update({ voice: patch });
    try { await refreshVoicePhrases(); } catch (e) { log.info('voice.enable: could not fetch phrases', { error: e?.message }); }
    await applyVoice();
    let st = voice ? voice.status() : { state: 'off' };
    for (let i = 0; i < 25 && voice && st.state !== 'listening' && st.state !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        st = voice.status();
    }
    reportState();
    pushState();
    return { enabled: true, state: st.state, error: st.error || null, phrases: st.phrases || 0, threshold: clampThreshold(config.get().voice.threshold) };
}

/** The switchover's Undo: voice on or off and the confidence, as they were before the switchover. */
async function setVoice(p) {
    const patch = {};
    if (p.enabled !== undefined && p.enabled !== null) patch.enabled = !!p.enabled;
    if (p.threshold !== undefined && p.threshold !== null && Number.isFinite(Number(p.threshold))) {
        patch.threshold = clampThreshold(p.threshold);
        // 0.2.10: the server's one-off correction to 0.7 passes onlyIfUnset, so a value the person chose is never overwritten.
        if (p.onlyIfUnset && config.get().voice.thresholdSetAt) delete patch.threshold;
        else patch.thresholdSetAt = Date.now();
    }
    if (!Object.keys(patch).length) {
        if (p.onlyIfUnset) { const v = config.get().voice; return { enabled: !!v.enabled, state: voice ? voice.status().state : 'off', threshold: clampThreshold(v.threshold), thresholdSet: true, unchanged: true }; }
        const e = new Error('Nothing to set'); e.code = 'bad_params'; throw e;
    }
    config.update({ voice: patch });
    if (patch.enabled !== undefined) applyVoice();
    reportState();
    pushState();
    const v = config.get().voice;
    return { enabled: !!v.enabled, state: voice ? voice.status().state : 'off', threshold: clampThreshold(v.threshold), thresholdSet: !!v.thresholdSetAt };
}

function onVoicePhrase({ text, confidence }) {
    const sent = engine?.supports('event') ? engine.sendEvent({ type: 'voice.phrase', metadata: { phrase: text, confidence } }) : false;
    log.info('voice command', { phrase: text, confidence, sent: !!sent });   // the command only, never other speech
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

    handle('vod:removeSource', async () => {
        const v = await vodSafe.removeSource();
        addActivity({ kind: 'info', title: 'Removed the CertiFried Music source from OBS', ok: true });
        pushState();
        return { vod: v };
    });

    // Lights, Voicemeeter, Stream Deck (Phase 5)
    handle('lights:find', async () => {
        if (!config.get().lights.enabled) { config.update({ lights: { enabled: true } }); log.info('lights turned on'); }
        const list = await findLights();
        return { count: list.length };
    });
    handle('lights:off', async () => { config.update({ lights: { enabled: false } }); lightsChanged(); return {}; });
    handle('lights:drivers', async ({ drivers }) => {
        const patch = {};
        for (const k of ['govee', 'hue', 'lifx', 'nanoleaf', 'elgato', 'litra', 'goveeble']) if (drivers && typeof drivers[k] === 'boolean') patch[k] = drivers[k];
        config.update({ lights: { drivers: patch } });
        lightsChanged();
        return {};
    });
    handle('lights:add', async ({ driver, address }) => {
        const added = await lights.addManual({ driver: String(driver || ''), address: String(address || '').trim().slice(0, 60) });
        config.update({ lights: { enabled: true } });
        lightsChanged();
        return { count: added.length };
    });
    handle('lights:pair', async ({ id }) => {
        lightsBusy = 'pairing';
        pushState();
        try {
            const r = await lights.pair(String(id || ''));
            addActivity({ kind: 'info', title: r.ok ? 'Light paired' : 'Pairing did not finish', detail: r.message || '', ok: !!r.ok });
            return { result: r };
        } finally { lightsBusy = null; lightsChanged(); }
    });
    handle('lights:forget', async ({ id }) => { lights.forget(String(id || '')); lightsChanged(); return {}; });
    // 0.2.14: heart rate. Scanning lists devices that advertise the Heart Rate Service (all: every named device nearby).
    handle('heart:scan', async (p) => {
        try { return { devices: await heart.scan({ all: !!p?.all }) }; } catch (e) { const err = new Error(e.message); err.code = e.code; throw err; }
    });
    handle('heart:choose', async (p) => {
        config.update({ heart: { enabled: true } });
        const st = heart.choose({ address: p?.address, name: p?.name });
        pushState();
        return { heart: st };
    });
    handle('heart:forget', async () => { heart.forget(); pushState(); return {}; });
    handle('heart:settings', async (p) => {
        const patch = {};
        if (typeof p?.enabled === 'boolean') patch.enabled = p.enabled;
        if (typeof p?.share === 'boolean') patch.share = p.share;
        if (!Object.keys(patch).length) { const e = new Error('Nothing to set'); e.code = 'bad_params'; throw e; }
        config.update({ heart: patch });
        if (patch.enabled !== undefined) heart.start();
        pushState();
        return { heart: heartView() };
    });
    handle('lights:test', async ({ id }) => { await lights.test(String(id || '')); return {}; });
    // 0.2.10: the cloud lights the server runs with the streamer's Govee / LIFX key, and its test flash.
    handle('lights:cloud', async () => {
        if (!engine?.supports('request')) throw new Error('Connect Studio to CertiFried to see the lights on your Govee key.');
        try { return await engine.request('lights.cloud', {}, 15000); } catch (e) {
            if (String(e?.code) === 'unknown_method') throw new Error('The CertiFried server does not list cloud lights yet.');
            throw new Error(e?.message || 'Could not get the cloud lights.');
        }
    });
    handle('lights:cloudTest', async ({ id }) => {
        if (!engine?.supports('request')) throw new Error('Connect Studio to CertiFried first.');
        const r = await engine.request('lights.cloudTest', { device: String(id || '').slice(0, 120) }, 20000);
        if (!r?.ok) throw new Error(r?.message || 'The light did not flash.');
        return { message: r.message || 'Flashed.' };
    });
    handle('alertAudio:find', async () => ({ sources: await alertAudio.find() }));
    // 0.2.11: the list of programs automations may start (Settings, Programs it may run).
    handle('programs:pick', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { title: 'Pick a program', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd'] }] });
        return { path: r.canceled ? null : (r.filePaths[0] || null) };
    });
    handle('programs:save', async ({ program }) => {
        const v = validateProgram(program || {});
        if (!v.ok) throw new Error(v.error);
        const list = (config.get().programs || []).filter((x) => x.id !== v.value.id);
        if (list.some((x) => x.name.toLowerCase() === v.value.name.toLowerCase())) throw new Error('Another program already has that name.');
        if (list.length >= MAX_PROGRAMS) throw new Error(`At most ${MAX_PROGRAMS} programs.`);
        config.replace('programs', [...list, v.value]);
        log.info('program list changed', { added: v.value.name });
        pushState();
        return { program: v.value };
    });
    handle('programs:remove', async ({ id }) => {
        config.replace('programs', (config.get().programs || []).filter((x) => x.id !== String(id || '')));
        pushState();
        return {};
    });
    handle('alertAudio:apply', async () => {
        const r = await alertAudio.apply();
        addActivity({ kind: 'info', title: `CertiFried now manages the audio of ${r.applied.length} Sound Alerts / Blerp source${r.applied.length === 1 ? '' : 's'}`, detail: r.applied.join(', '), ok: r.applied.length > 0 });
        vodSafe.ensure('alert audio').catch(() => {});
        pushState(); reportState();
        return r;
    });
    handle('alertAudio:undo', async () => {
        const r = await alertAudio.undo();
        addActivity({ kind: 'info', title: 'Sound Alerts and Blerp audio put back as it was', detail: r.restored.join(', '), ok: true });
        vodSafe.ensure('alert audio undo').catch(() => {});
        pushState(); reportState();
        return r;
    });

    handle('voicemeeter:settings', async ({ enabled }) => {
        config.update({ voicemeeter: { enabled: !!enabled } });
        await voicemeeter.configure({ enabled: !!enabled });
        if (enabled) await detectVoicemeeter(); else { reportState(); pushState(); }
        return {};
    });
    handle('voicemeeter:detect', async () => ({ info: await detectVoicemeeter() }));

    handle('streamdeck:settings', async ({ enabled, port }) => {
        const patch = {};
        if (enabled !== undefined) patch.enabled = !!enabled;
        if (port !== undefined) {
            const p = Number(port);
            if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('The port is a number from 1024 to 65535.');
            patch.port = p;
        }
        config.update({ streamdeck: patch });
        await applyStreamdeck();
        return {};
    });
    // The token is shown only when asked for (never in the pushed state); Regenerate disconnects every key pad.
    handle('streamdeck:token', async ({ regenerate }) => {
        if (regenerate || !config.hasSecret('streamdeckToken')) {
            config.setSecret('streamdeckToken', generateBridgeToken());
            bridge?.dropClients();
            if (regenerate) addActivity({ kind: 'info', title: 'New Stream Deck token: paste it into the plugin again', ok: true });
        }
        return { token: config.getSecret('streamdeckToken') };
    });
    handle('streamdeck:install', async () => {
        const file = sdPluginPath();
        if (!fs.existsSync(file)) throw new Error('The Stream Deck plugin is not included in this copy of Studio. Download it from the download page.');
        const err = await shell.openPath(file);
        if (err) throw new Error('Windows could not open the plugin file. Is the Elgato Stream Deck app installed?');
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
        if (p.mode === 'always' || p.mode === 'ptt' || p.mode === 'wake') patch.mode = p.mode;
        if (p.engine === 'auto' || p.engine === 'cpu' || p.engine === 'windows') patch.engine = p.engine;
        if (p.matchThreshold !== undefined) { const t = Number(p.matchThreshold); if (Number.isFinite(t)) patch.matchThreshold = clampMatch(t); }
        if (typeof p.wakePhrase === 'string') {
            const w = p.wakePhrase.replace(/\s+/g, ' ').trim().slice(0, 40);
            if (w.split(' ').length > 4 || w.replace(/[^a-z0-9]/gi, '').length < 4) throw new Error('Use a wake phrase of two to four words, such as "hey studio".');
            patch.wakePhrase = w;
        }
        if (typeof p.pttKey === 'string') {
            const { UiohookKey } = (() => { try { return require('uiohook-napi'); } catch { return { UiohookKey: null }; } })();
            if (UiohookKey) { try { parseKeys(p.pttKey, UiohookKey); } catch { throw new Error('Pick a single key, such as F13 or Num 0.'); } }
            patch.pttKey = p.pttKey.slice(0, 30);
        }
        if (p.threshold !== undefined) { const t = Number(p.threshold); if (Number.isFinite(t)) { patch.threshold = clampThreshold(t); patch.thresholdSetAt = Date.now(); } }
        if (p.logAllSpeech !== undefined) patch.logAllSpeech = !!p.logAllSpeech;
        if (p.shareSpeechText !== undefined) patch.shareSpeechText = !!p.shareSpeechText;
        if (p.keepRecordings !== undefined) patch.keepRecordings = !!p.keepRecordings;
        if (p.trainTakes !== undefined) patch.trainTakes = clampTakes(p.trainTakes);
        if (patch.logAllSpeech === false) {
            // Privacy: turning it off also forgets the words already in the log.
            patch.shareSpeechText = false;
            for (const e of voiceLog) if (e.outcome === 'noise' || e.outcome === 'nowake' || e.outcome === 'below') e.heard = null;
        }
        config.update({ voice: patch });
        if (patch.logAllSpeech !== undefined) voice?.refresh();
        if (patch.engine !== undefined) { voiceFallback = null; whisperVoice.stop(); windowsVoice.stop(); }
        if (patch.inputDeviceId !== undefined) config.update({ voice: { inputPickedBy: 'person', inputPickedAt: Date.now() } });
        if (patch.enabled !== undefined || patch.inputDeviceId !== undefined || patch.mode !== undefined || patch.pttKey !== undefined || patch.engine !== undefined) await applyVoice();
        reportState();
        pushState();
        return {};
    });
    handle('voice:clearLog', async () => { clearVoiceLog(); return {}; });
    // 0.2.13: "Teach Studio how you say it", and teaching from the voice log
    handle('voice:train', async (p) => {
        if (!trainer) throw new Error('Voice commands are not ready yet.');
        switch (p.action) {
            case 'start': {
                if (voice !== whisperVoice) throw new Error('Teaching needs Whisper. Pick Whisper under Speech recognition.');
                if (!engine?.supports('request')) throw new Error('Connect Studio to CertiFried first. What Studio learns is saved on your automation.');
                const takes = clampTakes(p.takes ?? config.get().voice.trainTakes);
                if (takes !== config.get().voice.trainTakes) config.update({ voice: { trainTakes: takes } });
                return { training: trainer.start({ key: String(p.key || ''), takes }) };
            }
            case 'stop': return { training: trainer.stop() };
            case 'resume': return { training: trainer.resume() };
            case 'delete': return { training: trainer.deleteTake(String(p.id || '')) };
            case 'cancel': return { training: trainer.cancel() };
            case 'save': return { saved: await trainer.save(), training: null };
            default: throw new Error('Unknown action');
        }
    });
    handle('voice:learn', async (p) => learnFromLog({ id: String(p.id || ''), action: String(p.action || ''), automationId: p.automationId }));
    // 0.2.12: the one-click switch from a mix bus to the microphone Studio suggests, and "Try Whisper again" after a fallback
    handle('voice:useMic', async () => {
        const s = inputView.suggestion;
        if (!s) throw new Error('There is no other microphone to switch to.');
        config.update({ voice: { inputDeviceId: s.id, inputDeviceLabel: s.label, inputPickedBy: 'person', inputPickedAt: Date.now() } });
        addActivity({ kind: 'info', title: `Voice commands now use ${s.label}`, ok: true });
        await applyVoice();
        return { label: s.label };
    });
    handle('voice:retryWhisper', async () => { voiceFallback = null; windowsVoice.stop(); await applyVoice(); return {}; });
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
    // Phase 5 devices. Tests and packaged test launches point every device at 127.0.0.1 mocks (sandbox.js).
    step('device sandbox', () => { sandbox = loadSandbox(process.env, { logger: log }); if (sandbox) log.warn('device sandbox in use: lights, Litra and Voicemeeter are mocks'); });
    lights = createLights({ config, logger: log, sandbox, hid: sandbox ? fakeHid(sandbox.record) : null,
        // 0.2.11: Govee over Bluetooth. The helper is unpacked next to app.asar like the voice helper; the cloud lights (from the
        // server) say which Bluetooth lights are the streamer's own.
        ble: { helperPath: path.join(__dirname, '..', 'ble', 'govee-ble-helper.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), getCloudMacs: () => cloudMacs } });
    lights.onChange(() => lightsChanged());
    // 0.2.14: heart rate over Bluetooth LE, through its own helper next to the Govee one (both unpacked next to app.asar).
    heart = createHeartRate({
        helperPath: sandbox ? null : path.join(__dirname, '..', 'ble', 'heart-ble-helper.exe').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
        logger: log, getSettings: () => config.get().heart,
        saveDevice: (d) => config.update({ heart: { device: d } }),
        onReading: onHeartReading,
        onStatus: () => { send('heart', heartView()); pushState(); },
    });
    heartSender = createSender({ send: sendHeart });
    step('heart rate', () => heart.start());
    voicemeeter = createVoicemeeter({ logger: log, binding: sandbox ? fakeVoicemeeterBinding(sandbox.record) : null, record: sandbox ? sandbox.record : null,
        // In the sandbox the settings-file list comes from a folder in the scratch data folder, never the real Documents.
        documentsDir: sandbox ? path.join(userData, 'sandbox-documents') : app.getPath('documents'), enabled: false });
    vodSafe = createVodSafe({
        // Song requests on (the server's automations.list says so) before VOD protection touches OBS; null = not told yet.
        enforced: config.get().music.songRequests === true,
        obs, logger: log, getSettings: () => config.get().music, saveSettings: (p) => config.update({ music: p }), getMusicUrl,
        backupProfile: async () => {
            const pl = await obs.call('GetProfileList');
            return backupProfileIni({ dir: obsDir(), profileName: pl.currentProfileName });
        },
    });
    vodSafe.onChange(onVodChange);
    programRunner = createProgramRunner({ getList: () => config.get().programs || [], logger: log });
    alertAudio = createAlertAudio({ obs, logger: log, getVod: async () => vodSafe.ensure('alert audio check'),
        getSaved: () => config.get().alertAudio, save: (v) => config.replace('alertAudio', v) });
    router = createRouter({ extra: {
        'music.prepare': () => vodSafe.prepare(),
        ...lightHandlers(),
        ...voicemeeter.handlers(),
        // 0.2.7: add CertiFried overlays next to the sources they replace (hidden), show / hide for the switchover, and
        // close Firebot / Streamer.bot when the streamer ticks it (obs-sources.js).
        ...sourceHandlers(obs, { resolveOverlay }),
        // 0.2.8: the switchover turns voice commands on (capability 'voice'): set the switch, fetch the phrases, start listening and
        // answer with where it got to. An optional threshold (0.2 to 0.95) is applied first.
        'voice.enable': (p) => enableVoice(p || {}),
        // 0.2.9: Undo of the switchover puts the voice switch and confidence back as they were.
        'voice.set': (p) => setVoice(p || {}),
        // 0.2.10: SoundAlerts and Blerp browser sources get "Control audio via OBS" and stay off the VOD track, like
        // CertiFried Music (alert-audio.js). { undo: true } puts the recorded old settings back. Capability 'alertaudio'.
        // 0.2.11: "Run a program on your PC": only a program on the streamer's own list here, by name (programs.js).
        'system.run': (p) => programRunner.run(p || {}),
        'obs.alert_audio': async (p) => {
            const r = p?.undo ? await alertAudio.undo() : await alertAudio.apply();
            vodSafe.ensure('alert audio').catch(() => {});
            pushState(); reportState();
            return r;
        },
        // The dashboard's "Ask Studio to look again" (Devices): look for lights and Voicemeeter once more and report.
        'devices.check': async () => {
            const s = config.get();
            const found = s.lights.enabled ? (await findLights().catch(() => lights.list())).length : null;
            const vm = s.voicemeeter.enabled ? await detectVoicemeeter() : null;
            reportState();
            return { lights: found, lightsOn: !!s.lights.enabled, voicemeeter: vm ? (vm.running ? vm.type : vm.installed ? 'not_running' : 'not_installed') : 'off' };
        },
    }, obs, sound, library, keys, screenshotDir: process.env.CF_STUDIO_USER_DATA ? path.join(userData, 'Screenshots') : path.join(app.getPath('pictures'), 'CertiFried Studio'), logger: log, defaultSoundMode: () => config.get().sound.defaultMode });
    hotkeys = createHotkeys({ globalShortcut, onTrigger: triggerBinding, logger: log });
    const voiceDir = path.join(__dirname, '..', 'voice').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const voiceStatus = (s) => { pushState(); if (s && s.state !== lastVoiceState) { lastVoiceState = s.state; reportState(); } };
    const automationOn = (id) => { const a = automations.find((x) => x.id === id); return a ? a.enabled : true; };
    windowsVoice = createVoice({
        // The helper script must be a real file for PowerShell: it is unpacked next to app.asar in the installed app.
        helperPath: path.join(voiceDir, 'speech-helper.ps1'),
        tmpDir: path.join(userData, 'voice'), logger: log, getSettings: () => config.get().voice,
        onPhrase: onVoicePhrase,
        onLog: onVoiceLog,
        isEnabled: automationOn,
        onStatus: voiceStatus,
    });
    // 0.2.12: Whisper. Its folder also holds the Visual C++ runtime that onnxruntime (the voice detector) needs, so it goes on
    // PATH before onnxruntime is loaded; the model and the graphics card files are downloaded into <userData>\voice once.
    const whisperBin = path.join(voiceDir, 'whisper');
    process.env.PATH = `${whisperBin};${process.env.PATH || ''}`;
    const whisperEngine = createWhisperEngine({ binDir: whisperBin, dataDir: path.join(userData, 'voice'), logger: log });
    whisperVoice = createWhisperVoice({
        vad: createSileroVad({ modelPath: path.join(voiceDir, 'silero_vad.onnx') }),
        recogniser: whisperEngine,
        getSettings: () => config.get().voice, logger: log,
        onPhrase: onVoicePhrase,
        onLog: onVoiceLog,
        isEnabled: automationOn,
        onStatus: voiceStatus,
    });
    whisperVoice.onEngineFailed = onWhisperFailed;
    trainer = createVoiceTrainer({
        voice: whisperVoice,
        getCommand: (key) => whisperVoice.command(key) || null,
        getNegatives: voiceNegatives,
        learn: (cmd, r) => voiceLearn(cmd.automationId, { add: { aliases: r.aliases }, confidence: r.confidence, trained: { takes: r.takes } }),
        recordingsDir: path.join(userData, 'voice', 'training'),
        keepRecordings: () => !!config.get().voice.keepRecordings,
        wavBytes, logger: log,
        onUpdate: () => pushState(),
    });
    let whisperCrashes = [];
    whisperEngine.onExit = () => {
        const t = Date.now();
        whisperCrashes = whisperCrashes.filter((x) => t - x < 60000);
        whisperCrashes.push(t);
        if (whisperCrashes.length > 3) { onWhisperFailed(new Error('Whisper keeps stopping on this PC.')); return; }
        setTimeout(() => { if (voice === whisperVoice && config.get().voice.enabled) whisperVoice.restart(); }, 1000);
    };
    voice = whisperVoice;
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
    obs.on('obs-event', (name, data) => {
        vodSafe.onObsEvent(name, data);
        if (bridge && BRIDGE_OBS_EVENTS.has(name)) {
            if (name === 'SceneItemEnableStateChanged') {
                // OBS names the item by id only; look its source name up for the plugin (cached).
                const key = `${data?.sceneName}:${data?.sceneItemId}`;
                const send = (sourceName) => bridge?.broadcast({ type: 'obs', event: name, data: { sceneName: data?.sceneName, sceneItemId: data?.sceneItemId, sceneItemEnabled: !!data?.sceneItemEnabled, sourceName } });
                if (sceneItemNames.has(key)) send(sceneItemNames.get(key));
                else obs.call('GetSceneItemList', { sceneName: data?.sceneName }).then((r) => {
                    for (const it of r?.sceneItems || []) sceneItemNames.set(`${data?.sceneName}:${it.sceneItemId}`, it.sourceName);
                    if (sceneItemNames.size > 5000) sceneItemNames.clear();
                    send(sceneItemNames.get(key) || null);
                }).catch(() => send(null));
            } else bridge.broadcast({ type: 'obs', event: name, data });
        }
    });
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
    step('lights', () => { if (config.get().lights.enabled) findLights().catch((e) => log.warn('lights could not be found', { error: e.message })); });
    step('Voicemeeter', () => { if (config.get().voicemeeter.enabled) Promise.resolve(voicemeeter.configure({ enabled: true })).then(() => detectVoicemeeter()).catch(() => {}); });
    step('Stream Deck', () => { if (config.get().streamdeck.enabled) applyStreamdeck().catch(() => {}); });
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
                    fs.writeFileSync(process.env.CF_STUDIO_SMOKE, JSON.stringify({ started: true, lights: lights ? lights.list().length : null, secureStorage: config.secureStorageAvailable(), storageMode: config.storageMode(), paired: config.hasSecret('deviceToken'), hasObsPassword: config.hasSecret('obsPassword'), keyFile: fs.existsSync(config.paths.keyFile), keySending: keys.available, importCheck, ...shown }));
                }
            } catch (e) { log.error('capture failed', { error: e.message }); }
            quitting = true;
            app.quit();
        }, Number(process.env.CF_STUDIO_CAPTURE_WAIT || 3000)));
    }
    // While idle and song requests are on, keep VOD-safe music checked every minute (OBS settings can change without an event).
    setInterval(() => { if (obs.connected && vodSafe.enforced()) vodSafe.ensure('timer').catch(() => {}); }, 60 * 1000).unref?.();
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
    // 0.2.12: both engines; whisper-server is a child process that Windows would otherwise leave running
    try { stopPtt(); whisperVoice?.stop(); windowsVoice?.stop(); } catch { /* ignore */ }
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
    try { engine?.stop(); } catch { /* ignore */ }
    try { obs?.stop(); } catch { /* ignore */ }
    try { lights?.close(); } catch { /* ignore */ }
    try { voicemeeter?.close(); } catch { /* ignore */ }
    try { heartSender?.close(); heart?.close(); } catch { /* ignore */ }
    try { bridge?.stop(); } catch { /* ignore */ }
    log?.info('CertiFried Studio closed');
});
