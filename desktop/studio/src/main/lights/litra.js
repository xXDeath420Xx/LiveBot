'use strict';
/*
 * Logitech Litra Glow / Beam / Beam LX over USB HID (node-hid, injected).
 *
 *   createLitraDriver({ logger, sandbox, hid, readTimeoutMs }) → { id: 'litra', discover, list, restore, getState, setState, close }
 *
 * Devices: vendor 0x046d; Glow 0xc900 (20-250 lm), Beam 0xc901 (30-400 lm), Beam LX 0xb901 (30-400 lm). Only the HID
 * interface on usage page 0xff43 is used when node-hid reports usage pages (the others are not the light's control).
 * Reports are HID++ long reports, 20 bytes, report id 0x11, device index 0xff, feature index 0x04 (0x06 on the Beam LX,
 * as in timrogers/litra-rs), then the function byte:
 *   power        11 ff 04 1c 01|00
 *   brightness   11 ff 04 4c <lumen hi> <lumen lo>     (0-100 % mapped onto the model's lumen range)
 *   temperature  11 ff 04 9c <kelvin hi> <kelvin lo>   (2700-6500 K, steps of 100)
 *   reads        11 ff 04 01 (power) / 31 (brightness) / 81 (temperature); the answer echoes bytes 2-3, value at 4..5
 * No colour: colour requests are turned into the nearest white by the manager. The Beam LX back light is left out.
 * Reads skip unrelated input reports (button notifications) by matching the echoed feature and function bytes.
 *
 * Which HID implementation: an injected `hid` wins; with a sandbox, the in-process fake from sandbox.js when the sandbox
 * says "litra": "fake", otherwise none; with neither, node-hid itself (loaded on first use). Handles are opened lazily
 * and closed in close().
 */
const crypto = require('node:crypto');
const { codeError, clamp, safeId } = require('./util');

const VENDOR_ID = 0x046d;
const USAGE_PAGE = 0xff43;
const MODELS = Object.freeze({
    0xc900: { model: 'Litra Glow', minLm: 20, maxLm: 250, feature: 0x04 },
    0xc901: { model: 'Litra Beam', minLm: 30, maxLm: 400, feature: 0x04 },
    0xb901: { model: 'Litra Beam LX', minLm: 30, maxLm: 400, feature: 0x06 },
});
const FN = Object.freeze({ setPower: 0x1c, setBrightness: 0x4c, setTemperature: 0x9c, getPower: 0x01, getBrightness: 0x31, getTemperature: 0x81 });
const KELVIN = Object.freeze({ min: 2700, max: 6500 });

function report(feature, fn, b4 = 0, b5 = 0) {
    const r = new Array(20).fill(0);
    r[0] = 0x11; r[1] = 0xff; r[2] = feature; r[3] = fn; r[4] = b4 & 0xff; r[5] = b5 & 0xff;
    return r;
}

function pctToLumen(spec, pct) {
    const p = clamp(Math.round(pct), 1, 100);
    return Math.round(spec.minLm + ((spec.maxLm - spec.minLm) * (p - 1)) / 99);
}
function lumenToPct(spec, lm) {
    return clamp(Math.round(1 + ((clamp(lm, spec.minLm, spec.maxLm) - spec.minLm) * 99) / (spec.maxLm - spec.minLm)), 1, 100);
}
function roundKelvin(k) { return clamp(Math.round(clamp(k, KELVIN.min, KELVIN.max) / 100) * 100, KELVIN.min, KELVIN.max); }

function idFor(d) {
    const serial = typeof d.serialNumber === 'string' ? d.serialNumber.trim() : '';
    if (serial && /^[A-Za-z0-9._-]{4,64}$/.test(serial)) return `litra:${safeId(serial)}`;
    return `litra:${crypto.createHash('sha256').update(String(d.path)).digest('hex').slice(0, 16)}`;
}

function createLitraDriver({ logger = null, sandbox = null, hid = null, readTimeoutMs = 120 } = {}) {
    const devices = new Map();   // id → { dev, path, spec, handle }
    let impl = hid;
    let implResolved = !!hid;
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };

    function getImpl() {
        if (implResolved) return impl;
        implResolved = true;
        if (sandbox) {
            impl = sandbox.litra === 'fake' ? require('../sandbox').fakeHid(sandbox.record) : null;
        } else {
            try { impl = require('node-hid'); } catch (e) {
                impl = null;
                log('warn', 'USB light support (node-hid) could not be loaded', { error: String(e?.message || e).slice(0, 120) });
            }
        }
        return impl;
    }

    function enumerate() {
        const h = getImpl();
        if (!h) return [];
        let list = [];
        try { list = h.devices() || []; } catch (e) { log('warn', 'Could not list USB devices', { error: String(e?.message || e).slice(0, 120) }); return []; }
        return list.filter((d) => d && d.vendorId === VENDOR_ID && MODELS[d.productId] && typeof d.path === 'string'
            && (d.usagePage === undefined || d.usagePage === USAGE_PAGE)).slice(0, 16);
    }

    function publicDevice(id, d, spec, online) {
        return {
            id, driver: 'litra', name: spec.model, model: spec.model, address: null, online,
            caps: { power: true, brightness: true, color: false, white: { ...KELVIN }, scenes: [], effects: [] },
            needsPairing: false, kind: 'light',
        };
    }

    function closeHandle(rec) {
        if (rec?.handle) { try { rec.handle.close(); } catch { /* already gone */ } rec.handle = null; }
    }

    function scan() {
        const found = enumerate();
        const seen = new Set();
        for (const d of found) {
            const id = idFor(d);
            seen.add(id);
            const spec = MODELS[d.productId];
            const rec = devices.get(id);
            if (rec) {
                // Keep the same record object (callers may hold it); a new path means it was plugged in again.
                if (rec.path !== d.path) { closeHandle(rec); rec.path = d.path; }
                rec.spec = spec;
                rec.dev = publicDevice(id, d, spec, true);
            } else {
                devices.set(id, { dev: publicDevice(id, d, spec, true), path: d.path, spec, handle: null });
            }
        }
        for (const [id, rec] of devices) if (!seen.has(id)) { closeHandle(rec); rec.path = null; rec.dev.online = false; }
        return [...devices.values()].filter((r) => r.dev.online).map((r) => ({ ...r.dev }));
    }

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string' || devices.has(entry.id)) return;
        const spec = Object.values(MODELS).find((m) => m.model === entry.model) || MODELS[0xc900];
        devices.set(entry.id, { dev: { ...publicDevice(entry.id, {}, spec, false), name: String(entry.name || spec.model).slice(0, 80) }, path: null, spec, handle: null });
    }

    function rec(id) {
        const r = devices.get(id);
        if (!r) throw codeError('device_not_found');
        return r;
    }

    function open(r) {
        if (r.handle) return r.handle;
        if (!r.path) {
            scan();
            if (!r.path) throw codeError('device_unreachable', 'The Litra is not plugged in');
        }
        const h = getImpl();
        if (!h) throw codeError('device_unreachable', 'USB light support is not available');
        try { r.handle = new h.HID(r.path); } catch {
            r.dev.online = false;
            throw codeError('device_unreachable', 'Could not open the Litra (is it plugged in, or used by Logitech G HUB?)');
        }
        return r.handle;
    }

    function write(r, bytes) {
        const handle = open(r);
        try {
            const n = handle.write(bytes);
            if (typeof n === 'number' && n <= 0) throw new Error('short write');
            r.dev.online = true;
        } catch {
            closeHandle(r);
            r.dev.online = false;
            throw codeError('device_unreachable', 'Could not send to the Litra');
        }
    }

    function query(r, fn) {
        write(r, report(r.spec.feature, fn));
        for (let i = 0; i < 6; i++) {
            let data;
            try { data = r.handle.readTimeout(readTimeoutMs); } catch { closeHandle(r); throw codeError('device_unreachable', 'Could not read from the Litra'); }
            if (!data || !data.length) break;
            if (data[0] === 0x11 && data[2] === r.spec.feature && data[3] === fn) return [data[4] ?? 0, data[5] ?? 0];
        }
        throw codeError('device_unreachable', 'The Litra did not answer a read');
    }

    async function getState(id) {
        const r = rec(id);
        const [p] = query(r, FN.getPower);
        const [bh, bl] = query(r, FN.getBrightness);
        const [th, tl] = query(r, FN.getTemperature);
        const kelvin = (th << 8) | tl;
        return { on: p === 1, brightness: lumenToPct(r.spec, (bh << 8) | bl), color: null, kelvin: kelvin >= 1000 ? roundKelvin(kelvin) : null };
    }

    async function setState(id, s = {}) {
        const r = rec(id);
        if (s.color && !Number.isFinite(s.kelvin)) throw codeError('not_supported', 'The Litra has no colour');
        if (s.on === true) write(r, report(r.spec.feature, FN.setPower, 1));
        if (Number.isFinite(s.kelvin)) { const k = roundKelvin(s.kelvin); write(r, report(r.spec.feature, FN.setTemperature, k >> 8, k)); }
        if (Number.isFinite(s.brightness)) { const lm = pctToLumen(r.spec, s.brightness); write(r, report(r.spec.feature, FN.setBrightness, lm >> 8, lm)); }
        if (s.on === false) write(r, report(r.spec.feature, FN.setPower, 0));
    }

    function close() { for (const r of devices.values()) closeHandle(r); }

    return {
        id: 'litra',
        discover: async () => scan(),
        list: () => [...devices.values()].map((r) => ({ ...r.dev })),
        restore,
        getState,
        setState,
        close,
    };
}

module.exports = { createLitraDriver, MODELS, FN, KELVIN, VENDOR_ID, USAGE_PAGE, report, pctToLumen, lumenToPct };
