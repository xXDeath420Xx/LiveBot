'use strict';
/*
 * A mock Philips Hue bridge over HTTPS on 127.0.0.1 with a `selfsigned` certificate.
 *
 *   const m = await startHueMock({ mode: 'v2'|'v1', pressAfter: 2, bridgeid, username })
 *     → { port, address, fingerprint, state, requests[], connections, pressLink(), close() }
 * pressAfter: how many POST /api answer error 101 ("link button not pressed") before the pairing succeeds
 * (Infinity: never). v1 mode answers 404 on /clip/v2 like a bridge without CLIP v2.
 * v2 resources: two lights (1: colour + white, 2: colour only, no color_temperature), one room with its grouped_light,
 * two scenes. requests[] keeps { method, url, key (the hue-application-key header), body }.
 */
const https = require('node:https');
const crypto = require('node:crypto');
const selfsigned = require('selfsigned');

let certCache = null;
async function cert(fresh = false) {
    if (certCache && !fresh) return certCache;
    const p = await selfsigned.generate([{ name: 'commonName', value: 'hue-bridge-mock' }], { keySize: 2048, algorithm: 'sha256' });
    const c = { key: p.private, cert: p.cert, fingerprint: new crypto.X509Certificate(p.cert).fingerprint256 };
    if (!fresh) certCache = c;
    return c;
}

function freshState() {
    return {
        lights: {
            'aaaa1111-0000-4000-8000-000000000001': { name: 'Desk lamp', on: false, bri: 40, xy: { x: 0.3, y: 0.3 }, mirek: 300, mirekValid: true, color: true, ct: true },
            'aaaa1111-0000-4000-8000-000000000002': { name: 'Strip', on: true, bri: 80, xy: { x: 0.6, y: 0.3 }, mirek: null, mirekValid: false, color: true, ct: false },
        },
        groups: { 'bbbb2222-0000-4000-8000-000000000001': { owner: 'cccc3333-0000-4000-8000-000000000001', on: false, bri: 50 } },
        rooms: { 'cccc3333-0000-4000-8000-000000000001': 'Office' },
        scenes: {
            'dddd4444-0000-4000-8000-000000000001': { name: 'Relax', group: 'cccc3333-0000-4000-8000-000000000001' },
            'dddd4444-0000-4000-8000-000000000002': { name: 'Energize', group: 'cccc3333-0000-4000-8000-000000000001' },
        },
        recalled: [],
        v1: {
            lights: { 1: { name: 'Old lamp', state: { on: true, bri: 127, xy: [0.4, 0.4], ct: 300, colormode: 'ct' }, capabilities: { control: { ct: { min: 153, max: 454 } } } } },
            groups: { 1: { name: 'Living room', type: 'Room', action: { on: true, bri: 127 } } },
            scenes: { AbC123: { name: 'Read', group: '1' } },
        },
    };
}

async function startHueMock({ mode = 'v2', pressAfter = 2, bridgeid = '001788fffe123456', username = 'mockUsernameAbcdefghijklmnop0123', freshCert = false } = {}) {
    const c = await cert(freshCert);
    const state = freshState();
    const requests = [];
    let posts = 0;
    let connections = 0;
    let pressed = false;
    const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

    const server = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            let json = null; try { json = body ? JSON.parse(body) : null; } catch { json = null; }
            const key = req.headers['hue-application-key'] || null;
            requests.push({ method: req.method, url: req.url, key, body: json });
            const url = req.url;
            if (req.method === 'GET' && url === '/api/config') return send(res, 200, { name: 'Mock bridge', bridgeid: bridgeid.toUpperCase(), modelid: 'BSB002', apiversion: '1.60.0' });
            if (req.method === 'POST' && url === '/api') {
                posts++;
                if (!json?.devicetype || !/^certifried_studio#/.test(json.devicetype)) return send(res, 200, [{ error: { type: 7, address: '/devicetype', description: 'invalid value' } }]);
                if (!pressed && posts <= pressAfter) return send(res, 200, [{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
                return send(res, 200, [{ success: { username, clientkey: '0123456789ABCDEF0123456789ABCDEF' } }]);
            }
            if (url.startsWith('/clip/v2/')) {
                if (mode === 'v1') return send(res, 404, undefined);
                if (key !== username) return send(res, 403, { errors: [{ description: 'unauthorized user' }] });
                const m = url.match(/^\/clip\/v2\/resource\/([a-z_]+)(?:\/([0-9a-f-]+))?$/);
                if (!m) return send(res, 404, { errors: [{ description: 'not found' }] });
                const [, type, rid] = m;
                const lightRes = (id, l) => ({
                    id, type: 'light', metadata: { name: l.name, archetype: 'classic_bulb' }, on: { on: l.on }, dimming: { brightness: l.bri },
                    ...(l.color ? { color: { xy: l.xy, gamut_type: 'C' } } : {}),
                    ...(l.ct ? { color_temperature: { mirek: l.mirek, mirek_valid: l.mirekValid, mirek_schema: { mirek_minimum: 153, mirek_maximum: 454 } } } : {}),
                });
                if (req.method === 'GET') {
                    if (type === 'light') {
                        const list = Object.entries(state.lights).filter(([id]) => !rid || id === rid).map(([id, l]) => lightRes(id, l));
                        return rid && !list.length ? send(res, 404, { errors: [{ description: 'not found' }] }) : send(res, 200, { errors: [], data: list });
                    }
                    if (type === 'grouped_light') return send(res, 200, { errors: [], data: Object.entries(state.groups).filter(([id]) => !rid || id === rid).map(([id, g]) => ({ id, type: 'grouped_light', owner: { rid: g.owner, rtype: 'room' }, on: { on: g.on }, dimming: { brightness: g.bri } })) });
                    if (type === 'room') return send(res, 200, { errors: [], data: Object.entries(state.rooms).map(([id, name]) => ({ id, type: 'room', metadata: { name } })) });
                    if (type === 'zone') return send(res, 200, { errors: [], data: [] });
                    if (type === 'scene') return send(res, 200, { errors: [], data: Object.entries(state.scenes).map(([id, s]) => ({ id, type: 'scene', metadata: { name: s.name }, group: { rid: s.group, rtype: 'room' } })) });
                    return send(res, 404, { errors: [{ description: 'not found' }] });
                }
                if (req.method === 'PUT') {
                    if (type === 'light' && state.lights[rid]) {
                        const l = state.lights[rid];
                        if (json.on) l.on = json.on.on;
                        if (json.dimming) l.bri = json.dimming.brightness;
                        if (json.color) { if (!l.color) return send(res, 400, { errors: [{ description: 'color not supported' }] }); l.xy = json.color.xy; l.mirekValid = false; }
                        if (json.color_temperature) { l.mirek = json.color_temperature.mirek; l.mirekValid = true; }
                        l.lastDuration = json.dynamics?.duration ?? null;
                        return send(res, 200, { errors: [], data: [{ rid, rtype: 'light' }] });
                    }
                    if (type === 'grouped_light' && state.groups[rid]) {
                        const g = state.groups[rid];
                        if (json.on) g.on = json.on.on;
                        if (json.dimming) g.bri = json.dimming.brightness;
                        return send(res, 200, { errors: [], data: [{ rid, rtype: 'grouped_light' }] });
                    }
                    if (type === 'scene' && state.scenes[rid] && json?.recall?.action === 'active') { state.recalled.push(rid); return send(res, 200, { errors: [], data: [{ rid, rtype: 'scene' }] }); }
                    return send(res, 404, { errors: [{ description: 'not found' }] });
                }
                return send(res, 405, { errors: [{ description: 'method not allowed' }] });
            }
            // CLIP v1
            const v = url.match(/^\/api\/([^/]+)\/(lights|groups|scenes)(?:\/([^/]+))?(?:\/(state|action))?$/);
            if (v) {
                if (v[1] !== username) return send(res, 200, [{ error: { type: 1, address: '/', description: 'unauthorized user' } }]);
                const coll = state.v1[v[2]];
                if (req.method === 'GET') return send(res, 200, v[3] ? coll[v[3]] : coll);
                if (req.method === 'PUT') {
                    if (v[2] === 'groups' && v[4] === 'action' && json?.scene) { state.recalled.push(json.scene); return send(res, 200, [{ success: { '/groups/0/action/scene': json.scene } }]); }
                    const item = coll[v[3]];
                    if (!item) return send(res, 200, [{ error: { type: 3, description: 'resource not available' } }]);
                    const st = v[2] === 'lights' ? item.state : item.action;
                    Object.assign(st, json);
                    if (json.ct) st.colormode = 'ct';
                    if (json.xy) st.colormode = 'xy';
                    return send(res, 200, Object.keys(json).map((k) => ({ success: { [`/${v[2]}/${v[3]}/${v[4]}/${k}`]: json[k] } })));
                }
            }
            return send(res, 404, [{ error: { type: 3, description: 'not available' } }]);
        });
    });
    server.on('secureConnection', () => { connections++; });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    return {
        port, address: `127.0.0.1:${port}`, fingerprint: c.fingerprint, state, requests, bridgeid, username,
        get connections() { return connections; },
        pressLink() { pressed = true; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}

module.exports = { startHueMock };
