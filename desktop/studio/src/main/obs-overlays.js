'use strict';
/*
 * "CertiFried overlays" in Set up OBS (0.2.5, server Phase 3): the profile's overlays, read from the server with the
 * request overlays.list, each added to the scene on air as a browser source on its own click.
 *
 *   OVERLAY_PATH                        /stream/bot/overlay/<type>/sbo_<32>
 *   cleanOverlays(list, { origin, siteHost })  only https (or the configured server) addresses on CertiFried under
 *                                       OVERLAY_PATH; a source name per overlay ("CertiFried Alerts", or "CertiFried Alerts
 *                                       - <overlay name>" when there are several of one kind)
 *   planOverlay(obsSnapshot, overlay, inputs)  what a click will do, shown before it: { action: add|scene|update|there,
 *                                       scene, sourceName, text }
 *   addOverlay(obs, overlay)            does it: a new browser source 1920×1080 in the scene on air with "Control audio via
 *                                       OBS" on (its sounds go through OBS's tracks, so the streamer decides about the VOD),
 *                                       and "Monitor and Output" for the kinds that play sound; an existing CertiFried source
 *                                       of the same name gets the new address (after a new key) or is only put in the scene.
 *                                       Nothing else in OBS is touched.
 */
const OVERLAY_PATH = /^\/stream\/bot\/overlay\/(alerts|chat|events|goal|counter|nowplaying|canvas)\/sbo_[A-Za-z0-9_-]{32}$/;
const MONITOR = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';

function err(code, message) { const e = new Error(message); e.code = code; return e; }

function cleanOverlays(list, { origin = null, siteHost = 'certifriedmultitool.com' } = {}) {
    const out = [];
    for (const o of Array.isArray(list) ? list : []) {
        let u;
        try { u = new URL(String(o?.url || '')); } catch { continue; }
        const ours = (origin && u.origin === origin) || (u.protocol === 'https:' && u.hostname === siteHost);
        const m = u.pathname.match(OVERLAY_PATH);
        if (!ours || !m || u.search || u.hash) continue;
        out.push({
            id: Number(o.id) || 0, type: m[1], label: String(o.label || m[1]).slice(0, 40), name: String(o.name || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80),
            baseName: /^CertiFried [A-Za-z ]{1,30}$/.test(String(o.sourceName || '')) ? String(o.sourceName) : 'CertiFried Overlay',
            url: u.href, audio: !!o.audio, width: 1920, height: 1080,
        });
    }
    const count = {};
    for (const o of out) count[o.baseName] = (count[o.baseName] || 0) + 1;
    for (const o of out) o.sourceName = count[o.baseName] > 1 && o.name ? `${o.baseName} - ${o.name}`.slice(0, 120) : o.baseName;
    return out;
}

/** The browser sources that already exist, with their addresses: [{ inputName, url }]. */
async function browserInputs(obs) {
    const list = ((await obs.call('GetInputList')).inputs || []).filter((i) => /^browser_source/.test(i.inputKind || i.unversionedInputKind || ''));
    const out = [];
    for (const i of list.slice(0, 100)) {
        try { out.push({ inputName: i.inputName, url: String((await obs.call('GetInputSettings', { inputName: i.inputName })).inputSettings?.url || '') }); } catch { /* gone meanwhile */ }
    }
    return out;
}

function planOverlay(snapshot, overlay, inputs = []) {
    const scene = snapshot?.currentScene || null;
    const inScene = new Set((snapshot?.sources?.[scene]) || []);
    const sameUrl = inputs.find((i) => i.url === overlay.url);
    const sameName = inputs.find((i) => i.inputName === overlay.sourceName);
    if (!scene) return { action: 'none', scene: null, sourceName: overlay.sourceName, text: 'Connect OBS first.' };
    if (sameUrl) {
        return inScene.has(sameUrl.inputName)
            ? { action: 'there', scene, sourceName: sameUrl.inputName, text: `Already in ${scene} as ${sameUrl.inputName}.` }
            : { action: 'scene', scene, sourceName: sameUrl.inputName, text: `Puts your existing ${sameUrl.inputName} source into ${scene}.` };
    }
    if (sameName) {
        let u = null;
        try { u = new URL(sameName.url); } catch { /* not a URL */ }
        const sameKind = u && u.pathname.match(OVERLAY_PATH)?.[1] === overlay.type;
        if (sameKind) return { action: 'update', scene, sourceName: sameName.inputName, text: `Gives your ${sameName.inputName} source this overlay's new address${inScene.has(sameName.inputName) ? '' : ` and puts it into ${scene}`}.` };
        let n = 2;
        while (inputs.some((i) => i.inputName === `${overlay.sourceName} ${n}`)) n++;
        return { action: 'add', scene, sourceName: `${overlay.sourceName} ${n}`, text: `Adds a browser source "${overlay.sourceName} ${n}" (1920 × 1080) to ${scene}; your own "${overlay.sourceName}" stays as it is.` };
    }
    return { action: 'add', scene, sourceName: overlay.sourceName, text: `Adds a browser source "${overlay.sourceName}" (1920 × 1080) to ${scene}.${overlay.audio ? ' Its sounds go through OBS, so you choose in Advanced Audio Properties whether they reach your VOD.' : ''}` };
}

async function addOverlay(obs, overlay) {
    if (!obs?.connected) throw err('obs_not_connected', 'Connect OBS first.');
    const current = await obs.call('GetCurrentProgramScene');
    const scene = current.currentProgramSceneName || current.sceneName;
    const items = ((await obs.call('GetSceneItemList', { sceneName: scene })).sceneItems || []).map((s) => s.sourceName);
    const inputs = await browserInputs(obs);
    const plan = planOverlay({ currentScene: scene, sources: { [scene]: items } }, overlay, inputs);
    const result = { scene, sourceName: plan.sourceName, action: plan.action };
    if (plan.action === 'there') return result;
    if (plan.action === 'update') {
        await obs.call('SetInputSettings', { inputName: plan.sourceName, inputSettings: { url: overlay.url, width: 1920, height: 1080, reroute_audio: true }, overlay: true });
        if (!items.includes(plan.sourceName)) await obs.call('CreateSceneItem', { sceneName: scene, sourceName: plan.sourceName, sceneItemEnabled: true });
        return result;
    }
    if (plan.action === 'scene') {
        await obs.call('CreateSceneItem', { sceneName: scene, sourceName: plan.sourceName, sceneItemEnabled: true });
        return result;
    }
    await obs.call('CreateInput', {
        sceneName: scene, inputName: plan.sourceName, inputKind: 'browser_source', sceneItemEnabled: true,
        inputSettings: { url: overlay.url, width: 1920, height: 1080, reroute_audio: true, shutdown: false, restart_when_active: false },
    });
    if (overlay.audio) await obs.call('SetInputAudioMonitorType', { inputName: plan.sourceName, monitorType: MONITOR }).catch(() => {});
    return result;
}

module.exports = { OVERLAY_PATH, cleanOverlays, browserInputs, planOverlay, addOverlay };
