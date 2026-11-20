'use strict';
/*
 * The action router: one dispatched action → the module that carries it out → { ok, result } or { ok: false, error }.
 *
 *   createRouter({ obs, sound, library, keys, screenshotDir, logger })
 *   router.run(action, params) → { ok: true, result } | { ok: false, error }
 *   router.capabilities()      what this app announces in hello: obs, sound, hotkey (+ light, voicemeeter when given)
 *   router.handles(action)
 *
 * Errors are short reason codes (shown on the dashboard's run page), never stack traces.
 */
const fs = require('node:fs');
const { OBS_ACTIONS, runObsAction } = require('./obs-actions');

const LATER = new Set();

function createRouter({ obs, sound, library, keys, screenshotDir, logger = null, defaultSoundMode = () => 'overlap', extra = {} }) {
    const handlers = new Map();
    for (const t of OBS_ACTIONS) {
        handlers.set(t, (p) => {
            if (t === 'obs.screenshot' && screenshotDir) { try { fs.mkdirSync(screenshotDir, { recursive: true }); } catch { /* OBS reports it */ } }
            return runObsAction(obs, t, p, { screenshotDir });
        });
    }
    handlers.set('sound.play', async (p) => {
        const r = library.resolve(p.sound);
        // The automation's own mode wins; without one, the app's setting decides.
        const mode = p.mode === 'queue' || p.mode === 'overlap' ? p.mode : (defaultSoundMode() === 'queue' ? 'queue' : 'overlap');
        const vol = Number(p.volume);
        const out = await sound.play({ src: r.src, name: r.name, volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, vol)) : 100, mode });
        return { sound: r.name, ...out };
    });
    handlers.set('sound.stop', async () => sound.stopAll());
    handlers.set('studio.hotkey', async (p) => keys.send(p.keys));
    for (const [type, fn] of Object.entries(extra)) handlers.set(type, fn);   // e.g. music.prepare (VOD-safe music)

    return {
        handles: (t) => handlers.has(t),
        // Phase 5: light and voicemeeter once those handlers are given (main.js passes them through `extra`).
        // 0.2.7: 'apps' once studio.close_apps is given (closing Firebot / Streamer.bot for the switchover).
        capabilities: () => ['obs', 'sound', 'hotkey', ...(handlers.has('light.set') ? ['light'] : []), ...(handlers.has('voicemeeter.mute') ? ['voicemeeter'] : []), ...(handlers.has('studio.close_apps') ? ['apps'] : [])],
        async run(action, params = {}) {
            const fn = handlers.get(action);
            if (!fn) return { ok: false, error: LATER.has(action) ? 'not_supported_yet' : 'unsupported_action' };
            try {
                const result = await fn(params && typeof params === 'object' ? params : {});
                return { ok: true, result: result || {} };
            } catch (e) {
                const error = String(e?.code || 'failed');
                const detail = e?.message && e.message !== error ? `: ${String(e.message).slice(0, 180)}` : '';
                logger?.info?.(`[router] ${action} failed`, { error, detail: e?.message });
                return { ok: false, error: `${error}${detail}`.slice(0, 250) };
            }
        },
    };
}

module.exports = { createRouter };
