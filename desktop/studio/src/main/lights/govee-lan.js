'use strict';
/*
 * Govee lights over the Govee LAN API (UDP, JSON messages).
 *
 *   createGoveeDriver({ logger, sandbox, transports, replyTimeoutMs, sendGapMs })
 *     → { id: 'govee', discover, list, restore, addManual, getState, setState, notes, close }
 *
 * Protocol: a scan {"msg":{"cmd":"scan","data":{"account_topic":"reserve"}}} goes to 239.255.255.250:4001; lights answer
 * on UDP 4002 of this PC with { ip, device (MAC), sku, ... }. Control messages go to <ip>:4003:
 *   turn {value:0|1}, brightness {value:1-100}, colorwc {color:{r,g,b}, colorTemInKelvin (2000-9000, 0 for a colour)},
 *   devStatus {} → answer on 4002 { onOff, brightness, color, colorTemInKelvin }.
 * LAN control is off until it is switched on per light in the Govee Home app; when nothing answers, the note and the
 * error say so. There are no transitions and no scenes on the LAN API.
 *
 * Endpoints: the sandbox's `govee` block when a sandbox is set (nothing at all when it has none), else transports.govee,
 * else the real ports and multicast group above. One UDP socket, bound to the listen port, sends and receives; it is
 * opened on first use and closed in close(). With a sandbox every target must be 127.0.0.1.
 */
const { codeError, clamp, guardHost, isLanIPv4, parseAddress, safeId, sleep } = require('./util');
const { kelvinToRgb } = require('./color');

const PROD = Object.freeze({ host: '239.255.255.250', scanPort: 4001, listenPort: 4002, controlPort: 4003, bind: '0.0.0.0' });
const WHITE = Object.freeze({ min: 2000, max: 9000 });
const LAN_HINT = 'No answer from the Govee light. Switch on LAN control for it in the Govee Home app (the light\'s settings), and check this PC and the light are on the same network.';

function createGoveeDriver({ logger = null, sandbox = null, transports = {}, replyTimeoutMs = 1500, sendGapMs = 40 } = {}) {
    const dgram = transports.dgram || require('node:dgram');
    const ep = sandbox ? (sandbox.govee ? { ...sandbox.govee, bind: '127.0.0.1' } : null) : { ...PROD, ...(transports.govee || {}) };
    const devices = new Map();   // id → { dev, ip }
    const waiting = new Map();   // ip → [resolve]
    let scanSink = null;
    let socket = null;
    let opening = null;
    let lastNotes = [];
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };

    function onMessage(buf, rinfo) {
        if (!buf || buf.length > 4096) return;
        let msg;
        try { msg = JSON.parse(buf.toString('utf8'))?.msg; } catch { return; }
        if (!msg || typeof msg.cmd !== 'string' || !msg.data || typeof msg.data !== 'object') return;
        if (msg.cmd === 'scan') { if (scanSink) scanSink(msg.data, rinfo); return; }
        if (msg.cmd === 'devStatus') {
            const list = waiting.get(rinfo.address);
            if (!list) return;
            waiting.delete(rinfo.address);
            for (const fn of list) fn(msg.data);
        }
    }

    function ensureSocket() {
        if (!ep) return Promise.reject(codeError('device_unreachable', 'Govee is not part of the device sandbox'));
        if (socket) return Promise.resolve(socket);
        if (opening) return opening;
        opening = new Promise((resolve, reject) => {
            const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
            const fail = (e) => {
                opening = null;
                try { s.close(); } catch { /* not open */ }
                reject(e?.code === 'EADDRINUSE'
                    ? codeError('driver_error', `Another program is using UDP port ${ep.listenPort}, which Govee lights answer on`)
                    : codeError('driver_error', `Could not open the Govee socket (${String(e?.code || 'error').slice(0, 30)})`));
            };
            s.once('error', fail);
            s.on('message', onMessage);
            s.bind(ep.listenPort, ep.bind, () => {
                s.removeListener('error', fail);
                s.on('error', (e) => log('warn', 'Govee socket error', { error: String(e?.code || e?.message).slice(0, 60) }));
                socket = s;
                opening = null;
                resolve(s);
            });
        });
        return opening;
    }

    function sendTo(host, port, obj) {
        guardHost(sandbox, host);
        const data = Buffer.from(JSON.stringify({ msg: obj }));
        return new Promise((resolve, reject) => socket.send(data, port, host, (e) => (e ? reject(codeError('device_unreachable', 'Could not send to the Govee light')) : resolve())));
    }

    function publicDevice(id, data, online) {
        const sku = String(data.sku || 'Govee').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20) || 'Govee';
        const tail = String(data.device || data.ip || '').replace(/[^A-Fa-f0-9]/g, '').slice(-4).toUpperCase();
        return {
            id, driver: 'govee', name: `Govee ${sku}${tail ? ` ${tail}` : ''}`, model: sku, address: data.ip, online,
            caps: { power: true, brightness: true, color: true, white: { ...WHITE }, scenes: [], effects: [] },
            needsPairing: false, kind: 'light',
        };
    }

    function accept(data, rinfo) {
        const ip = typeof data.ip === 'string' ? data.ip : rinfo?.address;
        if (!isLanIPv4(ip)) return null;
        if (sandbox && ip !== '127.0.0.1') return null;
        const mac = typeof data.device === 'string' ? data.device.replace(/[^A-Fa-f0-9]/g, '').toLowerCase().slice(0, 32) : '';
        const id = `govee:${mac ? safeId(mac) : `a${require('node:crypto').createHash('sha256').update(String(ip)).digest('hex').slice(0, 12)}`}`;   // never the IP in an id
        const dev = publicDevice(id, { ...data, ip }, true);
        devices.set(id, { dev, ip });
        return dev;
    }

    async function scan(host, timeoutMs) {
        await ensureSocket();
        const found = new Map();
        scanSink = (data, rinfo) => { const d = accept(data, rinfo); if (d) found.set(d.id, d); };
        try {
            await sendTo(host, ep.scanPort, { cmd: 'scan', data: { account_topic: 'reserve' } });
            await sleep(setTimeout, clamp(timeoutMs, 200, 10000));
        } finally { scanSink = null; }
        return [...found.values()];
    }

    async function discover({ timeoutMs = 3000 } = {}) {
        lastNotes = [];
        if (!ep) return [];
        let found;
        try { found = await scan(ep.host, timeoutMs); } catch (e) {
            lastNotes.push({ driver: 'govee', message: e.message });
            return [];
        }
        const seen = new Set(found.map((d) => d.id));
        for (const [id, r] of devices) if (!seen.has(id)) r.dev.online = false;
        if (!found.length) {
            lastNotes.push({ driver: 'govee', message: 'No Govee light answered. Switch on LAN control for each light in the Govee Home app (the light\'s settings), and check this PC and the lights are on the same network.' });
            log('info', 'No Govee light answered the scan (LAN control may be off in the Govee Home app)');
        }
        return found.map((d) => ({ ...d }));
    }

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string' || devices.has(entry.id) || !isLanIPv4(entry.address)) return;
        const dev = publicDevice(entry.id, { sku: entry.model, ip: entry.address }, false);
        dev.name = String(entry.name || dev.name).slice(0, 80);
        devices.set(entry.id, { dev, ip: entry.address });
    }

    function rec(id) {
        const r = devices.get(id);
        if (!r) throw codeError('device_not_found');
        return r;
    }

    function status(ip) {
        return new Promise((resolve, reject) => {
            let done = false;
            const fn = (data) => { if (!done) { done = true; clearTimeout(t); resolve(data); } };
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                const list = waiting.get(ip);
                if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); if (!list.length) waiting.delete(ip); }
                reject(codeError('device_unreachable', LAN_HINT));
            }, replyTimeoutMs);
            const list = waiting.get(ip) || [];
            list.push(fn);
            waiting.set(ip, list);
            sendTo(ip, ep.controlPort, { cmd: 'devStatus', data: {} }).catch((e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
        });
    }

    async function addManual(address) {
        const a = parseAddress(address, ep ? ep.controlPort : PROD.controlPort);
        if (!a || !isLanIPv4(a.host)) throw codeError('bad_params', 'Enter the light\'s IPv4 address');
        guardHost(sandbox, a.host);
        const found = await scan(a.host, 1500).catch(() => []);
        if (found.length) return found.map((d) => ({ ...d }));
        await ensureSocket();
        await status(a.host);   // throws with the LAN hint when nothing answers
        return [{ ...accept({ ip: a.host, sku: 'Govee' }) }];
    }

    async function getState(id) {
        const r = rec(id);
        await ensureSocket();
        let d;
        try { d = await status(r.ip); } catch (e) { r.dev.online = false; throw e; }
        r.dev.online = true;
        const kelvin = Number(d.colorTemInKelvin) > 0 ? clamp(Math.round(d.colorTemInKelvin), WHITE.min, WHITE.max) : null;
        const c = d.color && typeof d.color === 'object' ? { r: clamp(d.color.r, 0, 255), g: clamp(d.color.g, 0, 255), b: clamp(d.color.b, 0, 255) } : null;
        return { on: Number(d.onOff) === 1, brightness: clamp(Math.round(Number(d.brightness) || 0), 0, 100), color: kelvin ? null : c, kelvin };
    }

    async function setState(id, s = {}) {
        const r = rec(id);
        await ensureSocket();
        const msgs = [];
        if (s.on === true) msgs.push({ cmd: 'turn', data: { value: 1 } });
        if (Number.isFinite(s.kelvin)) {
            const k = Math.round(clamp(s.kelvin, WHITE.min, WHITE.max));
            msgs.push({ cmd: 'colorwc', data: { color: kelvinToRgb(k), colorTemInKelvin: k } });
        } else if (s.color) {
            msgs.push({ cmd: 'colorwc', data: { color: { r: Math.round(clamp(s.color.r, 0, 255)), g: Math.round(clamp(s.color.g, 0, 255)), b: Math.round(clamp(s.color.b, 0, 255)) }, colorTemInKelvin: 0 } });
        }
        if (Number.isFinite(s.brightness)) msgs.push({ cmd: 'brightness', data: { value: Math.round(clamp(s.brightness, 1, 100)) } });
        if (s.on === false) msgs.push({ cmd: 'turn', data: { value: 0 } });
        for (let i = 0; i < msgs.length; i++) {
            if (i && sendGapMs > 0) await sleep(setTimeout, sendGapMs);
            await sendTo(r.ip, ep.controlPort, msgs[i]);
        }
    }

    function close() {
        for (const list of waiting.values()) list.length = 0;
        waiting.clear();
        if (socket) { try { socket.close(); } catch { /* closed */ } socket = null; }
    }

    return {
        id: 'govee',
        discover,
        list: () => [...devices.values()].map((r) => ({ ...r.dev })),
        restore,
        addManual,
        getState,
        setState,
        notes: () => lastNotes.slice(),
        close,
        forget: (id) => { devices.delete(id); },
    };
}

module.exports = { createGoveeDriver, LAN_HINT };
