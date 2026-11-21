'use strict';
/*
 * Heart rate from a Bluetooth LE sensor (Studio 0.2.14): a watch running a heart-rate broadcast app (Heart for Bluetooth on
 * the owner's Galaxy Watch 8 Classic), a Garmin with "Broadcast heart rate", or a chest strap. Replaces Pulsoid's cloud relay:
 * the watch talks to this PC only.
 *
 *   parseHeartRate(bytes)  → { bpm, sixteenBit, contactSupported, contact, energy, rr: [ms] } | null
 *     Heart Rate Measurement, Bluetooth SIG characteristic 0x2A37 (GATT Specification Supplement, 3.113):
 *       byte 0 flags  bit 0  value format: 0 = uint8 BPM, 1 = uint16 BPM (little endian)
 *                     bit 1  sensor contact detected        bit 2  sensor contact status supported
 *                     bit 3  energy expended present (uint16, kJ)
 *                     bit 4  RR intervals present (uint16 each, 1/1024 s), as many as fit in the rest of the packet
 *     A reading with contact supported but not detected is not used (the watch is off the wrist).
 *
 *   createHeartRate({ helperPath, spawnImpl, logger, getSettings, saveDevice, onReading, onStatus, now, setTimer, clearTimer,
 *                     backoff, staleMs, smooth })
 *     .start()                 connect to the saved device when heart rate is on (and keep reconnecting)
 *     .stop()                  disconnect and stop the helper
 *     .scan({ all, ms })       → [{ address, name, rssi, hr }]   nearby Heart Rate Service devices (all: every named device)
 *     .choose({ address, name })   save it and connect
 *     .forget()                stop and forget the device
 *     .status()                { state, device, bpm, lastAt, battery, contact, rr, error, history }
 *       state: off | idle (no device chosen) | connecting | waiting (connected, no reading yet) | connected | reconnecting | error
 *       history: the last 120 smoothed readings, at most one a second, for the sparkline
 *     .close()
 *   Reconnects with backoff from 5 s, doubling to 60 s, when the link drops, the connect fails, the helper stops, or no
 *   reading arrives for staleMs (20 s) while connected (the watch app stopped broadcasting but kept the link).
 *
 *   createSender({ send, now, setTimer, clearTimer, minMs = 1000, keepMs = 3000 })
 *     .push(reading)   at most one send a second; a repeat of the same BPM only every keepMs, so the server sees the watch
 *                      is still there (it falls back to Pulsoid after 10 s of silence)
 *     .close()
 *
 * Tested in test/heart-rate.test.js with a fake helper process (no Bluetooth needed).
 */
const { spawn: defaultSpawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const BPM_RANGE = [25, 250];
const HISTORY = 120;

function parseHeartRate(input) {
    let b;
    try { b = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input, 'hex') : Buffer.from(input || []); } catch { return null; }
    if (b.length < 2) return null;
    const flags = b[0];
    const sixteenBit = (flags & 0x01) !== 0;
    let i = 1;
    if (sixteenBit && b.length < 3) return null;
    const bpm = sixteenBit ? b.readUInt16LE(1) : b[1];
    i += sixteenBit ? 2 : 1;
    const contactSupported = (flags & 0x04) !== 0;
    const contact = contactSupported ? (flags & 0x02) !== 0 : null;
    let energy = null;
    if (flags & 0x08) {
        if (b.length < i + 2) return null;
        energy = b.readUInt16LE(i);
        i += 2;
    }
    const rr = [];
    if (flags & 0x10) {
        for (; i + 1 < b.length; i += 2) rr.push(Math.round((b.readUInt16LE(i) * 1000) / 1024));
    }
    return { bpm, sixteenBit, contactSupported, contact, energy, rr };
}

/** Whether a parsed reading should be shown and sent: worn, and a believable heart rate. */
function usable(r) {
    if (!r) return false;
    if (r.contactSupported && !r.contact) return false;
    return Number.isInteger(r.bpm) && r.bpm >= BPM_RANGE[0] && r.bpm <= BPM_RANGE[1];
}

const cleanAddress = (a) => String(a || '').replace(/[^0-9a-f]/gi, '').toUpperCase();

function createHeartRate({
    helperPath = null, spawnImpl = defaultSpawn, logger = null, getSettings = () => ({ enabled: false, device: null }), saveDevice = () => {},
    onReading = () => {}, onStatus = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    backoff = { min: 5000, max: 60000 }, staleMs = 20000, smooth = 3, timeoutMs = 15000,
} = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[heart] ${m}`, meta); } catch { /* ignore */ } };
    let proc = null;
    let buf = '';
    let seq = 0;
    const waiting = new Map();
    let state = 'off';
    let error = null;
    let device = null;           // { address, name }
    let battery = null;
    let last = null;             // { bpm, at, contact, rr }
    let window3 = [];
    const history = [];          // [{ t, bpm }]
    let retryTimer = null;
    let staleTimer = null;
    let delay = backoff.min;
    let running = false;
    let connecting = false;

    function setState(s, err = null) {
        const changed = s !== state || err !== error;
        state = s;
        error = err;
        if (changed) { try { onStatus(status()); } catch { /* ignore */ } }
    }

    function start_() {
        if (proc) return proc;
        if (!helperPath) throw Object.assign(new Error('The Bluetooth helper is missing'), { code: 'not_supported' });
        if (process.platform !== 'win32' && spawnImpl === defaultSpawn) throw Object.assign(new Error('Bluetooth heart rate needs Windows'), { code: 'not_supported' });
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
                onHelperEvent(m);
            }
        });
        p.stdin.on('error', () => { /* gone; exit handler */ });
        p.on('exit', (code) => {
            if (proc !== p) return;
            proc = null;
            for (const w of waiting.values()) w({ ok: false, error: 'failed', message: 'The Bluetooth helper stopped' });
            waiting.clear();
            log('info', 'Bluetooth helper stopped', { code });
            if (running && device) lost('The Bluetooth helper stopped');
        });
        p.on('error', (e) => log('warn', 'Bluetooth helper could not start', { error: e.message }));
        return p;
    }

    function call(op, params = {}, ms = timeoutMs) {
        let p;
        try { p = start_(); } catch (e) { return Promise.reject(e); }
        return new Promise((resolve, reject) => {
            const id = ++seq;
            const timer = setTimer(() => { waiting.delete(id); reject(Object.assign(new Error('The heart-rate device did not answer'), { code: 'timeout' })); }, ms + 1000);
            timer?.unref?.();
            waiting.set(id, (m) => {
                clearTimer(timer);
                if (m.ok) return resolve(m);
                reject(Object.assign(new Error(messageFor(m.error, m.message)), { code: m.error || 'failed' }));
            });
            try { p.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`); } catch { waiting.delete(id); clearTimer(timer); reject(Object.assign(new Error('The Bluetooth helper is not running'), { code: 'failed' })); }
        });
    }

    function messageFor(code, msg) {
        switch (code) {
            case 'no_adapter': return 'Bluetooth is off, or this PC has no Bluetooth adapter. Turn it on in Windows Settings.';
            case 'not_found': return 'The watch was not found. Check that the heart-rate app on the watch is broadcasting and the watch is near this PC.';
            case 'no_service': return 'That device does not send heart rate over Bluetooth.';
            case 'access_denied': return 'Windows refused the connection. Remove the watch under Windows Settings, Bluetooth and devices, then choose it here again.';
            case 'timeout': return 'The heart-rate device did not answer.';
            default: return String(msg || code || 'failed').slice(0, 200);
        }
    }

    function onHelperEvent(m) {
        if (m.type === 'hr') {
            if (!device || cleanAddress(m.address) !== device.address) return;
            reading(parseHeartRate(m.hex));
        } else if (m.type === 'battery') {
            const p = Number(m.percent);
            if (Number.isInteger(p) && p >= 0 && p <= 100) { battery = p; try { onStatus(status()); } catch { /* ignore */ } }
        } else if (m.type === 'link') {
            if (!device || cleanAddress(m.address) !== device.address) return;
            if (m.connected) { if (state === 'reconnecting' || state === 'connecting') setState(last && now() - last.at < staleMs ? 'connected' : 'waiting'); }
            else if (running) lost('The watch disconnected');
        } else if (m.type === 'log') log('info', 'Bluetooth helper', { message: String(m.message || '').slice(0, 200) });
    }

    function reading(r) {
        if (!usable(r)) {
            if (r && r.contactSupported && !r.contact && state === 'connected') setState('waiting');
            return;
        }
        window3.push(r.bpm);
        if (window3.length > Math.max(1, smooth)) window3 = window3.slice(-Math.max(1, smooth));
        const bpm = Math.round(window3.reduce((a, x) => a + x, 0) / window3.length);
        const t = now();
        last = { bpm, at: t, contact: r.contact, rr: r.rr.slice(0, 8), raw: r.bpm };
        const prev = history[history.length - 1];
        if (!prev || t - prev.t >= 1000) { history.push({ t, bpm }); if (history.length > HISTORY) history.shift(); } else prev.bpm = bpm;
        delay = backoff.min;
        armStale();
        if (state !== 'connected') setState('connected');
        try { onReading({ bpm, at: t, contact: r.contact, rr: last.rr, battery }); } catch { /* ignore */ }
    }

    function armStale() {
        if (staleTimer) clearTimer(staleTimer);
        staleTimer = setTimer(() => { staleTimer = null; if (running && device && (state === 'connected' || state === 'waiting')) lost('No heart rate for a while: the watch app may have stopped broadcasting'); }, staleMs);
        staleTimer?.unref?.();
    }

    function lost(why) {
        if (staleTimer) { clearTimer(staleTimer); staleTimer = null; }
        window3 = [];
        if (!running || !device) return;
        setState('reconnecting', why);
        scheduleRetry();
    }

    function scheduleRetry() {
        if (retryTimer) return;
        const wait = delay;
        delay = Math.min(backoff.max, delay * 2);
        log('info', 'reconnecting', { inMs: wait });
        retryTimer = setTimer(() => { retryTimer = null; connect().catch(() => {}); }, wait);
        retryTimer?.unref?.();
    }

    async function connect() {
        if (!running || !device || connecting) return;
        connecting = true;
        if (state !== 'reconnecting') setState('connecting');
        try {
            const r = await call('connect', { address: device.address }, timeoutMs);
            if (Number.isInteger(r.battery)) battery = r.battery;
            if (r.name && !device.name) device.name = String(r.name).slice(0, 80);
            if (!running) return;
            setState(last && now() - last.at < staleMs ? 'connected' : 'waiting');
            armStale();
        } catch (e) {
            log('info', 'connect failed', { code: e.code });
            if (e.code === 'not_supported' || e.code === 'no_adapter') { setState('error', e.message); scheduleRetry(); return; }
            setState('reconnecting', e.message);
            scheduleRetry();
        } finally { connecting = false; }
    }

    function status() {
        return {
            state, error, device: device ? { ...device } : null, battery,
            bpm: last ? last.bpm : null, lastAt: last ? last.at : null, contact: last ? last.contact : null, rr: last ? last.rr : [],
            history: history.map((h) => h.bpm),
        };
    }

    function halt() {
        running = false;
        if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
        if (staleTimer) { clearTimer(staleTimer); staleTimer = null; }
        delay = backoff.min;
        window3 = [];
    }

    const api = Object.assign(new EventEmitter(), {
        start() {
            const s = getSettings() || {};
            const d = s.device && s.device.address ? { address: cleanAddress(s.device.address), name: s.device.name ? String(s.device.name).slice(0, 80) : '' } : null;
            if (!s.enabled) { api.stop(); setState('off'); return; }
            if (!d || d.address.length !== 12) { halt(); device = null; setState('idle'); return; }
            if (running && device && device.address === d.address) return;
            device = d;
            running = true;
            delay = backoff.min;
            connect().catch(() => {});
        },
        stop() {
            const was = running;
            halt();
            if (proc && was) call('disconnect', {}, 3000).catch(() => {});
            setState(getSettings()?.enabled ? 'idle' : 'off');
        },
        async scan({ all = false, ms = 6000 } = {}) {
            const r = await call('scan', { ms: Math.max(1000, Math.min(15000, Number(ms) || 6000)), all: !!all }, Math.max(1000, Math.min(15000, Number(ms) || 6000)) + 3000);
            return (r.devices || []).map((d) => ({ address: cleanAddress(d.address), name: String(d.name || '').slice(0, 80), rssi: Number.isFinite(d.rssi) ? d.rssi : null, hr: !!d.hr }))
                .filter((d) => d.address.length === 12)
                .sort((a, b) => (b.hr - a.hr) || ((b.rssi ?? -200) - (a.rssi ?? -200)));
        },
        choose({ address, name } = {}) {
            const a = cleanAddress(address);
            if (a.length !== 12) throw Object.assign(new Error('Pick a device from the list.'), { code: 'bad_params' });
            halt();
            last = null;
            battery = null;
            history.length = 0;
            device = null;
            saveDevice({ address: a, name: String(name || '').slice(0, 80) });
            api.start();
            return status();
        },
        forget() {
            api.stop();
            device = null;
            last = null;
            battery = null;
            history.length = 0;
            saveDevice(null);
            setState(getSettings()?.enabled ? 'idle' : 'off');
        },
        status,
        close() {
            halt();
            const p = proc;
            proc = null;
            if (p) { try { p.stdin.end(); } catch { /* gone */ } const t = setTimer(() => { try { p.kill(); } catch { /* gone */ } }, 1500); t?.unref?.(); }
        },
        _reading: reading,
    });
    return api;
}

function createSender({ send, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, minMs = 1000, keepMs = 3000 } = {}) {
    let lastSent = 0;
    let lastBpm = null;
    let pending = null;
    let timer = null;
    function flush() {
        timer = null;
        if (!pending) return;
        const r = pending;
        pending = null;
        lastSent = now();
        lastBpm = r.bpm;
        try { send(r); } catch { /* best effort */ }
    }
    return {
        push(r) {
            if (!r || !Number.isInteger(r.bpm)) return;
            const t = now();
            if (r.bpm === lastBpm && t - lastSent < keepMs) return;
            pending = r;
            if (t - lastSent >= minMs) { if (timer) { clearTimer(timer); timer = null; } flush(); return; }
            if (!timer) { timer = setTimer(flush, minMs - (t - lastSent)); timer?.unref?.(); }
        },
        close() { if (timer) clearTimer(timer); timer = null; pending = null; },
    };
}

module.exports = { parseHeartRate, usable, createHeartRate, createSender, BPM_RANGE };
