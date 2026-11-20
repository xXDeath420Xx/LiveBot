/*
 * What each Stream Deck key does, independent of the Stream Deck SDK (src/plugin.js wires the SDK to this; the tests
 * drive it with a mocked SDK surface).
 *
 *   const c = createController({ client, ui, log })
 *     client     src/studio-client.js (request, on, status, connected, configure)
 *     ui         { sendToPropertyInspector(payload) }   the property inspector that is open, if any
 *     c.appear(key, settings) / c.disappear(id) / c.settingsChanged(key, settings)
 *     c.keyDown(key, settings)          runs the request; showOk on success, showAlert on failure
 *     c.fromPropertyInspector(key, payload)   { event: 'list', kind, scene? } and { event: 'status' }
 *     c.globalSettings(settings)        { port, token } → client.configure
 *   `key` is { id, manifestId, setState(0|1), setTitle(text), showAlert(), showOk() }.
 *
 * Actions (UUIDs com.certifried.studio.<name>) and their settings:
 *   run-automation { automationId, automationName? }          → automations.run { automationId }
 *   switch-scene   { scene }                                   → obs.scene { scene }          state 1 = program scene
 *   toggle-source  { scene, source, mode: toggle|show|hide }   → obs.source { scene, source, state: mode }  state 1 = visible
 *   mute-input     { input, mode: toggle|mute|unmute }         → obs.mute { input, state: mode }           state 1 = muted
 *   counter        { counter, direction: up|down, step 1-1000 }→ counters.add { counter, amount: ±step }   title = value
 *   play-sound     { sound }                                   → sound.play { sound }
 *   light-preset   { preset }                                  → lights.apply { preset }
 * Global settings: { port (default 39720), token }.
 *
 * Pushes from Studio that update keys:
 *   { type: 'obs', event: 'CurrentProgramSceneChanged', data: { sceneName } }
 *   { type: 'obs', event: 'InputMuteStateChanged', data: { inputName, inputMuted } }
 *   { type: 'obs', event: 'SceneItemEnableStateChanged', data: { sceneName, sourceName?, sceneItemEnabled } }
 *        (without sourceName every source key on that scene asks obs.sourceState again)
 *   { type: 'state', obs?: { connected, currentScene }, counters?: { name: value } | [{ name, value }], counter?: { name, value } }
 * On connecting, visible keys read their state: status (current scene), obs.muteState, obs.sourceState, counters.list.
 */
export const PREFIX = 'com.certifried.studio.';
export const ACTIONS = ['run-automation', 'switch-scene', 'toggle-source', 'mute-input', 'counter', 'play-sound', 'light-preset'];

const str = (v, n = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, n) : '');
const nameOf = (uuid) => (String(uuid || '').startsWith(PREFIX) ? String(uuid).slice(PREFIX.length) : '');

/** The Studio request for a key, or null when the key is not set up yet. */
export function requestFor(uuid, settings = {}) {
    const s = settings && typeof settings === 'object' ? settings : {};
    switch (nameOf(uuid)) {
        case 'run-automation': {
            const id = str(s.automationId, 64);
            return id ? { method: 'automations.run', params: { automationId: /^\d+$/.test(id) ? Number(id) : id } } : null;
        }
        case 'switch-scene': return str(s.scene) ? { method: 'obs.scene', params: { scene: str(s.scene) } } : null;
        case 'toggle-source': {
            const mode = ['show', 'hide'].includes(s.mode) ? s.mode : 'toggle';
            return str(s.scene) && str(s.source) ? { method: 'obs.source', params: { scene: str(s.scene), source: str(s.source), state: mode } } : null;
        }
        case 'mute-input': {
            const mode = ['mute', 'unmute'].includes(s.mode) ? s.mode : 'toggle';
            return str(s.input) ? { method: 'obs.mute', params: { input: str(s.input), state: mode } } : null;
        }
        case 'counter': {
            if (!str(s.counter)) return null;
            const step = Math.max(1, Math.min(1000, Math.round(Number(s.step) || 1)));
            return { method: 'counters.add', params: { counter: str(s.counter), amount: s.direction === 'down' ? -step : step } };
        }
        case 'play-sound': return str(s.sound) ? { method: 'sound.play', params: { sound: str(s.sound) } } : null;
        case 'light-preset': return str(s.preset) ? { method: 'lights.apply', params: { preset: str(s.preset) } } : null;
        default: return null;
    }
}

/** The list a property inspector asks for → Studio method and how to read its answer. */
const LISTS = {
    automations: { method: 'automations.list', key: 'automations' },
    scenes: { method: 'obs.scenes', key: 'scenes' },
    sources: { method: 'obs.sources', key: 'sources', needs: 'scene' },
    inputs: { method: 'obs.inputs', key: 'inputs' },
    counters: { method: 'counters.list', key: 'counters' },
    sounds: { method: 'sounds.list', key: 'sounds' },
    presets: { method: 'lights.presets', key: 'presets' },
};

/** Strings or { id?, name } objects → [{ value, label }], capped and de-duplicated. */
export function toItems(list) {
    const out = [];
    const seen = new Set();
    for (const it of Array.isArray(list) ? list.slice(0, 500) : []) {
        let value; let label;
        if (typeof it === 'string') { value = it; label = it; } else if (it && typeof it === 'object') {
            const name = str(it.name ?? it.label ?? it.id);
            value = str(it.id ?? it.name);
            label = name || value;
        }
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push({ value, label: String(label).slice(0, 200) });
    }
    return out;
}

const STATUS_TEXT = {
    connected: 'Connected to CertiFried Studio.',
    connecting: 'Connecting to CertiFried Studio.',
    not_configured: 'Paste the pairing token from Studio (Settings, Stream Deck) to connect.',
    unreachable: 'Studio is not reachable. Check that it is running and the Stream Deck bridge is on.',
    auth_failed: 'Studio refused the pairing token. Copy it again from Studio.',
    locked_out: 'Too many wrong tokens. Studio will accept a new try in a minute.',
    stopped: 'Not connected.',
};
export const statusText = (status, detail) => (status === 'auth_failed' && detail === 'token_changed'
    ? 'The pairing token was regenerated in Studio. Paste the new one.'
    : STATUS_TEXT[status] || 'Not connected.');

export function createController({ client, ui, log = () => {} }) {
    const keys = new Map();          // id → { key, uuid, settings }
    const live = { scene: null, muted: new Map(), visible: new Map(), counters: new Map() };
    const vkey = (scene, source) => `${scene}\u0000${source}`;

    const safe = (p) => Promise.resolve(p).catch(() => {});
    const each = (name, fn) => { for (const k of keys.values()) if (nameOf(k.uuid) === name) fn(k); };

    // ---- key visuals ------------------------------------------------------------------------------------------------
    function paint(k) {
        const s = k.settings || {};
        switch (nameOf(k.uuid)) {
            case 'switch-scene': safe(k.key.setState(live.scene && str(s.scene) === live.scene ? 1 : 0)); break;
            case 'mute-input': { const m = live.muted.get(str(s.input)); if (m !== undefined) safe(k.key.setState(m ? 1 : 0)); break; }
            case 'toggle-source': { const v = live.visible.get(vkey(str(s.scene), str(s.source))); if (v !== undefined) safe(k.key.setState(v ? 1 : 0)); break; }
            case 'counter': { const v = live.counters.get(str(s.counter)); safe(k.key.setTitle(v === undefined ? '' : String(v))); break; }
            default: break;
        }
    }
    const paintAll = (name) => each(name, paint);

    /** Ask Studio for the state one key shows (after connecting, or when it appears / its settings change). */
    async function readState(k) {
        if (!client.connected) return;
        const s = k.settings || {};
        try {
            switch (nameOf(k.uuid)) {
                case 'switch-scene': {
                    const r = await client.request('status', {});
                    const cur = r?.obs?.currentScene ?? r?.currentScene;
                    if (typeof cur === 'string') { live.scene = cur; paintAll('switch-scene'); }
                    break;
                }
                case 'mute-input':
                    if (!str(s.input)) return;
                    live.muted.set(str(s.input), !!(await client.request('obs.muteState', { input: str(s.input) }))?.muted);
                    paintAll('mute-input');
                    break;
                case 'toggle-source':
                    if (!str(s.scene) || !str(s.source)) return;
                    live.visible.set(vkey(str(s.scene), str(s.source)), !!(await client.request('obs.sourceState', { scene: str(s.scene), source: str(s.source) }))?.visible);
                    paintAll('toggle-source');
                    break;
                case 'counter': {
                    if (!str(s.counter)) return;
                    applyCounters((await client.request('counters.list', {}))?.counters);
                    break;
                }
                default: break;
            }
        } catch (e) { log('debug', `state read failed: ${e?.code}`); }
    }

    function applyCounters(list) {
        if (Array.isArray(list)) {
            for (const c of list) if (c && typeof c === 'object' && str(c.name)) live.counters.set(str(c.name), Number(c.value) || 0);
        } else if (list && typeof list === 'object') {
            for (const [n, v] of Object.entries(list)) live.counters.set(str(n), Number(v) || 0);
        }
        paintAll('counter');
    }

    async function refreshAll() {
        const seen = new Set();
        for (const k of keys.values()) {
            const name = nameOf(k.uuid);
            if (name === 'switch-scene' || name === 'counter') { if (seen.has(name)) continue; seen.add(name); }
            await readState(k);
        }
    }

    // ---- pushes from Studio -----------------------------------------------------------------------------------------
    function onPush(msg) {
        if (msg.type === 'obs') {
            const d = msg.data && typeof msg.data === 'object' ? msg.data : {};
            if (msg.event === 'CurrentProgramSceneChanged' && typeof d.sceneName === 'string') { live.scene = d.sceneName; paintAll('switch-scene'); }
            if (msg.event === 'InputMuteStateChanged' && typeof d.inputName === 'string') { live.muted.set(d.inputName, !!d.inputMuted); paintAll('mute-input'); }
            if (msg.event === 'SceneItemEnableStateChanged' && typeof d.sceneName === 'string') {
                if (typeof d.sourceName === 'string') { live.visible.set(vkey(d.sceneName, d.sourceName), !!d.sceneItemEnabled); paintAll('toggle-source'); }
                else each('toggle-source', (k) => { if (str(k.settings?.scene) === d.sceneName) readState(k); });
            }
            return;
        }
        if (msg.type === 'state') {
            const cur = msg.obs?.currentScene;
            if (typeof cur === 'string' && cur !== live.scene) { live.scene = cur; paintAll('switch-scene'); }
            if (msg.obs && msg.obs.connected === false && live.scene !== null) { live.scene = null; paintAll('switch-scene'); }
            if (msg.counters) applyCounters(msg.counters);
            if (msg.counter && str(msg.counter.name)) applyCounters([msg.counter]);
        }
    }

    client.on('push', onPush);
    client.on('welcome', () => { refreshAll(); });
    client.on('status', (status, detail) => { safe(ui.sendToPropertyInspector({ event: 'status', status, connected: status === 'connected', text: statusText(status, detail) })); });

    // ---- Stream Deck events -----------------------------------------------------------------------------------------
    function appear(key, settings) {
        const k = { key, uuid: key.manifestId, settings: settings || {} };
        keys.set(key.id, k);
        paint(k);
        readState(k);
    }

    function disappear(id) { keys.delete(id); }

    function settingsChanged(key, settings) {
        const k = keys.get(key.id) || { key, uuid: key.manifestId };
        k.settings = settings || {};
        k.key = key;
        keys.set(key.id, k);
        paint(k);
        readState(k);
    }

    async function keyDown(key, settings) {
        const uuid = key.manifestId;
        const req = requestFor(uuid, settings);
        if (!req) { log('info', `${nameOf(uuid)} is not set up`); await safe(key.showAlert()); return { ok: false, error: 'not_configured' }; }
        try {
            const r = await client.request(req.method, req.params);
            const p = req.params;
            switch (nameOf(uuid)) {
                case 'switch-scene': live.scene = p.scene; paintAll('switch-scene'); break;
                case 'mute-input': if (typeof r?.muted === 'boolean') { live.muted.set(p.input, r.muted); paintAll('mute-input'); } break;
                case 'toggle-source': if (typeof r?.visible === 'boolean') { live.visible.set(vkey(p.scene, p.source), r.visible); paintAll('toggle-source'); } break;
                case 'counter': if (Number.isFinite(Number(r?.value))) { live.counters.set(p.counter, Number(r.value)); paintAll('counter'); } break;
                default: break;
            }
            await safe(key.showOk());
            return { ok: true, result: r };
        } catch (e) {
            log('info', `${req.method} failed: ${e?.code}`);
            await safe(key.showAlert());
            return { ok: false, error: e?.code || 'failed' };
        }
    }

    async function fromPropertyInspector(key, payload) {
        const p = payload && typeof payload === 'object' ? payload : {};
        if (p.event === 'status') {
            await safe(ui.sendToPropertyInspector({ event: 'status', status: client.status, connected: client.connected, text: statusText(client.status, client.detail) }));
            return;
        }
        if (p.event !== 'list') return;
        const spec = LISTS[p.kind];
        if (!spec) return;
        const reply = { event: 'list', kind: p.kind, scene: p.scene ?? null, items: [], error: null };
        if (spec.needs && !str(p[spec.needs])) { await safe(ui.sendToPropertyInspector(reply)); return; }
        try {
            const r = await client.request(spec.method, spec.needs ? { [spec.needs]: str(p[spec.needs]) } : {});
            reply.items = toItems(r?.[spec.key]);
            if (p.kind === 'counters') applyCounters(r?.counters);
        } catch (e) {
            reply.error = e?.code === 'not_connected' ? statusText(client.status, client.detail) : `Studio could not list these (${e?.code || 'failed'}).`;
        }
        await safe(ui.sendToPropertyInspector(reply));
    }

    function globalSettings(settings) {
        const s = settings && typeof settings === 'object' ? settings : {};
        client.configure({ port: s.port ?? 39720, token: typeof s.token === 'string' ? s.token : '' });
    }

    return { appear, disappear, settingsChanged, keyDown, fromPropertyInspector, globalSettings, onPush, _live: live, _keys: keys };
}
