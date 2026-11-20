'use strict';
/*
 * The lights manager: every light driver behind one list and the light.* actions.
 *
 *   const lights = createLights({ config, logger, sandbox, transports?, hid?, now?, setTimer?, clearTimer?, hostName?, timing?, drivers? })
 *   await lights.discover({ timeoutMs = 4000 })  → devices (every enabled driver; merged with lights.known; saved)
 *   lights.notes()                               → [{ driver, message }] from the last discovery (e.g. Govee LAN control off)
 *   lights.list()                                → devices
 *   lights.onChange(fn)                          → unsubscribe; fn(devices) when the list or online state changes
 *   await lights.addManual({ driver, address })  → devices added (hue, nanoleaf, elgato, govee, lifx; IPv4 address)
 *   await lights.pair(id)                        → { ok, message }   (Hue link button, Nanoleaf power button; 30 s)
 *   lights.forget(id)                            drops the saved pairing and the known entry
 *   await lights.run(action, params)             → { applied: [ids], skipped: [{ id, reason, message? }], notes: [{ id, reason }] }
 *   await lights.test(id)                        one short flash in #b4e04f, then the light goes back
 *   lights.close()                               sockets, HID handles, timers
 *
 * Device: { id, driver, name, model, address, online, caps: { power, brightness, color, white: {min,max}|null,
 * scenes: [], effects: [] }, needsPairing, kind: 'light'|'group'|'bridge' }. Never a token.
 *
 * Actions: light.set, light.color, light.white, light.brightness, light.power, light.scene, light.flash, light.preset.
 * `device` '' or 'all' means every paired, online light (rooms/groups and bridges left out so nothing is set twice).
 * run() throws an Error with .code when nothing was applied: no_lights, device_not_found, device_offline,
 * not_supported, needs_pairing, bad_color, scene_not_found, cert_changed, bad_params, driver_error (+ message).
 * Colour on a white-only light becomes the nearest white and adds { id, reason: 'white_only' } to notes.
 * Brightness 0 turns the light off.
 *
 * Temporary changes (durationMs > 0, flash, test): the light's state is read first and put back afterwards. A second
 * temporary change on the same light keeps the first saved state; a permanent change cancels the pending restore.
 * All timers go through the injected setTimer/clearTimer (tests use a fake clock); a timer callback returns its promise.
 *
 * Drivers are created on first use, so no socket is opened before discovery or an action. Which endpoints they use:
 * the sandbox when one is given (127.0.0.1 only), otherwise the real LAN (see each driver).
 */
const { codeError, clamp, toInt } = require('./util');
const { parseColor, rgbToKelvin } = require('./color');
const { createMdns } = require('./mdns');
const { createGoveeDriver } = require('./govee-lan');
const { createHueDriver } = require('./hue');
const { createLifxDriver } = require('./lifx-lan');
const { createNanoleafDriver } = require('./nanoleaf');
const { createElgatoDriver } = require('./elgato');
const { createLitraDriver } = require('./litra');

const DRIVER_NAMES = Object.freeze(['govee', 'hue', 'lifx', 'nanoleaf', 'elgato', 'litra']);
const MANUAL = new Set(['hue', 'nanoleaf', 'elgato', 'govee', 'lifx']);
const ACTIONS = Object.freeze(['light.set', 'light.color', 'light.white', 'light.brightness', 'light.power', 'light.scene', 'light.flash', 'light.preset']);
const PASS_CODES = new Set(['no_lights', 'device_not_found', 'device_offline', 'not_supported', 'needs_pairing', 'bad_color', 'driver_error', 'cert_changed', 'bad_params', 'scene_not_found', 'sandbox_refused']);
const BRAND_GREEN = Object.freeze({ r: 0xb4, g: 0xe0, b: 0x4f });
const MAX_KNOWN = 200;
const MAX_PRESET = 50;

function normaliseError(e) {
    const code = String(e?.code || '');
    if (PASS_CODES.has(code)) return e;
    if (code === 'device_unreachable') return codeError('device_offline', e.message);
    return codeError('driver_error', String(e?.message || 'failed').slice(0, 200));
}

function publicCopy(d) {
    const caps = d.caps || {};
    return {
        id: String(d.id), driver: d.driver, name: String(d.name || '').slice(0, 80), model: String(d.model || '').slice(0, 60),
        address: d.address == null ? null : String(d.address).slice(0, 40), online: !!d.online,
        caps: {
            power: !!caps.power, brightness: !!caps.brightness, color: !!caps.color,
            white: caps.white && Number.isFinite(caps.white.min) && Number.isFinite(caps.white.max) ? { min: caps.white.min, max: caps.white.max } : null,
            scenes: Array.isArray(caps.scenes) ? caps.scenes.filter((s) => typeof s === 'string').slice(0, 100) : [],
            effects: Array.isArray(caps.effects) ? caps.effects.filter((s) => typeof s === 'string').slice(0, 100) : [],
        },
        needsPairing: !!d.needsPairing, kind: ['light', 'group', 'bridge'].includes(d.kind) ? d.kind : 'light',
    };
}

function createLights({
    config, logger = null, sandbox = null, transports = {}, hid = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    hostName = null, timing = {}, drivers: injected = null,
} = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };
    const mdns = createMdns({ factory: transports.mdns || null, logger });
    const factories = {
        govee: () => createGoveeDriver({ logger, sandbox, transports, replyTimeoutMs: timing.goveeReplyMs ?? 1500, sendGapMs: timing.goveeGapMs ?? 40 }),
        lifx: () => createLifxDriver({ logger, sandbox, transports, replyTimeoutMs: timing.lifxReplyMs ?? 500, retries: timing.lifxRetries ?? 2 }),
        hue: () => createHueDriver({ logger, sandbox, config, transports, mdns, hostName, setTimer, now, timeoutMs: timing.httpTimeoutMs ?? 4000, pairTimeoutMs: timing.pairTimeoutMs ?? 30000, pairIntervalMs: timing.pairIntervalMs ?? 2000 }),
        nanoleaf: () => createNanoleafDriver({ logger, sandbox, config, transports, mdns, setTimer, now, timeoutMs: timing.httpTimeoutMs ?? 3000, pairTimeoutMs: timing.pairTimeoutMs ?? 30000, pairIntervalMs: timing.pairIntervalMs ?? 2000 }),
        elgato: () => createElgatoDriver({ logger, sandbox, transports, mdns, timeoutMs: timing.httpTimeoutMs ?? 3000 }),
        litra: () => createLitraDriver({ logger, sandbox, hid, readTimeoutMs: timing.litraReadMs ?? 120 }),
    };
    const live = new Map();          // driver name → driver
    const listeners = new Set();
    const jobs = new Map();          // device id → { saved, ready, timers: Set }
    let lastNotes = [];
    let closed = false;
    let lastSig = '';

    const settings = () => { try { return config?.get?.()?.lights || {}; } catch { return {}; } };
    const enabled = (name) => settings().drivers?.[name] !== false;

    function driver(name) {
        if (!DRIVER_NAMES.includes(name)) throw codeError('bad_params', 'Unknown light type');
        let d = live.get(name);
        if (!d) {
            d = injected && injected[name] ? injected[name] : (injected ? null : factories[name]());
            if (!d) throw codeError('not_supported', 'That light type is not available');
            live.set(name, d);
        }
        return d;
    }
    const driverOf = (dev) => driver(dev.driver);

    // Known devices from settings go back into their drivers (offline until found or used).
    const known = Array.isArray(settings().known) ? settings().known.slice(0, MAX_KNOWN) : [];
    for (const entry of known) {
        if (!entry || !DRIVER_NAMES.includes(entry.driver) || typeof entry.id !== 'string' || !entry.id.startsWith(`${entry.driver}:`)) continue;
        try { driver(entry.driver).restore?.(entry); } catch (e) { log('warn', 'A saved light could not be restored', { driver: entry.driver, code: e.code }); }
    }

    function list() {
        const out = [];
        const seen = new Set();
        for (const name of DRIVER_NAMES) {
            const d = live.get(name);
            if (!d) continue;
            let items = [];
            try { items = d.list() || []; } catch { items = []; }
            for (const dev of items) {
                if (!dev || seen.has(dev.id)) continue;
                seen.add(dev.id);
                out.push(publicCopy({ ...dev, driver: name }));
            }
        }
        return out;
    }

    const signature = (l) => JSON.stringify(l.map((d) => [d.id, d.online, d.needsPairing, d.name]));
    function emitIfChanged(force = false) {
        const l = list();
        const sig = signature(l);
        if (!force && sig === lastSig) return;
        lastSig = sig;
        for (const fn of listeners) { try { fn(l); } catch { /* listener errors are theirs */ } }
    }
    function save() {
        const l = list().slice(0, MAX_KNOWN).map(({ online, ...rest }) => rest);
        try { config?.update?.({ lights: { known: l } }); } catch (e) { log('warn', 'Could not save the light list', { error: String(e?.message || e).slice(0, 80) }); }
    }

    async function discover({ timeoutMs = 4000 } = {}) {
        if (closed) throw codeError('driver_error', 'Lights are closed');
        const t = clamp(toInt(timeoutMs, 4000), 300, 15000);
        const names = DRIVER_NAMES.filter(enabled).filter((n) => !injected || injected[n]);
        const notes = [];
        const results = await Promise.allSettled(names.map((n) => driver(n).discover({ timeoutMs: t })));
        results.forEach((r, i) => {
            const n = names[i];
            if (r.status === 'rejected') {
                notes.push({ driver: n, message: String(r.reason?.message || 'search failed').slice(0, 200) });
                log('info', 'A light search failed', { driver: n, code: r.reason?.code });
            }
            try { for (const note of live.get(n)?.notes?.() || []) notes.push({ driver: n, message: String(note.message || '').slice(0, 300) }); } catch { /* none */ }
        });
        lastNotes = notes;
        save();
        emitIfChanged(true);
        const l = list();
        log('info', 'Light search finished', { found: l.filter((d) => d.online).length, known: l.length });
        return l;
    }

    async function addManual({ driver: name, address } = {}) {
        if (!MANUAL.has(name)) throw codeError('bad_params', 'Choose Hue, Nanoleaf, Elgato, Govee or LIFX');
        if (typeof address !== 'string' || !address.trim() || address.length > 32) throw codeError('bad_params', 'Enter an IPv4 address');
        const d = driver(name);
        if (!d.addManual) throw codeError('not_supported');
        let added;
        try { added = await d.addManual(address.trim()); } catch (e) { throw normaliseError(e); }
        save();
        emitIfChanged();
        return (added || []).map((x) => publicCopy({ ...x, driver: name }));
    }

    async function pair(id) {
        const dev = list().find((d) => d.id === id);
        if (!dev) return { ok: false, message: 'That light is not in the list.' };
        const d = driver(dev.driver);
        if (!d.pair) return { ok: false, message: 'This light does not need pairing.' };
        let r;
        try { r = await d.pair(id); } catch (e) { return { ok: false, message: String(normaliseError(e).message).slice(0, 200) }; }
        if (r?.ok) { save(); }
        emitIfChanged(true);
        return { ok: !!r?.ok, message: String(r?.message || '').slice(0, 300) };
    }

    function forget(id) {
        const dev = list().find((d) => d.id === id);
        if (!dev) return false;
        for (const x of list()) if (x.id === id || x.id.startsWith(`${id}/`)) cancelJob(x.id);
        try { driver(dev.driver).forget?.(id); } catch (e) { log('warn', 'Could not forget a light', { code: e.code }); }
        save();
        emitIfChanged();
        return true;
    }

    /* ---------- temporary changes ---------- */
    function clearTimers(job) { for (const h of job.timers) { try { clearTimer(h); } catch { /* gone */ } } job.timers.clear(); }
    function cancelJob(id) { const j = jobs.get(id); if (j) { clearTimers(j); jobs.delete(id); } }
    function schedule(job, ms, fn) {
        const h = setTimer(() => { job.timers.delete(h); return fn(); }, ms);
        job.timers.add(h);
    }
    async function beginTemp(dev) {
        let job = jobs.get(dev.id);
        if (job) { clearTimers(job); await job.ready; return job; }
        job = { saved: null, timers: new Set(), ready: null };
        job.ready = driverOf(dev).getState(dev.id).then((s) => { job.saved = s; }, (e) => { log('info', 'Could not read a light before a temporary change', { id: dev.id, code: e.code }); });
        jobs.set(dev.id, job);
        await job.ready;
        return job;
    }
    async function restoreNow(dev, job) {
        if (jobs.get(dev.id) !== job) return;
        jobs.delete(dev.id);
        clearTimers(job);
        const s = job.saved;
        if (!s) return;
        try {
            const d = driverOf(dev);
            if (s.scene && s.on && d.scene) { await d.scene(dev.id, s.scene, {}); return; }
            const st = { on: !!s.on, transitionMs: 0 };
            if (Number.isFinite(s.brightness) && s.brightness > 0 && dev.caps.brightness) st.brightness = s.brightness;
            if (Number.isFinite(s.kelvin) && s.kelvin > 0 && dev.caps.white) st.kelvin = clamp(s.kelvin, dev.caps.white.min, dev.caps.white.max);
            else if (s.color && dev.caps.color) st.color = s.color;
            await d.setState(dev.id, st);
        } catch (e) { log('info', 'Could not put a light back after a temporary change', { id: dev.id, code: e.code }); }
        emitIfChanged();
    }

    /* ---------- targets and state ---------- */
    async function targets(device, { allowBridge = false } = {}) {
        const all = list();
        const want = typeof device === 'string' ? device.trim() : '';
        if (!want || want === 'all') {
            const t = all.filter((d) => d.kind === 'light' && !d.needsPairing && d.online);
            if (!t.length) throw codeError('no_lights', 'No paired lights are online. Search for lights in Studio first.');
            return t;
        }
        const dev = all.find((d) => d.id === want);
        if (!dev) throw codeError('device_not_found');
        if (dev.needsPairing) throw codeError('needs_pairing', 'Pair this light in Studio first');
        if (dev.kind === 'bridge' && !allowBridge) throw codeError('not_supported', 'Choose a light or a room, not the bridge');
        if (!dev.online && dev.kind !== 'bridge') {
            try { await driverOf(dev).getState(dev.id); } catch (e) {
                if (['cert_changed', 'needs_pairing'].includes(e.code)) throw e;
                throw codeError('device_offline', 'The light is not answering');
            }
            dev.online = true;
        }
        return [dev];
    }

    /** Fits the wanted state to a device: colour → nearest white on white-only lights, kelvin clamped. */
    function adapt(dev, want, notes) {
        const s = {};
        if (want.on !== undefined) s.on = want.on;
        if (Number.isFinite(want.brightness) && dev.caps.brightness) s.brightness = want.brightness;
        if (want.color) {
            if (dev.caps.color) s.color = want.color;
            else if (dev.caps.white) {
                s.kelvin = clamp(rgbToKelvin(want.color), dev.caps.white.min, dev.caps.white.max);
                notes.push({ id: dev.id, reason: 'white_only' });
            } else throw codeError('not_supported', 'This light has no colour');
        } else if (Number.isFinite(want.kelvin)) {
            if (!dev.caps.white) throw codeError('not_supported', 'This light has no white setting');
            s.kelvin = Math.round(clamp(want.kelvin, dev.caps.white.min, dev.caps.white.max));
        }
        if (Number.isFinite(want.transitionMs) && want.transitionMs > 0) s.transitionMs = want.transitionMs;
        return s;
    }

    async function each(list, fn) {
        const applied = []; const skipped = []; const notes = []; const errors = [];
        const results = await Promise.allSettled(list.map((dev) => fn(dev, notes)));
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') applied.push(list[i].id);
            else {
                const e = normaliseError(r.reason);
                errors.push(e);
                skipped.push(e.message && e.message !== e.code ? { id: list[i].id, reason: e.code, message: String(e.message).slice(0, 200) } : { id: list[i].id, reason: e.code });
            }
        });
        return { applied, skipped, notes: notes.filter((n) => applied.includes(n.id)), errors };
    }

    function finish(out, action) {
        emitIfChanged();
        log('info', 'Light action', { action, applied: out.applied.length, skipped: out.skipped.length });
        if (!out.applied.length) {
            const e = out.errors[0] || codeError('no_lights');
            throw e;
        }
        return { applied: out.applied, skipped: out.skipped, notes: out.notes };
    }

    function colourParam(v, { strict }) {
        if (v === undefined || v === null || v === '') return null;
        const c = parseColor(String(v));
        if (!c) throw codeError('bad_color', 'That colour could not be read');
        if (strict && c.kelvin) return { kelvin: c.kelvin };
        return c;
    }
    function brightnessParam(v) {
        const b = toInt(v, null);
        return b === null ? null : clamp(b, 0, 100);
    }
    const durationParam = (v) => clamp(toInt(v, 0) ?? 0, 0, 600000);

    /** A wanted state from set/color/white/brightness params. */
    function wantFrom(p, { colour = null, kelvin = null }) {
        const want = { on: true };
        const b = brightnessParam(p.brightness);
        if (b === 0) return { on: false };
        if (b !== null) want.brightness = b;
        if (colour?.rgb) want.color = colour.rgb;
        else if (colour?.kelvin) want.kelvin = colour.kelvin;
        if (Number.isFinite(kelvin)) want.kelvin = kelvin;
        return want;
    }

    async function applyWant(devs, want, durationMs) {
        return each(devs, async (dev, notes) => {
            const s = adapt(dev, want, notes);
            const d = driverOf(dev);
            if (durationMs > 0) {
                const job = await beginTemp(dev);
                await d.setState(dev.id, s);
                if (jobs.get(dev.id) === job) schedule(job, durationMs, () => restoreNow(dev, job));
            } else {
                cancelJob(dev.id);
                await d.setState(dev.id, s);
            }
        });
    }

    async function flash(devs, p) {
        const colour = colourParam(p.color, { strict: false }) || { rgb: { r: 255, g: 255, b: 255 } };
        const b = brightnessParam(p.brightness) || 100;
        const times = clamp(toInt(p.times, 3), 1, 20);
        const period = clamp(toInt(p.periodMs, 1000), 200, 5000);
        const pulse = p.mode === 'pulse';
        const half = Math.round(period / 2);
        const bright = { on: true, brightness: b, ...(colour.rgb ? { color: colour.rgb } : { kelvin: colour.kelvin }) };
        const dim = pulse ? { on: true, brightness: Math.max(1, Math.round(b * 0.15)) } : { on: false };
        return each(devs, async (dev, notes) => {
            const sOn = adapt(dev, bright, notes);
            const sOff = adapt(dev, dim, []);
            const d = driverOf(dev);
            const job = await beginTemp(dev);
            await d.setState(dev.id, sOn);
            if (jobs.get(dev.id) !== job) return;
            const step = (s) => () => d.setState(dev.id, s).catch((e) => log('info', 'A flash step failed', { id: dev.id, code: e.code }));
            schedule(job, half, step(sOff));
            for (let i = 1; i < times; i++) {
                schedule(job, i * period, step(sOn));
                schedule(job, i * period + half, step(sOff));
            }
            schedule(job, times * period, () => restoreNow(dev, job));
        });
    }

    async function run(action, params = {}) {
        if (closed) throw codeError('driver_error', 'Lights are closed');
        const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
        switch (action) {
        case 'light.set':
        case 'light.color': {
            const colour = colourParam(p.color, { strict: false });
            if (action === 'light.color' && !colour) throw codeError('bad_color', 'Choose a colour');
            const want = wantFrom(p, { colour });
            if (want.on === true && !want.color && !Number.isFinite(want.kelvin) && !Number.isFinite(want.brightness) && action === 'light.set' && p.color == null && p.brightness == null) throw codeError('bad_params', 'Choose a colour or a brightness');
            return finish(await applyWant(await targets(p.device), want, durationParam(p.durationMs)), action);
        }
        case 'light.white': {
            const k = toInt(p.kelvin, null);
            if (k === null) throw codeError('bad_params', 'Choose a white (kelvin)');
            const want = wantFrom(p, { kelvin: clamp(k, 1000, 12000) });
            return finish(await applyWant(await targets(p.device), want, durationParam(p.durationMs)), action);
        }
        case 'light.brightness': {
            const b = brightnessParam(p.brightness);
            if (b === null) throw codeError('bad_params', 'Choose a brightness');
            const want = b === 0 ? { on: false } : { on: true, brightness: b };
            return finish(await applyWant(await targets(p.device), want, durationParam(p.durationMs)), action);
        }
        case 'light.power': {
            const state = ['on', 'off', 'toggle'].includes(p.state) ? p.state : null;
            if (!state) throw codeError('bad_params', 'Choose on, off or toggle');
            const devs = await targets(p.device);
            return finish(await each(devs, async (dev) => {
                const d = driverOf(dev);
                let on = state === 'on';
                if (state === 'toggle') on = !(await d.getState(dev.id)).on;
                cancelJob(dev.id);
                await d.setState(dev.id, { on });
            }), action);
        }
        case 'light.scene': {
            const name = typeof p.scene === 'string' ? p.scene.trim().slice(0, 80) : '';
            if (!name) throw codeError('bad_params', 'Choose a scene');
            const ms = durationParam(p.durationMs);
            const devs = await targets(p.device, { allowBridge: true });
            return finish(await each(devs, async (dev) => {
                const d = driverOf(dev);
                if (!d.scene) throw codeError('not_supported', 'Scenes are not available for this light here');
                if (ms > 0 && dev.kind !== 'bridge') {
                    const job = await beginTemp(dev);
                    await d.scene(dev.id, name, { transitionMs: 0 });
                    if (jobs.get(dev.id) === job) schedule(job, ms, () => restoreNow(dev, job));
                } else {
                    cancelJob(dev.id);
                    await d.scene(dev.id, name, { transitionMs: 0 });
                }
            }), action);
        }
        case 'light.flash':
            return finish(await flash(await targets(p.device), p), action);
        case 'light.preset': {
            const entries = Array.isArray(p.lights) ? p.lights.slice(0, MAX_PRESET) : [];
            if (!entries.length) throw codeError('bad_params', 'The preset has no lights');
            const total = { applied: [], skipped: [], notes: [], errors: [] };
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') continue;
                let devs;
                try { devs = await targets(entry.device, { allowBridge: !!entry.scene }); } catch (e) {
                    const n = normaliseError(e);
                    total.errors.push(n);
                    total.skipped.push({ id: String(entry.device || 'all').slice(0, 120), reason: n.code });
                    continue;
                }
                let r;
                if (typeof entry.scene === 'string' && entry.scene.trim()) {
                    const name = entry.scene.trim().slice(0, 80);
                    r = await each(devs, async (dev) => {
                        const d = driverOf(dev);
                        if (!d.scene) throw codeError('not_supported', 'Scenes are not available for this light here');
                        cancelJob(dev.id);
                        await d.scene(dev.id, name, {});
                    });
                } else if (entry.power === 'off' || entry.power === false) {
                    r = await applyWant(devs, { on: false }, 0);
                } else {
                    let colour;
                    try { colour = colourParam(entry.color, { strict: false }); } catch (e) {
                        total.errors.push(e);
                        for (const d of devs) total.skipped.push({ id: d.id, reason: 'bad_color' });
                        continue;
                    }
                    const k = toInt(entry.kelvin, null);
                    r = await applyWant(devs, wantFrom(entry, { colour, kelvin: k === null ? null : clamp(k, 1000, 12000) }), 0);
                }
                total.applied.push(...r.applied); total.skipped.push(...r.skipped); total.notes.push(...r.notes); total.errors.push(...r.errors);
            }
            return finish(total, action);
        }
        default:
            throw codeError('unsupported_action');
        }
    }

    async function test(id) {
        return run('light.flash', { device: String(id || ''), color: '#b4e04f', brightness: 100, times: 1, periodMs: 800, mode: 'flash' });
    }

    function close() {
        closed = true;
        for (const job of jobs.values()) clearTimers(job);
        jobs.clear();
        for (const d of live.values()) { try { d.close?.(); } catch { /* already closed */ } }
        listeners.clear();
    }

    lastSig = signature(list());
    return {
        discover,
        notes: () => lastNotes.slice(),
        list,
        onChange(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
        addManual,
        pair,
        forget,
        run,
        test,
        handles: (action) => ACTIONS.includes(action),
        close,
        pendingRestores: () => jobs.size,
    };
}

module.exports = { createLights, ACTIONS, DRIVER_NAMES, BRAND_GREEN };
