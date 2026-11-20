/*
 * A mock CertiFried Studio bridge on 127.0.0.1 (random port) speaking the same protocol as Studio's
 * src/main/bridge-server.js: hello with token → welcome or auth_failed + 4401; request → response; state/obs pushes.
 *
 *   const studio = await startMockStudio({ token, handlers?, lockout?, port? })
 *     studio.port, studio.requests ([{ method, params }]), studio.hellos, studio.upgrades ([{ origin, host }])
 *     studio.push(msg)  studio.closeAll(code)  studio.setToken(t)  studio.close()
 */
import { WebSocketServer } from 'ws';

export const OBS = {
    scenes: ['Main', 'BRB', 'Starting Soon'],
    sources: { Main: ['Webcam', 'Alert Box'], BRB: ['Clock'] },
    inputs: ['Mic', 'Desktop Audio'],
};

export async function startMockStudio({ token = 'sdk_test-token-0123456789abcdef', handlers = {}, lockout = false, port: wantPort = 0 } = {}) {
    const state = { scene: 'Main', muted: { Mic: false, 'Desktop Audio': false }, visible: { 'Main\u0000Webcam': true }, counters: { deaths: 3, wins: 0 } };
    const base = {
        status: () => ({ obs: { connected: true, currentScene: state.scene } }),
        'automations.list': () => ({ automations: [{ id: 7, name: 'Hype train', enabled: true }, { id: 9, name: 'Raid', enabled: false }] }),
        'automations.run': (p) => ({ runId: 'run1', status: 'done', automationId: p.automationId }),
        'obs.scenes': () => ({ scenes: OBS.scenes, current: state.scene }),
        'obs.scene': (p) => { if (!OBS.scenes.includes(p.scene)) throw Object.assign(new Error('No such scene'), { code: 'scene_not_found' }); state.scene = p.scene; return { scene: p.scene }; },
        'obs.sources': (p) => ({ sources: OBS.sources[p.scene] || [] }),
        'obs.source': (p) => {
            const k = `${p.scene}\u0000${p.source}`;
            const v = p.state === 'show' ? true : p.state === 'hide' ? false : !state.visible[k];
            state.visible[k] = v;
            return { visible: v };
        },
        'obs.sourceState': (p) => ({ visible: !!state.visible[`${p.scene}\u0000${p.source}`] }),
        'obs.inputs': () => ({ inputs: OBS.inputs.map((name) => ({ name, kind: 'wasapi_input_capture' })) }),
        'obs.mute': (p) => {
            const m = p.state === 'mute' ? true : p.state === 'unmute' ? false : !state.muted[p.input];
            state.muted[p.input] = m;
            return { muted: m };
        },
        'obs.muteState': (p) => ({ muted: !!state.muted[p.input] }),
        'counters.list': () => ({ counters: Object.entries(state.counters).map(([name, value]) => ({ name, value })) }),
        'counters.add': (p) => { state.counters[p.counter] = (state.counters[p.counter] || 0) + p.amount; return { counter: p.counter, value: state.counters[p.counter] }; },
        'sounds.list': () => ({ sounds: [{ name: 'airhorn' }, { name: 'sad trombone' }] }),
        'sound.play': (p) => ({ sound: p.sound, started: true }),
        'lights.presets': () => ({ presets: [{ id: 'p1', name: 'Stream start' }, { id: 'p2', name: 'Chill' }] }),
        'lights.apply': (p) => ({ preset: p.preset, applied: 2 }),
    };
    const all = { ...base, ...handlers };
    let current = token;
    const requests = [];
    const hellos = [];
    const upgrades = [];
    const sockets = new Set();
    let port = 0;

    const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: wantPort,
        verifyClient: (info, cb) => {
            const h = info.req.headers;
            upgrades.push({ origin: h.origin, host: h.host });
            if (h.origin !== undefined || h.host !== `127.0.0.1:${port}`) return cb(false, 403);
            return cb(true);
        },
    });
    await new Promise((r) => wss.once('listening', r));
    port = wss.address().port;

    wss.on('connection', (ws) => {
        sockets.add(ws);
        let authed = false;
        ws.on('close', () => sockets.delete(ws));
        ws.on('message', async (data) => {
            const msg = JSON.parse(String(data));
            if (!authed) {
                hellos.push(msg);
                if (lockout) { ws.send(JSON.stringify({ type: 'error', code: 'locked_out' })); ws.close(4429, 'locked_out'); return; }
                if (msg.type !== 'hello' || msg.token !== current) { ws.send(JSON.stringify({ type: 'error', code: 'auth_failed' })); ws.close(4401, 'auth_failed'); return; }
                authed = true;
                ws.authed = true;
                ws.send(JSON.stringify({ type: 'welcome', proto: 1, studio: { version: '0.2.6' }, features: ['request', 'state', 'obs'], methods: Object.keys(all) }));
                return;
            }
            if (msg.type !== 'request') return;
            requests.push({ method: msg.method, params: msg.params });
            const fn = all[msg.method];
            if (!fn) { ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: 'unknown_method' })); return; }
            try {
                const result = await fn(msg.params || {});
                if (result === '__no_answer__') return;
                ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result }));
            } catch (e) {
                ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: e.code || 'failed', message: e.message }));
            }
        });
    });

    return {
        get port() { return port; },
        state,
        requests,
        hellos,
        upgrades,
        get clients() { return [...sockets].filter((s) => s.authed).length; },
        setToken(t) { current = t; },
        push(msg) { for (const s of sockets) if (s.authed) s.send(JSON.stringify(msg)); },
        closeAll(code = 1001) { for (const s of sockets) s.close(code); },
        close() { for (const s of sockets) s.terminate(); return new Promise((r) => wss.close(() => r())); },
    };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out');
        await sleep(10);
    }
}
