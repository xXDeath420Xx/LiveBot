'use strict';
/*
 * Elgato Key Light / Key Light Air / Light Strip over their local HTTP API (port 9123, no pairing).
 *
 *   createElgatoDriver({ logger, sandbox, transports, mdns, timeoutMs })
 *     → { id: 'elgato', discover, list, restore, addManual, getState, setState, close }
 *
 * Discovery: mDNS `_elg._tcp.local` (or the sandbox's addresses), then GET /elgato/accessory-info
 * ({ productName, serialNumber, displayName }) and GET /elgato/lights. Control: PUT /elgato/lights
 * { numberOfLights: 1, lights: [{ on: 0|1, brightness, temperature }] } where temperature is 143-344 (= 1000000 / kelvin,
 * about 7000-2900 K). Light Strips answer with hue (0-360) / saturation (0-100) / brightness and take colour that way.
 * A Key Light has no colour; the manager turns colour into the nearest white. No transitions in this API.
 */
const { codeError, clamp, guardHost, isLanIPv4, parseAddress, formatAddress, safeId, httpRequest } = require('./util');
const { rgbToHsv, hsvToRgb } = require('./color');

const PORT = 9123;
const WHITE = Object.freeze({ min: 2900, max: 7000 });

function createElgatoDriver({ logger = null, sandbox = null, transports = {}, mdns = null, timeoutMs = 3000 } = {}) {
    const http = transports.http || require('node:http');
    const devices = new Map();   // id → { dev, host, port, strip }
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };

    async function call(host, port, method, path, body) {
        guardHost(sandbox, host);
        const res = await httpRequest({ http, method, host, port, path, body, timeoutMs });
        if (res.status < 200 || res.status >= 300) throw codeError('driver_error', `The Elgato light answered ${res.status}`);
        return res.json;
    }

    async function identify(host, port) {
        const info = await call(host, port, 'GET', '/elgato/accessory-info');
        const lights = await call(host, port, 'GET', '/elgato/lights');
        const l = lights?.lights?.[0] || {};
        const product = String(info?.productName || 'Elgato light').slice(0, 60);
        const strip = 'hue' in l || /strip/i.test(product);
        const serial = String(info?.serialNumber || '').trim();
        const id = `elgato:${safeId(serial || `a${require('node:crypto').createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 12)}`)}`;   // never the IP in an id
        const dev = {
            id, driver: 'elgato', name: String(info?.displayName || product).trim().slice(0, 80) || product, model: product,
            address: formatAddress(host, port, PORT), online: true,
            caps: { power: true, brightness: true, color: strip, white: !strip || 'temperature' in l ? { ...WHITE } : null, scenes: [], effects: [] },
            needsPairing: false, kind: 'light',
        };
        devices.set(id, { dev, host, port, strip });
        return { ...dev };
    }

    async function discover({ timeoutMs: t = 3000 } = {}) {
        let targets;
        if (sandbox) targets = (sandbox.elgato || []).map((a) => ({ host: a.host, port: a.port }));
        else if (mdns) targets = (await mdns.browse('_elg._tcp.local', { timeoutMs: t })).map((s) => ({ host: s.address, port: s.port || PORT }));
        else targets = [];
        const found = [];
        for (const tg of targets.slice(0, 20)) {
            try { found.push(await identify(tg.host, tg.port)); } catch (e) { log('info', 'An Elgato light did not answer', { code: e.code }); }
        }
        const seen = new Set(found.map((d) => d.id));
        for (const [id, r] of devices) if (!seen.has(id)) r.dev.online = false;
        return found;
    }

    async function addManual(address) {
        const a = parseAddress(address, PORT);
        if (!a || !isLanIPv4(a.host)) throw codeError('bad_params', 'Enter the light\'s IPv4 address');
        return [await identify(a.host, a.port)];
    }

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string' || devices.has(entry.id)) return;
        const a = parseAddress(String(entry.address || ''), PORT);
        if (!a || !isLanIPv4(a.host)) return;
        const strip = !!entry.caps?.color;
        devices.set(entry.id, {
            dev: { id: entry.id, driver: 'elgato', name: String(entry.name || 'Elgato light').slice(0, 80), model: String(entry.model || 'Elgato').slice(0, 60), address: formatAddress(a.host, a.port, PORT), online: false, caps: { power: true, brightness: true, color: strip, white: entry.caps?.white === null ? null : { ...WHITE }, scenes: [], effects: [] }, needsPairing: false, kind: 'light' },
            host: a.host, port: a.port, strip,
        });
    }

    function rec(id) {
        const r = devices.get(id);
        if (!r) throw codeError('device_not_found');
        return r;
    }

    async function guarded(r, fn) {
        try { const v = await fn(); r.dev.online = true; return v; } catch (e) { if (e.code === 'device_unreachable') r.dev.online = false; throw e; }
    }

    async function getState(id) {
        const r = rec(id);
        const j = await guarded(r, () => call(r.host, r.port, 'GET', '/elgato/lights'));
        const l = j?.lights?.[0];
        if (!l) throw codeError('driver_error', 'The Elgato light sent no state');
        const kelvin = Number(l.temperature) > 0 && !(r.strip && 'hue' in l && Number(l.saturation) > 5) ? clamp(Math.round(1e6 / l.temperature), WHITE.min, WHITE.max) : null;
        return {
            on: Number(l.on) === 1,
            brightness: clamp(Math.round(Number(l.brightness) || 0), 0, 100),
            color: r.strip && 'hue' in l && !kelvin ? hsvToRgb(Number(l.hue) || 0, Number(l.saturation) || 0, 100) : null,
            kelvin,
        };
    }

    async function setState(id, s = {}) {
        const r = rec(id);
        const l = {};
        if (s.on === true || s.on === false) l.on = s.on ? 1 : 0;
        if (Number.isFinite(s.brightness)) l.brightness = Math.round(clamp(s.brightness, r.strip ? 0 : 3, 100));
        if (Number.isFinite(s.kelvin)) l.temperature = Math.round(clamp(1e6 / clamp(s.kelvin, WHITE.min, WHITE.max), 143, 344));
        else if (s.color) {
            if (!r.strip) throw codeError('not_supported', 'This Elgato light has no colour');
            const hsv = rgbToHsv(s.color);
            l.hue = hsv.h; l.saturation = hsv.s;
        }
        if (!Object.keys(l).length) return;
        await guarded(r, () => call(r.host, r.port, 'PUT', '/elgato/lights', { numberOfLights: 1, lights: [l] }));
    }

    return {
        id: 'elgato',
        discover,
        list: () => [...devices.values()].map((r) => ({ ...r.dev })),
        restore,
        addManual,
        getState,
        setState,
        close() {},
        forget: (id) => { devices.delete(id); },
    };
}

module.exports = { createElgatoDriver, PORT };
