'use strict';
/*
 * Voice commands 0.2.12: Silero voice activity detection, Whisper and matching.
 *   - matching (voice-match.js): the owner's phrases as Whisper writes them, near misses, wake phrase, prompt
 *   - the segmenter (voice-vad.js) with made-up per-frame chances: clicks are dropped, speech is cut with padding
 *   - the REAL Silero model through onnxruntime-node: clicks, typing, noise, beeps and a bang never make a segment;
 *     speech from a Windows voice does (Windows only, for the voice)
 *   - the pipeline (voice-whisper.js) with a fake detector and a fake Whisper: gating, outcomes, per-command threshold and
 *     cooldown, wake word, push to talk and tap, privacy of the words, engine failure
 *   - the engine (whisper-engine.js) with a fake server and fake downloads: checksums, graphics card then processor
 *   - static checks on the page, the settings and the packaging
 * The full run with real Whisper on this PC is scripts/voice-selftest.js (see the 0.2.12 report).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');

const { normalise, scorePhrase, matchCommands, stripWake, biasPrompt } = require('../src/main/voice-match');
const { createSegmenter, createSileroVad, FRAME } = require('../src/main/voice-vad');
const { createWhisperVoice, clampMatch, normaliseCommand, WAKE_WINDOW_MS } = require('../src/main/voice-whisper');
const { createWhisperEngine, download, wavBytes, GPU_BACKEND, CUDA_RUNTIME, MODELS } = require('../src/main/whisper-engine');
const { readWav, playInto } = require('../src/main/voice-file');

const ROOT = path.join(__dirname, '..');
const OWNER = ["Let's Get Into The Game", "Let's Have a Chat", 'Time for a Break', 'Go Live On Stream Right Now', 'took another dab', 'Fuck, I died again', 'Reset Counters',
    'Pokeycheck', 'Run Bitch Run!', 'Kill the Counters', 'Bring back the counters', 'Toggle Discord Audio', 'Join the Discord', 'wipe it all down'].map((text, i) => ({ text, automationId: i + 1 }));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-whisper-'));

// ── matching ──
test('matching: Whisper spellings of the owner\'s phrases score high, other sentences stay low', () => {
    assert.equal(normalise("  Let's  GET into the game!! "), 'lets get into the game');
    assert.equal(normalise('Uh, pokey check.'), 'pokey check');
    const best = (t) => matchCommands(t, OWNER).best;
    for (const [heard, phrase, min] of [['Pokey Check.', 'Pokeycheck', 0.99], ['Pokeycheck.', 'Pokeycheck', 0.99], ['Poke check.', 'Pokeycheck', 0.85], ['Run, bitch, run!', 'Run Bitch Run!', 0.99],
        ["Let's get into the game.", "Let's Get Into The Game", 0.99], ['Time for a break.', 'Time for a Break', 0.99], ['Okay, time for a break now.', 'Time for a Break', 0.95],
        ['Kill the counter.', 'Kill the Counters', 0.9], ['Took another dab.', 'took another dab', 0.99], ['Go live on stream right now.', 'Go Live On Stream Right Now', 0.99]]) {
        const b = best(heard);
        assert.equal(b.cmd.text, phrase, heard);
        assert.ok(b.score >= min, `${heard}: ${b.score}`);
    }
    // the sentences the old recogniser forced onto commands, and ordinary talk: under the 0.8 default
    for (const t of ['wipe the table down', 'What a lovely day', 'check the pokemon', 'Poker chips', 'I will be right there', 'Thank you.', 'lights are on now', 'run']) {
        assert.ok(best(t).score < 0.8, `${t}: ${best(t).score} (${best(t).cmd.text})`);
    }
    // a heard word pairs with one phrase word only: "run bitch" is not all of "Run Bitch Run!"
    assert.ok(scorePhrase('run bitch', 'Run Bitch Run!').score < 0.9);
    assert.equal(scorePhrase('', 'x').score, 0);
});

test('matching: the wake phrase at the start (one word before it allowed), and the bias prompt', () => {
    assert.deepEqual(stripWake('Hey Studio, pokeycheck.'), { found: true, rest: 'pokeycheck' });
    assert.deepEqual(stripWake('Hey, Studio.'), { found: true, rest: '' });
    assert.deepEqual(stripWake('OK hey studio run bitch run'), { found: true, rest: 'run bitch run' });
    assert.equal(stripWake('Pokeycheck').found, false);
    assert.equal(stripWake('I said hey studio earlier').found, false, 'not in the middle of a sentence');
    assert.deepEqual(stripWake('computer reset counters', 'computer'), { found: true, rest: 'reset counters' });
    const p = biasPrompt(['Pokeycheck', 'Run Bitch Run!', '', '  ']);
    assert.equal(p, 'Pokeycheck. Run Bitch Run!');
    assert.ok(biasPrompt(Array.from({ length: 300 }, (_, i) => `phrase number ${i}`)).length <= 620, 'kept within Whisper\'s prompt size');
});

// ── the segmenter ──
function frames(n, v = 0.01) { return Array.from({ length: n }, () => new Float32Array(FRAME).fill(v)); }
function run(seg, probs, t0 = 0) {
    const out = [];
    probs.forEach((p, i) => { const r = seg.push(new Float32Array(FRAME).fill(i), p, t0 + i * 32); if (r) out.push(r); });
    return out;
}

test('segmenter: a click (one or two loud frames) is dropped as short; speech becomes one padded segment', () => {
    const seg = createSegmenter();
    // click: 2 frames over the threshold, then silence
    let out = run(seg, [0.02, 0.02, 0.9, 0.7, ...Array(15).fill(0.02)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'short');
    assert.ok(out[0].speechMs < 250);
    // speech: 30 frames (~1 s), then 300 ms of silence ends it
    seg.reset();
    out = run(seg, [...Array(10).fill(0.05), ...Array(30).fill(0.9), ...Array(12).fill(0.05)], 1000);
    assert.equal(out.length, 1);
    const s = out[0];
    assert.equal(s.type, 'segment');
    assert.equal(s.speechMs, 960);
    assert.equal(s.endAt, 1000 + 39 * 32, 'latency is counted from the last voiced frame');
    // 200 ms padding before (6 frames) and after (6 of the 10 silent frames that ended it)
    assert.equal(s.samples.length / FRAME, 6 + 30 + 6);
    assert.equal(s.samples[0], 4, 'pre-roll starts 6 frames before speech');
});

test('segmenter: brief dips do not split a phrase; long talk is cut at maxSpeechMs; flush ends at once', () => {
    const seg = createSegmenter({ minSilenceMs: 300 });
    const out = run(seg, [...Array(15).fill(0.9), ...Array(5).fill(0.1), ...Array(15).fill(0.9), ...Array(12).fill(0.02)]);
    assert.equal(out.length, 1, 'a 160 ms pause between words is one phrase');
    assert.equal(out[0].speechMs, 30 * 32);
    const long = createSegmenter({ maxSpeechMs: 2000 });
    const o2 = run(long, Array(200).fill(0.9));
    assert.ok(o2.length >= 3 && o2.every((x) => x.type === 'segment'));
    const ptt = createSegmenter();
    run(ptt, Array(20).fill(0.9));
    assert.equal(ptt.active, true);
    const f = ptt.flush(5000);
    assert.equal(f.type, 'segment');
    assert.equal(f.endAt, 5000);
    assert.equal(ptt.active, false);
    assert.equal(ptt.flush(6000), null);
});

test('segmenter: sound the model only half believes is a voice (music, a jingle) is dropped as unclear', () => {
    const seg = createSegmenter();
    const out = run(seg, [...Array(30).fill(0.65), ...Array(12).fill(0.02)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'unclear');
    const strict = createSegmenter({ minMeanProb: 0 });
    assert.equal(run(strict, [...Array(30).fill(0.65), ...Array(12).fill(0.02)])[0].type, 'segment', 'the gate is a setting');
});

// ── the real Silero model ──
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function synth(kind, seconds) {
    const a = new Float32Array(Math.round(seconds * 16000));
    if (kind === 'click') for (let t = 0.2; t < seconds; t += 0.5) for (let i = 0; i < 200; i++) a[Math.round(t * 16000) + i] = 0.9 * (rnd() * 2 - 1) * Math.exp(-i / 24);
    if (kind === 'typing') for (let t = 0.05; t < seconds - 0.05; t += 0.06 + rnd() * 0.16) for (let i = 0; i < 190; i++) a[Math.round(t * 16000) + i] = (0.3 + rnd() * 0.6) * (rnd() * 2 - 1) * Math.exp(-i / 24);
    if (kind === 'white') for (let i = 0; i < a.length; i++) a[i] = 0.25 * (rnd() * 2 - 1);
    if (kind === 'beep') for (let i = 0; i < a.length; i++) a[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / 16000);
    if (kind === 'bang') { let lp = 0; for (let i = 0; i < a.length; i++) { lp += 0.08 * ((rnd() * 2 - 1) - lp); a[i] = Math.max(-1, Math.min(1, 2.8 * lp * Math.exp(-i / 2900))); } }
    return a;
}
async function vadRun(vad, samples) {
    vad.reset();
    const seg = createSegmenter();
    const out = [];
    let max = 0;
    for (let off = 0; off + FRAME <= samples.length; off += FRAME) {
        const f = samples.slice(off, off + FRAME);
        const p = await vad.prob(f);
        max = Math.max(max, p);
        const r = seg.push(f, p, off / 16);
        if (r) out.push(r);
    }
    const end = seg.flush(samples.length / 16);
    if (end) out.push(end);
    return { segments: out.filter((r) => r.type === 'segment'), short: out.filter((r) => r.type === 'short').length, max };
}

const ortOk = (() => { try { require.resolve('onnxruntime-node'); return fs.existsSync(path.join(ROOT, 'src', 'voice', 'silero_vad.onnx')); } catch { return false; } })();
const canSpeak = process.platform === 'win32' && (() => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count'], { encoding: 'utf8', windowsHide: true }).trim() !== '0'; } catch { return false; } })();

test('the real Silero VAD: clicks, typing, noise, a beep and a bang never become speech', { skip: !ortOk && 'onnxruntime-node or the model missing', timeout: 60000 }, async () => {
    const vad = createSileroVad({ modelPath: path.join(ROOT, 'src', 'voice', 'silero_vad.onnx') });
    await vad.load();
    for (const kind of ['click', 'typing', 'white', 'beep', 'bang']) {
        const r = await vadRun(vad, synth(kind, 3));
        assert.equal(r.segments.length, 0, `${kind} made a speech segment (max chance ${r.max.toFixed(2)})`);
    }
    const silent = await vadRun(vad, new Float32Array(16000));
    assert.equal(silent.segments.length + silent.short, 0);
    await vad.close();
});

test('the real Silero VAD: a Windows voice saying a command is one speech segment', { skip: !(ortOk && canSpeak) && 'needs Windows voices and onnxruntime', timeout: 60000 }, async () => {
    const dir = tmp();
    const wav = path.join(dir, 'p.wav');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice-synth.ps1'), '-Text', 'Time for a break', '-Out', wav], { windowsHide: true });
    const speech = readWav(wav);
    const vad = createSileroVad({ modelPath: path.join(ROOT, 'src', 'voice', 'silero_vad.onnx') });
    await vad.load();
    const pad = new Float32Array(8000);
    const all = new Float32Array(pad.length * 2 + speech.length);
    all.set(synth('typing', 0.5), 0); all.set(speech, pad.length);
    const r = await vadRun(vad, all);
    assert.equal(r.segments.length, 1);
    assert.ok(r.segments[0].speechMs >= 500, `speech ${r.segments[0].speechMs} ms`);
    await vad.close();
});

// ── the pipeline, with a fake detector and a fake Whisper ──
function fakeVad(probFor = () => 0.01) {
    return { loaded: false, async load() { this.loaded = true; }, async prob(f) { return probFor(f); }, reset() {} };
}
function fakeWhisper(answers) {
    const r = { calls: [], prompts: [], started: 0, fail: null };
    r.start = async () => { if (r.fail) throw Object.assign(new Error(r.fail), { code: 'start_failed' }); r.started += 1; return { device: 'cuda', model: 'large-v3-turbo-q5_0', gpuName: 'Test GPU' }; };
    r.transcribe = async (samples, { prompt }) => { r.calls.push(samples.length); r.prompts.push(prompt); const a = typeof answers === 'function' ? answers(r.calls.length) : answers.shift(); return { text: a ?? '', ms: 5, noSpeech: 0, avgLogprob: -0.1 }; };
    r.stop = () => {};
    r.status = () => ({});
    return r;
}
// audio where the sample value says "speech" (1) or not (0): the fake VAD reads it back
function pcm(seconds, speech) { const b = Buffer.alloc(Math.round(seconds * 16000) * 2); if (speech) for (let i = 0; i < b.length; i += 2) b.writeInt16LE(16000, i); return b; }
const vadFromLevel = (f) => (f[100] > 0.3 ? 0.95 : 0.02);

async function setup(answers, settings = {}) {
    const logs = [];
    const fired = [];
    let t = 1_000_000;
    const s = { mode: 'always', matchThreshold: 0.8, logAllSpeech: false, ...settings };
    const rec = fakeWhisper(answers);
    const enabled = new Map();
    const v = createWhisperVoice({ vad: fakeVad(vadFromLevel), recogniser: rec, getSettings: () => s, onLog: (e) => logs.push(e), onPhrase: (p) => fired.push(p.text), isEnabled: (id) => enabled.get(id) ?? true, now: () => t });
    v.setPhrases(OWNER.map((o) => ({ ...o, cooldownMs: 10000 })));
    v.start();
    for (let i = 0; i < 50 && v.status().state !== 'listening'; i++) await new Promise((r) => setImmediate(r));
    const say = async (speechSeconds = 1, gap = 0.5) => { v.feed(pcm(0.2, false)); v.feed(pcm(speechSeconds, true)); v.feed(pcm(gap, false)); await v.idle(); };
    return { v, logs, fired, rec, s, enabled, say, tick: (ms) => { t += ms; } };
}

test('pipeline: silence and clicks never reach Whisper; speech does, with the phrases as the prompt', async () => {
    const x = await setup(['Pokey check.']);
    assert.equal(x.v.status().state, 'listening');
    assert.equal(x.v.status().engine, 'whisper-cuda');
    x.v.feed(pcm(2, false));
    x.v.feed(Buffer.concat([pcm(0.04, true), pcm(0.6, false)]));   // a click: one or two loud frames
    await x.v.idle();
    assert.equal(x.rec.calls.length, 0, 'nothing went to Whisper');
    assert.equal(x.logs.filter((l) => l.outcome === 'short').length, 1, 'the click is logged as ignored');
    await x.say(1);
    assert.equal(x.rec.calls.length, 1);
    assert.match(x.rec.prompts[0], /Pokeycheck\. Run Bitch Run! /);
    assert.deepEqual(x.fired, ['Pokeycheck']);
    const e = x.logs.find((l) => l.outcome === 'fired');
    assert.equal(e.heard, 'Pokey check.');
    assert.equal(e.phrase, 'Pokeycheck');
    assert.equal(e.confidence, 1);
    assert.equal(e.threshold, 0.8);
    assert.ok(e.vad.speechMs >= 900);
    assert.ok(Number.isFinite(e.latencyMs));
});

test('pipeline: below, cooldown, a turned-off automation, per-command threshold and cooldown, Whisper\'s silence words', async () => {
    const answers = ['Poke check.', 'Pokeycheck', 'Pokeycheck', 'Thank you.', '[BLANK_AUDIO]', 'wipe the table down', 'Reset counters', 'Reset counters', 'Time for a break'];
    const x = await setup(answers, { matchThreshold: 0.95 });
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'below', 'Poke check is 0.9, under 0.95');
    assert.equal(x.logs.at(-1).heard, null, 'words of a miss are not kept without "log all speech"');
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'fired');
    x.tick(3000);
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'cooldown');
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'noise', '"Thank you." is what Whisper says for noise');
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'noise');
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'below');
    // per-command: Reset Counters with its own 50% and no wait
    x.v.setPhrases(OWNER.map((o) => (o.text === 'Reset Counters' ? { ...o, confidence: 0.5, cooldownMs: 0 } : o)));
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'fired'); assert.equal(x.logs.at(-1).threshold, 0.5);
    x.tick(2000);
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'fired', 'no wait, but never twice within 1.5 s');
    x.enabled.set(3, false);
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'disabled');
    assert.deepEqual(x.fired, ['Pokeycheck', 'Reset Counters', 'Reset Counters']);
    assert.equal(normaliseCommand({ text: 'x', cooldownMs: -1 }).cooldownMs, 10000);
    assert.equal(clampMatch(0.2), 0.5);
    assert.equal(clampMatch(5), 0.98);
    assert.equal(clampMatch('x'), 0.8);
});

test('pipeline: "log all speech" keeps the words of misses; without it they are dropped', async () => {
    const x = await setup(['What a lovely day', 'What a lovely day'], { logAllSpeech: true });
    await x.say();
    assert.equal(x.logs.at(-1).outcome, 'noise');
    assert.equal(x.logs.at(-1).heard, 'What a lovely day');
    x.s.logAllSpeech = false;
    await x.say();
    assert.equal(x.logs.at(-1).heard, null);
});

test('pipeline: wake phrase in the same breath, wake then command, no wake, window closes', async () => {
    const x = await setup(['Hey Studio, pokeycheck.', 'Pokeycheck.', 'Hey studio.', 'Time for a break.', 'Hey studio', 'Join the discord'], { mode: 'wake' });
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'fired'); assert.equal(x.fired.at(-1), 'Pokeycheck');
    x.tick(20000);
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'nowake');
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'wake'); assert.equal(x.v.status().wakeOpen, true);
    x.tick(2000);
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'fired'); assert.equal(x.fired.at(-1), 'Time for a Break');
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'wake');
    x.tick(WAKE_WINDOW_MS + 1);
    await x.say(); assert.equal(x.logs.at(-1).outcome, 'nowake', 'too long after the wake phrase');
    assert.match(x.rec.prompts[0], /^hey studio\. /, 'the wake phrase is in the prompt too');
});

test('pipeline: push to talk uses audio only while the key is held; release ends the phrase; a tap listens once', async () => {
    const x = await setup(['Pokeycheck.', 'Join the Discord.'], { mode: 'ptt' });
    await x.say(1, 1);
    assert.equal(x.rec.calls.length, 0, 'key not held: nothing used');
    x.v.setHeld(true);
    assert.equal(x.v.held, true);
    x.v.feed(pcm(0.1, false)); x.v.feed(pcm(1, true));   // released while still talking
    x.v.setHeld(false);
    await x.v.idle();
    assert.deepEqual(x.fired, ['Pokeycheck'], 'the release ended the segment without waiting for silence');
    x.v.tap();
    assert.equal(x.v.held, true, 'a tap listens');
    await x.say(1, 0.5);
    assert.equal(x.fired.at(-1), 'Join the Discord');
    assert.equal(x.v.held, false, 'one phrase per tap');
    await x.say(1, 0.5);
    assert.equal(x.rec.calls.length, 2);
});

test('pipeline: Whisper failing to start is reported, so Studio can fall back', async () => {
    const rec = fakeWhisper([]);
    rec.fail = 'The Whisper files are missing from this copy of Studio.';
    let failed = null;
    const v = createWhisperVoice({ vad: fakeVad(), recogniser: rec, getSettings: () => ({ mode: 'always' }) });
    v.onEngineFailed = (e) => { failed = e; };
    v.setPhrases(['Pokeycheck']);
    v.start();
    for (let i = 0; i < 50 && !failed; i++) await new Promise((r) => setImmediate(r));
    assert.equal(v.status().state, 'error');
    assert.match(failed.message, /missing/);
    const none = createWhisperVoice({ vad: fakeVad(), recogniser: fakeWhisper([]), getSettings: () => ({}) });
    none.start();
    await new Promise((r) => setImmediate(r));
    assert.match(none.status().error, /no voice commands yet/);
});

// ── the engine ──
function fakeFetch(routes) {
    return async (url, opts = {}) => {
        const r = routes(String(url), opts);
        if (!r) throw new Error('refused');
        const body = r.body !== undefined ? Buffer.from(r.body) : Buffer.from(JSON.stringify(r.json || {}));
        return { ok: (r.status || 200) < 400, status: r.status || 200, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(body.length) : null) },
            body: (async function* () { yield body; })(), json: async () => JSON.parse(body.toString()), arrayBuffer: async () => body };
    };
}

test('engine: downloads are checked against their SHA-256; a wrong file is deleted, never used', async () => {
    const dir = tmp();
    const good = Buffer.from('model bytes');
    const sha = crypto.createHash('sha256').update(good).digest('hex');
    const dest = path.join(dir, 'm.bin');
    await assert.rejects(download({ url: 'https://x/m', dest, sha256: sha, fetchImpl: fakeFetch(() => ({ body: 'tampered' })) }), (e) => e.code === 'checksum');
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    await assert.rejects(download({ url: 'https://x/m', dest, sha256: sha, fetchImpl: fakeFetch(() => ({ status: 404, body: '' })) }), (e) => e.code === 'download_failed');
    await download({ url: 'https://x/m', dest, sha256: sha, fetchImpl: fakeFetch(() => ({ body: good })) });
    assert.deepEqual(fs.readFileSync(dest), good);
    // the pinned sources
    assert.match(GPU_BACKEND.url, /^https:\/\/certifriedmultitool\.com\/downloads\/studio\/CertiFried-Studio-Voice-CUDA-/);
    assert.match(GPU_BACKEND.sha256, /^[0-9a-f]{64}$/);
    for (const p of CUDA_RUNTIME.parts) { assert.match(p.url, /^https:\/\/developer\.download\.nvidia\.com\/compute\/cuda\/redist\//); assert.match(p.sha256, /^[0-9a-f]{64}$/); }
    for (const m of Object.values(MODELS)) assert.match(m.sha256, /^[0-9a-f]{64}$/);
    const w = wavBytes(new Float32Array([0, 1, -1]));
    assert.equal(w.toString('ascii', 0, 4), 'RIFF');
    assert.equal(w.readUInt32LE(24), 16000);
    assert.equal(w.readInt16LE(46), 32767);
    assert.equal(w.readInt16LE(48), -32768);
});

test('engine: graphics card first; when Whisper does not report CUDA it starts again on the processor with --no-gpu', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'whisper-server.exe'), '');
    // model and graphics card files already there (as after a first download)
    const m = MODELS['large-v3-turbo-q5_0'];
    const c = MODELS['base.en'];
    const data = path.join(dir, 'data');
    fs.mkdirSync(path.join(data, 'models'), { recursive: true });
    for (const x of [m, c]) { const f = path.join(data, 'models', x.file); fs.writeFileSync(f, ''); fs.truncateSync(f, x.size); fs.writeFileSync(`${f}.ok`, x.sha256); }
    const cuda = path.join(data, `cuda-${CUDA_RUNTIME.version}`);
    fs.mkdirSync(cuda, { recursive: true });
    for (const f of ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'ggml-cuda.dll', 'complete.json', `backend-${GPU_BACKEND.sha256.slice(0, 12)}.ok`]) fs.writeFileSync(path.join(cuda, f), 'x');
    const spawned = [];
    const spawnImpl = (exe, args, opts) => {
        const p = new EventEmitter();
        p.stdout = new PassThrough(); p.stderr = new PassThrough();
        p.kill = () => p.emit('exit', 0);
        spawned.push({ args, env: opts.env });
        // this "GPU" never reports a CUDA backend
        setImmediate(() => p.stderr.write('whisper_backend_init_gpu: no GPU found\n'));
        return p;
    };
    const e = createWhisperEngine({ binDir: bin, dataDir: data, spawnImpl, gpuProbe: async () => ({ name: 'Test GPU' }),
        fetchImpl: fakeFetch((url) => (url.endsWith('/inference') ? { json: { text: ' Pokeycheck.', segments: [{ no_speech_prob: 0.01, avg_logprob: -0.2 }] } } : { body: 'ok' })) });
    const r = await e.start();
    assert.equal(r.device, 'cpu');
    assert.equal(r.model, 'base.en');
    assert.equal(spawned.length, 2);
    assert.ok(!spawned[0].args.includes('-ng') && spawned[0].env.GGML_BACKEND_PATH.endsWith('ggml-cuda.dll'), 'first try on the graphics card');
    assert.ok(spawned[1].args.includes('-ng') && !spawned[1].env.GGML_BACKEND_PATH, 'then the processor');
    assert.ok(spawned.every((s) => s.args[s.args.indexOf('--host') + 1] === '127.0.0.1'), 'only ever on 127.0.0.1');
    const t = await e.transcribe(new Float32Array(16000), { prompt: 'Pokeycheck.' });
    assert.equal(t.text, 'Pokeycheck.');
    e.stop();
    assert.equal(e.status().state, 'off');
});

test('voice file input: a WAV is read at 16 kHz and played in 32 ms chunks', async () => {
    const dir = tmp();
    const f = path.join(dir, 'a.wav');
    fs.writeFileSync(f, wavBytes(new Float32Array(16000).fill(0.5)));
    const s = readWav(f);
    assert.equal(s.length, 16000);
    assert.ok(Math.abs(s[10] - 0.5) < 0.001);
    const got = [];
    await playInto(s, (b) => got.push(b.length), { realtime: false });
    assert.equal(got.length, Math.ceil(16000 / 512));
    assert.equal(got[0], 1024);
});

// ── static checks ──
test('0.2.12: the page, settings, main process and packaging', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    for (const id of ['voice-engine', 'voice-match', 'voice-wake', 'voice-input-warn', 'voice-input-fix', 'voice-fallback', 'voice-retry', 'voice-engine-line']) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /<option value="wake">After the wake phrase<\/option>/);
    assert.match(html, /<th>Voice detector<\/th>/);
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
    assert.match(html, /<select id="voice-device"><\/select>/, 'Studio never offers "default" as a microphone; the list is filled with real devices');
    const cfg = fs.readFileSync(path.join(ROOT, 'src', 'main', 'config.js'), 'utf8');
    assert.match(cfg, /engine: 'auto', matchThreshold: 0\.8, wakePhrase: 'hey studio'/);
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    assert.match(main, /d\.id === 'communications'/);
    assert.match(main, /const BUS_INPUT = \/voicemeeter\|vb-audio\|stereo mix/);
    assert.match(main, /'voice\.ptt'/);
    assert.match(main, /nowake: 'noise'/);
    assert.match(main, /if \(!SERVER_OUTCOME\[e\.outcome\]\) return;/, 'local-only outcomes never go to CertiFried');
    const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
    for (const c of ['voice:useMic', 'voice:retryWhisper']) assert.ok(pre.includes(c), c);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['onnxruntime-node'], '1.31.1');
    assert.ok(pkg.build.asarUnpack.includes('node_modules/onnxruntime-node/bin/**/*'));
    assert.ok(pkg.build.asarUnpack.includes('src/voice/**/*'));
    for (const f of ['whisper-server.exe', 'whisper.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll', 'ggml-cpu-haswell.dll', 'msvcp140.dll', 'vcomp140.dll', 'LICENSE.whisper.cpp.txt']) assert.ok(fs.existsSync(path.join(ROOT, 'src', 'voice', 'whisper', f)), f);
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'voice', 'whisper', 'ggml-cuda.dll')), false, 'the 88 MB graphics card part is downloaded, not bundled');
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'voice', 'silero_vad.LICENSE.txt')));
    const worklet = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'voice-worklet.js'), 'utf8');
    assert.match(worklet, /new Int16Array\(512\)/, '32 ms capture chunks');
});
