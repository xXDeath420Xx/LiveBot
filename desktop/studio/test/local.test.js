'use strict';
/*
 * The local pieces: safeStorage use for secrets, settings, log redaction and rotation, the sound queue and library
 * (resolve and dashboard sync), hotkey parsing and registration, key sending, and the router for sound and hotkey.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createConfig } = require('../src/main/config');
const { createLogger, redact } = require('../src/main/logger');
const { createSoundPlayer, createLibrary } = require('../src/main/sound');
const { normaliseAccelerator, validateBinding, createHotkeys, parseKeys, createKeySender } = require('../src/main/hotkeys');
const { createRouter } = require('../src/main/router');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-'));
const TOKEN = `sbd_${'Q'.repeat(43)}`;

/** A stand-in for Electron safeStorage: reversible, but not plain text, and records calls. */
function fakeSafeStorage({ available = true } = {}) {
    const calls = [];
    return {
        calls,
        isEncryptionAvailable: () => available,
        encryptString: (s) => { calls.push('encrypt'); return Buffer.from(`ENC:${Buffer.from(s).toString('hex')}`); },
        decryptString: (b) => { calls.push('decrypt'); const s = b.toString(); if (!s.startsWith('ENC:')) throw new Error('bad'); return Buffer.from(s.slice(4), 'hex').toString(); },
    };
}

test('secrets go through safeStorage and are never on disk in plain text', () => {
    const dir = tmp();
    const ss = fakeSafeStorage();
    const cfg = createConfig({ dir, safeStorage: ss });
    cfg.setSecret('deviceToken', TOKEN);
    cfg.setSecret('obsPassword', 'hunter2-obs');
    assert.deepEqual(ss.calls, ['encrypt', 'encrypt']);
    const onDisk = fs.readFileSync(cfg.paths.secretsFile, 'utf8') + fs.readFileSync(cfg.paths.secretsFile, 'utf8');
    assert.ok(!onDisk.includes(TOKEN) && !onDisk.includes('hunter2-obs'), 'no plain text secrets');
    assert.ok(!fs.existsSync(cfg.paths.settingsFile) || !fs.readFileSync(cfg.paths.settingsFile, 'utf8').includes('hunter2'));
    const again = createConfig({ dir, safeStorage: ss });
    assert.equal(again.getSecret('deviceToken'), TOKEN);
    assert.equal(again.getSecret('obsPassword'), 'hunter2-obs');
    again.setSecret('obsPassword', '');
    assert.equal(again.hasSecret('obsPassword'), false);
    assert.throws(() => again.setSecret('other', 'x'), /unknown_secret/);
    // no DPAPI (unavailable, or failing): saved with the local key instead, never in plain text, still there after a restart
    for (const ssBad of [fakeSafeStorage({ available: false }), { ...fakeSafeStorage(), encryptString: () => { throw new Error('Error while encrypting the text provided to encryptString'); } }]) {
        const offDir = tmp();
        const off = createConfig({ dir: offDir, safeStorage: ssBad, localKey: require('../src/main/local-key').createLocalKey({ dir: offDir, restrict: () => true }) });
        assert.equal(off.setSecret('deviceToken', TOKEN), 'local');
        assert.equal(off.storageMode(), 'local');
        assert.ok(!fs.readFileSync(off.paths.secretsFile, 'utf8').includes(TOKEN), 'not on disk in plain text');
        assert.equal(createConfig({ dir: offDir, safeStorage: ssBad }).getSecret('deviceToken'), TOKEN, 'still there after a restart');
    }
});

test('settings merge and survive a restart; prototype keys ignored', () => {
    const dir = tmp();
    const cfg = createConfig({ dir, safeStorage: fakeSafeStorage() });
    assert.equal(cfg.get().obs.port, 4455);
    assert.equal(cfg.get().obs.host, '127.0.0.1');
    cfg.update({ obs: { port: 4466 }, __proto__: { polluted: true } });
    assert.equal(({}).polluted, undefined);
    const again = createConfig({ dir, safeStorage: fakeSafeStorage() });
    assert.deepEqual([again.get().obs.port, again.get().obs.host, again.get().app.theme], [4466, '127.0.0.1', 'dark']);
});

test('logs: tokens, passwords, codes and bearer headers are removed; files rotate', () => {
    const dir = tmp();
    const log = createLogger({ dir, maxBytes: 400, keep: 2 });
    log.info(`paired with ${TOKEN} code ABCD-EFGH`, { password: 'x', obsPassword: 'y', headers: { Authorization: `Bearer ${TOKEN}` }, url: 'certifried-studio://pair?code=ABCD-EFGH', port: 4455 });
    const text = fs.readFileSync(log.file, 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes('ABCD-EFGH') && !text.includes('"x"') && !text.includes('"y"'));
    assert.match(text, /"port":4455/);
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${'.'.repeat(40)}`);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['studio.1.log', 'studio.2.log', 'studio.log']);
    assert.deepEqual(redact({ token: 'abc', enabled: true, nested: { deviceToken: 'z' } }), { token: '[hidden]', enabled: true, nested: { deviceToken: '[hidden]' } });
});

/** A fake audio renderer: records commands; the test decides when sounds start and end. */
function fakeBackend() {
    const b = { played: [], stopped: [], player: null };
    b.play = (cmd) => { b.played.push(cmd); if (b.auto) setImmediate(() => b.player.onStarted(cmd.id)); };
    b.stop = (id) => b.stopped.push(id);
    return b;
}

test('sound queue: overlap plays at once; queue waits its turn; stop-all clears; volume and device applied', async () => {
    const backend = fakeBackend();
    backend.auto = true;
    const settings = { masterVolume: 50, outputDeviceId: 'dev-123' };
    const p = createSoundPlayer({ backend, getSettings: () => settings, startTimeoutMs: 200 });
    backend.player = p;
    assert.deepEqual(await p.play({ src: 'file:///a.mp3', volume: 80 }), { started: true, mode: 'overlap' });
    assert.deepEqual(await p.play({ src: 'file:///b.mp3', volume: 100 }), { started: true, mode: 'overlap' });
    assert.equal(backend.played.length, 2, 'both play together');
    assert.equal(backend.played[0].volume, 0.4, '80% of a 50% master');
    assert.equal(backend.played[0].sinkId, 'dev-123');

    assert.deepEqual(await p.play({ src: 'file:///q1.mp3', mode: 'queue' }), { started: true, mode: 'queue' });
    assert.deepEqual(await p.play({ src: 'file:///q2.mp3', mode: 'queue' }), { queued: true, position: 1 });
    assert.deepEqual(await p.play({ src: 'file:///q3.mp3', mode: 'queue' }), { queued: true, position: 2 });
    assert.equal(backend.played.length, 3, 'q2 and q3 wait');
    const q1 = backend.played[2].id;
    p.onEnded(q1);
    assert.equal(backend.played.length, 4);
    assert.equal(backend.played[3].src, 'file:///q2.mp3', 'next in order');
    p.onError(backend.played[3].id, 'decode');          // a failed queued sound does not block the queue
    assert.equal(backend.played[4].src, 'file:///q3.mp3');
    assert.deepEqual(p.state(), { playing: 3, queued: 0 }, 'a, b and q3');
    const r = p.stopAll();
    assert.equal(r.stopped, 3);
    assert.deepEqual(backend.stopped, [null]);
    assert.deepEqual(p.state(), { playing: 0, queued: 0 });
});

test('sound queue: a sound that fails to start is reported in the ack; at most 10 overlapping', async () => {
    const backend = fakeBackend();
    const p = createSoundPlayer({ backend, startTimeoutMs: 100 });
    const pending = p.play({ src: 'file:///broken.mp3' });
    p.onError(backend.played[0].id, 'NotSupportedError');
    await assert.rejects(pending, { code: 'playback_failed' });
    const many = [];
    for (let i = 0; i < 10; i++) many.push(p.play({ src: `file:///${i}.mp3` }));
    await assert.rejects(p.play({ src: 'file:///11.mp3' }), { code: 'too_many_sounds' });
    await Promise.all(many);    // still loading after the wait counts as started
});

test('sound library: resolves dashboard names, local files, https; refuses paths; syncs the dashboard library', async () => {
    const localDir = tmp();
    const dashboardDir = path.join(tmp(), 'dash');
    fs.writeFileSync(path.join(localDir, 'Airhorn.mp3'), 'x');
    fs.writeFileSync(path.join(localDir, 'notes.txt'), 'x');
    const lib = createLibrary({ localDir, dashboardDir });
    assert.match(lib.resolve('airhorn').src, /^file:.*Airhorn\.mp3$/);
    assert.match(lib.resolve('Airhorn.mp3').src, /Airhorn\.mp3$/);
    assert.equal(lib.resolve('https://cdn.example.com/a.mp3').src, 'https://cdn.example.com/a.mp3');
    for (const bad of ['..\\secret.mp3', 'C:\\Windows\\a.wav', 'file:///C:/a.mp3', 'http://x/a.mp3', '../a']) assert.throws(() => lib.resolve(bad), { code: 'bad_params' }, bad);
    assert.throws(() => lib.resolve('nothing'), { code: 'sound_not_found' });
    assert.throws(() => lib.resolve('notes'), { code: 'sound_not_found' }, 'not an audio file');

    const bytes = Buffer.from('ID3 pretend mp3');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    let remote = [{ id: 'ab12', name: 'Victory', size: bytes.length, sha256: sha, mime: 'audio/mpeg', url: '/stream/bot/api/device/sounds/ab12' },
        { id: 'zz99', name: 'Tampered', size: 3, sha256: 'f'.repeat(64), mime: 'audio/mpeg', url: '/x' }];
    const downloads = [];
    const download = async (url) => { downloads.push(url); return url === '/x' ? Buffer.from('abc') : bytes; };
    const r1 = await lib.syncDashboard({ list: async () => remote, download });
    assert.deepEqual(r1, { total: 1, downloaded: 1, removed: 0 }, 'the file that does not match its checksum is skipped');
    assert.match(lib.resolve('victory').src, /dash.*ab12\.mp3$/, 'dashboard sounds by name');
    assert.deepEqual(lib.list().map((s) => [s.name, s.source]), [['Victory', 'dashboard'], ['Airhorn.mp3', 'local']]);
    const r2 = await lib.syncDashboard({ list: async () => remote, download });
    assert.equal(r2.downloaded, 0, 'unchanged files are not downloaded again');
    remote = [];
    const r3 = await lib.syncDashboard({ list: async () => remote, download });
    assert.equal(r3.removed, 1);
    assert.throws(() => lib.resolve('Victory'), { code: 'sound_not_found' });
});

test('hotkeys: accelerators are normalised; plain keys only where safe', () => {
    assert.equal(normaliseAccelerator('ctrl + shift + f1'), 'Ctrl+Shift+F1');
    assert.equal(normaliseAccelerator('Shift+Control+a'), 'Ctrl+Shift+A');
    assert.equal(normaliseAccelerator('Alt+Num5'), 'Alt+num5');
    assert.equal(normaliseAccelerator('F13'), 'F13');
    assert.equal(normaliseAccelerator('numadd'), 'numadd');
    assert.equal(normaliseAccelerator('MediaPlayPause'), 'MediaPlayPause');
    assert.equal(normaliseAccelerator('A'), null, 'a letter alone would block typing');
    assert.equal(normaliseAccelerator('F5'), null);
    assert.equal(normaliseAccelerator('Ctrl'), null);
    assert.equal(normaliseAccelerator('Ctrl+A+B'), null);
    assert.equal(normaliseAccelerator('Ctrl+Banana'), null);
    const v = validateBinding({ accelerator: 'ctrl+alt+b', action: { kind: 'automation', automationId: '7', automationName: 'BRB' } });
    assert.ok(v.ok);
    assert.deepEqual([v.value.accelerator, v.value.action], ['Ctrl+Alt+B', { kind: 'automation', automationId: 7, automationName: 'BRB' }]);
    assert.ok(validateBinding({ accelerator: 'Ctrl+1', action: { kind: 'action', type: 'sound.play', params: { sound: 'Airhorn', volume: 70, evil: { x: 1 } } } }).value.action.params.evil === undefined);
    assert.equal(validateBinding({ accelerator: 'Ctrl+1', action: { kind: 'action', type: 'studio.hotkey' } }).ok, false, 'a hotkey cannot press hotkeys');
    assert.equal(validateBinding({ accelerator: 'Ctrl+1', action: { kind: 'automation', automationId: 0 } }).ok, false);
});

test('hotkeys: registered with globalShortcut, duplicates and taken keys reported, triggers call back', async () => {
    const registered = new Map();
    const gs = {
        register: (acc, fn) => { if (acc === 'Ctrl+Shift+T') return false; registered.set(acc, fn); return true; },
        unregister: (acc) => registered.delete(acc),
    };
    const fired = [];
    const hk = createHotkeys({ globalShortcut: gs, onTrigger: (b) => fired.push(b.id) });
    const r = hk.apply([
        { id: 'a', accelerator: 'Ctrl+Shift+F1', action: { kind: 'automation', automationId: 1 } },
        { id: 'b', accelerator: 'ctrl+shift+f1', action: { kind: 'action', type: 'sound.stop' } },
        { id: 'c', accelerator: 'Ctrl+Shift+T', action: { kind: 'action', type: 'sound.stop' } },
        { id: 'd', accelerator: 'Q', action: { kind: 'action', type: 'sound.stop' } },
        { id: 'e', accelerator: 'F14', enabled: false, action: { kind: 'action', type: 'sound.stop' } },
    ]);
    assert.deepEqual(r.registered, ['a']);
    assert.deepEqual(r.failed, [{ id: 'b', reason: 'duplicate' }, { id: 'c', reason: 'in_use' }, { id: 'd', reason: 'invalid' }]);
    registered.get('Ctrl+Shift+F1')();
    await new Promise((x) => setImmediate(x));
    assert.deepEqual(fired, ['a']);
    hk.apply([]);
    assert.equal(registered.size, 0, 'old bindings removed');
});

test('key sending: parsed to uiohook key codes; missing native module reported', () => {
    const UiohookKey = { Ctrl: 29, Shift: 42, Alt: 56, Meta: 3675, F1: 59, A: 30, Numpad5: 76, ArrowUp: 57416, Minus: 12 };
    assert.deepEqual(parseKeys('Ctrl+Shift+F1', UiohookKey), { key: 59, modifiers: [29, 42] });
    assert.deepEqual(parseKeys('alt + a', UiohookKey), { key: 30, modifiers: [56] });
    assert.deepEqual(parseKeys('Win+Up', UiohookKey), { key: 57416, modifiers: [3675] });
    assert.deepEqual(parseKeys('num5', UiohookKey), { key: 76, modifiers: [] });
    assert.throws(() => parseKeys('Ctrl+Shift', UiohookKey), { code: 'bad_params' });
    assert.throws(() => parseKeys('Ctrl+A+F1', UiohookKey), { code: 'bad_params' });
    const taps = [];
    const ks = createKeySender({ load: () => ({ UiohookKey, uIOhook: { keyTap: (k, m) => taps.push([k, m]) } }) });
    assert.deepEqual(ks.send('Ctrl+F1'), { keys: 'Ctrl+F1' });
    assert.deepEqual(taps, [[59, [29]]]);
    const none = createKeySender({ load: () => { throw new Error('no binary'); } });
    assert.throws(() => none.send('Ctrl+F1'), { code: 'hotkey_unavailable' });
});

test('router: sound.play resolves and plays, sound.stop, studio.hotkey, errors as reasons', async () => {
    const localDir = tmp();
    fs.writeFileSync(path.join(localDir, 'Ding.wav'), 'x');
    const library = createLibrary({ localDir, dashboardDir: path.join(localDir, 'dash') });
    const backend = fakeBackend();
    backend.auto = true;
    const sound = createSoundPlayer({ backend, startTimeoutMs: 100 });
    backend.player = sound;
    const taps = [];
    const keys = createKeySender({ load: () => ({ UiohookKey: { Ctrl: 29, F2: 60 }, uIOhook: { keyTap: (k, m) => taps.push([k, m]) } }) });
    const router = createRouter({ obs: { connected: false }, sound, library, keys, screenshotDir: localDir });
    assert.deepEqual(router.capabilities(), ['obs', 'sound', 'hotkey']);
    const r = await router.run('sound.play', { sound: 'ding', volume: 120, mode: 'queue' });
    assert.deepEqual(r, { ok: true, result: { sound: 'Ding.wav', started: true, mode: 'queue' } });
    assert.equal(backend.played[0].volume, 1, 'volume capped at 100');
    assert.match((await router.run('sound.play', { sound: 'missing' })).error, /^sound_not_found/);
    assert.deepEqual(await router.run('sound.stop', {}), { ok: true, result: { stopped: 1 } });
    assert.deepEqual(await router.run('studio.hotkey', { keys: 'Ctrl+F2' }), { ok: true, result: { keys: 'Ctrl+F2' } });
    assert.deepEqual(taps, [[60, [29]]]);
    assert.match((await router.run('studio.hotkey', { keys: 'Ctrl+' }).then((x) => x.error)), /^bad_params/);
});
