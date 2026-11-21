/*
 * Long-lived Piper processes for low-latency speech (the chat voice reader).
 *
 * utils/piper-tts.cjs spawns Piper per phrase, and loading the model is most of the cost:
 * ~1.3s for a medium voice, ~4s for a high one, before a word is spoken. Here each model is loaded
 * once and fed lines of `--json-input`; Piper prints each output path when that file is complete.
 * A worker exits after IDLE_MS unused, so a quiet bot doesn't hold models in memory.
 *
 * Output is padded with silence: Discord drops the first few Opus frames of a fresh stream and
 * the tail of the last one, which clipped the speaker's name at the start and the last syllable at
 * the end. Piper itself starts speaking on the very first sample.
 *
 * Kokoro voices (`kokoro_*`, utils/kokoro-tts.js) are routed from here too: synthesizeFast() returns
 * one padded WAV like Piper's, synthesizeFastStream() one padded WAV per sentence for a player that
 * can start on the first. If Kokoro can't speak, Piper's default voice does, and the log says so.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import logger from './logger.js';
import { getModelPath, logFallback } from './piper-tts.js';

const kokoroLogic = createRequire(import.meta.url)('./kokoro-logic.cjs');

const PIPER_BINARY = process.env.PIPER_PATH || '/home/death/.local/bin/piper';
const TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'temp_audio');
const IDLE_MS = 10 * 60_000;
const JOB_TIMEOUT_MS = 30_000;

export const DEFAULTS = {
    sentenceSilence: 0.35,   // Piper's 0.2 runs sentences together once chat lines become sentences
    lengthScale: 1.05,       // a touch slower than Piper's default reads clearer over Discord
    noiseScale: 0.6,
    noiseW: 0.7,
    leadSilence: 0.25,
    tailSilence: 0.45,
};

// A voice trained on one speaker (piper_models/en_US/bear) is tuned to how that person talks: its
// .onnx.json carries a "certifried" block ({ lengthScale, noiseScale, noiseW, sentenceSilence })
// that replaces DEFAULTS for that voice. Stock voices have no block and keep DEFAULTS; options a
// caller passes still win. Read once per model (a replaced model needs a restart, like the voice list).
const TUNING_KEYS = ['sentenceSilence', 'lengthScale', 'noiseScale', 'noiseW'];
const tuningCache = new Map();   // model path → tuning

export function voiceTuning(modelPath) {
    if (tuningCache.has(modelPath)) return tuningCache.get(modelPath);
    const tuning = {};
    try {
        const block = JSON.parse(fs.readFileSync(`${modelPath}.json`, 'utf8')).certifried || {};
        for (const k of TUNING_KEYS) {
            const v = Number(block[k]);
            if (Number.isFinite(v) && v <= 3 && (k === 'lengthScale' ? v > 0 : v >= 0)) tuning[k] = v;
        }
    } catch { /* no config, or unreadable: stock defaults */ }
    tuningCache.set(modelPath, tuning);
    return tuning;
}

const workers = new Map();   // key → Worker

class Worker {
    constructor(key, modelPath, opts) {
        this.key = key;
        this.pending = new Map();   // output path → { resolve, reject, timer }
        this.buffer = '';
        this.proc = spawn(PIPER_BINARY, [
            '-m', modelPath, '--json-input',
            '--sentence_silence', String(opts.sentenceSilence),
            '--length_scale', String(opts.lengthScale),
            '--noise_scale', String(opts.noiseScale),
            '--noise_w', String(opts.noiseW),
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.stdout.on('data', d => this.onStdout(d));
        this.proc.stderr.on('data', d => {
            const line = d.toString();
            if (/error|failed/i.test(line)) logger.warn(`[PiperWorker] ${key}: ${line.trim().slice(0, 300)}`);
        });
        this.proc.on('exit', code => this.onExit(code));
        this.proc.on('error', err => this.onExit(err.message));
        this.proc.stdin.on('error', () => {});
        this.touch();
    }

    touch() {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => { if (!this.pending.size) this.stop(); }, IDLE_MS);
        this.idle.unref?.();
    }

    onStdout(d) {
        this.buffer += d.toString();
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            const job = this.pending.get(line);
            if (!job) continue;
            this.pending.delete(line);
            clearTimeout(job.timer);
            job.resolve(line);
        }
    }

    onExit(code) {
        if (this.dead) return;
        this.dead = true;
        clearTimeout(this.idle);
        if (workers.get(this.key) === this) workers.delete(this.key);
        for (const [file, job] of this.pending) {
            clearTimeout(job.timer);
            job.reject(new Error(`Piper exited (${code}) before finishing`));
            fs.promises.unlink(file).catch(() => {});
        }
        this.pending.clear();
    }

    stop() {
        this.onExit('idle');
        try { this.proc.kill(); } catch { /* already gone */ }
    }

    speak(text) {
        this.touch();
        const file = path.join(TEMP_DIR, `reader_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(file);
                reject(new Error('Piper timed out'));
                this.stop();   // a wedged process would time out every later phrase too
            }, JOB_TIMEOUT_MS);
            this.pending.set(file, { resolve, reject, timer });
            this.proc.stdin.write(`${JSON.stringify({ text, output_file: file })}\n`);
        });
    }
}

/** Prepend/append silence to a 16-bit PCM WAV in place (any sample rate: it reads the header). */
export async function padWav(file, lead, tail) {
    const buf = await fs.promises.readFile(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return;
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const len = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
        if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, buf.length - off - 8); break; }
        off += 8 + len + (len % 2);
    }
    if (!fmt || dataOff < 0 || fmt.bits !== 16) return;
    const frame = fmt.channels * 2;
    const leadBytes = Math.round(lead * fmt.rate) * frame;
    const tailBytes = Math.round(tail * fmt.rate) * frame;
    const data = Buffer.concat([Buffer.alloc(leadBytes), buf.subarray(dataOff, dataOff + dataLen), Buffer.alloc(tailBytes)]);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(fmt.channels, 22); header.writeUInt32LE(fmt.rate, 24);
    header.writeUInt32LE(fmt.rate * frame, 28); header.writeUInt16LE(frame, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    await fs.promises.writeFile(file, Buffer.concat([header, data]));
}

/**
 * Speak `text` with a voice, returning a padded WAV path the caller must delete.
 * Piper falls back to one respawn if the worker died between phrases; a Kokoro voice falls back
 * to Piper's default voice.
 */
export async function synthesizeFast(text, voice, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const routed = await kokoroLogic.routeSynthesis({
        voice,
        kokoro: async (name) => {
            const { kokoroToFile } = await import('./kokoro-tts.js');
            const file = await kokoroToFile(text, name, path.join(TEMP_DIR, `reader_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`));
            await padWav(file, opts.leadSilence, opts.tailSilence);
            return file;
        },
        piper: (v) => piperFast(text, v, options),
        log: logFallback,
    });
    return routed.result;
}

/**
 * Speak `text` as a stream of padded WAV files, one per sentence for Kokoro (one in all for Piper),
 * in a chunk stream (utils/kokoro-logic.cjs createChunkStream) returned at once: read it with
 * `for await`, and discard(unlink) whatever you stop reading. Kokoro failing before its first
 * sentence falls back to Piper's default voice; failing part-way just ends the stream early.
 */
export function synthesizeFastStream(text, voice, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const out = kokoroLogic.createChunkStream();
    const viaPiper = async (v) => {
        out.push(await piperFast(text, v, options));
        out.end();
    };
    (async () => {
        const p = kokoroLogic.parseVoiceId(voice);
        if (p.engine === 'piper') return viaPiper(p.voice);
        let reason = p.known ? null : `unknown Kokoro voice "${p.voice}"`;
        if (!reason) {
            const { streamKokoro } = await import('./kokoro-tts.js');
            // Each sentence is its own clip, any of which may be the last, so each keeps the full
            // tail; after the first, the lead is short (the tail before it is the sentence pause).
            const src = streamKokoro(text, voice, {
                prepare: (file, index) => padWav(file, index === 0 ? opts.leadSilence : 0.05, opts.tailSilence),
            });
            try {
                for await (const file of src) out.push(file);
            } catch (err) {
                reason = err.message;
            }
            if (!reason) {
                if (src.error) logger.warn(`[TTS] Kokoro stopped part-way (${src.error.message}); read ${out.produced} sentence(s)`);
                if (out.produced) { out.end(); return; }
                reason = 'no audio produced';
            }
        }
        logFallback(`Kokoro voice ${voice} unavailable (${reason}); using Piper ${kokoroLogic.FALLBACK_PIPER_VOICE}`);
        return viaPiper(kokoroLogic.FALLBACK_PIPER_VOICE);
    })().catch((err) => out.end(err));
    return out;
}

async function piperFast(text, voice, options) {
    const modelPath = getModelPath(voice);
    if (!modelPath) throw new Error(`Voice '${voice}' not found`);
    return piperAt(modelPath, text, options);
}

/**
 * Speak with an explicit model file: own voices (core/voice-clone/synth.js) are decrypted into /dev/shm and are never
 * in piper_models/ or any voice list. Returns a padded WAV path the caller must delete.
 */
export async function synthesizeWithModel(text, modelPath, options = {}) {
    if (!path.isAbsolute(String(modelPath || '')) || !String(modelPath).endsWith('.onnx')) throw new Error('bad model path');
    return piperAt(modelPath, text, options);
}

/** Stop every warm worker of one model file (a deleted or suspended own voice stops at once). */
export function stopWorkersFor(modelPath) {
    let n = 0;
    for (const [key, w] of [...workers]) if (key.startsWith(`${modelPath}|`)) { w.stop(); n++; }
    return n;
}

async function piperAt(modelPath, text, options) {
    const opts = { ...DEFAULTS, ...voiceTuning(modelPath), ...options };
    const clean = String(text).replace(/[\r\n]+/g, ' ').trim();
    if (!clean) throw new Error('Nothing to say');
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });

    const key = [modelPath, opts.sentenceSilence, opts.lengthScale, opts.noiseScale, opts.noiseW].join('|');
    for (let attempt = 0; attempt < 2; attempt++) {
        let worker = workers.get(key);
        if (!worker || worker.dead) {
            worker = new Worker(key, modelPath, opts);
            workers.set(key, worker);
        }
        try {
            const file = await worker.speak(clean);
            await padWav(file, opts.leadSilence, opts.tailSilence);
            return file;
        } catch (err) {
            if (attempt === 1 || !/exited/.test(err.message)) throw err;
        }
    }
    throw new Error('unreachable');
}

export function stopAllPiperWorkers() {
    for (const w of workers.values()) w.stop();
}

export default { synthesizeFast, synthesizeFastStream, synthesizeWithModel, stopWorkersFor, stopAllPiperWorkers, padWav, voiceTuning, DEFAULTS };
