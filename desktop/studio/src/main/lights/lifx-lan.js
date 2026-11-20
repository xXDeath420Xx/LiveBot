'use strict';
/*
 * LIFX lights over the LIFX LAN protocol (binary UDP, port 56700).
 *
 *   createLifxDriver({ logger, sandbox, transports, replyTimeoutMs, retries })
 *     → { id: 'lifx', discover, list, restore, addManual, getState, setState, close }
 *
 * Every packet starts with a 36-byte little-endian header (lan.developer.lifx.com, "Encoding a packet"):
 *   0 size u16 | 2 protocol 1024 (12 bits) + addressable (bit 12) + tagged (bit 13) + origin 0 | 4 source u32
 *   8 target: 6-byte MAC + 2 zero bytes | 16 reserved 6 | 22 bit0 res_required, bit1 ack_required | 23 sequence u8
 *   24 reserved 8 | 32 type u16 | 34 reserved 2
 * Messages used: GetService (2) → StateService (3: service u8, port u32) for discovery (tagged, target 0);
 * Get (101) → LightState (107: hue, saturation, brightness, kelvin u16, 2 reserved, power u16, label 32 bytes, 8 reserved);
 * SetColor (102: reserved u8, HSBK u16 x4, duration u32 ms); SetPower (117: level u16 0|65535, duration u32);
 * Acknowledgement (45). Sets ask for an ack; replies are matched on source + sequence (+ target).
 * Pulses are done by the manager with plain set and restore (SetWaveformOptional is not used). LIFX scenes are cloud
 * only, so scenes are not supported here. Kelvin 1500-9000.
 *
 * Endpoints: the sandbox's `lifx` block (unicast to it, never broadcast) when a sandbox is set, else transports.lifx,
 * else broadcast to 255.255.255.255:56700. One UDP socket on an ephemeral port, opened on first use, closed in close().
 */
const crypto = require('node:crypto');
const { codeError, clamp, guardHost, isLanIPv4, parseAddress, sleep } = require('./util');
const { rgbToHsv, hsvToRgb } = require('./color');

const PORT = 56700;
const T = Object.freeze({ GetService: 2, StateService: 3, Ack: 45, Get: 101, SetColor: 102, State: 107, SetPower: 117 });
const WHITE = Object.freeze({ min: 1500, max: 9000 });
const PROD = Object.freeze({ host: '255.255.255.255', port: PORT, broadcast: true, bind: '0.0.0.0' });

function encode({ type, tagged = false, target = null, source, sequence, ack = false, res = false, payload = Buffer.alloc(0) }) {
    const buf = Buffer.alloc(36 + payload.length);
    buf.writeUInt16LE(buf.length, 0);
    buf.writeUInt16LE(1024 | 0x1000 | (tagged ? 0x2000 : 0), 2);
    buf.writeUInt32LE(source >>> 0, 4);
    if (target) Buffer.from(target).copy(buf, 8, 0, 6);
    buf.writeUInt8((res ? 1 : 0) | (ack ? 2 : 0), 22);
    buf.writeUInt8(sequence & 0xff, 23);
    buf.writeUInt16LE(type, 32);
    payload.copy(buf, 36);
    return buf;
}

function decode(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 36 || buf.length > 1024) return null;
    if (buf.readUInt16LE(0) !== buf.length) return null;
    if ((buf.readUInt16LE(2) & 0x0fff) !== 1024) return null;
    return {
        source: buf.readUInt32LE(4),
        target: buf.subarray(8, 14).toString('hex'),
        sequence: buf.readUInt8(23),
        type: buf.readUInt16LE(32),
        payload: buf.subarray(36),
    };
}

function parseState(p) {
    if (!p || p.length < 52) return null;
    const label = p.subarray(12, 44).toString('utf8').replace(/\0.*$/s, '').trim();
    return { hue: p.readUInt16LE(0), sat: p.readUInt16LE(2), bri: p.readUInt16LE(4), kelvin: p.readUInt16LE(6), power: p.readUInt16LE(10), label };
}

function setColorPayload({ hue, sat, bri, kelvin }, duration) {
    const p = Buffer.alloc(13);
    p.writeUInt16LE(hue & 0xffff, 1); p.writeUInt16LE(sat & 0xffff, 3); p.writeUInt16LE(bri & 0xffff, 5);
    p.writeUInt16LE(clamp(kelvin, WHITE.min, WHITE.max), 7); p.writeUInt32LE(clamp(duration, 0, 600000) >>> 0, 9);
    return p;
}
function setPowerPayload(on, duration) {
    const p = Buffer.alloc(6);
    p.writeUInt16LE(on ? 65535 : 0, 0); p.writeUInt32LE(clamp(duration, 0, 600000) >>> 0, 2);
    return p;
}

function createLifxDriver({ logger = null, sandbox = null, transports = {}, replyTimeoutMs = 500, retries = 2 } = {}) {
    const dgram = transports.dgram || require('node:dgram');
    const ep = sandbox ? (sandbox.lifx ? { ...sandbox.lifx, broadcast: false, bind: '127.0.0.1' } : null) : { ...PROD, ...(transports.lifx || {}) };
    const source = (crypto.randomBytes(4).readUInt32LE(0) | 2) >>> 0;   // never 0 or 1 (those mean "broadcast replies")
    const devices = new Map();     // id → { dev, mac, host, port }
    const pending = new Map();     // sequence → { onReply(msg, rinfo) }
    let seq = 0;
    let socket = null;
    let opening = null;
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };

    function ensureSocket() {
        if (!ep) return Promise.reject(codeError('device_unreachable', 'LIFX is not part of the device sandbox'));
        if (socket) return Promise.resolve(socket);
        if (opening) return opening;
        opening = new Promise((resolve, reject) => {
            const s = dgram.createSocket({ type: 'udp4' });
            const fail = (e) => { opening = null; try { s.close(); } catch { /* not open */ } reject(codeError('driver_error', `Could not open the LIFX socket (${String(e?.code || 'error').slice(0, 30)})`)); };
            s.once('error', fail);
            s.on('message', (buf, rinfo) => {
                const msg = decode(buf);
                if (!msg || msg.source !== source) return;
                const p = pending.get(msg.sequence);
                if (p) p.onReply(msg, rinfo);
            });
            s.bind(0, ep.bind, () => {
                s.removeListener('error', fail);
                s.on('error', (e) => log('warn', 'LIFX socket error', { error: String(e?.code || e?.message).slice(0, 60) }));
                socket = s;
                opening = null;
                resolve(s);
            });
        });
        return opening;
    }

    function nextSeq() {
        for (let i = 0; i < 256; i++) { seq = (seq + 1) & 0xff; if (!pending.has(seq)) return seq; }
        throw codeError('driver_error', 'Too many LIFX requests at once');
    }

    function send(buf, host, port) {
        guardHost(sandbox, host);
        return new Promise((resolve, reject) => socket.send(buf, port, host, (e) => (e ? reject(codeError('device_unreachable', 'Could not send to the LIFX light')) : resolve())));
    }

    /** One request to one light; resolves with the reply of `want` type (or the ack). */
    async function request(r, type, payload, want) {
        await ensureSocket();
        const sequence = nextSeq();
        const target = Buffer.from(r.mac, 'hex');
        const buf = encode({ type, target, source, sequence, ack: want === T.Ack, res: false, payload });
        try {
            for (let attempt = 0; attempt <= retries; attempt++) {
                const reply = new Promise((resolve) => {
                    const t = setTimeout(() => resolve(null), replyTimeoutMs);
                    pending.set(sequence, { onReply: (msg) => { if (msg.type === want && msg.target === r.mac) { clearTimeout(t); resolve(msg); } } });
                });
                await send(buf, r.host, r.port);
                const msg = await reply;
                if (msg) { r.dev.online = true; return msg; }
            }
        } finally { pending.delete(sequence); }
        r.dev.online = false;
        throw codeError('device_unreachable', 'No answer from the LIFX light');
    }

    function publicDevice(id, host, port, label, online) {
        return {
            id, driver: 'lifx', name: String(label || 'LIFX light').slice(0, 80), model: 'LIFX', address: port && port !== PORT ? `${host}:${port}` : host, online,
            caps: { power: true, brightness: true, color: true, white: { ...WHITE }, scenes: [], effects: [] },
            needsPairing: false, kind: 'light',
        };
    }

    async function probe(host, port, timeoutMs) {
        await ensureSocket();
        const sequence = nextSeq();
        const found = new Map();
        pending.set(sequence, {
            onReply: (msg, rinfo) => {
                if (msg.type !== T.StateService || msg.payload.length < 5 || msg.payload.readUInt8(0) !== 1) return;
                if (!/^[0-9a-f]{12}$/.test(msg.target) || msg.target === '000000000000') return;
                const h = rinfo.address;
                if (!isLanIPv4(h) || (sandbox && h !== '127.0.0.1')) return;
                const p = msg.payload.readUInt32LE(1);
                found.set(msg.target, { mac: msg.target, host: h, port: p > 0 && p < 65536 ? p : rinfo.port });
            },
        });
        try {
            if (ep.broadcast && !sandbox && host === ep.host) socket.setBroadcast(true);
            await send(encode({ type: T.GetService, tagged: true, source, sequence }), host, port);
            await sleep(setTimeout, clamp(timeoutMs, 200, 10000));
        } finally { pending.delete(sequence); }
        const out = [];
        for (const f of found.values()) {
            const id = `lifx:${f.mac}`;
            const prev = devices.get(id);
            const r = { dev: publicDevice(id, f.host, f.port, prev?.dev?.name, true), mac: f.mac, host: f.host, port: f.port };
            devices.set(id, r);
            try {
                const st = parseState((await request(r, T.Get, Buffer.alloc(0), T.State)).payload);
                if (st?.label) r.dev.name = st.label.slice(0, 80);
            } catch { /* listed without its label */ }
            out.push({ ...r.dev });
        }
        return out;
    }

    async function discover({ timeoutMs = 2000 } = {}) {
        if (!ep) return [];
        const found = await probe(ep.host, ep.port, Math.min(timeoutMs, 3000));
        const seen = new Set(found.map((d) => d.id));
        for (const [id, r] of devices) if (!seen.has(id)) r.dev.online = false;
        return found;
    }

    async function addManual(address) {
        const a = parseAddress(address, PORT);
        if (!a || !isLanIPv4(a.host)) throw codeError('bad_params', 'Enter the light\'s IPv4 address');
        guardHost(sandbox, a.host);
        if (!ep) throw codeError('device_unreachable', 'LIFX is not part of the device sandbox');
        const found = await probe(a.host, a.port, 1000);
        if (!found.length) throw codeError('device_unreachable', 'No LIFX light answered at that address');
        return found;
    }

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string' || devices.has(entry.id)) return;
        const mac = entry.id.slice(5);
        const a = parseAddress(String(entry.address || ''), PORT);
        if (!/^[0-9a-f]{12}$/.test(mac) || !a || !isLanIPv4(a.host)) return;
        devices.set(entry.id, { dev: publicDevice(entry.id, a.host, a.port, entry.name, false), mac, host: a.host, port: a.port });
    }

    function rec(id) {
        const r = devices.get(id);
        if (!r) throw codeError('device_not_found');
        return r;
    }

    async function getRaw(r) {
        const st = parseState((await request(r, T.Get, Buffer.alloc(0), T.State)).payload);
        if (!st) throw codeError('driver_error', 'The LIFX light sent a state that could not be read');
        return st;
    }

    async function getState(id) {
        const st = await getRaw(rec(id));
        const white = st.sat < 0.05 * 65535;
        return {
            on: st.power > 0,
            brightness: Math.round((st.bri / 65535) * 100),
            color: white ? null : hsvToRgb((st.hue / 65535) * 360, (st.sat / 65535) * 100, 100),
            kelvin: white ? clamp(st.kelvin, WHITE.min, WHITE.max) : null,
        };
    }

    async function setState(id, s = {}) {
        const r = rec(id);
        const d = Math.round(clamp(s.transitionMs || 0, 0, 600000));
        const hasColour = !!s.color || Number.isFinite(s.kelvin) || Number.isFinite(s.brightness);
        if (hasColour) {
            const cur = await getRaw(r);
            const next = { hue: cur.hue, sat: cur.sat, bri: cur.bri, kelvin: cur.kelvin || 3500 };
            if (Number.isFinite(s.kelvin)) { next.sat = 0; next.kelvin = Math.round(clamp(s.kelvin, WHITE.min, WHITE.max)); }
            else if (s.color) { const hsv = rgbToHsv(s.color); next.hue = Math.round((hsv.h / 360) * 65535); next.sat = Math.round((hsv.s / 100) * 65535); }
            if (Number.isFinite(s.brightness)) next.bri = Math.round((clamp(s.brightness, 1, 100) / 100) * 65535);
            await request(r, T.SetColor, setColorPayload(next, d), T.Ack);
        }
        if (s.on === true || s.on === false) await request(r, T.SetPower, setPowerPayload(s.on, d), T.Ack);
    }

    function close() {
        pending.clear();
        if (socket) { try { socket.close(); } catch { /* closed */ } socket = null; }
    }

    return {
        id: 'lifx',
        discover,
        list: () => [...devices.values()].map((r) => ({ ...r.dev })),
        restore,
        addManual,
        getState,
        setState,
        close,
        forget: (id) => { devices.delete(id); },
    };
}

module.exports = { createLifxDriver, encode, decode, parseState, T, PORT };
