'use strict';
/*
 * Run the app against demo services: the mock OBS from test/mock-obs.js and a fake CertiFried engine on 127.0.0.1.
 * Nothing real is touched (the app's settings go to a throwaway folder).
 *
 *   node scripts/demo.js [captureDir]     with captureDir: screenshots of every tab and theme, then exit
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { startMockObs } = require('../test/mock-obs');

const TOKEN = `sbd_${'D'.repeat(43)}`;

(async () => {
    const capture = process.argv[2] ? path.resolve(process.argv[2]) : null;
    const obs = await startMockObs();   // no password: the demo never stores one
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const enginePort = wss.address().port;
    wss.on('connection', (ws) => ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'hello') ws.send(JSON.stringify({ type: 'welcome', proto: 1, deviceId: 7, kind: 'studio', heartbeatMs: 20000, serverTime: Date.now(), features: ['state', 'event', 'request'] }));
        else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
        else if (m.type === 'request') {
            const result = m.method === 'automations.list'
                ? { automations: [{ id: 1, name: 'BRB', enabled: true }, { id: 2, name: 'Follow alert', enabled: true }, { id: 3, name: 'Raid shout-out', enabled: true }] }
                : m.method === 'sounds.list' ? { sounds: [] } : null;
            ws.send(JSON.stringify(result ? { type: 'response', id: m.id, ok: true, result } : { type: 'response', id: m.id, ok: false, error: 'unknown_method' }));
        }
    }));

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-demo-'));
    fs.mkdirSync(path.join(userData, 'Sounds'), { recursive: true });
    for (const f of ['Airhorn.mp3', 'Applause.wav', 'Drum roll.ogg']) fs.writeFileSync(path.join(userData, 'Sounds', f), '');
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
        server: `http://127.0.0.1:${enginePort}`,
        device: { id: 7, name: 'Streaming PC', pairedAt: new Date().toISOString() },
        obs: { enabled: true, host: '127.0.0.1', port: obs.port },
        hotkeys: [
            { id: 'h1', accelerator: 'Ctrl+Shift+F1', label: '', enabled: true, action: { kind: 'automation', automationId: 1, automationName: 'BRB' } },
            { id: 'h2', accelerator: 'F13', label: '', enabled: true, action: { kind: 'action', type: 'sound.play', params: { sound: 'Airhorn.mp3', volume: 80 } } },
            { id: 'h3', accelerator: 'Ctrl+Alt+M', label: '', enabled: true, action: { kind: 'action', type: 'obs.mute', params: { input: 'Mic', state: 'toggle' } } },
        ],
    }, null, 2));

    const electron = require('electron');
    const env = { ...process.env, CF_STUDIO_USER_DATA: userData, CF_STUDIO_DEMO: '1', CF_STUDIO_DEMO_TOKEN: TOKEN };
    if (capture) env.CF_STUDIO_CAPTURE_DIR = capture;
    const child = spawn(electron, [path.join(__dirname, '..')], { env, stdio: 'inherit' });
    child.on('exit', async (code) => {
        await obs.close();
        wss.close();
        fs.rmSync(userData, { recursive: true, force: true });
        process.exit(code ?? 0);
    });
})();
