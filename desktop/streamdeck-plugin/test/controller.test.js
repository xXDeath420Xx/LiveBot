/*
 * src/controller.js with a mocked Stream Deck surface (fake keys and property inspector) and the real client against
 * the mock Studio bridge: settings → request mapping, key states from presses and pushes, property inspector lists,
 * unconfigured keys and failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioClient } from '../src/studio-client.js';
import { createController, requestFor, toItems, statusText, ACTIONS, PREFIX } from '../src/controller.js';
import { startMockStudio, until, sleep } from './mock-studio.js';

const TOKEN = 'sdk_test-token-0123456789abcdef';
let nextId = 0;

function fakeKey(name) {
    const k = { id: `ctx${++nextId}`, manifestId: `${PREFIX}${name}`, states: [], titles: [], alerts: 0, oks: 0 };
    k.setState = async (s) => { k.states.push(s); };
    k.setTitle = async (t) => { k.titles.push(t); };
    k.showAlert = async () => { k.alerts++; };
    k.showOk = async () => { k.oks++; };
    return k;
}

async function setup() {
    const studio = await startMockStudio({ token: TOKEN });
    const client = createStudioClient();
    const pi = [];
    const controller = createController({ client, ui: { sendToPropertyInspector: async (p) => { pi.push(p); } } });
    controller.globalSettings({ port: studio.port, token: TOKEN });
    await until(() => client.connected);
    return { studio, client, controller, pi, done: async () => { client.stop(); await studio.close(); } };
}

test('settings → request for every action; unconfigured settings give null', () => {
    const u = (n) => `${PREFIX}${n}`;
    assert.deepEqual(requestFor(u('run-automation'), { automationId: '7' }), { method: 'automations.run', params: { automationId: 7 } });
    assert.deepEqual(requestFor(u('run-automation'), { automationId: 'abc' }), { method: 'automations.run', params: { automationId: 'abc' } });
    assert.deepEqual(requestFor(u('switch-scene'), { scene: 'BRB' }), { method: 'obs.scene', params: { scene: 'BRB' } });
    assert.deepEqual(requestFor(u('toggle-source'), { scene: 'Main', source: 'Webcam' }), { method: 'obs.source', params: { scene: 'Main', source: 'Webcam', state: 'toggle' } });
    assert.deepEqual(requestFor(u('toggle-source'), { scene: 'Main', source: 'Webcam', mode: 'hide' }).params.state, 'hide');
    assert.deepEqual(requestFor(u('mute-input'), { input: 'Mic', mode: 'mute' }), { method: 'obs.mute', params: { input: 'Mic', state: 'mute' } });
    assert.deepEqual(requestFor(u('mute-input'), { input: 'Mic', mode: 'weird' }).params.state, 'toggle');
    assert.deepEqual(requestFor(u('counter'), { counter: 'deaths' }), { method: 'counters.add', params: { counter: 'deaths', amount: 1 } });
    assert.deepEqual(requestFor(u('counter'), { counter: 'deaths', direction: 'down', step: '5' }).params.amount, -5);
    assert.deepEqual(requestFor(u('counter'), { counter: 'deaths', step: 99999 }).params.amount, 1000);
    assert.deepEqual(requestFor(u('play-sound'), { sound: 'airhorn' }), { method: 'sound.play', params: { sound: 'airhorn' } });
    assert.deepEqual(requestFor(u('light-preset'), { preset: 'p1' }), { method: 'lights.apply', params: { preset: 'p1' } });
    for (const n of ACTIONS) assert.equal(requestFor(u(n), {}), null, n);
    assert.equal(requestFor(u('toggle-source'), { scene: 'Main' }), null);
    assert.equal(requestFor('com.other.plugin.switch-scene', { scene: 'BRB' }), null);
    assert.equal(requestFor(u('switch-scene'), { scene: { evil: true } }), null);
});

test('toItems takes strings or { id, name } and drops junk and duplicates', () => {
    assert.deepEqual(toItems(['A', 'B', 'A', '', null, 5]), [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
    assert.deepEqual(toItems([{ id: 7, name: 'Hype' }, { name: 'Mic', kind: 'x' }]), [{ value: '7', label: 'Hype' }, { value: 'Mic', label: 'Mic' }]);
    assert.deepEqual(toItems(undefined), []);
});

test('status texts are plain sentences', () => {
    for (const s of ['connected', 'connecting', 'not_configured', 'unreachable', 'auth_failed', 'locked_out', 'stopped', 'other']) {
        const t = statusText(s);
        assert.match(t, /^[A-Z][^!]*\.$/, s);
    }
    assert.match(statusText('auth_failed', 'token_changed'), /regenerated/);
});

test('key presses send the mapped request; showOk on success, showAlert on failure or when not set up', async () => {
    const t = await setup();
    try {
        const run = fakeKey('run-automation');
        t.controller.appear(run, { automationId: '7' });
        assert.deepEqual(await t.controller.keyDown(run, { automationId: '7' }), { ok: true, result: { runId: 'run1', status: 'done', automationId: 7 } });
        assert.equal(run.oks, 1);
        assert.deepEqual(t.studio.requests.at(-1), { method: 'automations.run', params: { automationId: 7 } });

        const scene = fakeKey('switch-scene');
        assert.equal((await t.controller.keyDown(scene, { scene: 'Nope' })).error, 'scene_not_found');
        assert.equal(scene.alerts, 1);
        assert.equal((await t.controller.keyDown(scene, {})).error, 'not_configured');
        assert.equal(scene.alerts, 2);

        const sound = fakeKey('play-sound');
        await t.controller.keyDown(sound, { sound: 'airhorn' });
        const light = fakeKey('light-preset');
        await t.controller.keyDown(light, { preset: 'p2' });
        assert.deepEqual(t.studio.requests.slice(-2), [{ method: 'sound.play', params: { sound: 'airhorn' } }, { method: 'lights.apply', params: { preset: 'p2' } }]);
        assert.equal(sound.oks + light.oks, 2);
    } finally { await t.done(); }
});

test('scene keys: lit while their scene is live, from the first read, presses and pushes', async () => {
    const t = await setup();
    try {
        const main = fakeKey('switch-scene');
        const brb = fakeKey('switch-scene');
        t.controller.appear(main, { scene: 'Main' });
        t.controller.appear(brb, { scene: 'BRB' });
        await until(() => main.states.at(-1) === 1 && brb.states.at(-1) === 0);
        await t.controller.keyDown(brb, { scene: 'BRB' });
        assert.equal(brb.states.at(-1), 1);
        assert.equal(main.states.at(-1), 0);
        t.studio.push({ type: 'obs', event: 'CurrentProgramSceneChanged', data: { sceneName: 'Main' } });
        await until(() => main.states.at(-1) === 1 && brb.states.at(-1) === 0);
        t.studio.push({ type: 'state', obs: { connected: true, currentScene: 'Starting Soon' } });
        await until(() => main.states.at(-1) === 0);
        t.controller.disappear(main.id);
        const before = main.states.length;
        t.studio.push({ type: 'obs', event: 'CurrentProgramSceneChanged', data: { sceneName: 'Main' } });
        await sleep(50);
        assert.equal(main.states.length, before, 'a key that left the deck is not touched');
    } finally { await t.done(); }
});

test('mute keys show muted; toggle-source keys show visible; both follow pushes', async () => {
    const t = await setup();
    try {
        const mic = fakeKey('mute-input');
        t.controller.appear(mic, { input: 'Mic' });
        await until(() => mic.states.at(-1) === 0);
        await t.controller.keyDown(mic, { input: 'Mic' });
        assert.equal(mic.states.at(-1), 1);
        assert.equal(t.studio.state.muted.Mic, true);
        t.studio.push({ type: 'obs', event: 'InputMuteStateChanged', data: { inputName: 'Mic', inputMuted: false } });
        await until(() => mic.states.at(-1) === 0);

        const cam = fakeKey('toggle-source');
        t.controller.appear(cam, { scene: 'Main', source: 'Webcam' });
        await until(() => cam.states.at(-1) === 1);
        await t.controller.keyDown(cam, { scene: 'Main', source: 'Webcam' });
        assert.equal(cam.states.at(-1), 0);
        t.studio.push({ type: 'obs', event: 'SceneItemEnableStateChanged', data: { sceneName: 'Main', sourceName: 'Webcam', sceneItemEnabled: true } });
        await until(() => cam.states.at(-1) === 1);
        // Without the source name, the key asks Studio again.
        t.studio.state.visible['Main\u0000Webcam'] = false;
        t.studio.push({ type: 'obs', event: 'SceneItemEnableStateChanged', data: { sceneName: 'Main', sceneItemId: 3, sceneItemEnabled: false } });
        await until(() => cam.states.at(-1) === 0);
    } finally { await t.done(); }
});

test('counter keys show the value as the title and step up or down', async () => {
    const t = await setup();
    try {
        const up = fakeKey('counter');
        const down = fakeKey('counter');
        t.controller.appear(up, { counter: 'deaths', direction: 'up', step: 2 });
        t.controller.appear(down, { counter: 'deaths', direction: 'down', step: 1 });
        await until(() => up.titles.at(-1) === '3' && down.titles.at(-1) === '3');
        await t.controller.keyDown(up, { counter: 'deaths', direction: 'up', step: 2 });
        assert.equal(up.titles.at(-1), '5');
        assert.equal(down.titles.at(-1), '5');
        await t.controller.keyDown(down, { counter: 'deaths', direction: 'down', step: 1 });
        assert.equal(up.titles.at(-1), '4');
        t.studio.push({ type: 'state', counters: { deaths: 10 } });
        await until(() => up.titles.at(-1) === '10');
        t.studio.push({ type: 'state', counter: { name: 'deaths', value: 11 } });
        await until(() => down.titles.at(-1) === '11');
    } finally { await t.done(); }
});

test('settings changed in the property inspector re-read the key state', async () => {
    const t = await setup();
    try {
        const k = fakeKey('mute-input');
        t.controller.appear(k, {});
        t.studio.state.muted['Desktop Audio'] = true;
        t.controller.settingsChanged(k, { input: 'Desktop Audio' });
        await until(() => k.states.at(-1) === 1);
    } finally { await t.done(); }
});

test('property inspector lists come from Studio; sources need a scene; status is answered', async () => {
    const t = await setup();
    try {
        const k = fakeKey('toggle-source');
        const list = async (payload) => { t.pi.length = 0; await t.controller.fromPropertyInspector(k, payload); return t.pi.find((p) => p.event === 'list'); };
        assert.deepEqual((await list({ event: 'list', kind: 'scenes' })).items.map((i) => i.value), ['Main', 'BRB', 'Starting Soon']);
        assert.deepEqual((await list({ event: 'list', kind: 'sources', scene: 'Main' })).items.map((i) => i.value), ['Webcam', 'Alert Box']);
        const none = await list({ event: 'list', kind: 'sources' });
        assert.deepEqual(none.items, []);
        assert.deepEqual((await list({ event: 'list', kind: 'automations' })).items, [{ value: '7', label: 'Hype train' }, { value: '9', label: 'Raid' }]);
        assert.deepEqual((await list({ event: 'list', kind: 'inputs' })).items.map((i) => i.value), ['Mic', 'Desktop Audio']);
        assert.deepEqual((await list({ event: 'list', kind: 'counters' })).items.map((i) => i.value), ['deaths', 'wins']);
        assert.deepEqual((await list({ event: 'list', kind: 'sounds' })).items.map((i) => i.value), ['airhorn', 'sad trombone']);
        assert.deepEqual((await list({ event: 'list', kind: 'presets' })).items, [{ value: 'p1', label: 'Stream start' }, { value: 'p2', label: 'Chill' }]);
        assert.equal(await list({ event: 'list', kind: 'secrets' }), undefined, 'unknown lists are ignored');
        t.pi.length = 0;
        await t.controller.fromPropertyInspector(k, { event: 'status' });
        assert.deepEqual(t.pi[0], { event: 'status', status: 'connected', connected: true, text: 'Connected to CertiFried Studio.' });
    } finally { await t.done(); }
});

test('wrong token: the property inspector hears why, lists explain it, and keys alert', async () => {
    const studio = await startMockStudio({ token: TOKEN });
    const client = createStudioClient();
    const pi = [];
    const controller = createController({ client, ui: { sendToPropertyInspector: async (p) => { pi.push(p); } } });
    try {
        controller.globalSettings({ port: studio.port, token: 'sdk_wrong' });
        await until(() => pi.some((p) => p.event === 'status' && p.status === 'auth_failed'));
        assert.equal(pi.find((p) => p.status === 'auth_failed').text, 'Studio refused the pairing token. Copy it again from Studio.');
        const k = fakeKey('switch-scene');
        await controller.fromPropertyInspector(k, { event: 'list', kind: 'scenes' });
        assert.equal(pi.at(-1).error, 'Studio refused the pairing token. Copy it again from Studio.');
        assert.equal((await controller.keyDown(k, { scene: 'BRB' })).error, 'not_connected');
        assert.equal(k.alerts, 1);
        // The person pastes the right token: keys work again.
        controller.globalSettings({ port: studio.port, token: TOKEN });
        await until(() => client.connected);
        assert.equal((await controller.keyDown(k, { scene: 'BRB' })).ok, true);
        assert.equal(k.oks, 1);
    } finally { client.stop(); await studio.close(); }
});
