/*
 * Stream bot devices: what CertiFried Studio reports about the PC's lights, Voicemeeter and the Stream Deck bridge,
 * inside its `state` frame as `devices`. Pure.
 *
 *   sanitiseDevices(raw) → { lights: [...], voicemeeter: {...} | null, streamdeck: {...} | null } | null
 *
 * Kept: ids, names, models, what each light can do, scene names, online state; Voicemeeter's type, strip and bus labels and
 * settings file names; whether the Stream Deck bridge is on and how many keys pads are connected. Dropped: network addresses,
 * serial-number paths and anything else, so the dashboard and the profile's settings never hold a LAN address.
 * Limits: 200 lights, names 100 characters, 100 scenes and effects per light (60 characters), 8 strips and 8 buses,
 * 100 settings files, about 24 KB in all (scene lists are given up first).
 * Tested in tests/stream-bot-devices.test.js.
 */
import { DEVICE_ID } from './catalog.js';

export const DEVICE_STATE_LIMITS = Object.freeze({ lights: 200, name: 100, scenes: 100, scene: 60, profiles: 100, bytes: 24 * 1024 });
// goveeble: Govee over Bluetooth (Studio 0.2.11), with cloudId when it is also one of the streamer's Govee cloud lights.
const DRIVERS = new Set(['govee', 'hue', 'lifx', 'nanoleaf', 'elgato', 'litra', 'goveeble']);
const clean = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const list = (v, max, each) => [...new Set((Array.isArray(v) ? v : []).map((x) => clean(x, each)).filter(Boolean))].slice(0, max);
const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

function light(l) {
    if (!l || typeof l !== 'object') return null;
    const id = clean(l.id, 160);
    if (!DEVICE_ID.test(id) || id === 'all' || /-cloud:/.test(id)) return null;
    const driver = clean(l.driver, 12);
    if (!DRIVERS.has(driver) || !id.startsWith(`${driver}:`)) return null;
    const c = l.caps && typeof l.caps === 'object' ? l.caps : {};
    const white = c.white && typeof c.white === 'object' && int(c.white.min, 1000, 12000) && int(c.white.max, 1000, 12000)
        ? { min: int(c.white.min, 1000, 12000), max: int(c.white.max, 1000, 12000) } : null;
    return {
        id, driver, name: clean(l.name, DEVICE_STATE_LIMITS.name) || id, model: clean(l.model, 60) || null,
        online: l.online === true, needsPairing: l.needsPairing === true, kind: ['light', 'group', 'bridge'].includes(l.kind) ? l.kind : 'light',
        ...(driver === 'goveeble' && /^govee-cloud:[A-Za-z0-9:]{1,80}$/.test(String(l.cloudId || '')) ? { cloudId: String(l.cloudId) } : {}),
        caps: { power: c.power !== false, brightness: c.brightness === true, color: c.color === true, white,
            scenes: list(c.scenes, DEVICE_STATE_LIMITS.scenes, DEVICE_STATE_LIMITS.scene), effects: list(c.effects, DEVICE_STATE_LIMITS.scenes, DEVICE_STATE_LIMITS.scene) },
    };
}

function voicemeeter(v) {
    if (!v || typeof v !== 'object') return null;
    const type = ['basic', 'banana', 'potato'].includes(v.type) ? v.type : null;
    const lanes = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({ index: int(x?.index, 0, 7), label: clean(x?.label, 60) }))
        .filter((x) => x.index !== null).slice(0, 8);
    return {
        enabled: v.enabled === true, installed: v.installed === true, running: v.running === true, type, version: clean(v.version, 20) || null,
        strips: lanes(v.strips), buses: lanes(v.buses), macroButtons: v.macroButtons === true,
        profiles: list(v.profiles, DEVICE_STATE_LIMITS.profiles, 120).filter((p) => /\.xml$/i.test(p) && !/[\\/]/.test(p)),
    };
}

function streamdeck(s) {
    if (!s || typeof s !== 'object') return null;
    return { enabled: s.enabled === true, clients: int(s.clients, 0, 8) ?? 0 };
}

export function sanitiseDevices(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const seen = new Set();
    const lights = [];
    for (const l of Array.isArray(raw.lights) ? raw.lights : []) {
        const x = light(l);
        if (!x || seen.has(x.id)) continue;
        seen.add(x.id);
        lights.push(x);
        if (lights.length >= DEVICE_STATE_LIMITS.lights) break;
    }
    const out = { lights, voicemeeter: voicemeeter(raw.voicemeeter), streamdeck: streamdeck(raw.streamdeck) };
    const size = () => Buffer.byteLength(JSON.stringify(out));
    if (size() > DEVICE_STATE_LIMITS.bytes) for (const l of out.lights) { l.caps.scenes = l.caps.scenes.slice(0, 20); l.caps.effects = l.caps.effects.slice(0, 20); }
    if (size() > DEVICE_STATE_LIMITS.bytes) for (const l of out.lights) { l.caps.scenes = []; l.caps.effects = []; }
    if (size() > DEVICE_STATE_LIMITS.bytes) out.lights = out.lights.slice(0, 50);
    return out;
}

export default { sanitiseDevices, DEVICE_STATE_LIMITS };
