'use strict';
/*
 * The device sandbox: mock endpoints for tests and packaged test launches, so nothing reaches the real LAN or real USB.
 *
 *   loadSandbox(env = process.env, { logger?, readFile? }) → null | sandbox
 *   fakeHid(record?)        an in-memory node-hid replacement with a fake Litra Glow and Litra Beam
 *   makeRecorder(file)      record(entry): appends { t, ...entry } to a JSON array file (what the fakes were asked to do)
 *   SANDBOX_ENV             'CF_STUDIO_DEVICE_SANDBOX'
 *
 * CF_STUDIO_DEVICE_SANDBOX is a path to a JSON file:
 *   { "govee":   { "host": "127.0.0.1", "scanPort": 14001, "listenPort": 14002, "controlPort": 14003 },
 *     "hue":     [ { "address": "127.0.0.1:18443" } ],
 *     "lifx":    { "host": "127.0.0.1", "port": 15670 },
 *     "nanoleaf":[ { "address": "127.0.0.1:16021" } ],
 *     "elgato":  [ { "address": "127.0.0.1:19123" } ],
 *     "litra":   "fake",
 *     "voicemeeter": "fake",
 *     "recordFile": "C:\\...\\sandbox-record.json" }
 * Returned shape: { govee: {...}|null, hue: [{ host, port }], lifx: {...}|null, nanoleaf: [...], elgato: [...],
 *   litra: 'fake'|null, voicemeeter: 'fake'|null, recordFile: string|null, record(entry), invalid: bool }.
 * A driver missing from the file is simply absent (no devices of that kind; never the real ones).
 *
 * Every host must be 127.0.0.1. When the file cannot be read or anything in it is not 127.0.0.1, the error is logged
 * and a closed sandbox is returned instead (invalid: true, no endpoints, fake HID and Voicemeeter): with the variable
 * set, the app never falls back to the real devices.
 */
const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_ENV = 'CF_STUDIO_DEVICE_SANDBOX';
const LOOPBACK = '127.0.0.1';
const MAX_LIST = 20;

function isPort(v) { return Number.isInteger(v) && v >= 1 && v <= 65535; }

function bad(msg) { const e = new Error(msg); e.code = 'sandbox_invalid'; return e; }

function parseLoopbackAddress(text) {
    const m = typeof text === 'string' ? text.trim().match(/^([0-9.]+):(\d{1,5})$/) : null;
    if (!m) throw bad('an address must be 127.0.0.1:<port>');
    if (m[1] !== LOOPBACK) throw bad('only 127.0.0.1 is allowed');
    const port = Number(m[2]);
    if (!isPort(port)) throw bad('bad port');
    return { host: LOOPBACK, port };
}

function addressList(v, name) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw bad(`${name} must be a list`);
    return v.slice(0, MAX_LIST).map((e) => parseLoopbackAddress(e?.address));
}

function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('not an object');
    const out = { govee: null, hue: [], lifx: null, nanoleaf: [], elgato: [], litra: null, voicemeeter: null, recordFile: null };
    if (raw.govee != null) {
        const g = raw.govee;
        if (g.host !== LOOPBACK) throw bad('govee.host must be 127.0.0.1');
        for (const k of ['scanPort', 'listenPort', 'controlPort']) if (!isPort(g[k])) throw bad(`govee.${k} must be a port`);
        out.govee = { host: LOOPBACK, scanPort: g.scanPort, listenPort: g.listenPort, controlPort: g.controlPort };
    }
    if (raw.lifx != null) {
        if (raw.lifx.host !== LOOPBACK) throw bad('lifx.host must be 127.0.0.1');
        if (!isPort(raw.lifx.port)) throw bad('lifx.port must be a port');
        out.lifx = { host: LOOPBACK, port: raw.lifx.port };
    }
    out.hue = addressList(raw.hue, 'hue');
    out.nanoleaf = addressList(raw.nanoleaf, 'nanoleaf');
    out.elgato = addressList(raw.elgato, 'elgato');
    if (raw.litra != null && raw.litra !== 'fake') throw bad('litra must be "fake"');
    if (raw.voicemeeter != null && raw.voicemeeter !== 'fake') throw bad('voicemeeter must be "fake"');
    out.litra = raw.litra === 'fake' ? 'fake' : null;
    out.voicemeeter = raw.voicemeeter === 'fake' ? 'fake' : null;
    if (raw.recordFile != null) {
        if (typeof raw.recordFile !== 'string' || !path.isAbsolute(raw.recordFile) || raw.recordFile.length > 400) throw bad('recordFile must be an absolute path');
        out.recordFile = raw.recordFile;
    }
    return out;
}

function makeRecorder(file) {
    if (!file) return () => {};
    return (entry) => {
        try {
            let list = [];
            try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
            if (!Array.isArray(list)) list = [];
            list.push({ t: new Date().toISOString(), ...entry });
            if (list.length > 5000) list = list.slice(-5000);
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8');
            fs.renameSync(tmp, file);
        } catch { /* the record is a test aid; never break the app over it */ }
    };
}

function loadSandbox(env = process.env, { logger = null, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
    const file = env?.[SANDBOX_ENV];
    if (!file) return null;
    let sb;
    try {
        sb = validate(JSON.parse(readFile(String(file))));
        sb.invalid = false;
    } catch (e) {
        logger?.error?.('The device sandbox file was refused; no real devices will be used', { error: String(e?.message || e).slice(0, 160) });
        sb = { govee: null, hue: [], lifx: null, nanoleaf: [], elgato: [], litra: 'fake', voicemeeter: 'fake', recordFile: null, invalid: true };
    }
    sb.record = makeRecorder(sb.recordFile);
    logger?.info?.('Device sandbox is on: only the mock devices on 127.0.0.1 are used', { invalid: sb.invalid });
    return sb;
}

/* ---------- fake node-hid with two Litra lights ---------- */

const FAKE_LITRAS = [
    { path: 'fake-hid://litra-glow', serialNumber: 'FAKEGLOW0001', productId: 0xc900, product: 'Litra Glow', minLm: 20, maxLm: 250, feature: 0x04 },
    { path: 'fake-hid://litra-beam', serialNumber: 'FAKEBEAM0001', productId: 0xc901, product: 'Litra Beam', minLm: 30, maxLm: 400, feature: 0x04 },
];

/**
 * fakeHid(record?) → { devices(), HID, state(path), writes, unplug(path), plug(path) }
 * HID(path): write(bytes) → length; readTimeout(ms) → the queued answer or []; read(); close(). Writes are recorded as
 * { device: 'litra', path, report: 'hex' }. Answers mirror the real light: report id 0x11, bytes 2-3 echoed, value at 4..5.
 */
function fakeHid(record) {
    const rec = typeof record === 'function' ? record : Array.isArray(record) ? (e) => record.push(e) : () => {};
    const state = new Map(FAKE_LITRAS.map((d) => [d.path, { on: false, lumen: d.minLm, kelvin: 4000, plugged: true, spec: d }]));
    const writes = [];
    let opened = 0;

    class HID {
        constructor(p) {
            const s = state.get(p);
            if (!s || !s.plugged) throw new Error('cannot open device with path ' + String(p).slice(0, 60));
            this.path = p;
            this.queue = [];
            this.closed = false;
            opened++;
        }
        write(bytes) {
            const s = state.get(this.path);
            if (this.closed || !s.plugged) throw new Error('Cannot write to hid device');
            const b = Array.from(bytes || []).map((v) => Number(v) & 0xff);
            writes.push({ path: this.path, bytes: b });
            rec({ device: 'litra', path: this.path, report: Buffer.from(b).toString('hex') });
            if (b[0] !== 0x11 || b[1] !== 0xff || b[2] !== s.spec.feature) return b.length;
            const fn = b[3];
            const answer = (v4, v5) => { const r = new Array(20).fill(0); r[0] = 0x11; r[1] = 0xff; r[2] = s.spec.feature; r[3] = fn; r[4] = v4 & 0xff; r[5] = v5 & 0xff; this.queue.push(r); };
            if (fn === 0x1c) s.on = b[4] === 1;
            else if (fn === 0x4c) s.lumen = Math.min(s.spec.maxLm, Math.max(s.spec.minLm, (b[4] << 8) | b[5]));
            else if (fn === 0x9c) s.kelvin = Math.min(6500, Math.max(2700, (b[4] << 8) | b[5]));
            else if (fn === 0x01) answer(s.on ? 1 : 0, 0);
            else if (fn === 0x31) answer(s.lumen >> 8, s.lumen);
            else if (fn === 0x81) answer(s.kelvin >> 8, s.kelvin);
            return b.length;
        }
        readTimeout() { return this.closed ? [] : this.queue.shift() || []; }
        read() { return this.readTimeout(0); }
        close() { this.closed = true; }
    }

    return {
        HID,
        devices: () => FAKE_LITRAS.filter((d) => state.get(d.path).plugged).map((d) => ({
            vendorId: 0x046d, productId: d.productId, path: d.path, serialNumber: d.serialNumber, manufacturer: 'Logitech', product: d.product, usagePage: 0xff43, usage: 0x0202, interface: 0,
        })),
        state: (p) => { const s = state.get(p); return s ? { on: s.on, lumen: s.lumen, kelvin: s.kelvin, plugged: s.plugged } : null; },
        unplug: (p) => { const s = state.get(p); if (s) s.plugged = false; },
        plug: (p) => { const s = state.get(p); if (s) s.plugged = true; },
        writes,
        get opened() { return opened; },
        paths: FAKE_LITRAS.map((d) => d.path),
    };
}

module.exports = { loadSandbox, fakeHid, makeRecorder, SANDBOX_ENV };
