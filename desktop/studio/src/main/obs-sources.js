'use strict';
/*
 * Studio 0.2.7: OBS actions the server dispatches for "add CertiFried overlays next to my old ones" and the one-click
 * switchover from Firebot / Streamer.bot (server: core/stream-bot/switchover.js). Every one is careful by construction:
 *
 *   obs.output_status   {}  → { streaming, recording, currentScene, studioMode }                     read only
 *   obs.scene_items     { scenes? }  → { scenes: { <scene>: [{ id, source, enabled, index, kind, certifried? }] } }
 *                       read only; a CertiFried browser source also reports { overlayId, replaces } from its own settings
 *   obs.add_browser_source  { name, overlayId, width, height, replaces?, restartWhenActive?, shutdown?, monitor?,
 *                             placements: [{ scene, nextTo?, transform }] }
 *                       adds ONE browser source for a CertiFried overlay, switched off (hidden) in every placement, with the
 *                       given transform, directly above `nextTo` (the source it will replace). The address comes from the
 *                       server's overlays.list by overlay id (never from the dispatch), so it is always a CertiFried overlay.
 *                       Refused while OBS is streaming or recording. Never changes the scene on air, never touches another
 *                       source: a name that belongs to something else is refused (name_taken); our own source of that name
 *                       is reused (only missing scene items are added and its transform set).
 *   obs.set_scene_items { changes: [{ scene, source, enabled }], idleOnly? }  → { changes: [{ scene, source, enabled, previous }] }
 *                       shows or hides scene items (the switchover and its undo); a missing scene or source is reported
 *                       per change, not thrown, so one renamed source does not stop the rest.
 *   studio.close_apps   { apps: ['firebot', 'streamerbot'] } → { apps: [{ app, image, wasRunning, closed, stillRunning }] }
 *                       asks Firebot / Streamer.bot to close by their exact process names (taskkill without /F, the same as
 *                       closing the window). Only those two names can ever be closed; OBS and everything else never.
 *
 * Errors are short reason codes: obs_not_connected, obs_live, bad_params, scene_not_found, name_taken, overlay_not_found,
 * obs_error, not_windows.
 */
const childProcess = require('node:child_process');

const BOUNDS = ['OBS_BOUNDS_NONE', 'OBS_BOUNDS_STRETCH', 'OBS_BOUNDS_SCALE_INNER', 'OBS_BOUNDS_SCALE_OUTER', 'OBS_BOUNDS_SCALE_TO_WIDTH', 'OBS_BOUNDS_SCALE_TO_HEIGHT', 'OBS_BOUNDS_MAX_ONLY'];
const MONITOR = { none: 'OBS_MONITORING_TYPE_NONE', monitor: 'OBS_MONITORING_TYPE_MONITOR_ONLY', both: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' };
/** The only programs studio.close_apps can close, by their exact Windows image names. */
const CLOSABLE = Object.freeze({ firebot: { image: 'Firebot v5.exe', label: 'Firebot' }, streamerbot: { image: 'Streamer.bot.exe', label: 'Streamer.bot' } });
const LIMITS = Object.freeze({ placements: 20, changes: 200, scenes: 200, name: 120 });

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }
const str = (v, field, max = LIMITS.name) => {
    const s = v == null ? '' : String(v).trim();
    if (!s) throw fail('bad_params', `missing ${field}`);
    if (s.length > max || /[\u0000-\u001f]/.test(s)) throw fail('bad_params', `${field} is not a usable name`);
    return s;
};
const finite = (v, lo, hi, field) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw fail('bad_params', `${field} must be ${lo} to ${hi}`);
    return n;
};

async function call(obs, type, data, notFound = 'not_found') {
    try { return (await obs.call(type, data)) || {}; } catch (e) {
        if (Number(e?.code) === 600) throw fail(notFound, e.message);
        if (e?.code === 'obs_not_connected') throw e;
        throw fail('obs_error', String(e?.message || 'OBS refused the request').slice(0, 200));
    }
}
function needObs(obs) { if (!obs || !obs.connected) throw fail('obs_not_connected', 'OBS is not connected'); }

async function outputStatus(obs) {
    needObs(obs);
    const [st, rec, cur, sm] = await Promise.all([call(obs, 'GetStreamStatus'), call(obs, 'GetRecordStatus'), call(obs, 'GetCurrentProgramScene'), call(obs, 'GetStudioModeEnabled').catch(() => ({}))]);
    return { streaming: !!st.outputActive, recording: !!rec.outputActive, currentScene: cur.currentProgramSceneName || cur.sceneName || null, studioMode: !!sm.studioModeEnabled };
}
async function refuseWhenLive(obs) {
    const s = await outputStatus(obs);
    if (s.streaming || s.recording) throw fail('obs_live', `OBS is ${s.streaming ? 'streaming' : 'recording'}; nothing was changed`);
    return s;
}

/** A transform from the server (obs-websocket field names) → a checked SetSceneItemTransform body. */
function cleanTransform(t = {}) {
    if (!t || typeof t !== 'object') throw fail('bad_params', 'transform must be an object');
    const out = {
        positionX: finite(t.positionX ?? 0, -100000, 100000, 'positionX'), positionY: finite(t.positionY ?? 0, -100000, 100000, 'positionY'),
        rotation: finite(t.rotation ?? 0, -360, 360, 'rotation'),
        scaleX: finite(t.scaleX ?? 1, -100, 100, 'scaleX'), scaleY: finite(t.scaleY ?? 1, -100, 100, 'scaleY'),
        alignment: Math.round(finite(t.alignment ?? 5, 0, 15, 'alignment')),
        cropLeft: Math.round(finite(t.cropLeft ?? 0, 0, 100000, 'cropLeft')), cropRight: Math.round(finite(t.cropRight ?? 0, 0, 100000, 'cropRight')),
        cropTop: Math.round(finite(t.cropTop ?? 0, 0, 100000, 'cropTop')), cropBottom: Math.round(finite(t.cropBottom ?? 0, 0, 100000, 'cropBottom')),
    };
    const bt = t.boundsType ?? 'OBS_BOUNDS_NONE';
    if (!BOUNDS.includes(bt)) throw fail('bad_params', 'unknown boundsType');
    out.boundsType = bt;
    if (bt !== 'OBS_BOUNDS_NONE') {
        // OBS refuses bounds smaller than 1 px, so they are only sent with a bounds type.
        out.boundsWidth = finite(t.boundsWidth, 1, 100000, 'boundsWidth');
        out.boundsHeight = finite(t.boundsHeight, 1, 100000, 'boundsHeight');
        out.boundsAlignment = Math.round(finite(t.boundsAlignment ?? 0, 0, 15, 'boundsAlignment'));
    }
    return out;
}

async function itemsOf(obs, scene) {
    const r = await call(obs, 'GetSceneItemList', { sceneName: scene }, 'scene_not_found');
    return (r.sceneItems || []).map((s) => ({ id: s.sceneItemId, source: s.sourceName, enabled: !!s.sceneItemEnabled, index: Number(s.sceneItemIndex ?? 0), kind: s.inputKind || null }));
}

async function sceneItems(obs, params = {}) {
    needObs(obs);
    let scenes = Array.isArray(params.scenes) && params.scenes.length ? params.scenes.slice(0, LIMITS.scenes).map((s) => str(s, 'scene')) : null;
    if (!scenes) scenes = ((await call(obs, 'GetSceneList')).scenes || []).map((s) => s.sceneName).reverse().slice(0, LIMITS.scenes);
    const out = {};
    const settingsCache = new Map();
    for (const scene of scenes) {
        let list;
        try { list = await itemsOf(obs, scene); } catch (e) { if (e.code === 'scene_not_found') { out[scene] = null; continue; } throw e; }
        for (const it of list) {
            if (!/^browser_source/.test(String(it.kind || '')) || !/^CertiFried /.test(it.source)) continue;
            if (!settingsCache.has(it.source)) {
                const s = await call(obs, 'GetInputSettings', { inputName: it.source }).catch(() => ({}));
                const set = s.inputSettings || {};
                settingsCache.set(it.source, Number.isInteger(set.certifried_overlay) ? { overlayId: set.certifried_overlay, replaces: typeof set.certifried_replaces === 'string' ? set.certifried_replaces.slice(0, LIMITS.name) : null } : null);
            }
            const cf = settingsCache.get(it.source);
            if (cf) it.certifried = cf;
        }
        out[scene] = list;
    }
    return { scenes: out };
}

/**
 * Add a CertiFried overlay as a hidden browser source next to the source it will replace.
 * `resolveOverlay(id)` → { url, sourceName, type } | null (main.js: the server's overlays.list, cleaned by cleanOverlays()).
 */
async function addBrowserSource(obs, params = {}, { resolveOverlay } = {}) {
    needObs(obs);
    const name = str(params.name, 'name');
    if (!/^CertiFried /.test(name)) throw fail('bad_params', 'the source name must start with "CertiFried "');
    const overlayId = Number(params.overlayId);
    if (!Number.isInteger(overlayId) || overlayId <= 0) throw fail('bad_params', 'overlayId is missing');
    const width = Math.round(finite(params.width ?? 1920, 16, 7680, 'width'));
    const height = Math.round(finite(params.height ?? 1080, 16, 4320, 'height'));
    const replaces = params.replaces == null || params.replaces === '' ? null : str(params.replaces, 'replaces');
    const placements = Array.isArray(params.placements) ? params.placements : [];
    if (!placements.length || placements.length > LIMITS.placements) throw fail('bad_params', `1 to ${LIMITS.placements} placements`);
    const plan = placements.map((p) => ({ scene: str(p?.scene, 'scene'), nextTo: p?.nextTo ? str(p.nextTo, 'nextTo') : null, transform: cleanTransform(p?.transform || {}) }));
    const monitor = MONITOR[params.monitor] || null;
    const ov = typeof resolveOverlay === 'function' ? await resolveOverlay(overlayId) : null;
    if (!ov?.url) throw fail('overlay_not_found', 'that overlay is not in your CertiFried overlays list');

    const before = await refuseWhenLive(obs);
    const inputs = ((await call(obs, 'GetInputList')).inputs || []);
    const existing = inputs.find((i) => i.inputName === name);
    let created = false;
    if (existing) {
        const s = await call(obs, 'GetInputSettings', { inputName: name });
        if (!/^browser_source/.test(String(s.inputKind || existing.inputKind || '')) || s.inputSettings?.certifried_overlay !== overlayId) {
            throw fail('name_taken', `a source called ${name} already exists and is not this CertiFried overlay; nothing was changed`);
        }
    }
    const settings = {
        url: ov.url, width, height, reroute_audio: true, shutdown: !!params.shutdown, restart_when_active: !!params.restartWhenActive,
        certifried_overlay: overlayId, ...(replaces ? { certifried_replaces: replaces } : {}),
    };
    const result = { name, created: false, placements: [] };
    for (const p of plan) {
        const items = await itemsOf(obs, p.scene);
        let mine = items.find((i) => i.source === name);
        let added = false;
        if (!mine) {
            if (!existing && !created) {
                const r = await call(obs, 'CreateInput', { sceneName: p.scene, inputName: name, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: false }, 'scene_not_found');
                created = true;
                mine = { id: r.sceneItemId };
            } else {
                const r = await call(obs, 'CreateSceneItem', { sceneName: p.scene, sourceName: name, sceneItemEnabled: false }, 'scene_not_found');
                mine = { id: r.sceneItemId };
            }
            added = true;
        }
        await call(obs, 'SetSceneItemTransform', { sceneName: p.scene, sceneItemId: mine.id, sceneItemTransform: p.transform });
        let index = null;
        if (p.nextTo) {
            const now = await itemsOf(obs, p.scene);
            const ref = now.find((i) => i.source === p.nextTo);
            const me = now.find((i) => i.id === mine.id);
            if (ref && me) {
                // Directly above the source it replaces (OBS counts from the bottom, 0 = lowest).
                index = me.index > ref.index ? ref.index + 1 : ref.index;
                if (index !== me.index) await call(obs, 'SetSceneItemIndex', { sceneName: p.scene, sceneItemId: mine.id, sceneItemIndex: index });
            }
        }
        result.placements.push({ scene: p.scene, sceneItemId: mine.id, added, index, nextTo: p.nextTo });
    }
    if (existing) await call(obs, 'SetInputSettings', { inputName: name, inputSettings: settings, overlay: true });
    if (monitor) await call(obs, 'SetInputAudioMonitorType', { inputName: name, monitorType: monitor }).catch(() => {});
    result.created = created;
    // Nothing above may move the scene on air; check, and say so if OBS did anyway.
    const after = await call(obs, 'GetCurrentProgramScene');
    result.sceneOnAirUnchanged = (after.currentProgramSceneName || after.sceneName) === before.currentScene;
    return result;
}

async function setSceneItems(obs, params = {}) {
    needObs(obs);
    const changes = Array.isArray(params.changes) ? params.changes : [];
    if (!changes.length || changes.length > LIMITS.changes) throw fail('bad_params', `1 to ${LIMITS.changes} changes`);
    const plan = changes.map((c) => ({ scene: str(c?.scene, 'scene'), source: str(c?.source, 'source'), enabled: c?.enabled === true }));
    if (params.idleOnly) await refuseWhenLive(obs);
    const lists = new Map();
    const out = [];
    for (const c of plan) {
        if (!lists.has(c.scene)) lists.set(c.scene, await itemsOf(obs, c.scene).catch((e) => (e.code === 'scene_not_found' ? null : Promise.reject(e))));
        const items = lists.get(c.scene);
        if (!items) { out.push({ ...c, ok: false, error: 'scene_not_found' }); continue; }
        const it = items.find((i) => i.source === c.source);
        if (!it) { out.push({ ...c, ok: false, error: 'source_not_found' }); continue; }
        if (it.enabled !== c.enabled) await call(obs, 'SetSceneItemEnabled', { sceneName: c.scene, sceneItemId: it.id, sceneItemEnabled: c.enabled });
        out.push({ ...c, ok: true, previous: it.enabled, changed: it.enabled !== c.enabled });
        it.enabled = c.enabled;
    }
    return { changes: out };
}

function running(image, execFileSync) {
    const outp = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return String(outp).toLowerCase().includes(`"${image.toLowerCase()}"`);
}

async function closeApps(params = {}, { execFileSync = childProcess.execFileSync, platform = process.platform, wait = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 4000 } = {}) {
    if (platform !== 'win32') throw fail('not_windows', 'only on Windows');
    const apps = Array.isArray(params.apps) ? [...new Set(params.apps.map(String))] : [];
    if (!apps.length || apps.some((a) => !CLOSABLE[a])) throw fail('bad_params', 'apps must be firebot and/or streamerbot');
    const out = [];
    for (const app of apps) {
        const { image } = CLOSABLE[app];
        const wasRunning = running(image, execFileSync);
        let closed = false;
        if (wasRunning) {
            // No /F: the program is asked to close as if its window's close button was pressed, and can save its settings.
            try { execFileSync('taskkill', ['/IM', image], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch { /* it may refuse or be gone */ }
            await wait(settleMs);
            closed = !running(image, execFileSync);
        }
        out.push({ app, image, wasRunning, closed, stillRunning: wasRunning && !closed });
    }
    return { apps: out };
}

/** The handlers for router.js `extra` (main.js passes resolveOverlay). */
function sourceHandlers(obs, { resolveOverlay, execFileSync, platform } = {}) {
    return {
        'obs.output_status': () => outputStatus(obs),
        'obs.scene_items': (p) => sceneItems(obs, p),
        'obs.add_browser_source': (p) => addBrowserSource(obs, p, { resolveOverlay }),
        'obs.set_scene_items': (p) => setSceneItems(obs, p),
        'studio.close_apps': (p) => closeApps(p, { ...(execFileSync ? { execFileSync } : {}), ...(platform ? { platform } : {}) }),
    };
}

module.exports = { sourceHandlers, outputStatus, sceneItems, addBrowserSource, setSceneItems, closeApps, cleanTransform, CLOSABLE, BOUNDS, LIMITS };
