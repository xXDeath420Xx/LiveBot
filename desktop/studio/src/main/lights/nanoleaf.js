'use strict';
/*
 * Nanoleaf panels (Light Panels, Canvas, Shapes, Elements, Lines) over the Nanoleaf OpenAPI (HTTP, port 16021).
 *
 *   createNanoleafDriver({ logger, sandbox, config, transports, mdns, setTimer, now, timeoutMs, pairTimeoutMs, pairIntervalMs })
 *     → { id: 'nanoleaf', discover, list, restore, addManual, pair, forget, getState, setState, scene, close }
 *
 * Discovery: mDNS `_nanoleafapi._tcp.local` (TXT id, md = model) or the sandbox's addresses. A panel needs pairing:
 * hold its power button 5-7 seconds until the lights flash, then POST /api/v1/new answers { auth_token } (403 until the
 * panel is in pairing mode; retried every 2 s for 30 s). The token is kept with config.setSecret('dev:nanoleaf:<id>').
 * API: GET /api/v1/<token>/ (name, model, state, effects), PUT /api/v1/<token>/state
 * { on:{value}, brightness:{value, duration (s)}, hue:{value 0-360}, sat:{value 0-100}, ct:{value 1200-6500} },
 * GET /api/v1/<token>/effects/effectsList, GET /effects/select, PUT /effects { select }.
 * The token is in the URL path, so no path is ever logged; util.httpRequest keeps paths out of its errors.
 */
const { codeError, clamp, guardHost, isLanIPv4, parseAddress, formatAddress, safeId, httpRequest, sleep } = require('./util');
const { rgbToHsv, hsvToRgb } = require('./color');

const PORT = 16021;
const WHITE = Object.freeze({ min: 1200, max: 6500 });
const MAX_SCENES = 100;

function createNanoleafDriver({ logger = null, sandbox = null, config = null, transports = {}, mdns = null, setTimer = setTimeout, now = Date.now, timeoutMs = 3000, pairTimeoutMs = 30000, pairIntervalMs = 2000 } = {}) {
    const http = transports.http || require('node:http');
    const devices = new Map();   // id → { dev, host, port, key }
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };
    const secretName = (r) => `dev:nanoleaf:${r.key}`;
    const token = (r) => { try { return config?.getSecret?.(secretName(r)) || null; } catch { return null; } };

    async function call(r, method, path, body, tok) {
        guardHost(sandbox, r.host);
        const p = tok === undefined ? path : `/api/v1/${encodeURIComponent(tok)}${path}`;
        return httpRequest({ http, method, host: r.host, port: r.port, path: p, body, timeoutMs });
    }

    async function authed(r, method, path, body) {
        const tok = token(r);
        if (!tok) { r.dev.needsPairing = true; throw codeError('needs_pairing', 'Pair the Nanoleaf panel first'); }
        let res;
        try { res = await call(r, method, path, body, tok); } catch (e) { if (e.code === 'device_unreachable') r.dev.online = false; throw e; }
        r.dev.online = true;
        if (res.status === 401 || res.status === 403) { r.dev.needsPairing = true; throw codeError('needs_pairing', 'The Nanoleaf panel no longer accepts the saved pairing; pair it again'); }
        if (res.status < 200 || res.status >= 300) throw codeError('driver_error', `The Nanoleaf panel answered ${res.status}`);
        return res.json;
    }

    function register(host, port, txt = {}) {
        // Without the panel's own id, an opaque hash of its address: ids go to the dashboard, network addresses never do.
        const key = safeId(txt.id ? String(txt.id).replace(/:/g, '') : `a${require('node:crypto').createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 12)}`);
        const id = `nanoleaf:${key}`;
        let r = devices.get(id);
        if (!r) {
            r = {
                key, host, port,
                dev: {
                    id, driver: 'nanoleaf', name: 'Nanoleaf', model: String(txt.md || 'Nanoleaf').slice(0, 40), address: formatAddress(host, port, PORT), online: true,
                    caps: { power: true, brightness: true, color: true, white: { ...WHITE }, scenes: [], effects: [] }, needsPairing: true, kind: 'light',
                },
            };
            devices.set(id, r);
        } else { r.host = host; r.port = port; r.dev.address = formatAddress(host, port, PORT); r.dev.online = true; }
        return r;
    }

    async function refresh(r) {
        if (!token(r)) { r.dev.needsPairing = true; return; }
        const info = await authed(r, 'GET', '/');
        r.dev.needsPairing = false;
        if (info?.name) r.dev.name = String(info.name).slice(0, 80);
        if (info?.model) r.dev.model = String(info.model).slice(0, 40);
        const list = Array.isArray(info?.effects?.effectsList) ? info.effects.effectsList : [];
        r.dev.caps.scenes = list.filter((s) => typeof s === 'string').slice(0, MAX_SCENES).map((s) => s.slice(0, 80));
    }

    async function discover({ timeoutMs: t = 3000 } = {}) {
        let targets;
        if (sandbox) targets = (sandbox.nanoleaf || []).map((a) => ({ host: a.host, port: a.port, txt: {} }));
        else if (mdns) targets = (await mdns.browse('_nanoleafapi._tcp.local', { timeoutMs: t })).map((s) => ({ host: s.address, port: s.port || PORT, txt: s.txt }));
        else targets = [];
        const found = [];
        for (const tg of targets.slice(0, 20)) {
            const r = register(tg.host, tg.port, tg.txt);
            try { await refresh(r); } catch (e) { log('info', 'A Nanoleaf panel did not answer', { code: e.code }); }
            found.push({ ...r.dev, caps: { ...r.dev.caps } });
        }
        const seen = new Set(found.map((d) => d.id));
        for (const [id, r] of devices) if (!seen.has(id)) r.dev.online = false;
        return found;
    }

    async function addManual(address) {
        const a = parseAddress(address, PORT);
        if (!a || !isLanIPv4(a.host)) throw codeError('bad_params', 'Enter the panel\'s IPv4 address');
        guardHost(sandbox, a.host);
        const r = register(a.host, a.port);
        await refresh(r).catch(() => {});
        return [{ ...r.dev }];
    }

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string' || devices.has(entry.id)) return;
        const a = parseAddress(String(entry.address || ''), PORT);
        if (!a || !isLanIPv4(a.host)) return;
        const key = entry.id.slice('nanoleaf:'.length);
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(key)) return;
        const r = register(a.host, a.port, { id: key });
        if (r.dev.id !== entry.id) { devices.delete(r.dev.id); return; }
        r.dev.name = String(entry.name || 'Nanoleaf').slice(0, 80);
        r.dev.model = String(entry.model || 'Nanoleaf').slice(0, 40);
        r.dev.online = false;
        if (Array.isArray(entry.caps?.scenes)) r.dev.caps.scenes = entry.caps.scenes.filter((s) => typeof s === 'string').slice(0, MAX_SCENES);
        r.dev.needsPairing = !token(r);
    }

    function rec(id) {
        const r = devices.get(id);
        if (!r) throw codeError('device_not_found');
        return r;
    }

    async function pair(id) {
        const r = rec(id);
        const deadline = now() + pairTimeoutMs;
        for (;;) {
            let res = null;
            try { res = await call(r, 'POST', '/api/v1/new'); } catch (e) {
                if (e.code !== 'device_unreachable') throw e;
            }
            if (res && res.status >= 200 && res.status < 300 && typeof res.json?.auth_token === 'string' && /^[A-Za-z0-9._-]{8,200}$/.test(res.json.auth_token)) {
                config.setSecret(secretName(r), res.json.auth_token);
                r.dev.needsPairing = false;
                r.dev.online = true;
                try { await refresh(r); } catch { /* paired; details come with the next discovery */ }
                log('info', 'Paired with a Nanoleaf panel', { id: r.dev.id });
                return { ok: true, message: 'Paired with the Nanoleaf panel.' };
            }
            if (res && res.status !== 403 && res.status !== 401) return { ok: false, message: `The Nanoleaf panel answered ${res.status}.` };
            if (now() + pairIntervalMs > deadline) break;
            await sleep(setTimer, pairIntervalMs);
        }
        return { ok: false, message: 'Hold the Nanoleaf power button for 5 to 7 seconds until the lights flash, then press Pair again within 30 seconds.' };
    }

    function forget(id) {
        const r = devices.get(id);
        if (!r) return;
        try { config?.setSecret?.(secretName(r), null); } catch { /* not saved */ }
        devices.delete(id);
    }

    async function getState(id) {
        const r = rec(id);
        const st = await authed(r, 'GET', '/state');
        const mode = String(st?.colorMode || '');
        const out = { on: !!st?.on?.value, brightness: clamp(Math.round(Number(st?.brightness?.value) || 0), 0, 100), color: null, kelvin: null };
        if (mode === 'ct') out.kelvin = clamp(Math.round(Number(st?.ct?.value) || 4000), WHITE.min, WHITE.max);
        else if (mode === 'effect') {
            const sel = await authed(r, 'GET', '/effects/select').catch(() => null);
            if (typeof sel === 'string' && sel && !sel.startsWith('*')) out.scene = sel.slice(0, 80);
        } else out.color = hsvToRgb(Number(st?.hue?.value) || 0, Number(st?.sat?.value) || 0, 100);
        return out;
    }

    async function setState(id, s = {}) {
        const r = rec(id);
        const body = {};
        const dur = Math.round(clamp(s.transitionMs || 0, 0, 600000) / 1000);
        if (s.on === true || s.on === false) body.on = { value: s.on };
        if (Number.isFinite(s.kelvin)) body.ct = { value: Math.round(clamp(s.kelvin, WHITE.min, WHITE.max)) };
        else if (s.color) { const hsv = rgbToHsv(s.color); body.hue = { value: hsv.h }; body.sat = { value: hsv.s }; }
        if (Number.isFinite(s.brightness)) body.brightness = dur ? { value: Math.round(clamp(s.brightness, 0, 100)), duration: dur } : { value: Math.round(clamp(s.brightness, 0, 100)) };
        if (!Object.keys(body).length) return;
        await authed(r, 'PUT', '/state', body);
    }

    async function scene(id, name) {
        const r = rec(id);
        const want = String(name || '').trim().toLowerCase();
        if (!want) throw codeError('bad_params', 'Choose an effect');
        let list = r.dev.caps.scenes;
        if (!list.some((s) => s.toLowerCase() === want)) {
            const fresh = await authed(r, 'GET', '/effects/effectsList');
            list = Array.isArray(fresh) ? fresh.filter((s) => typeof s === 'string').slice(0, MAX_SCENES) : [];
            r.dev.caps.scenes = list;
        }
        const match = list.find((s) => s.toLowerCase() === want);
        if (!match) throw codeError('scene_not_found', 'No effect with that name on this Nanoleaf panel');
        await authed(r, 'PUT', '/effects', { select: match });
        return match;
    }

    return {
        id: 'nanoleaf',
        discover,
        list: () => [...devices.values()].map((r) => ({ ...r.dev, caps: { ...r.dev.caps } })),
        restore,
        addManual,
        pair,
        forget,
        getState,
        setState,
        scene,
        close() {},
    };
}

module.exports = { createNanoleafDriver, PORT };
