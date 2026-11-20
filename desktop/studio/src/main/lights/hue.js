'use strict';
/*
 * Philips Hue bridges, plain REST ("basic mode", no Entertainment API).
 *
 *   createHueDriver({ logger, sandbox, config, transports, mdns, hostName, setTimer, now, timeoutMs, pairTimeoutMs, pairIntervalMs })
 *     → { id: 'hue', discover, list, restore, addManual, pair, forget, getState, setState, scene, close }
 *
 * Ids: bridge 'hue:<bridgeId>' (kind 'bridge'), light 'hue:<bridgeId>/<lightRid>', room or zone
 * 'hue:<bridgeId>/group/<groupedLightRid>' (kind 'group'). With CLIP v1 the rids are the v1 numbers.
 *
 * Discovery: mDNS `_hue._tcp.local` (TXT bridgeid) or the sandbox's addresses; addManual(ip) reads GET /api/config
 * (no key) for the bridge id. Pairing: POST /api {"devicetype":"certifried_studio#<host>","generateclientkey":true},
 * retried every 2 s for 30 s while the bridge answers error 101 (link button not pressed). The username is kept with
 * config.setSecret('dev:hue:<bridgeId>'); the client key is not needed and not kept.
 *
 * CLIP v2: https://<ip>/clip/v2/resource/{light,grouped_light,room,zone,scene}, header hue-application-key.
 * Colour as CIE xy clamped into the light's gamut (Gamut C when it does not say), dimming.brightness 0-100,
 * color_temperature.mirek inside the light's mirek_schema (153-500 by default), dynamics.duration for transitions,
 * scenes recalled with { recall: { action: 'active' } }. When GET /clip/v2/resource/light answers 404 the bridge has
 * no v2 and CLIP v1 is used: /api/<user>/lights/<n>/state and /groups/<n>/action with on, bri 1-254, xy, ct,
 * transitiontime (100 ms steps); scenes with { scene: <id> } on the scene's group (0 when it has none).
 *
 * TLS: the bridge certificate is self-signed (or Signify-signed), so it is pinned instead of verified: the SHA-256
 * fingerprint seen when pairing is saved in settings (lights.hue.bridges[].certSha256). Every request first opens the
 * TLS connection, compares the fingerprint, and only then sends anything on that same socket; a different certificate
 * throws cert_changed (forget the bridge and pair again) and nothing is sent. The key is never sent without a pin.
 */
const os = require('node:os');
const { codeError, clamp, guardHost, isLanIPv4, parseAddress, formatAddress, safeId, httpRequest, sleep } = require('./util');
const { rgbToXy, xyToRgb, kelvinToMirek, mirekToKelvin } = require('./color');

const PORT = 443;
const MAX_SCENES = 100;
const CERT_CHANGED = 'The Hue bridge\'s certificate changed. Forget the bridge in Studio and pair it again.';

function cleanHost(name) {
    return String(name || 'pc').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 19) || 'pc';
}

function createHueDriver({
    logger = null, sandbox = null, config = null, transports = {}, mdns = null, hostName = null,
    setTimer = setTimeout, now = Date.now, timeoutMs = 4000, pairTimeoutMs = 30000, pairIntervalMs = 2000,
} = {}) {
    const https = transports.https || require('node:https');
    const tls = transports.tls || require('node:tls');
    const bridges = new Map();   // bridgeId → { id, host, port, name, model, api, online, error, lights: Map, groups: Map, scenes: [] }
    let lastNotes = [];
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[lights] ${m}`, meta); } catch { /* ignore */ } };
    const secretName = (bid) => `dev:hue:${bid}`;
    const userOf = (b) => { try { return config?.getSecret?.(secretName(b.id)) || null; } catch { return null; } };

    /* ---------- pins ---------- */
    function pins() {
        const list = config?.get?.()?.lights?.hue?.bridges;
        return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string') : [];
    }
    function pinOf(bid) { return pins().find((p) => p.id === bid)?.certSha256 || null; }
    function savePin(b, fp) {
        const rest = pins().filter((p) => p.id !== b.id);
        config?.update?.({ lights: { hue: { bridges: [...rest, { id: b.id, address: formatAddress(b.host, b.port, PORT), certSha256: fp }].slice(-20) } } });
    }
    function dropPin(bid) {
        const rest = pins().filter((p) => p.id !== bid);
        config?.update?.({ lights: { hue: { bridges: rest } } });
    }

    /** Opens TLS, reads the fingerprint, and checks it against the pin (when the bridge id and a pin are known). */
    function connect(host, port, bid) {
        guardHost(sandbox, host);
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(t); fn(v); } };
            const sock = tls.connect({ host, port, rejectUnauthorized: false });
            const t = setTimeout(() => { sock.destroy(); done(reject, codeError('device_unreachable', 'The Hue bridge did not answer in time')); }, timeoutMs);
            sock.once('error', (e) => done(reject, codeError('device_unreachable', `Could not reach the Hue bridge (${String(e?.code || 'error').slice(0, 30)})`)));
            sock.once('secureConnect', () => {
                const fp = sock.getPeerCertificate()?.fingerprint256 || null;
                if (!fp) { sock.destroy(); done(reject, codeError('device_unreachable', 'The Hue bridge sent no certificate')); return; }
                const pin = bid ? pinOf(bid) : null;
                if (pin && pin !== fp) { sock.destroy(); done(reject, codeError('cert_changed', CERT_CHANGED)); return; }
                done(resolve, { sock, fp, pinned: !!pin });
            });
        });
    }

    /** One request on a verified socket. opts.key: send the application key (refused unless the pin matched). */
    async function request(b, method, path, body, { key = null, v1User = null } = {}) {
        const { sock, fp, pinned } = await connect(b.host, b.port, b.id);
        if ((key || v1User) && !pinned) { sock.destroy(); throw codeError('needs_pairing', 'Pair the Hue bridge again (its certificate is not pinned)'); }
        const headers = key ? { 'hue-application-key': key } : {};
        try {
            const res = await httpRequest({ http: https, method, host: b.host, port: b.port, path, body, headers, timeoutMs, createConnection: () => sock });
            res.fp = fp;
            return res;
        } finally { sock.destroy(); }
    }

    /* ---------- bridges and resources ---------- */
    function bridgeDevice(b) {
        return {
            id: `hue:${b.id}`, driver: 'hue', name: b.name || 'Hue bridge', model: b.model || 'Hue bridge', address: formatAddress(b.host, b.port, PORT),
            online: !!b.online, caps: { power: false, brightness: false, color: false, white: null, scenes: b.scenes.map((s) => s.name).slice(0, MAX_SCENES), effects: [] },
            needsPairing: !userOf(b), kind: 'bridge',
        };
    }

    function ensureBridge(bid, host, port, extra = {}) {
        const id = safeId(String(bid).toLowerCase());
        let b = bridges.get(id);
        if (!b) {
            b = { id, host, port, name: null, model: null, api: null, online: false, error: null, lights: new Map(), groups: new Map(), scenes: [] };
            bridges.set(id, b);
        }
        if (host) { b.host = host; b.port = port || PORT; }
        Object.assign(b, extra);
        return b;
    }

    async function readConfig(host, port) {
        const fake = { id: null, host, port };
        const res = await request(fake, 'GET', '/api/config');
        const bid = typeof res.json?.bridgeid === 'string' ? res.json.bridgeid.toLowerCase() : null;
        if (!bid || !/^[0-9a-f]{12,16}$/.test(bid)) throw codeError('driver_error', 'That address did not answer like a Hue bridge');
        const pin = pinOf(safeId(bid));
        if (pin && pin !== res.fp) throw codeError('cert_changed', CERT_CHANGED);
        return { bid, name: typeof res.json.name === 'string' ? res.json.name.slice(0, 80) : null, model: typeof res.json.modelid === 'string' ? res.json.modelid.slice(0, 40) : null };
    }

    function whiteFromSchema(ct) {
        if (!ct) return null;
        const s = ct.mirek_schema || {};
        const minM = clamp(Number(s.mirek_minimum) || 153, 100, 1000);
        const maxM = clamp(Number(s.mirek_maximum) || 500, minM, 1000);
        return { min: mirekToKelvin(maxM), max: mirekToKelvin(minM), minMirek: minM, maxMirek: maxM };
    }

    function lightDevice(b, rid, name, caps, kind) {
        return {
            id: kind === 'group' ? `hue:${b.id}/group/${rid}` : `hue:${b.id}/${rid}`, driver: 'hue', name: String(name || 'Hue light').slice(0, 80),
            model: kind === 'group' ? 'Hue room' : 'Hue light', address: formatAddress(b.host, b.port, PORT), online: true,
            caps: { power: true, brightness: !!caps.brightness, color: !!caps.color, white: caps.white ? { min: caps.white.min, max: caps.white.max } : null, scenes: (caps.scenes || []).slice(0, MAX_SCENES), effects: [] },
            needsPairing: false, kind,
        };
    }

    async function loadV2(b, key) {
        const get = async (type) => {
            const res = await request(b, 'GET', `/clip/v2/resource/${type}`, undefined, { key });
            if (res.status === 401 || res.status === 403) throw codeError('needs_pairing', 'The Hue bridge no longer accepts the saved pairing; pair it again');
            if (res.status === 404 && type === 'light') return null;
            if (res.status !== 200) throw codeError('driver_error', `The Hue bridge answered ${res.status}`);
            return Array.isArray(res.json?.data) ? res.json.data.slice(0, 500) : [];
        };
        const lights = await get('light');
        if (lights === null) return false;
        const grouped = await get('grouped_light');
        const rooms = [...await get('room'), ...await get('zone')];
        const scenes = await get('scene');
        b.scenes = scenes.filter((s) => typeof s?.id === 'string').map((s) => ({ id: s.id, name: String(s.metadata?.name || '').slice(0, 80), group: s.group?.rid || null })).filter((s) => s.name);
        b.lights = new Map();
        for (const l of lights) {
            if (typeof l?.id !== 'string') continue;
            const white = whiteFromSchema(l.color_temperature);
            b.lights.set(l.id, { rid: l.id, gamut: l.color?.gamut || null, white, dev: lightDevice(b, l.id, l.metadata?.name, { brightness: !!l.dimming, color: !!l.color, white }, 'light') });
        }
        b.groups = new Map();
        for (const g of grouped) {
            if (typeof g?.id !== 'string' || !['room', 'zone'].includes(g.owner?.rtype)) continue;
            const owner = rooms.find((r) => r?.id === g.owner.rid);
            const sc = b.scenes.filter((s) => s.group === g.owner.rid).map((s) => s.name);
            b.groups.set(g.id, { rid: g.id, owner: g.owner.rid, white: { min: 2000, max: 6500, minMirek: 153, maxMirek: 500 }, dev: lightDevice(b, g.id, owner?.metadata?.name || 'Hue room', { brightness: true, color: true, white: { min: 2000, max: 6500 }, scenes: sc }, 'group') });
        }
        return true;
    }

    async function loadV1(b, user) {
        const get = async (what) => {
            const res = await request(b, 'GET', `/api/${encodeURIComponent(user)}/${what}`, undefined, { v1User: user });
            if (Array.isArray(res.json) && res.json[0]?.error?.type === 1) throw codeError('needs_pairing', 'The Hue bridge no longer accepts the saved pairing; pair it again');
            if (res.status !== 200 || !res.json || typeof res.json !== 'object') throw codeError('driver_error', `The Hue bridge answered ${res.status}`);
            return res.json;
        };
        const lights = await get('lights');
        const groups = await get('groups');
        const scenes = await get('scenes');
        b.scenes = Object.entries(scenes).slice(0, 500).map(([id, s]) => ({ id, name: String(s?.name || '').slice(0, 80), group: s?.group || null })).filter((s) => s.name && /^[A-Za-z0-9-]{1,40}$/.test(s.id));
        b.lights = new Map();
        for (const [n, l] of Object.entries(lights).slice(0, 200)) {
            if (!/^\d{1,4}$/.test(n)) continue;
            const ctc = l?.capabilities?.control?.ct;
            const hasCt = !!ctc || l?.state?.ct !== undefined;
            const white = hasCt ? whiteFromSchema({ mirek_schema: { mirek_minimum: ctc?.min, mirek_maximum: ctc?.max } }) : null;
            b.lights.set(n, { rid: n, gamut: null, white, dev: lightDevice(b, n, l?.name, { brightness: l?.state?.bri !== undefined, color: l?.state?.xy !== undefined, white }, 'light') });
        }
        b.groups = new Map();
        for (const [n, g] of Object.entries(groups).slice(0, 100)) {
            if (!/^\d{1,4}$/.test(n) || !['Room', 'Zone'].includes(g?.type)) continue;
            const sc = b.scenes.filter((s) => s.group === n).map((s) => s.name);
            b.groups.set(n, { rid: n, owner: n, white: { min: 2000, max: 6500, minMirek: 153, maxMirek: 500 }, dev: lightDevice(b, n, g?.name, { brightness: true, color: true, white: { min: 2000, max: 6500 }, scenes: sc }, 'group') });
        }
    }

    async function refresh(b) {
        const user = userOf(b);
        if (!user) return;
        try {
            if (b.api !== 'v1' && await loadV2(b, user)) b.api = 'v2';
            else { await loadV1(b, user); b.api = 'v1'; }
            b.online = true;
            b.error = null;
        } catch (e) {
            b.error = e.code;
            if (e.code === 'device_unreachable' || e.code === 'cert_changed') {
                b.online = false;
                for (const x of [...b.lights.values(), ...b.groups.values()]) x.dev.online = false;
            }
            throw e;
        }
    }

    async function discover({ timeoutMs: t = 3000 } = {}) {
        lastNotes = [];
        const found = [];
        const seen = new Set();
        let targets = [];
        if (sandbox) targets = (sandbox.hue || []).map((a) => ({ host: a.host, port: a.port, bid: null }));
        else if (mdns) {
            targets = (await mdns.browse('_hue._tcp.local', { timeoutMs: t }))
                .map((s) => ({ host: s.address, port: s.port || PORT, bid: typeof s.txt?.bridgeid === 'string' ? s.txt.bridgeid.toLowerCase() : null }))
                .filter((x) => x.bid && /^[0-9a-f]{12,16}$/.test(x.bid));
        }
        for (const tg of targets.slice(0, 10)) {
            let b;
            try {
                if (!tg.bid) {
                    const c = await readConfig(tg.host, tg.port);
                    b = ensureBridge(c.bid, tg.host, tg.port, { name: c.name, model: c.model });
                } else b = ensureBridge(tg.bid, tg.host, tg.port);
                b.online = true;
                seen.add(b.id);
                await refresh(b);
            } catch (e) {
                log('info', 'A Hue bridge could not be read', { code: e.code });
                if (e.code === 'cert_changed') lastNotes.push({ driver: 'hue', message: CERT_CHANGED });
                if (b) b.error = e.code;
            }
        }
        for (const b of bridges.values()) {
            if (seen.has(b.id)) {
                found.push(bridgeDevice(b));
                for (const x of [...b.lights.values(), ...b.groups.values()]) found.push({ ...x.dev, online: b.online });
            } else {
                b.online = false;
                for (const x of [...b.lights.values(), ...b.groups.values()]) x.dev.online = false;
            }
        }
        return found;
    }

    async function addManual(address) {
        const a = parseAddress(address, PORT);
        if (!a || !isLanIPv4(a.host)) throw codeError('bad_params', 'Enter the bridge\'s IPv4 address');
        const c = await readConfig(a.host, a.port);
        const b = ensureBridge(c.bid, a.host, a.port, { name: c.name, model: c.model, online: true });
        if (userOf(b)) await refresh(b).catch(() => {});
        return [bridgeDevice(b), ...[...b.lights.values(), ...b.groups.values()].map((x) => ({ ...x.dev }))];
    }

    function restore(entry) {
        if (!entry || typeof entry.id !== 'string') return;
        const m = entry.id.match(/^hue:([A-Za-z0-9._-]{1,80})(?:\/(group\/)?([A-Za-z0-9-]{1,40}))?$/);
        const a = parseAddress(String(entry.address || ''), PORT);
        if (!m || !a || !isLanIPv4(a.host)) return;
        const b = ensureBridge(m[1], bridges.has(m[1]) ? null : a.host, a.port);
        if (!m[3]) { if (entry.name) b.name = String(entry.name).slice(0, 80); return; }
        const kind = m[2] ? 'group' : 'light';
        const map = kind === 'group' ? b.groups : b.lights;
        if (map.has(m[3])) return;
        const caps = entry.caps || {};
        const white = caps.white && Number.isFinite(caps.white.min) ? { min: caps.white.min, max: caps.white.max, minMirek: kelvinToMirek(caps.white.max), maxMirek: kelvinToMirek(caps.white.min) } : null;
        const dev = lightDevice(b, m[3], entry.name, { brightness: caps.brightness !== false, color: !!caps.color, white, scenes: Array.isArray(caps.scenes) ? caps.scenes.filter((s) => typeof s === 'string') : [] }, kind);
        dev.online = false;
        map.set(m[3], { rid: m[3], gamut: null, white, owner: null, dev });
    }

    function parseId(id) {
        const m = String(id || '').match(/^hue:([A-Za-z0-9._-]{1,80})(?:\/(group\/)?([A-Za-z0-9-]{1,40}))?$/);
        if (!m) throw codeError('device_not_found');
        const b = bridges.get(m[1]);
        if (!b) throw codeError('device_not_found');
        if (!m[3]) return { b, kind: 'bridge', x: null };
        const kind = m[2] ? 'group' : 'light';
        const x = (kind === 'group' ? b.groups : b.lights).get(m[3]);
        if (!x) throw codeError('device_not_found');
        return { b, kind, x };
    }

    async function ready(b) {
        const user = userOf(b);
        if (!user) throw codeError('needs_pairing', 'Pair the Hue bridge first (press its link button)');
        if (!b.api) await refresh(b);
        return user;
    }

    function checkV2(res) {
        if (res.status === 401 || res.status === 403) throw codeError('needs_pairing', 'The Hue bridge no longer accepts the saved pairing; pair it again');
        if (res.status === 404) throw codeError('device_not_found', 'The Hue bridge no longer has that light');
        const errs = Array.isArray(res.json?.errors) ? res.json.errors : [];
        if (res.status >= 300 || errs.length) throw codeError('driver_error', `Hue: ${String(errs[0]?.description || res.status).slice(0, 160)}`);
        return res.json;
    }
    function checkV1(res) {
        const e = Array.isArray(res.json) ? res.json.find((r) => r?.error) : null;
        if (e?.error?.type === 1) throw codeError('needs_pairing', 'The Hue bridge no longer accepts the saved pairing; pair it again');
        if (res.status !== 200) throw codeError('driver_error', `The Hue bridge answered ${res.status}`);
        if (e && e.error.type !== 201) throw codeError('driver_error', `Hue: ${String(e.error.description || 'error').slice(0, 160)}`);
        return res.json;
    }

    async function withOnline(b, x, fn) {
        try {
            const v = await fn();
            b.online = true;
            if (x) x.dev.online = true;
            return v;
        } catch (e) {
            if (e.code === 'device_unreachable' || e.code === 'cert_changed') { b.online = false; if (x) x.dev.online = false; }
            throw e;
        }
    }

    async function getState(id) {
        const { b, kind, x } = parseId(id);
        if (kind === 'bridge') throw codeError('not_supported', 'A bridge has no light state');
        const user = await ready(b);
        return withOnline(b, x, async () => {
            if (b.api === 'v2') {
                const res = await request(b, 'GET', `/clip/v2/resource/${kind === 'group' ? 'grouped_light' : 'light'}/${x.rid}`, undefined, { key: user });
                const d = checkV2(res)?.data?.[0] || {};
                const ctValid = d.color_temperature?.mirek_valid && Number(d.color_temperature?.mirek) > 0;
                return {
                    on: !!d.on?.on,
                    brightness: clamp(Math.round(Number(d.dimming?.brightness) || 0), 0, 100),
                    color: !ctValid && d.color?.xy ? xyToRgb(d.color.xy.x, d.color.xy.y) : null,
                    kelvin: ctValid ? mirekToKelvin(d.color_temperature.mirek) : null,
                };
            }
            const res = await request(b, 'GET', `/api/${encodeURIComponent(user)}/${kind === 'group' ? 'groups' : 'lights'}/${x.rid}`, undefined, { v1User: user });
            checkV1(res);
            const st = (kind === 'group' ? res.json?.action : res.json?.state) || {};
            const mode = st.colormode;
            return {
                on: !!st.on,
                brightness: clamp(Math.round(((Number(st.bri) || 0) / 254) * 100), 0, 100),
                color: mode !== 'ct' && Array.isArray(st.xy) ? xyToRgb(st.xy[0], st.xy[1]) : null,
                kelvin: mode === 'ct' && Number(st.ct) > 0 ? mirekToKelvin(st.ct) : null,
            };
        });
    }

    async function setState(id, s = {}) {
        const { b, kind, x } = parseId(id);
        if (kind === 'bridge') throw codeError('not_supported', 'Choose a light or a room on the bridge');
        const user = await ready(b);
        const ms = Math.round(clamp(s.transitionMs || 0, 0, 600000));
        const w = x.white || { minMirek: 153, maxMirek: 500 };
        return withOnline(b, x, async () => {
            if (b.api === 'v2') {
                const body = {};
                if (s.on === true || s.on === false) body.on = { on: s.on };
                if (Number.isFinite(s.brightness)) body.dimming = { brightness: clamp(Math.round(s.brightness * 100) / 100, 1, 100) };
                if (Number.isFinite(s.kelvin)) body.color_temperature = { mirek: Math.round(clamp(kelvinToMirek(s.kelvin), w.minMirek, w.maxMirek)) };
                else if (s.color) body.color = { xy: rgbToXy(s.color, x.gamut) };
                if (ms) body.dynamics = { duration: ms };
                if (!Object.keys(body).length) return;
                checkV2(await request(b, 'PUT', `/clip/v2/resource/${kind === 'group' ? 'grouped_light' : 'light'}/${x.rid}`, body, { key: user }));
                return;
            }
            const body = {};
            if (s.on === false) body.on = false;
            else {
                if (s.on === true) body.on = true;
                if (Number.isFinite(s.brightness)) body.bri = Math.round(clamp((s.brightness / 100) * 254, 1, 254));
                if (Number.isFinite(s.kelvin)) body.ct = Math.round(clamp(kelvinToMirek(s.kelvin), w.minMirek, w.maxMirek));
                else if (s.color) { const xy = rgbToXy(s.color, x.gamut); body.xy = [xy.x, xy.y]; }
            }
            body.transitiontime = Math.round(ms / 100);
            const path = kind === 'group' ? `groups/${x.rid}/action` : `lights/${x.rid}/state`;
            checkV1(await request(b, 'PUT', `/api/${encodeURIComponent(user)}/${path}`, body, { v1User: user }));
        });
    }

    async function scene(id, name, { transitionMs = 0 } = {}) {
        const { b, kind, x } = parseId(id);
        const user = await ready(b);
        const want = String(name || '').trim().toLowerCase();
        if (!want) throw codeError('bad_params', 'Choose a scene');
        const pool = kind === 'group' ? b.scenes.filter((s) => s.group === x.owner) : b.scenes;
        const match = pool.find((s) => s.name.toLowerCase() === want);
        if (!match) throw codeError('scene_not_found', 'No Hue scene with that name here');
        const ms = Math.round(clamp(transitionMs, 0, 600000));
        return withOnline(b, x, async () => {
            if (b.api === 'v2') {
                checkV2(await request(b, 'PUT', `/clip/v2/resource/scene/${match.id}`, { recall: ms ? { action: 'active', duration: ms } : { action: 'active' } }, { key: user }));
            } else {
                const gid = match.group && /^\d{1,4}$/.test(match.group) ? match.group : '0';
                checkV1(await request(b, 'PUT', `/api/${encodeURIComponent(user)}/groups/${gid}/action`, { scene: match.id, transitiontime: Math.round(ms / 100) }, { v1User: user }));
            }
            return match.name;
        });
    }

    async function pair(id) {
        const m = String(id || '').match(/^hue:([A-Za-z0-9._-]{1,80})/);
        const b = m && bridges.get(m[1]);
        if (!b) throw codeError('device_not_found');
        const devicetype = `certifried_studio#${cleanHost(hostName || os.hostname())}`;
        const deadline = now() + pairTimeoutMs;
        let firstFp = null;
        for (;;) {
            let res;
            try { res = await request(b, 'POST', '/api', { devicetype, generateclientkey: true }); } catch (e) {
                if (e.code === 'cert_changed') return { ok: false, message: CERT_CHANGED };
                return { ok: false, message: 'Could not reach the Hue bridge. Check it is on and on the same network.' };
            }
            if (firstFp && res.fp !== firstFp) return { ok: false, message: CERT_CHANGED };
            firstFp = res.fp;
            const item = Array.isArray(res.json) ? res.json[0] : null;
            const user = item?.success?.username;
            if (typeof user === 'string' && /^[A-Za-z0-9-]{10,100}$/.test(user)) {
                if (!pinOf(b.id)) savePin(b, res.fp);
                config.setSecret(secretName(b.id), user);
                b.api = null;
                try { await refresh(b); } catch (e) { log('info', 'Paired with a Hue bridge; reading its lights failed', { code: e.code }); }
                log('info', 'Paired with a Hue bridge', { bridge: b.id });
                return { ok: true, message: 'Paired with the Hue bridge.' };
            }
            if (item?.error?.type !== 101) return { ok: false, message: `The Hue bridge refused: ${String(item?.error?.description || res.status).slice(0, 120)}` };
            if (now() + pairIntervalMs > deadline) break;
            await sleep(setTimer, pairIntervalMs);
        }
        return { ok: false, message: 'Press the round link button on the Hue bridge, then press Pair again within 30 seconds.' };
    }

    function forget(id) {
        let parsed;
        try { parsed = parseId(id); } catch { return; }
        const { b, kind, x } = parsed;
        if (kind === 'bridge') {
            try { config?.setSecret?.(secretName(b.id), null); } catch { /* not saved */ }
            dropPin(b.id);
            bridges.delete(b.id);
        } else (kind === 'group' ? b.groups : b.lights).delete(x.rid);
    }

    function list() {
        const out = [];
        for (const b of bridges.values()) {
            out.push(bridgeDevice(b));
            for (const x of [...b.lights.values(), ...b.groups.values()]) out.push({ ...x.dev, caps: { ...x.dev.caps } });
        }
        return out;
    }

    return { id: 'hue', discover, list, restore, addManual, pair, forget, getState, setState, scene, notes: () => lastNotes.slice(), close() {} };
}

module.exports = { createHueDriver, PORT };
