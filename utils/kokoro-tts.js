/*
 * Kokoro TTS — the second, more natural speech engine next to Piper (Piper stays the default; a
 * server or member gets Kokoro only by picking a `kokoro_*` voice). Pure rules are in
 * utils/kokoro-logic.cjs; the model runs in utils/kokoro-worker.js.
 *
 *   installed?  the kokoro-js package must resolve and models/kokoro/ (pinned Kokoro-82M v1.0 ONNX,
 *               fp32, put there by the deploy) must hold every file at its expected size. Until then
 *               available() is false and every Kokoro request falls back to Piper (routing lives in
 *               utils/piper-tts.cjs and utils/piper-worker.js).
 *   one model   a single child process per bot process, shared by every bot and guild in it, started
 *               on the first Kokoro request (~1 s to load) and stopped after IDLE_MS unused, like the
 *               Piper workers. 4 ONNX threads, lowered CPU priority, so the bots stay responsive.
 *   queue       one synthesis at a time (the fastest per request on this CPU; a second in parallel
 *               only halves both), up to QUEUE_MAX waiting; beyond that a request fails at once with
 *               EOVERLOADED and the caller falls back to Piper rather than queueing forever.
 *   streaming   every request is split into sentences in the worker; streamKokoro() hands each
 *               sentence's WAV over as soon as it exists, so the chat reader starts speaking after the
 *               first sentence (~0.8 s) instead of after the whole message.
 *   audio       24 kHz mono 16-bit WAV (Piper is 22.05 kHz; anything that reads raw PCM must be told).
 */
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const logic = require('./kokoro-logic.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_DIR = path.join(ROOT, 'temp_audio');
const PREVIEW_DIR = path.join(ROOT, logic.MODEL.dir, 'previews');
const THREADS = Math.min(4, Math.max(1, Number(process.env.KOKORO_THREADS) || 4));
const QUEUE_MAX = 8;
const IDLE_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 60_000;
const CHUNK_TIMEOUT_MS = 30_000;       // no sentence for this long = the worker is wedged
const BROKEN_RETRY_MS = 10 * 60_000;
const INSTALL_RECHECK_MS = 5 * 60_000;

const queue = logic.createSynthQueue({ concurrency: 1, maxWaiting: QUEUE_MAX, maxWaitMs: 60_000 });
const counters = { requests: 0, completed: 0, failed: 0, chunks: 0, totalMs: 0, lastMs: null, loads: 0, lastLoadMs: null };
let child = null;          // { proc, ready: Promise, jobs: Map, dead }
let idleTimer = null;
let brokenUntil = 0;
let lastError = null;
let install = null;
let installAt = 0;
let nextId = 1;

// ── installed? ──────────────────────────────────────────────────────────────

/** { ready, runtime, missing[] } — cached; rechecked every few minutes while not ready. */
export function installState({ fresh = false } = {}) {
    if (!fresh && install && (install.ready || Date.now() - installAt < INSTALL_RECHECK_MS)) return install;
    install = logic.checkInstall(ROOT, { fs, resolve: (m) => require.resolve(m) });
    installAt = Date.now();
    return install;
}

/** Can a Kokoro request run right now (installed, and not paused after the model failed to load)? */
export function available() {
    return installState().ready && Date.now() >= brokenUntil;
}

// ── the worker ──────────────────────────────────────────────────────────────

function noteError(msg) {
    lastError = { message: String(msg).slice(0, 300), at: new Date().toISOString() };
}

function startChild() {
    const proc = fork(fileURLToPath(new URL('./kokoro-worker.js', import.meta.url)), [], {
        cwd: ROOT,
        env: { ...process.env, KOKORO_ROOT: ROOT, KOKORO_THREADS: String(THREADS) },
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    // Below the bots: synthesis may be slow under load, the bots may not.
    try { os.setPriority(proc.pid, 10); } catch { /* not permitted: run at normal priority */ }
    // An idle worker must not keep the bot process alive on its own (hold() refs it while busy).
    proc.unref();
    proc.stderr.unref?.();
    const c = { proc, jobs: new Map(), dead: false };
    hold(c, true);
    proc.stderr.on('data', (d) => {
        for (const line of String(d).split('\n')) {
            // onnxruntime prints a harmless "GPU device discovery failed" warning on a GPU-less host.
            if (line.trim() && !/W:onnxruntime|device_discovery/.test(line)) logger.warn(`[Kokoro] worker: ${line.trim().slice(0, 300)}`);
        }
    });
    c.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('the model took too long to load')); stopChild(c, 'load timeout'); }, READY_TIMEOUT_MS);
        c.onReady = (msg) => {
            clearTimeout(timer);
            if (msg.ok) {
                counters.loads++;
                counters.lastLoadMs = msg.loadMs;
                logger.info(`[Kokoro] model loaded in ${msg.loadMs} ms (${THREADS} threads)`);
                resolve();
            } else {
                reject(new Error(`model failed to load: ${msg.error}`));
            }
        };
        c.onEarlyExit = (code) => { clearTimeout(timer); reject(new Error(`worker exited (${code}) while loading`)); };
    });
    c.ready.then(() => { if (!c.jobs.size) hold(c, false); }, () => {});
    c.ready.catch((err) => {
        noteError(err.message);
        logger.error(`[Kokoro] ${err.message}; Kokoro voices fall back to Piper for ${BROKEN_RETRY_MS / 60000} min`);
        brokenUntil = Date.now() + BROKEN_RETRY_MS;
    });
    proc.on('message', (msg) => {
        if (msg?.type === 'ready') { c.onReady?.(msg); return; }
        const job = c.jobs.get(msg?.id);
        if (!job) return;
        if (msg.type === 'chunk') job.onChunk(msg);
        else if (msg.type === 'done') job.onDone(msg);
        else if (msg.type === 'error') job.onError(new Error(msg.error));
    });
    proc.on('exit', (code, signal) => {
        c.dead = true;
        c.onEarlyExit?.(code ?? signal);
        if (child === c) child = null;
        for (const job of c.jobs.values()) job.onError(new Error(`Kokoro worker exited (${code ?? signal})`));
        c.jobs.clear();
    });
    proc.on('error', (err) => noteError(`worker error: ${err.message}`));
    return c;
}

/** Keep the event loop alive for the worker's IPC channel only while it is loading or busy. */
function hold(c, on) {
    try {
        if (on) c.proc.channel?.ref?.();
        else c.proc.channel?.unref?.();
    } catch { /* channel already closed */ }
}

function stopChild(c, why) {
    if (!c || c.dead) return;
    c.dead = true;
    if (child === c) child = null;
    try { c.proc.kill(); } catch { /* already gone */ }
    if (why) logger.info(`[Kokoro] worker stopped (${why})`);
}

function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (queue.running || queue.waiting) { armIdle(); return; }
        stopChild(child, 'idle; it loads again on the next Kokoro request');
    }, IDLE_MS);
    idleTimer.unref?.();
}

/**
 * Run one request in the worker. onChunk(samples, rate, index) per sentence; resolves with
 * { chunks, ms } when the last sentence is out.
 */
async function runInWorker(text, voice, { speed = 1, onChunk }) {
    if (!child || child.dead) child = startChild();
    const c = child;
    await c.ready;
    const id = nextId++;
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        let timer;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                job.onError(new Error(`no audio for ${CHUNK_TIMEOUT_MS / 1000}s; worker restarted`));
                stopChild(c, 'wedged');
            }, CHUNK_TIMEOUT_MS);
        };
        const finish = () => { clearTimeout(timer); c.jobs.delete(id); if (!c.jobs.size) hold(c, false); armIdle(); };
        const job = {
            onChunk(msg) { arm(); counters.chunks++; try { onChunk?.(msg.audio, msg.rate, msg.index); } catch (err) { logger.warn(`[Kokoro] chunk handler: ${err.message}`); } },
            onDone(msg) { finish(); resolve({ chunks: msg.chunks, ms: Date.now() - t0 }); },
            onError(err) { finish(); reject(err); },
        };
        c.jobs.set(id, job);
        hold(c, true);
        arm();
        c.proc.send({ type: 'synth', id, text, voice, speed });
    });
}

function cleanText(text) {
    const clean = String(text ?? '').replace(/[<>]/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Nothing to say');
    if (clean.length > 2000) throw new Error('Text is too long (max 2000 characters)');
    return clean;
}

/** Validate the request and get the Kokoro voice name, or throw a reason (the caller falls back). */
function voiceFor(voiceId) {
    const p = logic.parseVoiceId(voiceId);
    if (p.engine !== 'kokoro' || !p.known) throw new Error(`not a Kokoro voice: ${voiceId}`);
    if (!installState().ready) throw new Error(`model not installed (${install.missing.join('; ')})`);
    if (Date.now() < brokenUntil) throw new Error(`model paused after a load failure: ${lastError?.message || 'unknown'}`);
    return p.voice;
}

const tempFile = (prefix) => path.join(TEMP_DIR, `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`);

/**
 * Speak `text` in a Kokoro voice (`kokoro_am_michael` or `am_michael`) into one WAV file.
 * @returns {Promise<string>} the WAV path (24 kHz mono 16-bit); the caller deletes it
 */
export async function kokoroToFile(text, voiceId, outPath = null, { speed = 1 } = {}) {
    const voice = voiceFor(String(voiceId).startsWith(logic.KOKORO_PREFIX) ? voiceId : logic.kokoroId(voiceId));
    const clean = cleanText(text);
    counters.requests++;
    const parts = [];
    let rate = logic.KOKORO_SAMPLE_RATE;
    try {
        const { ms } = await queue.run(() => runInWorker(clean, voice, { speed, onChunk: (a, r) => { parts.push(a); rate = r; } }));
        if (!parts.length) throw new Error('no audio produced');
        const total = parts.reduce((n, p) => n + p.length, 0);
        const all = new Float32Array(total);
        let off = 0;
        for (const p of parts) { all.set(p, off); off += p.length; }
        const file = outPath || tempFile('tts');
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, logic.encodeWav(all, rate));
        counters.completed++;
        counters.totalMs += ms;
        counters.lastMs = ms;
        return file;
    } catch (err) {
        counters.failed++;
        noteError(err.message);
        throw err;
    }
}

/**
 * Speak `text` sentence by sentence. Returns a chunk stream (utils/kokoro-logic.cjs) at once; each
 * sentence's WAV path is pushed as soon as it is written, after `prepare(file, index)` (e.g. padding).
 * The stream ends with an error if nothing could be produced.
 */
export function streamKokoro(text, voiceId, { speed = 1, prepare = null } = {}) {
    const stream = logic.createChunkStream();
    (async () => {
        const voice = voiceFor(voiceId);
        const clean = cleanText(text);
        counters.requests++;
        let pending = Promise.resolve();
        const { ms } = await queue.run(() => runInWorker(clean, voice, {
            speed,
            onChunk: (audio, rate, index) => {
                // Write in order even though each write is async.
                pending = pending.then(async () => {
                    const file = tempFile('reader');
                    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
                    await fs.promises.writeFile(file, logic.encodeWav(audio, rate));
                    if (prepare) await prepare(file, index);
                    stream.push(file);
                });
            },
        }));
        await pending;
        counters.completed++;
        counters.totalMs += ms;
        counters.lastMs = ms;
        stream.end();
    })().catch((err) => {
        counters.failed++;
        noteError(err.message);
        stream.end(err);
    });
    return stream;
}

/**
 * The dashboard's preview clip for a Kokoro voice: made once, then served from
 * models/kokoro/previews/. Kokoro only — a fallback voice must never be cached as this voice.
 */
const previewJobs = new Map();
export async function kokoroPreviewFile(voiceId) {
    const p = logic.parseVoiceId(voiceId);
    if (p.engine !== 'kokoro' || !p.known) return null;
    const file = path.join(PREVIEW_DIR, `${logic.kokoroId(p.voice)}.wav`);
    if (fs.existsSync(file)) return file;
    if (!previewJobs.has(file)) {
        const name = logic.KOKORO_VOICES[p.voice].name;
        const text = `Hello, I'm ${name}. This is how I'd sound reading your chat or hosting your music as the AI DJ.`;
        const tmp = `${file}.${process.pid}.tmp`;
        previewJobs.set(file, kokoroToFile(text, p.voice, tmp)
            .then(() => fs.promises.rename(tmp, file))
            .then(() => file)
            .finally(() => { previewJobs.delete(file); fs.promises.unlink(tmp).catch(() => {}); }));
    }
    return previewJobs.get(file);
}

/** For diagnostics and the dashboard. */
export function status() {
    const s = installState();
    return {
        installed: s.ready,
        missing: s.missing,
        loaded: !!(child && !child.dead),
        paused: Date.now() < brokenUntil ? new Date(brokenUntil).toISOString() : null,
        threads: THREADS,
        queue: { running: queue.running, waiting: queue.waiting, ...queue.limits, ...queue.stats },
        ...counters,
        avgMs: counters.completed ? Math.round(counters.totalMs / counters.completed) : null,
        lastError,
    };
}

export function stopKokoro() {
    clearTimeout(idleTimer);
    stopChild(child, 'shutdown');
}

export default { installState, available, kokoroToFile, streamKokoro, kokoroPreviewFile, status, stopKokoro };
