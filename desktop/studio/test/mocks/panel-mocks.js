'use strict';
/*
 * Mock Nanoleaf panel and Elgato lights over plain HTTP on 127.0.0.1.
 *
 *   startNanoleafMock({ openAfter: 2, token }) → { port, address, state, requests[], close() }
 *     POST /api/v1/new answers 403 until `openAfter` tries were made (the power button not held yet), then { auth_token }.
 *     GET /api/v1/<t>/, GET|PUT /api/v1/<t>/state, GET /api/v1/<t>/effects/effectsList, GET /effects/select, PUT /effects.
 *   startElgatoMock({ strip: false, serial }) → { port, address, state, requests[], close() }
 *     GET /elgato/accessory-info, GET|PUT /elgato/lights.
 */
const http = require('node:http');

function serve(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            let json = null; try { json = body ? JSON.parse(body) : null; } catch { json = null; }
            requests.push({ method: req.method, url: req.url, body: json });
            const send = (status, obj) => { res.writeHead(status, obj === undefined ? {} : { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
            handler(req, json, send);
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, address: `127.0.0.1:${port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    }));
}

async function startNanoleafMock({ openAfter = 2, token = 'nanoTOKENabcdefghijklmnopqrstuv12' } = {}) {
    const state = {
        on: { value: false }, brightness: { value: 30, max: 100, min: 0 }, hue: { value: 120, max: 360, min: 0 }, sat: { value: 50, max: 100, min: 0 },
        ct: { value: 4000, max: 6500, min: 1200 }, colorMode: 'hs', select: 'Northern Lights', effectsList: ['Northern Lights', 'Flames', 'Forest'], lastBody: null,
    };
    let tries = 0;
    const m = await serve((req, json, send) => {
        if (req.method === 'POST' && req.url === '/api/v1/new') { tries++; return tries <= openAfter ? send(403, undefined) : send(200, { auth_token: token }); }
        const u = req.url.match(/^\/api\/v1\/([^/]+)(\/.*)?$/);
        if (!u) return send(404, undefined);
        if (u[1] !== token) return send(401, undefined);
        const rest = u[2] || '/';
        const st = () => ({ on: state.on, brightness: state.brightness, hue: state.hue, sat: state.sat, ct: state.ct, colorMode: state.colorMode });
        if (req.method === 'GET' && rest === '/') return send(200, { name: 'Shapes 1A2B', serialNo: 'S19124C8036', manufacturer: 'Nanoleaf', model: 'NL42', state: st(), effects: { select: state.select, effectsList: state.effectsList } });
        if (req.method === 'GET' && rest === '/state') return send(200, st());
        if (req.method === 'PUT' && rest === '/state') {
            state.lastBody = json;
            if (json.on) state.on = { value: !!json.on.value };
            if (json.brightness) state.brightness = { ...state.brightness, value: json.brightness.value };
            if (json.hue) { state.hue = { ...state.hue, value: json.hue.value }; state.colorMode = 'hs'; }
            if (json.sat) state.sat = { ...state.sat, value: json.sat.value };
            if (json.ct) { state.ct = { ...state.ct, value: json.ct.value }; state.colorMode = 'ct'; }
            return send(204, undefined);
        }
        if (req.method === 'GET' && rest === '/effects/effectsList') return send(200, state.effectsList);
        if (req.method === 'GET' && rest === '/effects/select') return send(200, state.select);
        if (req.method === 'PUT' && rest === '/effects') {
            if (!state.effectsList.includes(json?.select)) return send(404, undefined);
            state.select = json.select; state.colorMode = 'effect'; state.on = { value: true };
            return send(204, undefined);
        }
        return send(404, undefined);
    });
    return { ...m, state, token };
}

async function startElgatoMock({ strip = false, serial = 'BW33K1A01234' } = {}) {
    const state = strip ? { on: 0, brightness: 40, hue: 30, saturation: 80 } : { on: 0, brightness: 20, temperature: 200 };
    const m = await serve((req, json, send) => {
        if (req.method === 'GET' && req.url === '/elgato/accessory-info') return send(200, { productName: strip ? 'Elgato Light Strip' : 'Elgato Key Light', hardwareBoardType: 53, firmwareVersion: '1.0.3', serialNumber: serial, displayName: strip ? 'Shelf strip' : 'Key Light Left', features: ['lights'] });
        if (req.url === '/elgato/lights') {
            if (req.method === 'PUT') {
                const l = json?.lights?.[0];
                if (!l) return send(400, undefined);
                if (!strip && ('hue' in l || 'saturation' in l)) return send(400, undefined);
                Object.assign(state, l);
            }
            if (req.method === 'GET' || req.method === 'PUT') return send(200, { numberOfLights: 1, lights: [{ ...state }] });
        }
        return send(404, undefined);
    });
    return { ...m, state };
}

module.exports = { startNanoleafMock, startElgatoMock };
