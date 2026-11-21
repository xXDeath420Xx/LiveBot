'use strict';
/*
 * "Run a program on your PC" (src/main/programs.js, 0.2.11): only a program on Studio's own list runs, by name; the server's
 * words are never a path or an argument; refusals, the rate limit, .bat through cmd.exe without a shell, the 'run'
 * capability and the activity label. On Windows a real program from the list is started (where.exe, which exits at once).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateProgram, createProgramRunner } = require('../src/main/programs');
const { createRouter } = require('../src/main/router');
const { ACTION_LABELS, summarise } = require('../src/main/labels');

function fakeSpawn() {
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const c = new EventEmitter();
        c.pid = 4242;
        c.unref = () => { c.unrefed = true; };
        setImmediate(() => c.emit('spawn'));
        return c;
    };
    return { calls, spawnImpl };
}
const EXE = process.platform === 'win32' ? 'C:\\Tools\\clip editor\\editor.exe' : '/tools/editor.exe';
const BAT = process.platform === 'win32' ? 'C:\\Tools\\scene.bat' : '/tools/scene.bat';

test('validateProgram: name, an absolute .exe/.bat/.cmd that exists, fixed arguments', () => {
    const exists = () => true;
    const ok = validateProgram({ name: '  Clip   editor ', path: EXE, args: '--open "my clips" -x' }, { exists });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.name, 'Clip editor');
    assert.deepEqual(ok.value.args, ['--open', 'my clips', '-x']);
    assert.match(ok.value.id, /^[a-f0-9]{12}$/);
    assert.equal(validateProgram({ name: 'x', path: 'editor.exe' }, { exists }).ok, false, 'a relative path');
    assert.match(validateProgram({ name: 'x', path: EXE.replace('.exe', '.ps1') }, { exists }).error, /\.exe/);
    assert.match(validateProgram({ name: 'x', path: EXE }, { exists: () => false }).error, /not there/);
    assert.equal(validateProgram({ name: 'rm -rf /;', path: EXE }, { exists }).ok, false, 'names are plain');
    assert.equal(validateProgram({ name: 'x', path: EXE, args: ['a\nb'] }, { exists }).ok, false);
});

test('run: only listed names; the list decides the file and arguments; refusals and the rate limit', async () => {
    const f = fakeSpawn();
    let t = 0;
    const list = [{ id: 'aaaaaaaaaaaa', name: 'Clip editor', path: EXE, args: ['--open'] }, { id: 'bbbbbbbbbbbb', name: 'Scene', path: BAT, args: ['one'] }];
    const r = createProgramRunner({ getList: () => list, spawnImpl: f.spawnImpl, exists: (p) => p !== '/gone', now: () => t });
    assert.deepEqual(await r.run({ program: 'clip EDITOR' }), { program: 'Clip editor', pid: 4242 });
    assert.deepEqual([f.calls[0].cmd, f.calls[0].args, f.calls[0].opts.shell, f.calls[0].opts.detached], [EXE, ['--open'], false, true]);
    await r.run({ program: 'Scene', args: ['--evil'], path: 'C:\\Windows\\System32\\cmd.exe' });
    assert.deepEqual(f.calls[1].args.slice(0, 4), ['/d', '/c', BAT, 'one'], '.bat through cmd.exe; extra params from the server are ignored');
    assert.equal(f.calls[1].args.length, 4);
    await assert.rejects(() => r.run({ program: 'notepad' }), (e) => e.code === 'not_allowed');
    await assert.rejects(() => r.run({ program: 'C:\\Windows\\System32\\calc.exe' }), (e) => e.code === 'bad_params');
    await assert.rejects(() => r.run({}), (e) => e.code === 'bad_params');
    list.push({ id: 'cccccccccccc', name: 'Gone', path: '/gone', args: [] });
    await assert.rejects(() => r.run({ program: 'Gone' }), (e) => e.code === 'not_found');
    for (let i = 0; i < 8; i++) await r.run({ program: 'Clip editor' });
    await assert.rejects(() => r.run({ program: 'Clip editor' }), (e) => e.code === 'rate');
    t += 61_000;
    await r.run({ program: 'Clip editor' });
    assert.equal(f.calls.length, 11);
});

test('system.run through the router: capability run, plain errors, the activity label', async () => {
    const f = fakeSpawn();
    const runner = createProgramRunner({ getList: () => [{ id: 'aaaaaaaaaaaa', name: 'Clip editor', path: EXE, args: [] }], spawnImpl: f.spawnImpl, exists: () => true });
    const router = createRouter({ obs: {}, sound: {}, library: {}, keys: {}, extra: { 'system.run': (p) => runner.run(p) } });
    assert.ok(router.capabilities().includes('run'));
    assert.equal((await router.run('system.run', { program: 'Clip editor' })).ok, true);
    const no = await router.run('system.run', { program: 'Calculator' });
    assert.equal(no.ok, false);
    assert.match(no.error, /^not_allowed: "Calculator" is not in Studio's list/);
    assert.equal(ACTION_LABELS['system.run'], 'Run a program');
    assert.equal(summarise('system.run', { program: 'Clip editor' }), 'Clip editor');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    assert.match(main, /'system\.run': \(p\) => programRunner\.run\(p \|\| \{\}\)/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    assert.match(html, /Programs it may run/);
});

test('a real program from the list starts on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    const exe = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'where.exe');
    const v = validateProgram({ name: 'Where', path: exe, args: 'where' });
    assert.equal(v.ok, true);
    const r = createProgramRunner({ getList: () => [v.value] });
    const out = await r.run({ program: 'where' });
    assert.equal(out.program, 'Where');
    assert.ok(Number.isInteger(out.pid));
    assert.ok(fs.existsSync(os.tmpdir()));
});
