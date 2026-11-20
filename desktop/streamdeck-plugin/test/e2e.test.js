/*
 * The built plugin (com.certifried.studio.sdPlugin/bin/plugin.js, run `npm run build` first) started the way Stream Deck
 * starts it (-port -pluginUUID -registerEvent -info), against a fake Stream Deck socket and the mock Studio bridge, all
 * on 127.0.0.1. Runs from a temporary copy of the .sdPlugin folder so its logs stay out of the source tree.
 * Checks the SDK wiring: registration, global settings, willAppear → setState, keyDown → Studio request → showOk,
 * property inspector lists, and a token change from the property inspector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startMockStudio, until } from './mock-studio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SD = path.join(ROOT, 'com.certifried.studio.sdPlugin');
const built = fs.existsSync(path.join(SD, 'bin', 'plugin.js'));
const TOKEN = 'sdk_test-token-0123456789abcdef';

test('the bundled plugin talks to Stream Deck and Studio', { skip: built ? false : 'run npm run build first' }, async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const deck = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => deck.once('listening', r));
    const fromPlugin = [];
    let sock = null;
    deck.on('connection', (ws) => {
        sock = ws;
        ws.on('message', (d) => {
            const m = JSON.parse(String(d));
            fromPlugin.push(m);
            if (m.event === 'getGlobalSettings') {
                ws.send(JSON.stringify({ event: 'didReceiveGlobalSettings', id: m.id, payload: { settings: { port: studio.port, token: 'sdk_wrong' } } }));
            }
        });
    });
    const toPlugin = (m) => sock.send(JSON.stringify(m));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-sdplugin-'));
    fs.cpSync(SD, dir, { recursive: true });
    const info = {
        application: { font: 'Segoe UI', language: 'en', platform: 'windows', platformVersion: '10.0.26100', version: '7.1.0.22000' },
        plugin: { uuid: 'com.certifried.studio', version: '0.2.6.0' },
        devicePixelRatio: 1,
        colors: {},
        devices: [{ id: 'dev1', name: 'Test deck', size: { columns: 5, rows: 3 }, type: 0 }],
    };
    const child = spawn(process.execPath, [path.join(dir, 'bin', 'plugin.js'), '-port', String(deck.address().port), '-pluginUUID', 'com.certifried.studio',
        '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const action = (name) => `com.certifried.studio.${name}`;
    const appear = (ctx, name, settings) => toPlugin({ event: 'willAppear', action: action(name), context: ctx, device: 'dev1',
        payload: { controller: 'Keypad', coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings, state: 0 } });
    const sent = (pred) => until(() => fromPlugin.find(pred), 5000);

    try {
        assert.deepEqual(await sent((m) => m.event === 'registerPlugin'), { event: 'registerPlugin', uuid: 'com.certifried.studio' });
        await sent((m) => m.event === 'getGlobalSettings');
        await until(() => studio.hellos.length === 1, 5000);
        assert.equal(studio.hellos[0].token, 'sdk_wrong');
        assert.equal(studio.upgrades[0].origin, undefined, 'no Origin header');

        // The person pastes the right token in the property inspector.
        toPlugin({ event: 'didReceiveGlobalSettings', payload: { settings: { port: studio.port, token: TOKEN } } });
        await until(() => studio.clients === 1, 5000);

        appear('ctx1', 'switch-scene', { scene: 'Main' });
        appear('ctx2', 'counter', { counter: 'deaths', direction: 'up', step: 1 });
        await sent((m) => m.event === 'setState' && m.context === 'ctx1' && m.payload.state === 1);
        await sent((m) => m.event === 'setTitle' && m.context === 'ctx2' && m.payload.title === '3');

        toPlugin({ event: 'keyDown', action: action('switch-scene'), context: 'ctx1', device: 'dev1',
            payload: { controller: 'Keypad', coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: { scene: 'BRB' }, state: 1 } });
        await sent((m) => m.event === 'showOk' && m.context === 'ctx1');
        assert.ok(studio.requests.some((r) => r.method === 'obs.scene' && r.params.scene === 'BRB'));
        await sent((m) => m.event === 'setState' && m.context === 'ctx1' && m.payload.state === 0);

        toPlugin({ event: 'propertyInspectorDidAppear', action: action('switch-scene'), context: 'ctx1', device: 'dev1' });
        toPlugin({ event: 'sendToPlugin', action: action('switch-scene'), context: 'ctx1', payload: { event: 'list', kind: 'scenes' } });
        const list = await sent((m) => m.event === 'sendToPropertyInspector' && m.payload?.event === 'list');
        assert.equal(list.context, 'ctx1');
        assert.deepEqual(list.payload.items.map((i) => i.value), ['Main', 'BRB', 'Starting Soon']);

        toPlugin({ event: 'keyDown', action: action('switch-scene'), context: 'ctx1', device: 'dev1',
            payload: { controller: 'Keypad', coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: {}, state: 0 } });
        await sent((m) => m.event === 'showAlert' && m.context === 'ctx1');
        assert.equal(stderr.trim(), '');
    } finally {
        child.kill();
        await new Promise((r) => child.once('exit', r));
        deck.close();
        await studio.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
