'use strict';
/*
 * Voicemeeter through src/main/voicemeeter.js with the in-memory fake binding (never the real VoicemeeterRemote64.dll):
 * detect per type, mute/gain/fade, profile loading limited to Documents\Voicemeeter, macro buttons, the off switch,
 * not installed / not running, and the DLL locator's parsing of `reg query` output (injected, the registry is not read).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoicemeeter, fakeVoicemeeterBinding, locateVoicemeeterDll, uninstallDir, versionString, VOICEMEETER_ACTIONS } = require('../src/main/voicemeeter');
const { createRouter } = require('../src/main/router');

const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };

let docs;
test.before(() => {
    docs = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-vm-docs-'));
    fs.mkdirSync(path.join(docs, 'Voicemeeter'));
    fs.writeFileSync(path.join(docs, 'Voicemeeter', 'Streaming.xml'), '<VBAudioVoicemeeterSettings/>');
    fs.writeFileSync(path.join(docs, 'Voicemeeter', 'Gaming Night.xml'), '<VBAudioVoicemeeterSettings/>');
    fs.writeFileSync(path.join(docs, 'Voicemeeter', 'notes.txt'), 'not a profile');
    fs.mkdirSync(path.join(docs, 'Voicemeeter', 'folder.xml'));
    fs.writeFileSync(path.join(docs, 'Outside.xml'), '<x/>');
});
test.after(() => fs.rmSync(docs, { recursive: true, force: true }));

function make(opts = {}, vmOpts = {}) {
    const binding = fakeVoicemeeterBinding(null, { labels: { 'Strip[0]': 'Mic', 'Bus[0]': 'Headset' }, ...opts });
    const vm = createVoicemeeter({ binding, documentsDir: docs, enabled: true, ...vmOpts });
    return { vm, binding };
}

test('detect reads type, version, labels, strips and buses for each type', async () => {
    const counts = { basic: [3, 2, 1], banana: [5, 5, 2], potato: [8, 8, 3] };
    for (const [type, [strips, buses, virtual]] of Object.entries(counts)) {
        const { vm } = make({ type });
        const d = await vm.detect();
        assert.equal(d.installed, true);
        assert.equal(d.running, true);
        assert.equal(d.type, type);
        assert.equal(d.strips.length, strips, `${type} strips`);
        assert.equal(d.buses.length, buses, `${type} buses`);
        assert.equal(d.strips.filter((s) => s.isVirtual).length, virtual, `${type} virtual strips`);
        assert.equal(d.strips[0].label, 'Mic');
        assert.equal(d.buses[0].name, 'Headset');
        assert.equal(d.strips[1].label, '');
        assert.equal(d.strips[1].name, 'Hardware input 2');
        assert.equal(d.macroButtons, true);
    }
    const { vm } = make({ type: 'potato', version: '3.1.1.9' });
    const d = await vm.detect();
    assert.equal(d.version, '3.1.1.9');
    assert.deepEqual(d.buses.map((b) => b.name), ['Headset', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);
    assert.deepEqual(d.profiles, ['Gaming Night.xml', 'Streaming.xml'], 'only .xml files, no folders');
    assert.equal(versionString(0x02010109), '2.1.1.9');
});

test('detect: installed but not running, and not installed at all', async () => {
    const { vm, binding } = make({ running: false });
    const d = await vm.detect();
    assert.equal(d.installed, true);
    assert.equal(d.running, false, 'login returning 1 is reported as not running');
    assert.equal(d.type, null);
    assert.equal(binding.state.running, false, 'Voicemeeter is never started');

    let loaded = false;
    const none = createVoicemeeter({ locate: async () => null, loadBinding: () => { loaded = true; }, documentsDir: docs });
    const n = await none.detect();
    assert.deepEqual({ installed: n.installed, running: n.running, type: n.type }, { installed: false, running: false, type: null });
    assert.equal(loaded, false);
    none.configure({ enabled: true });
    assert.equal(await code(none.run('voicemeeter.mute', { target: 'strip:0', state: 'mute' })), 'voicemeeter_not_installed');

    const broken = createVoicemeeter({ locate: async () => 'C:\\nowhere\\VoicemeeterRemote64.dll', loadBinding: () => { throw new Error('cannot load'); }, enabled: true });
    assert.equal(await code(broken.run('voicemeeter.mute', { target: 'strip:0', state: 'mute' })), 'voicemeeter_not_installed');
});

test('nothing is loaded until it is turned on or Detect is clicked; detect while off leaves it unloaded', async () => {
    let loads = 0;
    const binding = fakeVoicemeeterBinding();
    const vm = createVoicemeeter({ locate: async () => 'C:\\VB\\VoicemeeterRemote64.dll', loadBinding: () => { loads++; return binding; }, documentsDir: docs });
    assert.equal(loads, 0);
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'strip:0', state: 'mute' })), 'voicemeeter_off');
    assert.equal(await code(vm.run('voicemeeter.profile', { profile: 'Streaming.xml' })), 'voicemeeter_off');
    assert.equal(loads, 0, 'an action while off does not load the DLL');
    const d = await vm.detect();
    assert.equal(d.dllPath, 'C:\\VB\\VoicemeeterRemote64.dll');
    assert.equal(loads, 1);
    assert.equal(binding.state.loggedIn, false, 'logged out again after detect while off');
    assert.equal(vm.status().loaded, false);
    vm.configure({ enabled: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(binding.state.loggedIn, true);
    vm.configure({ enabled: false });
    assert.equal(binding.state.loggedIn, false);
    assert.equal(vm.status().enabled, false);
});

test('mute: mute, unmute and toggle on strips and buses', async () => {
    const { vm, binding } = make();
    assert.deepEqual(await vm.run('voicemeeter.mute', { target: 'strip:0', state: 'mute' }), { target: 'strip:0', muted: true });
    assert.equal(binding.state.params['Strip[0].Mute'], 1);
    assert.deepEqual(await vm.run('voicemeeter.mute', { target: 'strip:0', state: 'toggle' }), { target: 'strip:0', muted: false });
    assert.equal(binding.state.params['Strip[0].Mute'], 0);
    assert.deepEqual(await vm.run('voicemeeter.mute', { target: 'bus:4', state: 'toggle' }), { target: 'bus:4', muted: true });
    assert.deepEqual(await vm.run('voicemeeter.mute', { target: 'BUS:4', state: 'unmute' }), { target: 'bus:4', muted: false });
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'strip:5', state: 'mute' })), 'bad_target', 'banana has 5 strips');
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'bus:9', state: 'mute' })), 'bad_target');
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'strip:-1', state: 'mute' })), 'bad_target');
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'Strip[0]', state: 'mute' })), 'bad_target');
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'strip:0', state: 'loud' })), 'bad_params');
});

test('mute: the strip range follows the running type', async () => {
    const basic = make({ type: 'basic' }).vm;
    assert.equal(await code(basic.run('voicemeeter.mute', { target: 'strip:3', state: 'mute' })), 'bad_target');
    assert.equal(await code(basic.run('voicemeeter.mute', { target: 'bus:2', state: 'mute' })), 'bad_target');
    assert.equal(await code(basic.run('voicemeeter.mute', { target: 'strip:2', state: 'mute' })), 'ok');
    const potato = make({ type: 'potato' }).vm;
    assert.equal(await code(potato.run('voicemeeter.mute', { target: 'strip:7', state: 'mute' })), 'ok');
    assert.equal(await code(potato.run('voicemeeter.mute', { target: 'bus:7', state: 'mute' })), 'ok');
});

test('gain: set and adjust are clamped; a fade goes through FadeTo', async () => {
    const { vm, binding } = make();
    assert.deepEqual(await vm.run('voicemeeter.gain', { target: 'strip:1', mode: 'set', gain: -12.34 }), { target: 'strip:1', gain: -12.3 });
    assert.equal(Math.round(binding.state.params['Strip[1].Gain'] * 10) / 10, -12.3);
    assert.deepEqual(await vm.run('voicemeeter.gain', { target: 'strip:1', mode: 'adjust', gain: 6 }), { target: 'strip:1', gain: -6.3 });
    assert.deepEqual(await vm.run('voicemeeter.gain', { target: 'strip:1', mode: 'set', gain: 40 }), { target: 'strip:1', gain: 12 });
    assert.deepEqual(await vm.run('voicemeeter.gain', { target: 'strip:1', mode: 'adjust', gain: -500 }), { target: 'strip:1', gain: -60 });
    assert.deepEqual(await vm.run('voicemeeter.gain', { target: 'bus:0', mode: 'set', gain: -10, fadeMs: 1500 }), { target: 'bus:0', gain: -10 });
    assert.equal(binding.state.scripts.at(-1), 'Bus[0].FadeTo = (-10.0, 1500);');
    await vm.run('voicemeeter.gain', { target: 'strip:2', mode: 'set', gain: 3, fadeMs: 999999 });
    assert.equal(binding.state.scripts.at(-1), 'Strip[2].FadeTo = (3.0, 5000);', 'fade clamped to 5 s');
    assert.equal(await code(vm.run('voicemeeter.gain', { target: 'strip:0', mode: 'set', gain: 'loud' })), 'bad_params');
    assert.equal(await code(vm.run('voicemeeter.gain', { target: 'strip:0', mode: 'set' })), 'bad_params');
    assert.equal(await code(vm.run('voicemeeter.gain', { target: 'strip:0', mode: 'multiply', gain: 1 })), 'bad_params');
});

test('profile: only file names from Documents\\Voicemeeter, loaded with Command.Load', async () => {
    const { vm, binding } = make();
    assert.deepEqual(await vm.run('voicemeeter.profile', { profile: 'Streaming.xml' }), { profile: 'Streaming.xml' });
    assert.equal(binding.state.scripts.at(-1), `Command.Load = "${path.join(docs, 'Voicemeeter', 'Streaming.xml')}";`);
    assert.deepEqual(await vm.run('voicemeeter.profile', { profile: 'gaming night.XML' }), { profile: 'Gaming Night.xml' }, 'case-insensitive, real name used');
    for (const bad of ['..\\Outside.xml', '../Outside.xml', 'Outside.xml', 'C:\\Windows\\win.xml', 'Voicemeeter\\Streaming.xml',
        'notes.txt', 'folder.xml', '', 'Stream"ing.xml', 'a..xml', 'Missing.xml', null]) {
        assert.equal(await code(vm.run('voicemeeter.profile', { profile: bad })), 'profile_not_found', String(bad));
    }
    assert.equal(binding.state.loads.length, 2, 'nothing else was loaded');
    const noDocs = createVoicemeeter({ binding: fakeVoicemeeterBinding(), enabled: true });
    assert.equal(await code(noDocs.run('voicemeeter.profile', { profile: 'Streaming.xml' })), 'profile_not_found');
});

test('macro buttons: press, on, off, toggle; range and availability', async () => {
    const { vm, binding } = make();
    assert.deepEqual(await vm.run('voicemeeter.macro', { button: 3, state: 'press' }), { button: 3, on: false });
    assert.deepEqual(binding.state.macroCalls.slice(-2), [{ button: 3, value: 1, mode: 0 }, { button: 3, value: 0, mode: 0 }]);
    assert.deepEqual(await vm.run('voicemeeter.macro', { button: 79, state: 'on' }), { button: 79, on: true });
    assert.deepEqual(await vm.run('voicemeeter.macro', { button: 79, state: 'toggle' }), { button: 79, on: false });
    assert.deepEqual(await vm.run('voicemeeter.macro', { button: 79, state: 'toggle' }), { button: 79, on: true });
    assert.deepEqual(await vm.run('voicemeeter.macro', { button: '79', state: 'off' }), { button: 79, on: false });
    for (const b of [80, -1, 1.5, '', null, 'x']) assert.equal(await code(vm.run('voicemeeter.macro', { button: b, state: 'on' })), 'bad_target', String(b));
    assert.equal(await code(vm.run('voicemeeter.macro', { button: 1, state: 'hold' })), 'bad_params');
    const old = make({ macro: false }).vm;
    assert.equal(await code(old.run('voicemeeter.macro', { button: 1, state: 'press' })), 'macro_unavailable');
    assert.equal((await old.detect()).macroButtons, false);
});

test('not running: actions answer voicemeeter_not_running, and work once Voicemeeter starts', async () => {
    const { vm, binding } = make({ running: false });
    assert.equal(await code(vm.run('voicemeeter.mute', { target: 'strip:0', state: 'mute' })), 'voicemeeter_not_running');
    assert.equal(await code(vm.run('voicemeeter.macro', { button: 0, state: 'press' })), 'voicemeeter_not_running');
    assert.equal(await code(vm.run('voicemeeter.profile', { profile: 'Streaming.xml' })), 'voicemeeter_not_running');
    binding.state.running = true;
    assert.deepEqual(await vm.run('voicemeeter.mute', { target: 'strip:0', state: 'mute' }), { target: 'strip:0', muted: true });
});

test('through the router: handlers() plug into extra, errors become reason codes; the record sees each action', async () => {
    const record = [];
    const fakeRecord = [];
    const binding = fakeVoicemeeterBinding(fakeRecord);
    const vm = createVoicemeeter({ binding, documentsDir: docs, enabled: true, record });
    const router = createRouter({ obs: null, sound: null, library: null, keys: null, extra: vm.handlers() });
    for (const a of VOICEMEETER_ACTIONS) assert.equal(router.handles(a), true, a);
    assert.deepEqual(await router.run('voicemeeter.mute', { target: 'strip:1', state: 'mute' }), { ok: true, result: { target: 'strip:1', muted: true } });
    const bad = await router.run('voicemeeter.mute', { target: 'strip:12', state: 'mute' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^bad_target: /);
    assert.equal(record.length, 1);
    assert.equal(record[0].kind, 'voicemeeter');
    assert.equal(record[0].action, 'voicemeeter.mute');
    assert.deepEqual(fakeRecord.map((r) => r.call), ['setFloat']);
});

test('locator: UninstallString folder first, then the default folder; never a shell', async () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VB:Voicemeeter {17359A74-1236-5467}\r\n'
        + '    UninstallString    REG_SZ    "D:\\Audio\\VB\\Voicemeeter\\voicemeeterprosetup.exe" /u\r\n';
    assert.equal(uninstallDir(out), 'D:\\Audio\\VB\\Voicemeeter');
    assert.equal(uninstallDir('    UninstallString    REG_SZ    C:\\Program Files (x86)\\VB\\Voicemeeter\\voicemeeterprosetup.exe /u'), 'C:\\Program Files (x86)\\VB\\Voicemeeter');
    assert.equal(uninstallDir('nothing here'), null);
    assert.equal(uninstallDir('    UninstallString    REG_SZ    relative\\setup.exe'), null);

    const calls = [];
    const run = async (file, args) => { calls.push({ file, args }); return out; };
    const found = await locateVoicemeeterDll({ run, exists: (p) => p === 'D:\\Audio\\VB\\Voicemeeter\\VoicemeeterRemote64.dll', platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
    assert.equal(found, 'D:\\Audio\\VB\\Voicemeeter\\VoicemeeterRemote64.dll');
    assert.equal(calls[0].file, 'C:\\Windows\\System32\\reg.exe');
    assert.deepEqual(calls[0].args.slice(0, 1), ['query'], 'read only');
    const fallback = await locateVoicemeeterDll({ run: async () => { throw new Error('not found'); }, exists: (p) => p.startsWith('C:\\Program Files (x86)\\VB\\Voicemeeter\\'), platform: 'win32', env: {} });
    assert.equal(fallback, 'C:\\Program Files (x86)\\VB\\Voicemeeter\\VoicemeeterRemote64.dll');
    assert.equal(await locateVoicemeeterDll({ run, exists: () => false, platform: 'win32', env: {} }), null);
    assert.equal(await locateVoicemeeterDll({ platform: 'linux' }), null);
});
