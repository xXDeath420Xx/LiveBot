'use strict';
/*
 * Run the app against demo services: the mock OBS from test/mock-obs.js, a fake CertiFried engine on 127.0.0.1, and the light
 * mocks from test/mocks with the fake Litra and Voicemeeter (the device sandbox). Nothing real is touched (the app's settings
 * go to a throwaway folder; no packet reaches the LAN).
 *
 *   node scripts/demo.js [captureDir]     with captureDir: screenshots of every tab and theme, then exit
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const dgram = require('node:dgram');
const { startMockObs } = require('../test/mock-obs');
const { startGoveeMock } = require('../test/mocks/govee-mock');
const { startLifxMock } = require('../test/mocks/lifx-mock');
const { startNanoleafMock, startElgatoMock } = require('../test/mocks/panel-mocks');

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

    const listenPort = await new Promise((r) => { const u = dgram.createSocket('udp4'); u.bind(0, '127.0.0.1', () => { const p = u.address().port; u.close(() => r(p)); }); });
    const govee = await startGoveeMock({ listenPort, mac: '1F:80:C5:32:32:36:72:4E', sku: 'H6199' });
    const lifx = await startLifxMock({ bulbs: [{ mac: 'd073d5000001', label: 'Shelf lamp' }] });
    const nano = await startNanoleafMock({ openAfter: 1 });
    const keyLight = await startElgatoMock();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-demo-'));
    const sandboxFile = path.join(userData, 'sandbox.json');
    fs.mkdirSync(path.join(userData, 'sandbox-documents', 'Voicemeeter'), { recursive: true });
    for (const f of ['Streaming.xml', 'Just Chatting.xml']) fs.writeFileSync(path.join(userData, 'sandbox-documents', 'Voicemeeter', f), '<VBAudioVoicemeeterSettings/>');
    fs.writeFileSync(sandboxFile, JSON.stringify({ govee: { host: '127.0.0.1', scanPort: govee.scanPort, listenPort, controlPort: govee.controlPort },
        lifx: { host: '127.0.0.1', port: lifx.port }, nanoleaf: [{ address: nano.address }], elgato: [{ address: keyLight.address }], litra: 'fake', voicemeeter: 'fake' }));
    fs.mkdirSync(path.join(userData, 'Sounds'), { recursive: true });
    for (const f of ['Airhorn.mp3', 'Applause.wav', 'Drum roll.ogg']) fs.writeFileSync(path.join(userData, 'Sounds', f), '');
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
        server: `http://127.0.0.1:${enginePort}`,
        device: { id: 7, name: 'Streaming PC', pairedAt: new Date().toISOString() },
        obs: { enabled: true, host: '127.0.0.1', port: obs.port },
        lights: { enabled: true }, voicemeeter: { enabled: true }, streamdeck: { enabled: true, port: 39790 },
        hotkeys: [
            { id: 'h1', accelerator: 'Ctrl+Shift+F1', label: '', enabled: true, action: { kind: 'automation', automationId: 1, automationName: 'BRB' } },
            { id: 'h2', accelerator: 'F13', label: '', enabled: true, action: { kind: 'action', type: 'sound.play', params: { sound: 'Airhorn.mp3', volume: 80 } } },
            { id: 'h3', accelerator: 'Ctrl+Alt+M', label: '', enabled: true, action: { kind: 'action', type: 'obs.mute', params: { input: 'Mic', state: 'toggle' } } },
        ],
    }, null, 2));

    const electron = require('electron');
    const env = { ...process.env, CF_STUDIO_USER_DATA: userData, CF_STUDIO_DEMO: '1', CF_STUDIO_DEMO_TOKEN: TOKEN, CF_STUDIO_DEVICE_SANDBOX: sandboxFile, CF_STUDIO_CAPTURE_WAIT: '7000' };
    if (capture) env.CF_STUDIO_CAPTURE_DIR = capture;
    const child = spawn(electron, [path.join(__dirname, '..')], { env, stdio: 'inherit' });
    child.on('exit', async (code) => {
        await obs.close();
        for (const m of [govee, lifx, nano, keyLight]) await m.close().catch(() => {});
        wss.close();
        fs.rmSync(userData, { recursive: true, force: true });
        process.exit(code ?? 0);
    });
})();
