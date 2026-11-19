/*
 * NSFW classifier — the main-thread side of the local models (decisions are in core/nsfw-logic.js, the
 * inference in core/nsfw-worker.js). Used by core/nsfw-protection.js for avatars and chat images.
 *
 *   installed?   onnxruntime-node must resolve and the model files (models/nsfw/, see MODELS) must exist
 *                and match their SHA-256. Until then status() says what is missing, classify() answers
 *                { ok:false, skipped:'not_installed' } at once, and the features show "model not
 *                installed" — the code can ship before the model does (like jsqr for QR codes).
 *   workers      NSFW_WORKERS worker threads (default 1), each running NSFW_THREADS ONNX threads
 *                (default 2), started on the first scan and stopped after 10 idle minutes (the models
 *                take ~400 MB while loaded). A crashed worker is replaced on the next scan.
 *   backpressure core/nsfw-queue.js: a small bounded queue with a priority lane for joins / avatar
 *                changes. A full lane drops the job at once ({ skipped:'overloaded' }); the caller counts
 *                it as skipped and the dashboard's stats say so. Nothing ever waits on the event loop.
 *   imageKey()   a hash of the downscaled pixels (64x64 RGB, 5 bits a channel): the same picture
 *                re-encoded or re-uploaded gets the same key. Keys the verdict cache and the
 *                "remembered as safe" list; never reversible to the image.
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import logger from '../utils/logger.js';
import { MODELS } from './nsfw-logic.js';
import { createJobQueue } from './nsfw-queue.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = Math.min(4, Math.max(1, Number(process.env.NSFW_WORKERS) || 1));
const THREADS = Math.min(8, Math.max(1, Number(process.env.NSFW_THREADS) || 2));
const JOB_TIMEOUT_MS = 30_000;
const IDLE_STOP_MS = 10 * 60_000;
const BROKEN_RETRY_MS = 10 * 60_000;
const INSTALL_RECHECK_MS = 5 * 60_000;

const queue = createJobQueue();
const pool = [];                 // { worker, ready, busy, job, timer }
const counters = { completed: 0, failed: 0, timeouts: 0, notInstalled: 0, totalMs: 0, lastMs: null };
let install = null;              // cached installState()
let installAt = 0;
let installing = null;
let brokenUntil = 0;
let lastError = null;
let lastErrorAt = null;
let idleTimer = null;
let nextId = 1;

// ── is it installed? ────────────────────────────────────────────────────────

function runtimeResolvable() {
    try {
        createRequire(import.meta.url).resolve('onnxruntime-node');
        return true;
    } catch {
        return false;
    }
}

async function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

async function checkModel(m) {
    const file = path.join(ROOT, m.file);
    try {
        const st = await fs.promises.stat(file);
        const sum = await sha256File(file);
        return { id: m.id, name: m.name, file: m.file, present: true, bytes: st.size, ok: sum === m.sha256, problem: sum === m.sha256 ? null : 'checksum does not match' };
    } catch {
        return { id: m.id, name: m.name, file: m.file, present: false, ok: false, problem: 'file missing' };
    }
}

/**
 * What is installed: { runtime, screen, judge, ready, partial, missing[] }. Cached; the model files are
 * hashed once (a few hundred ms, streamed) and again only after INSTALL_RECHECK_MS when not ready.
 */
export async function installState({ fresh = false } = {}) {
    const stale = !install || (!install.ready && Date.now() - installAt > INSTALL_RECHECK_MS);
    if (!fresh && !stale) return install;
    if (installing) return installing;
    installing = (async () => {
        const runtime = runtimeResolvable();
        const [screen, judge] = await Promise.all([checkModel(MODELS.screen), checkModel(MODELS.judge)]);
        const missing = [];
        if (!runtime) missing.push('the onnxruntime-node package');
        if (!screen.ok) missing.push(`${screen.file} (${screen.problem})`);
        if (!judge.ok) missing.push(`${judge.file} (${judge.problem})`);
        install = { runtime, screen, judge, ready: runtime && screen.ok && judge.ok, partial: runtime && screen.ok && !judge.ok, missing };
        installAt = Date.now();
        return install;
    })().finally(() => { installing = null; });
    return installing;
}

/** Can a scan run at all (runtime + the screen model)? Without the judge it runs review-only. */
export async function available() {
    const s = await installState();
    return (s.ready || s.partial) && Date.now() >= brokenUntil;
}

// ── the image key ───────────────────────────────────────────────────────────

/** 64 hex chars for "this picture" (see the header). Throws when the bytes are not an image. */
export async function imageKey(buffer) {
    const raw = await sharp(buffer, { failOn: 'none', animated: false, limitInputPixels: 80_000_000 })
        .rotate().flatten({ background: '#ffffff' }).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    for (let i = 0; i < raw.length; i++) raw[i] >>= 3;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── the pool ────────────────────────────────────────────────────────────────

function noteError(message) {
    lastError = String(message).slice(0, 300);
    lastErrorAt = Date.now();
}

function settle(job, result) {
    if (job.settled) return;
    job.settled = true;
    job.resolve(result);
}

function spawn() {
    const slot = { worker: null, ready: false, busy: false, job: null, timer: null };
    const judge = install?.judge?.ok ? MODELS.judge : null;
    slot.worker = new Worker(new URL('./nsfw-worker.js', import.meta.url), {
        workerData: { root: ROOT, models: { screen: MODELS.screen, judge }, threads: THREADS },
    });
    slot.worker.on('message', (msg) => {
        if (msg?.type === 'ready') {
            if (msg.ok) {
                slot.ready = true;
                pump();
                return;
            }
            // The runtime loaded but the model would not (or the native module failed): stop trying for a while.
            noteError(`model failed to load: ${msg.error}`);
            logger.error(`[NSFW] classifier worker could not load the model: ${msg.error}`);
            brokenUntil = Date.now() + BROKEN_RETRY_MS;
            for (const job of queue.drain()) settle(job, { ok: false, skipped: 'not_installed', error: lastError });
            retire(slot);
            return;
        }
        if (msg?.type !== 'result' || !slot.job || slot.job.id !== msg.id) return;
        const job = slot.job;
        clearTimeout(slot.timer);
        slot.job = null;
        slot.busy = false;
        if (msg.ok) {
            counters.completed++;
            counters.totalMs += msg.ms || 0;
            counters.lastMs = msg.ms ?? null;
            settle(job, { ok: true, scores: msg.scores, ms: msg.ms });
        } else {
            counters.failed++;
            noteError(msg.error);
            settle(job, { ok: false, skipped: 'error', error: msg.error });
        }
        pump();
    });
    slot.worker.on('error', (err) => {
        noteError(`worker error: ${err.message}`);
        logger.error(`[NSFW] classifier worker error: ${err.message}`);
    });
    slot.worker.on('exit', (code) => {
        const job = slot.job;
        slot.job = null;
        clearTimeout(slot.timer);
        const i = pool.indexOf(slot);
        if (i >= 0) pool.splice(i, 1);
        if (job) {
            counters.failed++;
            settle(job, { ok: false, skipped: 'error', error: `classifier worker stopped (code ${code})` });
        }
        if (queue.depth) pump();
    });
    pool.push(slot);
    return slot;
}

function retire(slot) {
    const i = pool.indexOf(slot);
    if (i >= 0) pool.splice(i, 1);
    slot.worker.terminate().catch(() => {});
}

function armIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (queue.depth || pool.some(s => s.busy)) { armIdleStop(); return; }
        for (const slot of [...pool]) retire(slot);
        logger.info('[NSFW] classifier idle; workers stopped (they start again on the next scan)');
    }, IDLE_STOP_MS);
    idleTimer.unref?.();
}

function pump() {
    for (const slot of pool) {
        if (!slot.ready || slot.busy) continue;
        const { job, expired } = queue.take();
        for (const old of expired) settle(old, { ok: false, skipped: 'overloaded', error: 'waited too long in the queue' });
        if (!job) break;
        slot.busy = true;
        slot.job = job;
        slot.timer = setTimeout(() => {
            counters.timeouts++;
            noteError(`a scan took over ${JOB_TIMEOUT_MS / 1000}s; worker restarted`);
            settle(job, { ok: false, skipped: 'error', error: 'timed out' });
            retire(slot);
        }, JOB_TIMEOUT_MS);
        slot.worker.postMessage({ type: 'classify', id: job.id, buf: job.bytes, review: job.review });
        job.bytes = null;
    }
    while (pool.length < WORKERS && queue.depth > pool.filter(s => !s.busy).length) spawn();
    armIdleStop();
}

/**
 * Classify one image. Never throws.
 * @param {Buffer} buffer          image bytes (copied to the worker; the caller's buffer is not touched)
 * @param {{ priority?:boolean, review?:number }} opts  review = the screen score that triggers the second model
 * @returns {Promise<{ ok:true, scores:object, ms:number } | { ok:false, skipped:'not_installed'|'overloaded'|'error', error?:string }>}
 */
export async function classify(buffer, { priority = false, review = 0.6 } = {}) {
    try {
        if (!(await available())) {
            counters.notInstalled++;
            return { ok: false, skipped: 'not_installed', error: (install?.missing || []).join('; ') || lastError || 'not installed' };
        }
        return await new Promise((resolve) => {
            const job = { id: nextId++, bytes: new Uint8Array(buffer), review, resolve, settled: false };
            if (!queue.offer(job, { priority })) {
                resolve({ ok: false, skipped: 'overloaded', error: 'the classifier queue is full' });
                return;
            }
            pump();
        });
    } catch (err) {
        noteError(err.message);
        return { ok: false, skipped: 'error', error: err.message };
    }
}

/** For the dashboard and `/avatarfilter nsfw status`. */
export async function status() {
    const s = await installState();
    return {
        installed: s.ready,
        partial: s.partial,
        runtime: s.runtime,
        missing: s.missing,
        models: [s.screen, s.judge].map(m => ({ id: m.id, name: m.name, file: m.file, ok: m.ok, problem: m.problem })),
        paused: Date.now() < brokenUntil ? new Date(brokenUntil).toISOString() : null,
        workers: { running: pool.length, busy: pool.filter(x => x.busy).length, max: WORKERS, threadsEach: THREADS },
        queue: { ...queue.waiting, limits: queue.limits, ...queue.stats },
        completed: counters.completed,
        failed: counters.failed,
        timeouts: counters.timeouts,
        avgMs: counters.completed ? Math.round(counters.totalMs / counters.completed) : null,
        lastMs: counters.lastMs,
        lastError,
        lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
    };
}

export default { installState, available, imageKey, classify, status };
