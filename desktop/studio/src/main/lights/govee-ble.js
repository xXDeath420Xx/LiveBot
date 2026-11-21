'use strict';
/*
 * Govee lights over Bluetooth LE (Studio 0.2.11), for Govee models without the LAN API (the owner's H6054 light bars) and as
 * a faster local path for lights that are also on the streamer's Govee cloud key.
 *
 *   createGoveeBleDriver({ logger, sandbox, helperPath, spawnImpl, getCloudMacs, timeoutMs, scanMs })
 *     → { id: 'goveeble', discover, list, restore, pair, forget, getState, setState, restoreState, test, blink, notes, close }
 *
 * Transport: src/ble/govee-ble-helper.exe (C#, Windows' own WinRT Bluetooth API; see its header for why not noble), started on
 * first use, JSON lines over stdin/stdout. It keeps each light's connection open with a keep-alive and reconnects.
 *
 * Which lights are listed: only Govee advertisement names (Govee_ / ihoment_ / GBK_ / Minger_ + model + last 4 of the address).
 * Bluetooth reaches the neighbours' lights too (a scan on the owner's PC sees several other Govee lights), so a light found
 * by a scan is "needs pairing" until the streamer adds it (Pair), except when its address is the MAC inside one of the
 * streamer's own Govee cloud lights (cloud ids end with the 8-byte device id whose last 6 bytes are the Bluetooth address,
 * e.g. govee-cloud:H6054:5A:0E:D6:39:32:37:09:41 is D6:39:32:37:09:41), which is added at once. 'all' never includes an
 * unpaired light.
 *
 * Packets: 20 bytes, 0x33 + command + data, zero padded, byte 19 the XOR of bytes 0 to 18 (Beshelmek/govee_ble_lights
 * light.py _prepareSinglePacketData; homebridge-govee lib/utils/ble-protocol.js "always 20 bytes with XOR checksum").
 *   power        33 01 01|00                       (govee_ble_lights LedCommand.POWER; sniffed packets in the Home
 *                                                   Assistant forum thread "Govee Bluetooth lights")
 *   brightness   33 04 <level>                     level 0-100 on the H6054: verified on the owner's light, whose status
 *                                                   answer was aa 04 64 at full brightness. Models that answer above 100
 *                                                   use 0-255 (govee_btled sends round(value * 0xFF)).
 *   colour       33 05 02 r g b                    (govee_ble_lights LedMode.MANUAL; govee_btled; homebridge-govee
 *                                                   COLOR_SUB.RGB_DEFAULT) on most models;
 *                33 05 15 01 r g b 00 00 00 00 00 ff 7f   on segmented (RGBIC) models: all segments (govee_ble_lights
 *                                                   SEGMENTED_MODELS H6053 H6072 H6102 H6199 and homebridge-govee
 *                                                   RGB_EXTENDED; H6054 Flow Pro is RGBIC). Not verified on the owner's
 *                                                   lights: changing colour there could not be undone exactly (see below).
 *   status       aa 01 (power), aa 04 (brightness), aa 05 (mode), answered on the notify characteristic with the same
 *                two first bytes. Verified on the owner's H6054: aa0101 = on, aa0464 = 100, aa0513... = a scene-type mode.
 * No colour temperature: no source documents a Bluetooth white packet beyond RGB white, so white-only requests become RGB.
 *
 * Putting a light back (temporary changes): power and brightness always; the colour only when the saved mode is a plain colour
 * (02, 0d or 15 with RGB). A light that was showing a scene cannot be put back after a colour change, so light.flash and the
 * Test button blink the power instead (off, then on; or on, then off when it was off), which Govee lights come back from in
 * the mode they were in. A timed colour change (durationMs) on a light showing a scene leaves the colour: said in the report.
 */
const { spawn: defaultSpawn } = require('node:child_process');
const { codeError, clamp } = require('./util');

const NAME = /^(Govee|ihoment|GBK|Minger)_([A-Z0-9]{4,6})_([0-9A-F]{4})$/i;
const SEGMENTED = new Set(['H6053', 'H6072', 'H6102', 'H6199', 'H6054']);
const PERCENT = new Set(['H6054']);   // verified 0-100 (status aa 04 64)

function packet(bytes) {
    const b = Buffer.alloc(20);
    bytes.slice(0, 19).forEach((x, i) => { b[i] = x & 0xff; });
    let x = 0;
    for (let i = 0; i < 19; i++) x ^= b[i];
    b[19] = x;
    return b.toString('hex');
}
const powerPacket = (on) => packet([0x33, 0x01, on ? 1 : 0]);
const brightnessPacket = (pct, scale = 'percent') => packet([0x33, 0x04, scale === 'byte' ? Math.round(clamp(pct, 0, 100) * 2.55) : Math.round(clamp(pct, 0, 100))]);
function colorPacket(model, { r, g, b }) {
    const c = [r, g, b].map((v) => Math.round(clamp(Number(v) || 0, 0, 255)));
    return SEGMENTED.has(String(model).toUpperCase())
        ? packet([0x33, 0x05, 0x15, 0x01, ...c, 0, 0, 0, 0, 0, 0xff, 0x7f])
        : packet([0x33, 0x05, 0x02, ...c]);
}
const statusPacket = (what) => packet([0xaa, what]);

/** 'D63932370941' from a cloud id (govee-cloud:H6054:5A:0E:D6:39:32:37:09:41), or null. */
function macFromCloudId(id) {
    const m = String(id || '').match(/^govee-cloud:[^:]+:((?:[0-9A-F]{2}:){5,7}[0-9A-F]{2})$/i);
    if (!m) return null;
    const hex = m[1].replace(/:/g, '').toUpperCase();
    return hex.length >= 12 ? hex.slice(-12) : null;
}

function parseName(name) {
    const m = String(name || '').match(NAME);
    return m ? { model: m[2].toUpperCase(), tail: m[3].toUpperCase() } : null;
}

function createGoveeBleDriver({ logger = null, sandbox = null, helperPath = null, spawnImpl = defaultSpawn, getCloudMacs = () => new Map(), timeoutMs = 6000, scanMs = 5000 } = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };
    const devices = new Map();   // id → { dev, address, model, scale }
    let proc = null;
    let buf = '';
    let seq = 0;
    const waiting = new Map();
    let lastNotes = [];

    function start() {
        if (sandbox) throw codeError('device_unreachable', 'Bluetooth is not part of the device sandbox');
        if (process.platform !== 'win32' && spawnImpl === defaultSpawn) throw codeError('not_supported', 'Bluetooth lights need Windows');
        if (!helperPath) throw codeError('not_supported', 'The Bluetooth helper is missing');
        if (proc) return proc;
        const p = spawnImpl(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        proc = p;
        buf = '';
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let m;
                try { m = JSON.parse(line); } catch { continue; }
                if (m.id != null && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m); continue; }
                if (m.type === 'link') {
                    const r = devices.get(`goveeble:${String(m.address).toUpperCase()}`);
                    if (r) r.dev.online = !!m.connected;
                } else if (m.type === 'log') log('info', 'Bluetooth helper', { message: String(m.message || '').slice(0, 200) });
            }
        });
        p.stdin.on('error', () => { /* gone; exit handler */ });
        p.on('exit', (code) => {
            if (proc !== p) return;
            proc = null;
            for (const w of waiting.values()) w({ ok: false, error: 'device_unreachable', message: 'The Bluetooth helper stopped' });
            waiting.clear();
            for (const r of devices.values()) r.dev.online = false;
            log('info', 'Bluetooth helper stopped', { code });
        });
        p.on('error', (e) => log('warn', 'Bluetooth helper could not start', { error: e.message }));
        return p;
    }

    function call(op, params = {}, ms = timeoutMs) {
        const p = start();
        return new Promise((resolve, reject) => {
            const id = ++seq;
            const timer = setTimeout(() => { waiting.delete(id); reject(codeError('device_offline', 'The Bluetooth light did not answer')); }, ms + 1000);
            timer.unref?.();
            waiting.set(id, (m) => {
                clearTimeout(timer);
                if (m.ok) return resolve(m);
                const code = m.error === 'not_found' || m.error === 'timeout' || m.error === 'no_service' ? 'device_offline'
                    : m.error === 'bad_params' ? 'bad_params' : m.error === 'no_adapter' ? 'not_supported' : 'driver_error';
                reject(codeError(code, m.error === 'no_adapter' ? 'Bluetooth is off or this PC has no Bluetooth adapter' : String(m.message || m.error || 'failed').slice(0, 200)));
            });
            try { p.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`); } catch { waiting.delete(id); clearTimeout(timer); reject(codeError('driver_error', 'The Bluetooth helper is not running')); }
        });
    }

    function rec(id) {
        const r = devices.get(id);
        if (!r) throw codeError('device_not_found');
        return r;
    }

    function accept({ address, name, rssi }) {
        const info = parseName(name);
        if (!info) return null;
        const addr = String(address).toUpperCase();
        const id = `goveeble:${addr}`;
        const cloud = getCloudMacs().get(addr) || null;
        const r = devices.get(id) || { dev: null, address: addr, model: info.model, scale: PERCENT.has(info.model) ? 'percent' : null };
        const paired = r.dev ? !r.dev.needsPairing : false;
        r.dev = {
            id, driver: 'goveeble', name: cloud?.name ? String(cloud.name) : `Govee ${info.model} (${info.tail})`, model: info.model, address: addr,
            online: true, kind: 'light', needsPairing: !(paired || cloud),
            caps: { power: true, brightness: true, color: true, white: null, scenes: [], effects: [] },
            cloudId: cloud?.id || null, rssi: Number.isFinite(rssi) ? rssi : null,
        };
        devices.set(id, r);
        return r.dev;
    }

    async function discover({ timeoutMs: t = scanMs } = {}) {
        lastNotes = [];
        let r;
        try { r = await call('scan', { ms: clamp(t, 1000, 15000) }, clamp(t, 1000, 15000) + 3000); } catch (e) {
            if (e.code === 'not_supported') lastNotes.push({ message: 'Bluetooth lights: turn Bluetooth on in Windows Settings to use Govee lights over Bluetooth.' });
            throw e;
        }
        const found = [];
        for (const d of r.devices || []) { const dev = accept(d); if (dev) found.push(dev); }
        const unpaired = found.filter((d) => d.needsPairing).length;
        if (unpaired) lastNotes.push({ message: `Bluetooth: ${unpaired} Govee light${unpaired === 1 ? '' : 's'} nearby that ${unpaired === 1 ? 'is' : 'are'} not on your Govee key. Bluetooth also reaches lights next door, so choose Pair only on lights that are yours.` });
        return found;
    }

    async function readStatus(r) {
        const power = await call('query', { address: r.address, hex: statusPacket(0x01), ms: 1500 });
        const bright = await call('query', { address: r.address, hex: statusPacket(0x04), ms: 1500 }).catch(() => null);
        const mode = await call('query', { address: r.address, hex: statusPacket(0x05), ms: 1500 }).catch(() => null);
        const ph = Buffer.from(power.hex, 'hex');
        const bh = bright ? Buffer.from(bright.hex, 'hex') : null;
        if (bh && !r.scale) r.scale = bh[2] > 100 ? 'byte' : 'percent';
        const level = bh ? (r.scale === 'byte' ? Math.round(bh[2] / 2.55) : bh[2]) : null;
        const mh = mode ? Buffer.from(mode.hex, 'hex') : null;
        let color = null;
        if (mh && mh[2] === 0x02) color = { r: mh[3], g: mh[4], b: mh[5] };
        if (mh && mh[2] === 0x0d) color = { r: mh[3], g: mh[4], b: mh[5] };
        if (mh && mh[2] === 0x15 && mh[3] === 0x01) color = { r: mh[4], g: mh[5], b: mh[6] };
        return { on: ph[2] === 1, brightness: level == null ? null : clamp(level, 0, 100), color, kelvin: null, mode: mh ? mh[2] : null, modeHex: mh ? mode.hex : null };
    }

    async function pair(id) {
        const r = rec(id);
        try {
            await call('connect', { address: r.address });
            await readStatus(r);
        } catch (e) { return { ok: false, message: e.code === 'device_offline' ? 'The light did not answer over Bluetooth. Close the Govee Home app on your phone (a light takes one Bluetooth connection at a time) and try again.' : e.message }; }
        r.dev.needsPairing = false;
        r.dev.online = true;
        return { ok: true, message: 'Added. Studio controls it over Bluetooth.' };
    }

    async function getState(id) {
        const r = rec(id);
        try { const s = await readStatus(r); r.dev.online = true; return s; } catch (e) { r.dev.online = false; throw e; }
    }

    async function setState(id, s = {}) {
        const r = rec(id);
        const out = [];
        if (s.on === true) out.push(powerPacket(true));
        if (s.color) out.push(colorPacket(r.model, s.color));
        if (Number.isFinite(s.brightness)) out.push(brightnessPacket(clamp(s.brightness, 1, 100), r.scale || 'percent'));
        if (s.on === false) out.push(powerPacket(false));
        for (const hex of out) await call('write', { address: r.address, hex });
        r.dev.online = true;
    }

    /** After a temporary change: power and brightness, and the colour only when it was a plain colour (see the header). */
    async function restoreState(id, saved) {
        if (!saved) return;
        const st = { on: !!saved.on };
        if (saved.color) st.color = saved.color;
        if (Number.isFinite(saved.brightness) && saved.brightness > 0) st.brightness = saved.brightness;
        await setState(id, st);
    }

    /** Blinks of the power (flash and test), which every Govee light comes back from in the mode it was in. */
    async function blink(id, { times = 1, periodMs = 1200 } = {}) {
        const r = rec(id);
        const s = await readStatus(r);
        const half = clamp(Math.round(periodMs / 2), 300, 2500);
        for (let i = 0; i < clamp(times, 1, 10); i++) {
            await call('write', { address: r.address, hex: powerPacket(!s.on) });
            await new Promise((res) => setTimeout(res, half));
            await call('write', { address: r.address, hex: powerPacket(s.on) });
            if (i + 1 < times) await new Promise((res) => setTimeout(res, half));
        }
        const after = await readStatus(r).catch(() => null);
        return { before: s.on, after: after ? after.on : null, restored: !!after && after.on === s.on };
    }
    const test = (id, { gapMs = 600 } = {}) => blink(id, { times: 1, periodMs: gapMs * 2 });

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string' || !/^goveeble:[0-9A-F]{12}$/.test(entry.id)) return;
        const addr = entry.id.slice(9);
        const model = String(entry.model || '').toUpperCase();
        devices.set(entry.id, { address: addr, model, scale: PERCENT.has(model) ? 'percent' : null,
            dev: { id: entry.id, driver: 'goveeble', name: String(entry.name || `Govee ${model}`), model, address: addr, online: false, kind: 'light',
                needsPairing: !!entry.needsPairing, caps: { power: true, brightness: true, color: true, white: null, scenes: [], effects: [] } } });
    }

    function close() {
        const p = proc;
        proc = null;
        if (p) { try { p.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500).unref?.(); }
    }

    return {
        id: 'goveeble',
        discover,
        list: () => [...devices.values()].map((r) => ({ ...r.dev })),
        restore, pair, getState, setState, restoreState, test, blink,
        notes: () => lastNotes.slice(),
        close,
        forget: (id) => { const r = devices.get(id); devices.delete(id); if (r && proc) call('disconnect', { address: r.address }).catch(() => {}); },
    };
}

module.exports = { createGoveeBleDriver, packet, powerPacket, brightnessPacket, colorPacket, statusPacket, macFromCloudId, parseName, SEGMENTED };
