/*
 * Kokoro voices — the pure half of the second TTS engine (no I/O, no model; unit-tested in
 * tests/kokoro-voices.test.js). The engine itself is utils/kokoro-tts.js; Piper stays the default
 * everywhere and is utils/piper-tts.cjs + utils/piper-worker.js.
 *
 *   ids          Kokoro voices live in the same id space as Piper's, prefixed: `kokoro_am_michael` is
 *                Kokoro's `am_michael`. No Piper voice starts with "kokoro_", so a saved voice column
 *                (tts_config.default_voice, voice_reader_config.voice, voice_reader_user_voices.voice,
 *                music_config.dj_voice) needs no engine column: parseVoiceId() tells them apart.
 *   catalog      the 28 English voices of Kokoro-82M v1.0 (US + GB), with kokoro-js's own quality grade,
 *                used to put the better voices first in lists.
 *   audio        Kokoro speaks at 24 kHz; Piper models at their config's audio.sample_rate (22.05 kHz
 *                for medium/high, 16 kHz for low/x_low). rawPcmInputArgs() is how ffmpeg must be told
 *                the rate of a RAW stream; WAV input carries its own rate. encodeWav() writes the 16-bit
 *                PCM WAV that padWav() (utils/piper-worker.js) and Discord playback expect.
 *   routing      routeSynthesis(): try Kokoro, fall back to Piper's default voice when the model is
 *                missing or synthesis fails, and say so in the log (once per reason per 10 minutes).
 *   queue        createSynthQueue(): a small concurrency limiter so many guilds speaking at once queue
 *                behind 1-2 running syntheses instead of piling onto the CPU the 44 bots share.
 *   chunks       createChunkStream(): sentence-by-sentence audio, buffered as it is produced, read in
 *                order by a player that can start on the first sentence.
 */
'use strict';

const KOKORO_PREFIX = 'kokoro_';
const KOKORO_SAMPLE_RATE = 24000;
const PIPER_DEFAULT_RATE = 22050;
const FALLBACK_PIPER_VOICE = 'ryan';

/** Pinned model: onnx-community/Kokoro-82M-v1.0-ONNX (Apache-2.0), fp32 — q8 was 3x slower on this CPU. */
const MODEL = {
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    dir: 'models/kokoro',
    files: [
        { file: 'config.json', bytes: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
        { file: 'tokenizer.json', bytes: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
        { file: 'tokenizer_config.json', bytes: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
        { file: 'onnx/model.onnx', bytes: 325532232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb' },
    ],
};

// name, accent, gender, kokoro-js overallGrade (A best ... F worst).
const CATALOG = [
    ['af_alloy', 'Alloy', 'US', 'female', 'C'], ['af_aoede', 'Aoede', 'US', 'female', 'C+'],
    ['af_bella', 'Bella', 'US', 'female', 'A-'], ['af_heart', 'Heart', 'US', 'female', 'A'],
    ['af_jessica', 'Jessica', 'US', 'female', 'D'], ['af_kore', 'Kore', 'US', 'female', 'C+'],
    ['af_nicole', 'Nicole', 'US', 'female', 'B-'], ['af_nova', 'Nova', 'US', 'female', 'C'],
    ['af_river', 'River', 'US', 'female', 'D'], ['af_sarah', 'Sarah', 'US', 'female', 'C+'],
    ['af_sky', 'Sky', 'US', 'female', 'C-'],
    ['am_adam', 'Adam', 'US', 'male', 'F+'], ['am_echo', 'Echo', 'US', 'male', 'D'],
    ['am_eric', 'Eric', 'US', 'male', 'D'], ['am_fenrir', 'Fenrir', 'US', 'male', 'C+'],
    ['am_liam', 'Liam', 'US', 'male', 'D'], ['am_michael', 'Michael', 'US', 'male', 'C+'],
    ['am_onyx', 'Onyx', 'US', 'male', 'D'], ['am_puck', 'Puck', 'US', 'male', 'C+'],
    ['am_santa', 'Santa', 'US', 'male', 'D-'],
    ['bf_alice', 'Alice', 'GB', 'female', 'D'], ['bf_emma', 'Emma', 'GB', 'female', 'B-'],
    ['bf_isabella', 'Isabella', 'GB', 'female', 'C'], ['bf_lily', 'Lily', 'GB', 'female', 'D'],
    ['bm_daniel', 'Daniel', 'GB', 'male', 'D'], ['bm_fable', 'Fable', 'GB', 'male', 'C'],
    ['bm_george', 'George', 'GB', 'male', 'C'], ['bm_lewis', 'Lewis', 'GB', 'male', 'D+'],
];
const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];

/** kokoro voice name (am_michael) -> { name, accent, gender, grade, locale } */
const KOKORO_VOICES = Object.freeze(Object.fromEntries(CATALOG.map(([id, name, accent, gender, grade]) =>
    [id, Object.freeze({ name, accent, gender, grade, locale: accent === 'GB' ? 'en_GB' : 'en_US' })])));

const isKokoroVoiceId = (id) => typeof id === 'string' && id.startsWith(KOKORO_PREFIX);

/**
 * Which engine a saved voice id belongs to. Kokoro ids name the Kokoro voice and whether it exists;
 * anything else is a Piper id (validated by Piper's own model lookup).
 * @returns {{ engine:'kokoro'|'piper', voice:string, known:boolean }}
 */
function parseVoiceId(id) {
    const s = String(id ?? '').trim();
    if (isKokoroVoiceId(s)) {
        const voice = s.slice(KOKORO_PREFIX.length);
        return { engine: 'kokoro', voice, known: Object.prototype.hasOwnProperty.call(KOKORO_VOICES, voice) };
    }
    return { engine: 'piper', voice: s, known: s.length > 0 };
}

const kokoroId = (voice) => `${KOKORO_PREFIX}${voice}`;

/** "Michael (Kokoro, US)" for kokoro_am_michael; null for anything else. */
function kokoroDisplayName(id) {
    const p = parseVoiceId(id);
    if (p.engine !== 'kokoro' || !p.known) return null;
    const v = KOKORO_VOICES[p.voice];
    return `${v.name} (Kokoro, ${v.accent})`;
}

const gradeRank = (g) => { const i = GRADES.indexOf(g); return i < 0 ? GRADES.length : i; };

/**
 * The Kokoro voices as installed-voice records, in the shape utils/piper-tts.cjs uses
 * ({ locale, quality, gender, description, flag }) plus engine/displayName/kokoroVoice/grade.
 * Ordered best grade first, then name.
 */
function kokoroVoiceRecords() {
    const out = {};
    const ids = Object.keys(KOKORO_VOICES).sort((a, b) =>
        gradeRank(KOKORO_VOICES[a].grade) - gradeRank(KOKORO_VOICES[b].grade) || a.localeCompare(b));
    for (const voice of ids) {
        const v = KOKORO_VOICES[voice];
        out[kokoroId(voice)] = {
            locale: v.locale,
            quality: 'natural',
            gender: v.gender,
            description: `Natural ${v.accent === 'GB' ? 'British' : 'American'} ${v.gender} voice (Kokoro)`,
            flag: v.accent === 'GB' ? '🇬🇧' : '🇺🇸',
            engine: 'kokoro',
            displayName: `${v.name} (Kokoro, ${v.accent})`,
            kokoroVoice: voice,
            grade: v.grade,
        };
    }
    return out;
}

/**
 * Piper's installed voices plus Kokoro's (only when the Kokoro model is installed). Piper records
 * get engine:'piper'; nothing Piper has is ever renamed or dropped.
 */
function mergeVoices(piperInstalled, kokoroInstalled) {
    const out = {};
    for (const [id, data] of Object.entries(piperInstalled || {})) out[id] = { engine: 'piper', ...data };
    if (kokoroInstalled) {
        for (const [id, data] of Object.entries(kokoroVoiceRecords())) if (!(id in out)) out[id] = data;
    }
    return out;
}

/** A human label for any voice record: Kokoro's display name, else Piper's capitalised id. */
function voiceLabel(id, data) {
    if (data?.engine === 'kokoro' && data.displayName) return data.displayName;
    return String(id).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const LOCALE_NAMES = { en_US: 'US English', en_GB: 'British English' };

/**
 * Grouped picker options for the dashboard: Piper first (the default engine), then Kokoro, each
 * grouped by language. [{ label, engine, voices:[{ value, label }] }]
 * @param {object} installed  mergeVoices() output
 * @param {(locale:string)=>string} [localeName]
 */
function voiceOptionGroups(installed, localeName = (l) => LOCALE_NAMES[l] || l) {
    const groups = new Map();
    const order = (engine, locale) => (engine === 'kokoro' ? 1000 : 0) + (locale === 'en_US' ? 0 : locale === 'en_GB' ? 1 : 2);
    for (const [id, data] of Object.entries(installed || {})) {
        const engine = data.engine === 'kokoro' ? 'kokoro' : 'piper';
        const key = `${engine}|${data.locale}`;
        if (!groups.has(key)) {
            groups.set(key, {
                label: `${engine === 'kokoro' ? 'Kokoro' : 'Piper'} · ${localeName(data.locale)}`,
                engine, locale: data.locale, rank: order(engine, data.locale), voices: [],
            });
        }
        const g = groups.get(key);
        const label = engine === 'kokoro'
            ? `${data.displayName || voiceLabel(id, data)}, ${data.gender}`
            : `${voiceLabel(id, data)} (${data.quality}, ${data.gender})`;
        g.voices.push({ value: id, label });
    }
    return [...groups.values()]
        .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
        .map(({ label, engine, voices }) => ({ label, engine, voices }));
}

/**
 * Is Kokoro installed under `root`? The packages must resolve and every model file must be there at
 * its pinned size (the deploy checked the SHA-256; a size check is cheap enough to run at start-up).
 * @param {string} root  repo root
 * @param {{ fs:{statSync:Function}, resolve:(m:string)=>string }} io
 * @returns {{ ready:boolean, runtime:boolean, missing:string[] }}
 */
function checkInstall(root, { fs, resolve }) {
    const missing = [];
    let runtime = true;
    for (const m of ['kokoro-js', '@huggingface/transformers', 'onnxruntime-node']) {
        try { resolve(m); } catch { runtime = false; missing.push(`the ${m} package`); }
    }
    for (const f of MODEL.files) {
        const rel = `${MODEL.dir}/${f.file}`;
        let size = null;
        try { size = fs.statSync(`${String(root).replace(/\/+$/, '')}/${rel}`).size; } catch { /* missing */ }
        if (size === null) missing.push(`${rel} (file missing)`);
        else if (size !== f.bytes) missing.push(`${rel} (${size} bytes, expected ${f.bytes})`);
    }
    return { ready: missing.length === 0, runtime, missing };
}

/** Piper model config -> its output sample rate (raw PCM has no header to say). */
function piperSampleRate(config) {
    const r = Number(config?.audio?.sample_rate);
    return Number.isInteger(r) && r >= 8000 && r <= 96000 ? r : PIPER_DEFAULT_RATE;
}

/** The sample rate an engine's audio comes out at. */
function engineSampleRate(engine, piperConfig) {
    return engine === 'kokoro' ? KOKORO_SAMPLE_RATE : piperSampleRate(piperConfig);
}

/** ffmpeg input args for a raw mono s16le stream at `rate` Hz on stdin. */
function rawPcmInputArgs(rate) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) throw new Error(`bad sample rate ${rate}`);
    return ['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0'];
}

/** Mono float samples (-1..1) -> 16-bit PCM WAV buffer. */
function encodeWav(samples, rate) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
        buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
    }
    return buf;
}

/** { rate, channels, bits } from a WAV header, or null. */
function wavInfo(buf) {
    if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const len = buf.readUInt32LE(off + 4);
        if (id === 'fmt ' && off + 24 <= buf.length) {
            return { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
        }
        off += 8 + len + (len % 2);
    }
    return null;
}

/**
 * Kokoro first, Piper's default voice when it can't: the model is missing, the voice is unknown,
 * the queue is full or synthesis fails. `log(reason)` is called with a short reason on every
 * fallback (the caller rate-limits). Piper voices go straight to Piper.
 * @param {{ voice:string, kokoro:(name:string)=>Promise<any>, piper:(voice:string)=>Promise<any>,
 *           fallbackVoice?:string, log?:(msg:string)=>void }} o
 * @returns {Promise<{ result:any, engine:'kokoro'|'piper', voice:string, fellBack:boolean }>}
 */
async function routeSynthesis({ voice, kokoro, piper, fallbackVoice = FALLBACK_PIPER_VOICE, log = () => {} }) {
    const p = parseVoiceId(voice);
    if (p.engine === 'piper') return { result: await piper(p.voice), engine: 'piper', voice: p.voice, fellBack: false };
    let reason;
    if (!p.known) reason = `unknown Kokoro voice "${p.voice}"`;
    else {
        try {
            return { result: await kokoro(p.voice), engine: 'kokoro', voice: kokoroId(p.voice), fellBack: false };
        } catch (err) {
            reason = err?.message || String(err);
        }
    }
    log(`Kokoro voice ${kokoroId(p.voice)} unavailable (${reason}); using Piper ${fallbackVoice}`);
    return { result: await piper(fallbackVoice), engine: 'piper', voice: fallbackVoice, fellBack: true };
}

/**
 * Concurrency limiter. run(fn) starts fn when fewer than `concurrency` are running, else waits in a
 * FIFO of at most `maxWaiting`; a full queue rejects at once (code 'EOVERLOADED') and a job that waited
 * longer than `maxWaitMs` rejects (code 'ETIMEDOUT') without running. Never runs more than
 * `concurrency` fns at a time, whatever they throw.
 */
function createSynthQueue({ concurrency = 1, maxWaiting = 8, maxWaitMs = 60_000, now = Date.now } = {}) {
    let running = 0;
    const waiting = [];
    const stats = { started: 0, completed: 0, failed: 0, rejectedFull: 0, rejectedStale: 0, peakWaiting: 0 };
    const err = (code, msg) => Object.assign(new Error(msg), { code });

    function next() {
        while (running < concurrency && waiting.length) {
            const job = waiting.shift();
            if (now() - job.at > maxWaitMs) {
                stats.rejectedStale++;
                job.reject(err('ETIMEDOUT', 'waited too long for a free speech slot'));
                continue;
            }
            start(job);
        }
    }
    function start(job) {
        running++;
        stats.started++;
        Promise.resolve().then(job.fn).then(
            (v) => { stats.completed++; job.resolve(v); },
            (e) => { stats.failed++; job.reject(e); },
        ).finally(() => { running--; next(); });
    }
    function run(fn) {
        return new Promise((resolve, reject) => {
            const job = { fn, resolve, reject, at: now() };
            if (running < concurrency) { start(job); return; }
            if (waiting.length >= maxWaiting) {
                stats.rejectedFull++;
                reject(err('EOVERLOADED', 'too many voices speaking at once'));
                return;
            }
            waiting.push(job);
            stats.peakWaiting = Math.max(stats.peakWaiting, waiting.length);
        });
    }
    return {
        run,
        get running() { return running; },
        get waiting() { return waiting.length; },
        stats,
        limits: { concurrency, maxWaiting, maxWaitMs },
    };
}

/**
 * Audio chunks (one per sentence) produced ahead of playback: push() as they arrive, end() when done
 * (with an error if it failed part-way), and read them in order with `for await`. discard(fn) hands
 * every chunk that was or will be produced but never read to fn (to delete its file).
 */
function createChunkStream() {
    const buffered = [];
    let ended = false;
    let error = null;
    let wake = null;
    let discardFn = null;
    let produced = 0;
    const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
    return {
        push(chunk) {
            produced++;
            if (discardFn) { discardFn(chunk); return; }
            buffered.push(chunk);
            notify();
        },
        end(err = null) { if (ended) return; ended = true; error = err; notify(); },
        get produced() { return produced; },
        get ended() { return ended; },
        get error() { return error; },
        discard(fn) { discardFn = fn; for (const c of buffered.splice(0)) fn(c); },
        async *[Symbol.asyncIterator]() {
            for (;;) {
                if (buffered.length) { yield buffered.shift(); continue; }
                if (ended) { if (error && !produced) throw error; return; }
                await new Promise((r) => { wake = r; });
            }
        },
    };
}

module.exports = {
    KOKORO_PREFIX, KOKORO_SAMPLE_RATE, PIPER_DEFAULT_RATE, FALLBACK_PIPER_VOICE, MODEL, KOKORO_VOICES,
    isKokoroVoiceId, parseVoiceId, kokoroId, kokoroDisplayName, kokoroVoiceRecords, mergeVoices, voiceLabel,
    voiceOptionGroups, checkInstall, piperSampleRate, engineSampleRate, rawPcmInputArgs, encodeWav, wavInfo,
    routeSynthesis, createSynthQueue, createChunkStream,
};
