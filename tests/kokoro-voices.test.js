// Kokoro as a second TTS engine (kokoro-voices wave): voice ids and listing, engine routing and the
// Piper fallback, sample rates (the DJ's raw-PCM rate bug), the synthesis queue, sentence streaming,
// and one real Kokoro synthesis (skipped when the model is not installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logic = require('../utils/kokoro-logic.cjs');

// ── ids and the catalog ─────────────────────────────────────────────────────

test('catalog: the 28 English Kokoro voices, 20 US and 8 GB, with the right gender', () => {
    const ids = Object.keys(logic.KOKORO_VOICES);
    assert.equal(ids.length, 28);
    assert.equal(ids.filter((i) => logic.KOKORO_VOICES[i].locale === 'en_US').length, 20);
    assert.equal(ids.filter((i) => logic.KOKORO_VOICES[i].locale === 'en_GB').length, 8);
    for (const id of ids) {
        const v = logic.KOKORO_VOICES[id];
        assert.equal(v.gender, id[1] === 'f' ? 'female' : 'male', id);
        assert.equal(v.locale, id[0] === 'b' ? 'en_GB' : 'en_US', id);
    }
    for (const id of ['af_heart', 'af_bella', 'am_michael', 'am_onyx', 'bf_emma', 'bm_george', 'bm_lewis', 'am_santa']) assert.ok(ids.includes(id), id);
});

test('ids: kokoro_<name> is Kokoro, anything else is Piper', () => {
    assert.deepEqual(logic.parseVoiceId('kokoro_am_michael'), { engine: 'kokoro', voice: 'am_michael', known: true });
    assert.deepEqual(logic.parseVoiceId('kokoro_zz_nobody'), { engine: 'kokoro', voice: 'zz_nobody', known: false });
    assert.deepEqual(logic.parseVoiceId('ryan'), { engine: 'piper', voice: 'ryan', known: true });
    assert.deepEqual(logic.parseVoiceId('amy_low'), { engine: 'piper', voice: 'amy_low', known: true });
    assert.equal(logic.parseVoiceId(null).engine, 'piper');
    assert.equal(logic.parseVoiceId('').known, false);
    assert.equal(logic.isKokoroVoiceId('kokoro_bf_emma'), true);
    assert.equal(logic.isKokoroVoiceId('northern_english_male'), false);
    assert.equal(logic.kokoroId('bf_emma'), 'kokoro_bf_emma');
    assert.equal(logic.kokoroDisplayName('kokoro_am_michael'), 'Michael (Kokoro, US)');
    assert.equal(logic.kokoroDisplayName('kokoro_bf_isabella'), 'Isabella (Kokoro, GB)');
    assert.equal(logic.kokoroDisplayName('ryan'), null);
    // Every id fits the narrowest voice column (tts_config.default_voice VARCHAR(50)) and the
    // dashboard's id pattern.
    for (const id of Object.keys(logic.kokoroVoiceRecords())) assert.match(id, /^[a-zA-Z0-9_]{1,50}$/);
});

// ── listing ─────────────────────────────────────────────────────────────────

const PIPER = {
    ryan: { locale: 'en_US', quality: 'medium', gender: 'male', description: 'en US ryan voice', flag: 'x' },
    alan: { locale: 'en_GB', quality: 'medium', gender: 'male', description: 'en GB alan voice', flag: 'x' },
    thorsten: { locale: 'de_DE', quality: 'medium', gender: 'male', description: 'de DE thorsten voice', flag: 'x' },
};

test('listing: Kokoro voices are merged in only while installed, with engine, name, language and gender', () => {
    const without = logic.mergeVoices(PIPER, false);
    assert.deepEqual(Object.keys(without), ['ryan', 'alan', 'thorsten']);
    assert.ok(Object.values(without).every((v) => v.engine === 'piper'));
    const merged = logic.mergeVoices(PIPER, true);
    assert.equal(Object.keys(merged).length, 3 + 28);
    assert.deepEqual(merged.ryan, { engine: 'piper', ...PIPER.ryan }, 'Piper records are untouched');
    const m = merged.kokoro_am_michael;
    assert.equal(m.engine, 'kokoro');
    assert.equal(m.displayName, 'Michael (Kokoro, US)');
    assert.equal(m.locale, 'en_US');
    assert.equal(m.gender, 'male');
    assert.equal(m.kokoroVoice, 'am_michael');
    assert.equal(merged.kokoro_bf_emma.locale, 'en_GB');
    assert.equal(merged.kokoro_bf_emma.gender, 'female');
    // Best-graded Kokoro voices first (Heart is kokoro-js's A grade).
    assert.equal(Object.keys(merged).find((k) => k.startsWith('kokoro_')), 'kokoro_af_heart');
    // A Piper id can never be shadowed.
    const clash = logic.mergeVoices({ kokoro_af_heart: { locale: 'en_US', quality: 'medium', gender: 'female' } }, true);
    assert.equal(clash.kokoro_af_heart.engine, 'piper');
});

test('listing: dashboard groups are by engine then language, Piper (the default engine) first', () => {
    const groups = logic.voiceOptionGroups(logic.mergeVoices(PIPER, true));
    assert.deepEqual(groups.map((g) => g.label), [
        'Piper · US English', 'Piper · British English', 'Piper · de_DE', 'Kokoro · US English', 'Kokoro · British English',
    ]);
    assert.equal(groups[3].voices.length, 20);
    assert.equal(groups[4].voices.length, 8);
    assert.deepEqual(groups[0].voices[0], { value: 'ryan', label: 'Ryan (medium, male)' });
    assert.ok(groups[3].voices.some((v) => v.value === 'kokoro_am_michael' && v.label === 'Michael (Kokoro, US), male'));
    assert.deepEqual(logic.voiceOptionGroups(logic.mergeVoices(PIPER, false)).map((g) => g.engine), ['piper', 'piper', 'piper']);
});

test('listing: utils/piper-tts.cjs merges Kokoro into every list, and knows a saved Kokoro voice even when not installed', () => {
    const tts = require('../utils/piper-tts.cjs');
    const installed = tts.isKokoroInstalled();
    const all = tts.getInstalledVoices();
    const kokoroIds = Object.keys(all).filter((k) => k.startsWith('kokoro_'));
    assert.equal(kokoroIds.length, installed ? 28 : 0);
    assert.equal(tts.getAvailableVoices().filter((v) => v.engine === 'kokoro').length, kokoroIds.length);
    const byLang = tts.getVoicesByLanguage();
    assert.equal((byLang.en_GB || []).filter((v) => v.engine === 'kokoro').length, installed ? 8 : 0);
    const info = tts.getVoiceInfo('kokoro_am_michael');
    assert.equal(info.name, 'kokoro_am_michael');
    assert.equal(info.engine, 'kokoro');
    assert.equal(info.installed, installed);
    assert.equal(tts.getVoiceInfo('kokoro_zz_nobody'), null);
    assert.equal(tts.getModelPath('kokoro_am_michael'), null, 'no Piper model for a Kokoro voice');
    const paths = tts.getAllVoicesPaths();
    if (installed) assert.equal(paths.kokoro_am_michael, 'kokoro:am_michael', 'DJ model path for a Kokoro voice');
    for (const [id, p] of Object.entries(paths)) if (!id.startsWith('kokoro_')) assert.match(p, /\.onnx$/, id);
    // The Piper side is exactly what it was: every Piper voice is still listed.
    assert.deepEqual(Object.keys(all).filter((k) => !k.startsWith('kokoro_')), Object.keys(tts.getPiperInstalledVoices()));
    const groups = tts.getVoiceOptions();
    assert.ok(groups.every((g, i) => i === 0 || !(groups[i - 1].engine === 'kokoro' && g.engine === 'piper')), 'Piper groups before Kokoro');
});

test('install check: packages must resolve and every model file must be there at its pinned size', () => {
    const sizes = Object.fromEntries(logic.MODEL.files.map((f) => [`/r/${logic.MODEL.dir}/${f.file}`, f.bytes]));
    const fakeFs = (over = {}) => ({ statSync: (p) => { const s = { ...sizes, ...over }[p]; if (s === undefined || s === null) throw new Error('ENOENT'); return { size: s }; } });
    const ok = logic.checkInstall('/r', { fs: fakeFs(), resolve: (m) => m });
    assert.deepEqual(ok, { ready: true, runtime: true, missing: [] });
    const noPkg = logic.checkInstall('/r', { fs: fakeFs(), resolve: (m) => { if (m === 'kokoro-js') throw new Error('nope'); return m; } });
    assert.equal(noPkg.ready, false);
    assert.equal(noPkg.runtime, false);
    assert.deepEqual(noPkg.missing, ['the kokoro-js package']);
    const model = `/r/${logic.MODEL.dir}/onnx/model.onnx`;
    const partial = logic.checkInstall('/r', { fs: fakeFs({ [model]: 1000 }), resolve: (m) => m });
    assert.equal(partial.ready, false);
    assert.match(partial.missing[0], /onnx\/model\.onnx \(1000 bytes, expected 325532232\)/);
    const gone = logic.checkInstall('/r/', { fs: fakeFs({ [model]: null }), resolve: (m) => m });
    assert.match(gone.missing[0], /file missing/);
    assert.equal(logic.MODEL.revision.length, 40, 'pinned to a commit');
    for (const f of logic.MODEL.files) assert.match(f.sha256, /^[0-9a-f]{64}$/, f.file);
});

// ── routing and the fallback ───────────────────────────────────────────────

test('routing: Piper ids go to Piper; Kokoro ids to Kokoro; a Kokoro failure falls back to Piper ryan and is logged', async () => {
    const calls = [];
    const logs = [];
    const engines = {
        kokoro: async (v) => { calls.push(['kokoro', v]); return `k:${v}`; },
        piper: async (v) => { calls.push(['piper', v]); return `p:${v}`; },
        log: (m) => logs.push(m),
    };
    assert.deepEqual(await logic.routeSynthesis({ voice: 'amy', ...engines }), { result: 'p:amy', engine: 'piper', voice: 'amy', fellBack: false });
    assert.deepEqual(await logic.routeSynthesis({ voice: 'kokoro_bf_emma', ...engines }), { result: 'k:bf_emma', engine: 'kokoro', voice: 'kokoro_bf_emma', fellBack: false });
    assert.deepEqual(logs, []);

    const failing = { ...engines, kokoro: async () => { throw new Error('model not installed (models/kokoro/onnx/model.onnx (file missing))'); } };
    const fb = await logic.routeSynthesis({ voice: 'kokoro_am_michael', ...failing });
    assert.deepEqual(fb, { result: 'p:ryan', engine: 'piper', voice: 'ryan', fellBack: true });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /kokoro_am_michael unavailable \(model not installed.*\); using Piper ryan/);

    calls.length = 0;
    const unknown = await logic.routeSynthesis({ voice: 'kokoro_zz_nobody', ...engines, fallbackVoice: 'amy' });
    assert.deepEqual(unknown, { result: 'p:amy', engine: 'piper', voice: 'amy', fellBack: true });
    assert.deepEqual(calls, [['piper', 'amy']], 'an unknown Kokoro voice never reaches Kokoro');
    assert.match(logs[1], /unknown Kokoro voice "zz_nobody"/);

    // A Piper failure is not hidden: it throws as before.
    await assert.rejects(logic.routeSynthesis({ voice: 'ryan', ...engines, piper: async () => { throw new Error('Piper failed with code 1'); } }), /Piper failed/);
});

const piperBinary = process.env.PIPER_PATH || '/home/death/.local/bin/piper';
const havePiper = fs.existsSync(piperBinary) && fs.existsSync(path.join(root, 'piper_models/en_US/ryan'));

test('fallback, for real: an unknown Kokoro voice is spoken by Piper ryan (synthesize and the reader stream)', { skip: !havePiper && 'Piper or its ryan model is not installed here' }, async () => {
    const tts = require('../utils/piper-tts.cjs');
    const out = await tts.synthesizeDetailed('Fallback check.', 'kokoro_zz_nobody');
    try {
        assert.equal(out.engine, 'piper');
        assert.equal(out.voice, 'ryan');
        assert.equal(out.fellBack, true);
        assert.equal(logic.wavInfo(fs.readFileSync(out.path)).rate, 22050);
    } finally { fs.rmSync(out.path, { force: true }); }

    const { synthesizeFastStream, stopAllPiperWorkers } = await import('../utils/piper-worker.js');
    const files = [];
    try {
        for await (const f of synthesizeFastStream('Fallback stream check.', 'kokoro_zz_nobody')) files.push(f);
        assert.equal(files.length, 1, 'Piper speaks it as one clip');
        assert.equal(logic.wavInfo(fs.readFileSync(files[0])).rate, 22050);
    } finally {
        for (const f of files) fs.rmSync(f, { force: true });
        stopAllPiperWorkers();
    }
});

// ── sample rates ────────────────────────────────────────────────────────────

test('sample rate: Kokoro is 24 kHz, Piper is whatever its model says (16 kHz for low voices), 22.05 kHz if unknown', () => {
    assert.equal(logic.engineSampleRate('kokoro'), 24000);
    assert.equal(logic.engineSampleRate('piper', { audio: { sample_rate: 16000 } }), 16000);
    assert.equal(logic.piperSampleRate({ audio: { sample_rate: 22050 } }), 22050);
    assert.equal(logic.piperSampleRate({ audio: { sample_rate: 44100 } }), 44100);
    assert.equal(logic.piperSampleRate(null), 22050);
    assert.equal(logic.piperSampleRate({ audio: { sample_rate: 'abc' } }), 22050);
    assert.equal(logic.piperSampleRate({ audio: { sample_rate: 5 } }), 22050);
    assert.deepEqual(logic.rawPcmInputArgs(16000), ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0']);
    assert.throws(() => logic.rawPcmInputArgs(NaN), /bad sample rate/);
    // Real model configs, where present: the low voices five servers use for the DJ are 16 kHz.
    const low = path.join(root, 'piper_models/en_US/amy/low/en_US-amy-low.onnx.json');
    if (fs.existsSync(low)) assert.equal(logic.piperSampleRate(JSON.parse(fs.readFileSync(low, 'utf8'))), 16000);
});

test('sample rate: the DJ no longer tells ffmpeg 22050 for every Piper voice', () => {
    const src = fs.readFileSync(path.join(root, 'core/dj-manager.cjs'), 'utf8');
    assert.ok(!/'-ar',\s*'22050'/.test(src), 'no hard-coded raw PCM rate');
    assert.match(src, /rawPcmInputArgs\(piperModelRate\(modelPath\)\)/);
    assert.match(src, /startsWith\('kokoro:'\)/, 'Kokoro DJ voices are rendered with Kokoro');
    // No other code feeds raw Piper PCM to anything.
    const offenders = [];
    for (const dir of ['core', 'utils', 'commands', 'events', 'handlers', 'dashboard/routes', 'interactions', 'jobs']) {
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(c|m)?js$/.test(e.name) && /--output-raw|output_raw/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
            }
        };
        if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
    }
    assert.deepEqual(offenders, ['core/dj-manager.cjs']);
});

test('audio: WAVs are written at the engine rate and padWav keeps that rate', async () => {
    const samples = new Float32Array(2400).map((_, i) => Math.sin(i / 10));
    const wav = logic.encodeWav(samples, 24000);
    assert.deepEqual(logic.wavInfo(wav), { channels: 1, rate: 24000, bits: 16 });
    assert.equal(wav.length, 44 + 2400 * 2);
    assert.equal(logic.wavInfo(Buffer.from('nope')), null);
    const { padWav } = await import('../utils/piper-worker.js');
    const file = path.join(os.tmpdir(), `kokoro-pad-${process.pid}.wav`);
    fs.writeFileSync(file, wav);
    try {
        await padWav(file, 0.25, 0.45);
        const out = fs.readFileSync(file);
        assert.deepEqual(logic.wavInfo(out), { channels: 1, rate: 24000, bits: 16 });
        assert.equal(out.length, 44 + (2400 + 6000 + 10800) * 2, '0.25 s + 0.45 s of silence at 24 kHz');
    } finally { fs.rmSync(file, { force: true }); }
});

// ── the queue ───────────────────────────────────────────────────────────────

test('queue: never more than `concurrency` at once, first come first served, full queue fails fast', async () => {
    const q = logic.createSynthQueue({ concurrency: 1, maxWaiting: 3 });
    let running = 0;
    let peak = 0;
    const order = [];
    const gates = [];
    const job = (n) => () => new Promise((resolve) => {
        running++;
        peak = Math.max(peak, running);
        order.push(n);
        gates.push(() => { running--; resolve(n); });
    });
    const ps = [1, 2, 3, 4].map((n) => q.run(job(n)));
    await assert.rejects(q.run(job(5)), (e) => e.code === 'EOVERLOADED');
    assert.equal(q.running, 1);
    assert.equal(q.waiting, 3);
    while (gates.length || q.running) {
        await new Promise((r) => setImmediate(r));
        gates.shift()?.();
    }
    assert.deepEqual(await Promise.all(ps), [1, 2, 3, 4]);
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.equal(peak, 1);
    assert.equal(q.stats.rejectedFull, 1);
    assert.equal(q.stats.completed, 4);
});

test('queue: a failing job frees its slot; a job that waited too long is rejected without running', async () => {
    let now = 0;
    const q = logic.createSynthQueue({ concurrency: 1, maxWaiting: 4, maxWaitMs: 1000, now: () => now });
    let release;
    const slow = q.run(() => new Promise((r) => { release = r; }));
    let ranStale = false;
    const stale = q.run(async () => { ranStale = true; });
    now = 5000;
    const fresh = q.run(async () => 'fresh');
    await new Promise((r) => setImmediate(r));
    release('slow');
    assert.equal(await slow, 'slow');
    await assert.rejects(stale, (e) => e.code === 'ETIMEDOUT');
    assert.equal(ranStale, false);
    assert.equal(await fresh, 'fresh');
    await assert.rejects(q.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await q.run(async () => 'after'), 'after', 'still usable after a failure');
    await new Promise((r) => setImmediate(r));
    assert.equal(q.running, 0, 'every slot released');
});

// ── sentence streaming ──────────────────────────────────────────────────────

test('chunks: produced ahead of the reader, read in order; discard() takes what is never read', async () => {
    const s = logic.createChunkStream();
    s.push('a');
    s.push('b');
    const seen = [];
    const reading = (async () => { for await (const c of s) { seen.push(c); if (c === 'c') break; } })();
    await new Promise((r) => setImmediate(r));
    s.push('c');
    await reading;
    assert.deepEqual(seen, ['a', 'b', 'c']);
    s.push('d');
    const dropped = [];
    s.discard((c) => dropped.push(c));
    s.push('e');
    s.end();
    assert.deepEqual(dropped, ['d', 'e']);
    assert.equal(s.produced, 5);

    const failed = logic.createChunkStream();
    failed.end(new Error('no voice'));
    await assert.rejects((async () => { for await (const c of failed) void c; })(), /no voice/);
    const partial = logic.createChunkStream();
    partial.push('x');
    partial.end(new Error('stopped part-way'));
    const got = [];
    for await (const c of partial) got.push(c);
    assert.deepEqual(got, ['x'], 'what was produced is still read');
    assert.match(partial.error.message, /part-way/);
});

// ── the real thing ──────────────────────────────────────────────────────────

const kokoro = await import('../utils/kokoro-tts.js');
const installed = kokoro.installState({ fresh: true }).ready;

test('integration: Kokoro speaks a short phrase as 24 kHz audio, and streams one clip per sentence', { skip: !installed && 'Kokoro model not installed (models/kokoro)', timeout: 120_000 }, async (t) => {
    t.after(() => kokoro.stopKokoro());
    const file = await kokoro.kokoroToFile('Hello from the Kokoro test.', 'kokoro_am_michael');
    try {
        const buf = fs.readFileSync(file);
        const info = logic.wavInfo(buf);
        assert.deepEqual(info, { channels: 1, rate: 24000, bits: 16 });
        const seconds = (buf.length - 44) / 2 / 24000;
        assert.ok(seconds > 0.6 && seconds < 6, `${seconds.toFixed(2)} s of speech`);
    } finally { fs.rmSync(file, { force: true }); }

    const clips = [];
    try {
        for await (const f of kokoro.streamKokoro('First sentence. Second sentence.', 'kokoro_bf_emma')) clips.push(f);
        assert.equal(clips.length, 2);
        for (const f of clips) assert.equal(logic.wavInfo(fs.readFileSync(f)).rate, 24000);
    } finally { for (const f of clips) fs.rmSync(f, { force: true }); }

    const st = kokoro.status();
    assert.equal(st.installed, true);
    assert.equal(st.threads, 4);
    assert.equal(st.queue.concurrency, 1);
    assert.ok(st.completed >= 2);
});
