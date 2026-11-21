'use strict';
/*
 * Voice commands 0.2.13: learning how the streamer says each command.
 *   - matching with "heard as" aliases (score = max of the phrase and the aliases) and the "not a command" penalty
 *   - calibration from training takes (leave one out, margin, 60% floor, ordinary speech kept below, overlap warning)
 *   - Whisper's prompt: phrases first, then the most frequent aliases, within the length limit
 *   - the pipeline: an alias fires its command, a negative keeps ordinary speech from firing, every line names the closest
 *     command; training captures takes through the same detector and Whisper without running or logging anything
 *   - the trainer (voice-train.js): takes, Whisper's silence words, delete, save (aliases + threshold to the server), and
 *     the recordings: never written unless "keep recordings" is on, and deleted with their take
 *   - sync: voice.phrases aliases and negatives reach the matcher (normaliseCommand)
 *   - the engine: a failed or wrong graphics card download falls back to Whisper on the processor, not to System.Speech
 *   - static checks: the learn and train IPC, the log's summary for CertiFried, the page and the wording
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { scoreCommand, matchCommands, calibrate, biasPrompt, PROMPT_MAX, CAL_FLOOR } = require('../src/main/voice-match');
const { createWhisperVoice, normaliseCommand } = require('../src/main/voice-whisper');
const { createVoiceTrainer, clampTakes } = require('../src/main/voice-train');
const { createWhisperEngine, wavBytes, MODELS, CUDA_RUNTIME } = require('../src/main/whisper-engine');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-learn-'));

// ── matching ──
test('aliases: the score is the best of the phrase and every alias', () => {
    const cmd = { text: 'Run Bitch Run!', aliases: [{ text: 'ron beach ron' }, { text: 'run beats run' }] };
    const plain = scoreCommand('Ron, beach, Ron.', { text: cmd.text });
    assert.ok(plain.score < 0.8, `without learning it is a miss: ${plain.score}`);
    const r = scoreCommand('Ron, beach, Ron.', cmd);
    assert.equal(r.score, 1);
    assert.equal(r.via, 'alias');
    assert.equal(r.alias, 'ron beach ron');
    assert.equal(r.phraseScore, plain.score, 'the phrase score is still reported');
    const p = scoreCommand('Run, bitch, run!', cmd);
    assert.equal(p.via, 'phrase', 'the phrase wins a tie');
    const near = scoreCommand('ran beach ron', cmd);
    assert.ok(near.score > 0.85 && near.via === 'alias', `close to an alias: ${near.score}`);
    // matchCommands picks the command whose alias fits
    const list = [{ text: 'Toggle Discord Audio', aliases: [{ text: 'tackle this cord audio' }] }, cmd];
    assert.equal(matchCommands('tackle this cord audio', list).best.cmd.text, 'Toggle Discord Audio');
});

test('negatives: words close to a "not a command" example score lower; the command itself is not hurt', () => {
    const cmd = { text: 'Lights on', negatives: [{ text: 'lights are on now' }] };
    const without = scoreCommand('lights are on now', { text: cmd.text });
    const withNeg = scoreCommand('lights are on now', cmd);
    assert.ok(without.score >= 0.6, `${without.score}`);
    assert.ok(withNeg.score < 0.5 && withNeg.score < without.score - 0.3, `penalised: ${without.score} -> ${withNeg.score}`);
    assert.ok(withNeg.penalty > 0 && withNeg.negScore === 1);
    const said = scoreCommand('Lights on.', cmd);
    assert.equal(said.score, 1, 'the phrase itself: no penalty');
    assert.equal(said.penalty, 0);
    // a negative far from the words does nothing
    assert.equal(scoreCommand('lights on', { text: 'Lights on', negatives: [{ text: 'what a lovely day' }] }).penalty, 0);
    // an alias and a negative both close: the closer one decides
    const both = { text: 'Pokeycheck', aliases: [{ text: 'poke check' }], negatives: [{ text: 'poker chips' }] };
    assert.ok(scoreCommand('poke check', both).score >= 0.95);
    assert.ok(scoreCommand('poker chips', both).score < 0.5);
});

test('calibration: a margin below the lowest take (leave one out), floored at 60%, above ordinary speech', () => {
    const c = calibrate({ cmd: { text: 'Pokeycheck' }, takes: ['pokey check', 'poke check', 'pokey chek', 'okey check'], negatives: ['poker chips', 'what a lovely day', 'pokemon check'] });
    assert.equal(c.perTake.length, 4);
    assert.ok(c.perTake.every((p) => p.score >= p.phraseScore), 'other takes only help');
    assert.ok(c.lowest > 0.85 && c.lowest < 1);
    assert.equal(c.threshold, Math.floor((c.lowest - 0.05) * 100) / 100);
    assert.ok(c.negMax < c.threshold, `ordinary speech stays below: ${c.negMax} < ${c.threshold}`);
    assert.deepEqual(c.overlaps, []);
    // badly heard takes: never under 60%
    const low = calibrate({ cmd: { text: 'Toggle Discord Audio' }, takes: ['tackle', 'the cord thing', 'oddio'] });
    assert.equal(low.threshold, CAL_FLOOR);
    // ordinary speech that scores as high as a take: raised above it when every take still passes, otherwise a warning
    const takes = ['pokey check', 'poke check', 'pokey chek', 'okey check'];
    const raised = calibrate({ cmd: { text: 'Pokeycheck' }, takes, negatives: ['poke the check'] });
    assert.equal(raised.raised, true);
    assert.deepEqual(raised.overlaps, []);
    assert.ok(raised.threshold > raised.negMax && raised.threshold <= raised.lowest, `${raised.negMax} < ${raised.threshold} <= ${raised.lowest}`);
    assert.ok(raised.threshold > c.threshold, 'higher than the takes alone would set');
    const hokey = calibrate({ cmd: { text: 'Pokeycheck' }, takes, negatives: ['hokey check'] });
    assert.equal(hokey.raised, false, 'as high as a take: cannot be raised above it');
    assert.deepEqual(hokey.overlaps.map((o) => o.text), ['hokey check']);
    const clash = calibrate({ cmd: { text: 'Toggle Discord Audio' }, takes: ['tackle this cord audio', 'toggle this court audio', 'tog of discord odd io'], negatives: ['tackle this core idea', 'what a lovely day'] });
    assert.equal(clash.raised, false);
    assert.equal(clash.overlaps[0].text, 'tackle this core idea', 'the overlap is reported');
    assert.ok(clash.overlaps[0].score >= clash.threshold);
    // a take never counts as ordinary speech against itself, nor does an alias already learned
    const self = calibrate({ cmd: { text: 'Pokeycheck', aliases: [{ text: 'poke e check' }] }, takes: ['pokey check', 'poke check'], negatives: ['pokey check', 'poke e check'] });
    assert.deepEqual(self.overlaps, []);
    assert.equal(self.negMax, 0);
    assert.equal(calibrate({ cmd: { text: 'x' }, takes: [] }).threshold, null);
});

test('prompt: the phrases, then the most frequent aliases, within Whisper\'s limit; no repeats', () => {
    const p = biasPrompt(['Pokeycheck', 'Run Bitch Run!'], [{ text: 'ron beach ron', count: 5 }, 'pokeycheck', { text: 'poke e check', count: 2 }]);
    assert.equal(p, 'Pokeycheck. Run Bitch Run! ron beach ron. poke e check.');
    const long = biasPrompt(['Pokeycheck'], Array.from({ length: 200 }, (_, i) => `alias number ${i}`));
    assert.ok(long.length <= PROMPT_MAX + 2, `${long.length}`);
    assert.ok(long.startsWith('Pokeycheck.'), 'phrases always first');
});

// ── the pipeline ──
function fakeVad() { return { async load() {}, async prob(f) { return f[100] > 0.3 ? 0.95 : 0.02; }, reset() {} }; }
function fakeWhisper(answers) {
    const r = { prompts: [] };
    r.start = async () => ({ device: 'cuda', model: 'large-v3-turbo-q5_0', gpuName: 'Test GPU' });
    r.transcribe = async (samples, { prompt }) => { r.prompts.push(prompt); return { text: answers.shift() ?? '', ms: 5, noSpeech: 0, avgLogprob: -0.1 }; };
    r.stop = () => {};
    r.status = () => ({});
    return r;
}
function pcm(seconds, speech) { const b = Buffer.alloc(Math.round(seconds * 16000) * 2); if (speech) for (let i = 0; i < b.length; i += 2) b.writeInt16LE(16000, i); return b; }
async function setup(answers, commands, settings = {}) {
    const logs = [];
    const fired = [];
    let t = 5_000_000;
    const s = { mode: 'always', matchThreshold: 0.8, logAllSpeech: true, ...settings };
    const rec = fakeWhisper(answers);
    const v = createWhisperVoice({ vad: fakeVad(), recogniser: rec, getSettings: () => s, onLog: (e) => logs.push(e), onPhrase: (p) => fired.push(p.text), now: () => t });
    v.setPhrases(commands);
    v.start();
    for (let i = 0; i < 50 && v.status().state !== 'listening'; i++) await new Promise((r) => setImmediate(r));
    const say = async () => { v.feed(pcm(0.2, false)); v.feed(pcm(1, true)); v.feed(pcm(0.5, false)); await v.idle(); t += 20000; };
    return { v, logs, fired, rec, s, say };
}
const LEARNED = [
    { text: 'Run Bitch Run!', automationId: 9, confidence: 0.75, aliases: [{ text: 'Ron, Beach, Ron', count: 3 }], negatives: ['run to the shop'] },
    { text: 'Toggle Discord Audio', automationId: 10 },
];

test('pipeline: an alias fires its command and the line says so; a negative keeps ordinary speech quiet; the closest command is always named', async () => {
    const x = await setup(['Ron beach Ron.', 'run to the shop', 'What a lovely day.', 'tackle discord audio'], LEARNED);
    assert.match(x.rec.prompts[0] || x.v.prompt(), /Run Bitch Run! Toggle Discord Audio\. ron beach ron\./, 'aliases in the prompt after the phrases');
    await x.say();
    assert.deepEqual(x.fired, ['Run Bitch Run!']);
    const f = x.logs.at(-1);
    assert.equal(f.outcome, 'fired');
    assert.equal(f.via, 'alias');
    assert.equal(f.alias, 'ron beach ron');
    assert.equal(f.threshold, 0.75, 'its own threshold (from training)');
    await x.say();
    assert.equal(x.logs.at(-1).outcome, 'noise', 'the same words as a "not a command" example');
    assert.deepEqual(x.fired, ['Run Bitch Run!'], 'it did not run again');
    assert.equal(scoreCommand('run to the shop', normaliseCommand(LEARNED[0])).score < 0.3, true);
    await x.say();
    const n = x.logs.at(-1);
    assert.equal(n.outcome, 'noise');
    assert.ok(n.closest, 'the closest command is named even for "not a command"');
    assert.ok(Number.isFinite(n.confidence));
    await x.say();
    assert.equal(x.logs.at(-1).closest, 'Toggle Discord Audio');
    assert.deepEqual(x.fired, ['Run Bitch Run!', 'Toggle Discord Audio'], 'a close spelling of the phrase still runs');
});

test('pipeline: training captures takes through the same detector and Whisper; nothing runs, nothing is logged, push to talk does not gate it', async () => {
    const x = await setup(['Run bitch run', 'Ron beach Ron.', 'Pokeycheck'], LEARNED, { mode: 'ptt' });
    const takes = [];
    assert.equal(x.v.capture((t) => takes.push(t)), true);
    assert.equal(x.v.status().training, true);
    await x.say();
    x.v.feed(Buffer.concat([pcm(0.04, true), pcm(0.6, false)]));   // a click
    await x.v.idle();
    await x.say();
    assert.deepEqual(takes.map((t) => t.kind), ['take', 'short', 'take']);
    assert.equal(takes[0].text, 'Run bitch run');
    assert.ok(takes[0].samples instanceof Float32Array && takes[0].samples.length > 8000, 'the audio is handed over in memory');
    assert.match(x.rec.prompts[0], /^Run Bitch Run! Toggle Discord Audio\. ron beach ron\.$/, 'the same prompt as live use');
    assert.deepEqual(x.fired, []);
    assert.deepEqual(x.logs, [], 'training takes never reach the voice log');
    x.v.endCapture();
    await x.say();
    assert.deepEqual(x.fired, [], 'push to talk gates live use again');
});

test('sync: voice.phrases aliases and negatives reach the matcher, normalised, capped, most frequent first', () => {
    const c = normaliseCommand({ text: 'Pokeycheck', automationId: 3, aliases: [{ text: 'Poke check.', count: 1 }, { text: 'POKEY CHECK', count: 4 }, { text: 'poke check' }, ''], negatives: ['Poker chips!', { text: 'poker chips' }] });
    assert.deepEqual(c.aliases, [{ text: 'pokey check', count: 4 }, { text: 'poke check', count: 1 }]);
    assert.deepEqual(c.negatives, [{ text: 'poker chips' }]);
    const many = normaliseCommand({ text: 'x y', aliases: Array.from({ length: 80 }, (_, i) => `a ${i}`), negatives: Array.from({ length: 150 }, (_, i) => `n ${i}`) });
    assert.equal(many.aliases.length, 50);
    assert.equal(many.negatives.length, 100);
    assert.deepEqual(normaliseCommand({ text: 'plain' }).aliases, []);
});

// ── the trainer ──
function trainerSetup({ keep = false, answers = [] } = {}) {
    let capture = null;
    const voice = { capture(fn) { capture = fn; return true; }, endCapture() { capture = null; } };
    const cmd = { text: 'Run Bitch Run!', key: 'run bitch run!', automationId: 9, aliases: [], negatives: [] };
    const learned = [];
    const dir = tmp();
    let k = keep;
    const tr = createVoiceTrainer({ voice, getCommand: (key) => (key === cmd.key ? cmd : null), getNegatives: () => ['what a lovely day', 'run to the shop'],
        learn: async (c, r) => { learned.push({ id: c.automationId, ...r }); return { ok: true }; }, recordingsDir: dir, keepRecordings: () => k, wavBytes, now: () => 1_800_000_000_000 });
    const say = (text) => capture && capture({ kind: 'take', text, samples: new Float32Array(16000), asrMs: 5, vad: { speechMs: 900 } });
    return { tr, say, learned, dir, voice, isCapturing: () => !!capture, setKeep: (v) => { k = v; }, short: () => capture && capture({ kind: 'short', vad: {} }), answers };
}
const filesIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith('.wav')) : []);

test('trainer: takes until enough, Whisper\'s silence words do not count, delete a bad take, save aliases and the threshold', async () => {
    const x = trainerSetup();
    assert.equal(clampTakes(undefined), 8);
    assert.equal(clampTakes(1), 3);
    assert.equal(clampTakes(99), 20);
    x.tr.start({ key: 'run bitch run!', takes: 3 });
    assert.equal(x.tr.view().state, 'listening');
    x.say('Ron, beach, Ron.');
    x.say('Thank you.');
    x.short();
    assert.match(x.tr.view().note, /too short/);
    x.say('Ron beach run.');
    let v = x.tr.view();
    assert.equal(v.good, 2);
    assert.equal(v.takes[1].ok, false, 'Whisper\'s silence words are not a take');
    assert.ok(v.calibration.enough);
    x.say('Run to the shops.');   // said the wrong thing
    v = x.tr.view();
    assert.equal(v.state, 'review', 'enough takes: listening stops');
    assert.equal(x.isCapturing(), false);
    assert.ok(v.calibration.overlaps.length > 0, 'the wrong take matches ordinary speech from the log');
    x.tr.deleteTake(v.takes.find((t) => t.text === 'run to the shops').id);
    v = x.tr.view();
    assert.equal(v.good, 2);
    assert.ok(v.takes.filter((t) => t.ok).every((t) => t.phraseScore != null && t.score != null), 'each take shows its scores');
    x.tr.resume();
    assert.equal(x.isCapturing(), true);
    x.say('Ron beach Ron');
    assert.equal(x.tr.view().state, 'review');
    const saved = await x.tr.save();
    assert.equal(x.learned.length, 1);
    assert.equal(x.learned[0].id, 9);
    assert.deepEqual(x.learned[0].aliases, ['ron beach ron', 'ron beach run', 'ron beach ron'], 'every take, repeats included (the server counts them)');
    assert.ok(x.learned[0].confidence >= 0.6 && x.learned[0].confidence <= 0.95);
    assert.equal(x.learned[0].takes, 3);
    assert.equal(saved.aliases, 2);
    assert.equal(x.tr.view(), null, 'done');
    assert.deepEqual(filesIn(x.dir), [], 'no recording was written: "keep recordings" is off');
});

test('trainer: recordings only with "keep recordings"; deleting a take deletes its file; cancel keeps nothing it should not', async () => {
    const x = trainerSetup({ keep: true });
    x.tr.start({ key: 'run bitch run!', takes: 3 });
    x.say('Ron beach Ron'); x.say('Ron beach run');
    assert.equal(filesIn(x.dir).length, 2);
    const wav = fs.readFileSync(path.join(x.dir, filesIn(x.dir)[0]));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    x.tr.deleteTake(x.tr.view().takes[0].id);
    assert.equal(filesIn(x.dir).length, 1, 'deleted with its take');
    x.setKeep(false);
    x.tr.cancel();
    assert.equal(filesIn(x.dir).length, 0, 'cancelled with the box off: removed');
    assert.throws(() => x.tr.start({ key: 'nope' }), /not in Studio's list/);
    await assert.rejects(() => x.tr.save(), /nothing to save/);
    // too few takes
    x.tr.start({ key: 'run bitch run!', takes: 3 });
    x.say('Ron beach Ron');
    await assert.rejects(() => x.tr.save(), /at least two/);
    x.tr.cancel();
    // voice off: training cannot start
    const off = createVoiceTrainer({ voice: { capture: () => false, endCapture() {} }, getCommand: () => ({ text: 'a b', key: 'a b', automationId: 1 }), learn: async () => ({}) });
    assert.throws(() => off.start({ key: 'a b' }), /Listen for voice commands/);
});

// ── the engine: a failed graphics card download ──
function fakeFetch(fn) {
    return async (url) => {
        const r = fn(url);
        const body = r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? '');
        return { ok: (r.status || 200) < 400, status: r.status || 200, headers: { get: () => String(Buffer.byteLength(body)) }, body: require('node:stream').Readable.toWeb(require('node:stream').Readable.from([Buffer.from(body)])), json: async () => JSON.parse(body) };
    };
}
test('engine: a graphics card download that fails or does not pass its check falls back to Whisper on the processor', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'whisper-server.exe'), '');
    const data = path.join(dir, 'data');
    fs.mkdirSync(path.join(data, 'models'), { recursive: true });
    const c = MODELS['base.en'];
    const f = path.join(data, 'models', c.file);
    fs.writeFileSync(f, ''); fs.truncateSync(f, c.size); fs.writeFileSync(`${f}.ok`, c.sha256);   // the processor model is there
    const spawned = [];
    const spawnImpl = (exe, args, opts) => {
        const p = new EventEmitter();
        p.stdout = new PassThrough(); p.stderr = new PassThrough();
        p.kill = () => p.emit('exit', 0);
        spawned.push({ args, env: opts.env });
        return p;
    };
    // NVIDIA's site answers 404 (no internet, or a moved file)
    const e = createWhisperEngine({ binDir: bin, dataDir: data, spawnImpl, gpuProbe: async () => ({ name: 'Test GPU' }),
        fetchImpl: fakeFetch((url) => (url.endsWith('/inference') ? { json: { text: ' Pokeycheck.', segments: [] } } : url.startsWith('https://developer.download.nvidia.com') ? { status: 404, body: '' } : { body: 'x' })) });
    const r = await e.start();
    assert.equal(r.device, 'cpu');
    assert.equal(r.model, 'base.en');
    assert.equal(r.gpuFailed.code, 'download_failed');
    assert.equal(e.status().gpuFailed.code, 'download_failed');
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0].args.includes('-ng'), 'on the processor');
    assert.equal(fs.existsSync(path.join(data, `cuda-${CUDA_RUNTIME.version}`, 'complete.json')), false);
    e.stop();
    // a download that does not match its SHA-256: the same
    const e2 = createWhisperEngine({ binDir: bin, dataDir: data, spawnImpl, gpuProbe: async () => ({ name: 'Test GPU' }),
        fetchImpl: fakeFetch((url) => (url.endsWith('/inference') ? { json: { text: '', segments: [] } } : { body: crypto.randomBytes(64) })) });
    const r2 = await e2.start();
    assert.equal(r2.device, 'cpu');
    assert.equal(r2.gpuFailed.code, 'checksum');
    e2.stop();
});

// ── static checks ──
test('0.2.13: learn and train IPC, the summary for CertiFried, the page and its wording', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    assert.match(main, /handle\('voice:train'/);
    assert.ok(main.indexOf("process.env.ORT_DISABLE_TELEMETRY = '1';") < main.indexOf('require('), 'the Microsoft telemetry in onnxruntime is off before anything loads');
    assert.match(main, /handle\('voice:learn'/);
    assert.match(main, /engine\.request\('voice\.learn'/);
    assert.match(main, /closest: e\.closest \|\| null, closestAutomationId: e\.closestAutomationId \|\| null/);
    assert.match(main, /heard: v\.logAllSpeech && v\.shareSpeechText \? \(e\.heard \|\| null\) : null/, 'the words go to CertiFried only with both switches on');
    assert.match(main, /aliases: words\(p\.aliases, true\), negatives: words\(p\.negatives, false\)/, 'voice.phrases sync');
    const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
    for (const c of ['voice:train', 'voice:learn']) assert.ok(pre.includes(`'${c}'`), c);
    const cfg = fs.readFileSync(path.join(ROOT, 'src', 'main', 'config.js'), 'utf8');
    assert.match(cfg, /trainTakes: 8, keepRecordings: false/);
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    for (const id of ['voice-train', 'voice-train-takes', 'voice-train-keep', 'voice-train-save', 'voice-train-overlap']) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /<th>Closest command<\/th>/);
    for (const s of ['Teach Studio how you say it', "'Not a command'", "'Wrong, undo learning'", "'This was...'", 'NEAR_MISS = 0.4']) assert.ok(app.includes(s), s);
    assert.match(app, /noise: 'Not a command'/);
    assert.doesNotMatch(html + app, /impediment|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/iu, 'plain wording, no emoji');
});
