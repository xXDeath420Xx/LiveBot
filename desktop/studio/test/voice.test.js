'use strict';
/*
 * Voice commands: the manager (src/main/voice.js) with a fake helper process (threshold, repeats, push-to-talk gating,
 * restarts, phrase changes), and on Windows the REAL helper (src/voice/speech-helper.ps1, System.Speech) fed with
 * speech synthesised by Windows itself (test/voice-synth.ps1) — no microphone, nothing recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { createVoice, cleanPhrase, clampThreshold, normaliseCommand, COOLDOWN_DEFAULT_MS } = require('../src/main/voice');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-voice-'));

function fakeSpawn() {
    const f = { procs: [], spawn: null };
    f.spawn = (cmd, args) => {
        const p = new EventEmitter();
        p.cmd = cmd; p.args = args;
        p.stdout = new PassThrough();
        p.stderr = new PassThrough();
        p.written = [];
        p.stdin = new PassThrough();
        p.stdin.on('data', (d) => p.written.push(d));
        p.kill = () => { p.killed = true; p.emit('exit', 0); };
        p.say = (obj) => p.stdout.write(`${JSON.stringify(obj)}\n`);
        f.procs.push(p);
        return p;
    };
    return f;
}

test('manager: grammar file, ready, threshold, repeats, push-to-talk gating, phrase changes restart', async () => {
    const f = fakeSpawn();
    const heard = [];
    let settings = { threshold: 0.7, mode: 'always' };
    let t = 1000;
    const dir = tmp();
    const v = createVoice({ helperPath: 'C:\\x\\speech-helper.ps1', spawnImpl: f.spawn, tmpDir: dir, getSettings: () => settings, onPhrase: (p) => heard.push(p), now: () => t });
    v.setPhrases(['Start the RAID', '  be   right back ', '', 'start the raid']);
    assert.deepEqual(v.phrases, ['start the raid', 'be right back'], 'cleaned and deduplicated');
    v.start();
    const p = f.procs[0];
    assert.equal(p.cmd, 'powershell.exe');
    assert.deepEqual(p.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.deepEqual(p.args.slice(-2), ['-CatchAll', 'garbage'], 'the wildcard catch-all by default (0.2.10)');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'voice-phrases.json'), 'utf8')), ['start the raid', 'be right back']);
    assert.equal(v.feed(Buffer.alloc(10)), false, 'nothing is sent before the helper is ready');
    p.say({ type: 'ready', culture: 'en-US', phrases: 2 });
    await new Promise((r) => setImmediate(r));
    assert.equal(v.status().state, 'listening');
    assert.equal(v.feed(Buffer.alloc(3200)), true);
    p.say({ type: 'recognized', text: 'start the raid', confidence: 0.92 });
    p.say({ type: 'recognized', text: 'be right back', confidence: 0.4 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(heard, [{ text: 'start the raid', confidence: 0.92 }], 'below the threshold does not count');
    assert.equal(v.status().lastHeard.accepted, false);
    p.say({ type: 'recognized', text: 'start the raid', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
    assert.equal(heard.length, 1, 'the same phrase within 1.5 s counts once');
    t += 2000;
    p.say({ type: 'recognized', text: 'start the raid', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
    assert.equal(heard.length, 1, 'still inside the default 10 s cooldown (0.2.10)');
    t += COOLDOWN_DEFAULT_MS;
    p.say({ type: 'recognized', text: 'start the raid', confidence: 0.95 });
    await new Promise((r) => setImmediate(r));
    assert.equal(heard.length, 2);

    settings = { ...settings, mode: 'ptt' };
    const before = p.written.length;
    assert.equal(v.feed(Buffer.alloc(3200)), false, 'push to talk: nothing while the key is up');
    v.setHeld(true);
    assert.equal(v.feed(Buffer.alloc(3200)), true);
    v.setHeld(false);
    await new Promise((r) => setImmediate(r));
    assert.equal(p.written.length, before + 2, 'one chunk while held, then a short silence on release');
    assert.equal(p.written.at(-1).length, 16000, '0.5 s of silence');

    v.setPhrases(['start the raid', 'be right back', 'play the airhorn']);
    assert.equal(f.procs.length, 2, 'new phrases: the helper restarts with the new grammar');
    v.stop();
    assert.equal(v.status().state, 'off');
});

test('manager: helper errors are explained; crashes restart at most three times a minute; no phrases', async () => {
    const f = fakeSpawn();
    const v = createVoice({ helperPath: 'h.ps1', spawnImpl: f.spawn, tmpDir: tmp() });
    v.start();
    assert.equal(v.status().state, 'error', 'no phrases yet');
    assert.match(v.status().error, /no voice commands yet/i);
    v.setPhrases(['brb']);
    f.procs[0].say({ type: 'error', message: 'no_recognizer' });
    await new Promise((r) => setImmediate(r));
    assert.match(v.status().error, /speech recogniser/);
    v.stop();
    assert.equal(cleanPhrase('  a\n b  '), 'a b');
});

const canSpeak = (() => {
    if (process.platform !== 'win32') return false;
    try { return /MS-1033|Recognizer/i.test(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | % { $_.Id }'], { encoding: 'utf8', timeout: 20000 })); } catch { return false; }
})();

test('the real helper recognises phrases spoken by a Windows voice, offline', { skip: !canSpeak && 'needs Windows with a System.Speech recogniser', timeout: 90000 }, async () => {
    const dir = tmp();
    const wav = (text, name) => {
        const out = path.join(dir, `${name}.wav`);
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice-synth.ps1'), '-Text', text, '-Out', out], { timeout: 30000 });
        const b = fs.readFileSync(out);
        return b.subarray(b.indexOf(Buffer.from('data')) + 8);
    };
    const raid = wav('start the raid', 'raid');
    const other = wav('what a lovely day', 'other');
    const near = wav('check the pokemon', 'near');
    const heard = [];
    const logged = [];
    const statuses = [];
    const v = createVoice({ helperPath: path.join(__dirname, '..', 'src', 'voice', 'speech-helper.ps1'), tmpDir: dir, getSettings: () => ({ threshold: 0.6, mode: 'always' }), onPhrase: (p) => heard.push(p), onLog: (e) => logged.push(e), onStatus: (s) => statuses.push(s.state) });
    v.setPhrases(['start the raid', 'be right back', 'play the airhorn', 'pokecheck']);
    v.start();
    for (let i = 0; i < 200 && v.status().state !== 'listening'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(v.status().state, 'listening');
    const feed = async (buf) => { for (let o = 0; o < buf.length; o += 3200) { v.feed(buf.subarray(o, o + 3200)); await new Promise((r) => setTimeout(r, 5)); } };
    await feed(Buffer.alloc(16000));
    await feed(other);
    await feed(Buffer.alloc(32000));
    await feed(near);
    await feed(Buffer.alloc(32000));
    await feed(raid);
    await feed(Buffer.alloc(32000));
    for (let i = 0; i < 100 && !heard.length; i++) await new Promise((r) => setTimeout(r, 100));
    v.stop();
    assert.equal(heard.length, 1, `heard ${JSON.stringify(heard)}`);
    assert.equal(heard[0].text, 'start the raid');
    assert.ok(heard[0].confidence >= 0.6);
    assert.equal(v.status().catchAll, 'garbage');
    assert.ok(logged.some((e) => e.outcome === 'noise'), `ordinary speech went to the catch-all: ${JSON.stringify(logged)}`);
    assert.ok(!logged.some((e) => e.phrase === 'pokecheck' && e.outcome === 'fired'), '"check the pokemon" did not fire "pokecheck"');
    assert.ok(logged.filter((e) => e.outcome === 'noise').every((e) => e.heard === null), 'no words are kept while log all speech is off');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('manager: a confidence setting of 0.2 counts a 0.25 phrase; below 0.2 clamps up, above 0.95 clamps down, nonsense is the 0.7 default', async () => {
    assert.equal(clampThreshold(0.2), 0.2);
    assert.equal(clampThreshold(0.05), 0.2);
    assert.equal(clampThreshold(0.123), 0.2);
    assert.equal(clampThreshold(0.99), 0.95);
    assert.equal(clampThreshold('x'), 0.7);
    assert.equal(clampThreshold(undefined), 0.7);
    assert.equal(clampThreshold(0.35), 0.35);
    const f = fakeSpawn();
    const heard = [];
    let settings = { threshold: 0.2, mode: 'always' };
    let t = 1000;
    const v = createVoice({ helperPath: 'C:/x/speech-helper.ps1', spawnImpl: f.spawn, tmpDir: tmp(), getSettings: () => settings, onPhrase: (p) => heard.push(p), now: () => t });
    v.setPhrases(['reset counters']);
    v.start();
    const p = f.procs[0];
    p.say({ type: 'ready', culture: 'en-US', phrases: 1 });
    await new Promise((r) => setImmediate(r));
    p.say({ type: 'recognized', text: 'reset counters', confidence: 0.25 });
    p.say({ type: 'recognized', text: 'reset counters', confidence: 0.15 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(heard, [{ text: 'reset counters', confidence: 0.25 }], 'at 0.2 a 0.25 phrase counts (the old floor of 0.5 dropped it)');
    t += 11000;
    p.say({ type: 'recognized', text: 'reset counters', confidence: 0.15 });
    await new Promise((r) => setImmediate(r));
    assert.equal(heard.length, 1, 'still below 0.2: not counted');
    settings = { ...settings, threshold: 0.7 };
    t += 11000;
    p.say({ type: 'recognized', text: 'reset counters', confidence: 0.25 });
    await new Promise((r) => setImmediate(r));
    assert.equal(heard.length, 1, 'back at 0.7 the same phrase does not count');
    v.stop();
});

test('the slider and the settings handler allow 20% to 95% in steps of 5, and the default stays 70%', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    assert.match(html, /id="voice-threshold" min="20" max="95" step="5"/);
    const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
    assert.match(cfg, /threshold: 0\.7/);
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    assert.match(main, /patch\.threshold = clampThreshold\(t\)/);
    assert.match(main, /'voice\.enable'/);
});

test('0.2.10 outcomes: noise from the catch-all, per-command confidence, per-command cooldown, a turned-off automation', async () => {
    const f = fakeSpawn();
    const heard = [];
    const logged = [];
    let settings = { threshold: 0.7, mode: 'always', logAllSpeech: false };
    let t = 100000;
    const off = new Set([9]);
    const v = createVoice({ helperPath: 'h.ps1', spawnImpl: f.spawn, tmpDir: tmp(), getSettings: () => settings, onPhrase: (p) => heard.push(p), onLog: (e) => logged.push(e), isEnabled: (id) => !off.has(id), now: () => t });
    v.setPhrases([
        { text: 'BRB', automationId: 1, confidence: 0.9, cooldownMs: 30000 },
        { text: 'pokecheck', automationId: 2, confidence: null, cooldownMs: null },
        { text: 'wipe it all down', automationId: 9 },
        'scene one',
    ]);
    assert.deepEqual(v.command('brb'), { text: 'brb', confidence: 0.9, cooldownMs: 30000, automationId: 1 });
    assert.equal(v.command('pokecheck').cooldownMs, COOLDOWN_DEFAULT_MS, 'no cooldown given: 10 s');
    v.start();
    const p = f.procs[0];
    p.say({ type: 'ready', culture: 'en-US', phrases: 4, catchAll: 'garbage' });
    await new Promise((r) => setImmediate(r));
    const say = async (o) => { p.say({ type: 'recognized', ...o }); await new Promise((r) => setImmediate(r)); };

    await say({ text: '...', confidence: 1, grammar: 'garbage' });
    await say({ text: 'what the table dealt', confidence: 0.41, grammar: 'dictation' });
    assert.deepEqual(logged.map((e) => [e.outcome, e.heard, e.phrase]), [['noise', null, null], ['noise', null, null]], 'not a command; with log all speech off no words are kept');
    assert.equal(heard.length, 0);

    settings = { ...settings, logAllSpeech: true };
    await say({ text: 'what the table dealt', confidence: 0.41, grammar: 'dictation' });
    assert.equal(logged.at(-1).heard, 'what the table dealt', 'log all speech: the dictated words');

    await say({ text: 'brb', confidence: 0.85, grammar: 'commands' });
    assert.deepEqual([logged.at(-1).outcome, logged.at(-1).threshold], ['below', 0.9], 'its own 90% beats the global 70%');
    await say({ text: 'brb', confidence: 0.93, grammar: 'commands' });
    assert.equal(logged.at(-1).outcome, 'fired');
    t += 20000;
    await say({ text: 'brb', confidence: 0.95, grammar: 'commands' });
    assert.equal(logged.at(-1).outcome, 'cooldown', 'its own 30 s cooldown');
    t += 11000;
    await say({ text: 'brb', confidence: 0.95, grammar: 'commands' });
    assert.equal(logged.at(-1).outcome, 'fired');

    await say({ text: 'pokecheck', confidence: 0.75, grammar: 'commands' });
    assert.deepEqual([logged.at(-1).outcome, logged.at(-1).threshold, logged.at(-1).automationId], ['fired', 0.7, 2]);
    t += 5000;
    await say({ text: 'pokecheck', confidence: 0.75, grammar: 'commands' });
    assert.equal(logged.at(-1).outcome, 'cooldown', 'default 10 s');

    await say({ text: 'wipe it all down', confidence: 0.99, grammar: 'commands' });
    assert.equal(logged.at(-1).outcome, 'disabled');

    await say({ text: 'scene one', confidence: 0.71 });
    assert.equal(logged.at(-1).outcome, 'fired', 'a helper without grammar names (before 0.2.10) counts as commands');
    assert.deepEqual(heard.map((h) => h.text), ['brb', 'brb', 'pokecheck', 'scene one']);
    v.stop();
});

test('0.2.10: turning log all speech on restarts the helper with the dictation catch-all, and off again with the wildcard', async () => {
    const f = fakeSpawn();
    let settings = { threshold: 0.7, logAllSpeech: false };
    const v = createVoice({ helperPath: 'h.ps1', spawnImpl: f.spawn, tmpDir: tmp(), getSettings: () => settings });
    v.setPhrases(['brb']);
    v.start();
    assert.equal(v.refresh(), false, 'nothing changed: no restart');
    settings = { ...settings, logAllSpeech: true };
    assert.equal(v.refresh(), true);
    assert.deepEqual(f.procs.at(-1).args.slice(-2), ['-CatchAll', 'dictation']);
    settings = { ...settings, logAllSpeech: false };
    v.refresh();
    assert.deepEqual(f.procs.at(-1).args.slice(-2), ['-CatchAll', 'garbage']);
    assert.equal(f.procs.length, 3);
    v.stop();
});

test('0.2.10: commands are cleaned; confidence clamps; bad cooldowns fall back to 10 s', () => {
    assert.deepEqual(normaliseCommand('  Be  Right Back '), { text: 'be right back', confidence: null, cooldownMs: 10000, automationId: null });
    assert.equal(normaliseCommand({ text: 'x', confidence: 0.05 }).confidence, 0.2);
    assert.equal(normaliseCommand({ text: 'x', confidence: 2 }).confidence, 0.95);
    assert.equal(normaliseCommand({ text: 'x', cooldownMs: -5 }).cooldownMs, 10000);
    assert.equal(normaliseCommand({ text: 'x', cooldownMs: 0 }).cooldownMs, 0);
    assert.equal(normaliseCommand({ text: 'x', cooldownMs: 99999999 }).cooldownMs, 3600000);
    assert.equal(normaliseCommand({ text: '' }), null);
});

test('0.2.10: the helper loads a catch-all grammar and names the grammar of each result; Studio never suggests 20%', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'speech-helper.ps1'), 'utf8');
    assert.match(ps, /AppendWildcard\(\)/);
    assert.match(ps, /DictationGrammar/);
    assert.match(ps, /grammar = \$gname/);
    assert.match(ps, /\$commands\.Name = 'commands'/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    assert.match(html, /id="voice-log"/);
    assert.match(html, /id="voice-log-clear"/);
    assert.match(html, /Studio scores speech differently from Streamer\.bot/);
    assert.match(html, /Through your Govee key \(cloud\)/);
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji');
    const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    for (const c of ['voice:clearLog', 'lights:cloud', 'lights:cloudTest', 'alertAudio:apply', 'alertAudio:undo', "'voice-log'"]) assert.ok(pre.includes(c), c);
});

test('0.2.10, the real helper with log all speech: ordinary speech is logged with its words and still runs nothing', { skip: !canSpeak && 'needs Windows with a System.Speech recogniser', timeout: 90000 }, async () => {
    const dir = tmp();
    const out = path.join(dir, 'o.wav');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice-synth.ps1'), '-Text', 'what a lovely day', '-Out', out], { timeout: 30000 });
    const b = fs.readFileSync(out);
    const other = b.subarray(b.indexOf(Buffer.from('data')) + 8);
    const heard = [];
    const logged = [];
    const v = createVoice({ helperPath: path.join(__dirname, '..', 'src', 'voice', 'speech-helper.ps1'), tmpDir: dir, getSettings: () => ({ threshold: 0.7, mode: 'always', logAllSpeech: true }), onPhrase: (p) => heard.push(p), onLog: (e) => logged.push(e) });
    v.setPhrases(['start the raid', 'be right back']);
    v.start();
    for (let i = 0; i < 200 && v.status().state !== 'listening'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(v.status().catchAll, 'dictation');
    for (const buf of [Buffer.alloc(16000), other, Buffer.alloc(32000)]) for (let o = 0; o < buf.length; o += 3200) { v.feed(buf.subarray(o, o + 3200)); await new Promise((r) => setTimeout(r, 5)); }
    for (let i = 0; i < 100 && !logged.length; i++) await new Promise((r) => setTimeout(r, 100));
    v.stop();
    assert.equal(heard.length, 0);
    assert.equal(logged[0]?.outcome, 'noise', JSON.stringify(logged));
    assert.ok(logged[0].heard && logged[0].heard.length > 3, 'the dictated words are in the log');
    fs.rmSync(dir, { recursive: true, force: true });
});
