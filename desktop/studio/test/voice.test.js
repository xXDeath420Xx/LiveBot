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
const { createVoice, cleanPhrase } = require('../src/main/voice');

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
    const heard = [];
    const statuses = [];
    const v = createVoice({ helperPath: path.join(__dirname, '..', 'src', 'voice', 'speech-helper.ps1'), tmpDir: dir, getSettings: () => ({ threshold: 0.6, mode: 'always' }), onPhrase: (p) => heard.push(p), onStatus: (s) => statuses.push(s.state) });
    v.setPhrases(['start the raid', 'be right back', 'play the airhorn']);
    v.start();
    for (let i = 0; i < 200 && v.status().state !== 'listening'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(v.status().state, 'listening');
    const feed = async (buf) => { for (let o = 0; o < buf.length; o += 3200) { v.feed(buf.subarray(o, o + 3200)); await new Promise((r) => setTimeout(r, 5)); } };
    await feed(Buffer.alloc(16000));
    await feed(other);
    await feed(Buffer.alloc(32000));
    await feed(raid);
    await feed(Buffer.alloc(32000));
    for (let i = 0; i < 100 && !heard.length; i++) await new Promise((r) => setTimeout(r, 100));
    v.stop();
    assert.equal(heard.length, 1, `heard ${JSON.stringify(heard)}`);
    assert.equal(heard[0].text, 'start the raid');
    assert.ok(heard[0].confidence >= 0.6);
    fs.rmSync(dir, { recursive: true, force: true });
});
