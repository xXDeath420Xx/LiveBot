/*
 * NSFW classifier worker thread (started by core/nsfw-classifier.js; never imported by anything else).
 *
 * Decodes an image with sharp and runs the two ONNX models (onnxruntime-node, CPU) from core/nsfw-logic.js
 * MODELS, so no inference ever runs on the bot's event loop:
 *
 *   1. screen the first frame (and, for an animated image, the middle frame) at the screen model's size;
 *      the highest frame is the one judged
 *   2. at or above the caller's review threshold: the screen on the mirror image, then the judge model on
 *      the image and its mirror (the judge's session is only created the first time it is needed)
 *
 * Messages in:  { type: 'classify', id, buf: Uint8Array, review: number }
 * Messages out: { type: 'result', id, ok: true, scores, ms } | { type: 'result', id, ok: false, error }
 *               { type: 'ready', ok, error } once the screen model has loaded (or failed to)
 * Nothing is written to disk; the image bytes live only for the length of one job.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { softmax, nsfwProbability, minorSuspected, toTensorData, framesToCheck } from './nsfw-logic.js';

const { root, models, threads = 2 } = workerData || {};
let ort = null;
let sharp = null;
const sessions = {};

async function session(which) {
    if (sessions[which]) return sessions[which];
    const m = models[which];
    sessions[which] = ort.InferenceSession.create(path.join(root, m.file), {
        intraOpNumThreads: Math.max(1, Number(threads) || 1),
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
    });
    try {
        return await sessions[which];
    } catch (err) {
        delete sessions[which];
        throw err;
    }
}

async function pixels(buf, size, { page = 0, flip = false } = {}) {
    let img = sharp(buf, { failOn: 'none', animated: false, page, limitInputPixels: 80_000_000 })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize(size, size, { fit: 'fill', kernel: 'cubic' });
    if (flip) img = img.flop();
    return img.removeAlpha().raw().toBuffer();
}

async function score(which, buf, opts) {
    const m = models[which];
    const s = await session(which);
    const data = toTensorData(await pixels(buf, m.size, opts), m.size, m.mean, m.std);
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, m.size, m.size]) });
    const probs = softmax(out[s.outputNames[0]].data);
    return { p: nsfwProbability(probs, m), minor: minorSuspected(probs, m) };
}

async function classify(buf, review) {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const frames = framesToCheck(meta.pages);
    let best = null;
    for (const page of frames) {
        const r = await score('screen', buf, { page });
        if (!best || r.p > best.p) best = { ...r, page };
    }
    const scores = { screen: best.p, screenFlip: null, judge: null, judgeFlip: null, minor: best.minor, frame: best.page, frames: meta.pages || 1, judgeError: null };
    if (best.p >= review) {
        scores.screenFlip = (await score('screen', buf, { page: best.page, flip: true })).p;
        if (models.judge) {
            try {
                const j = await score('judge', buf, { page: best.page });
                const jf = await score('judge', buf, { page: best.page, flip: true });
                scores.judge = j.p;
                scores.judgeFlip = jf.p;
                scores.minor = scores.minor || j.minor || jf.minor;
            } catch (err) {
                // No judge (model file missing or broken): the decision treats this as review-only.
                scores.judgeError = err.message;
            }
        }
    }
    return scores;
}

async function boot() {
    try {
        const mod = await import('onnxruntime-node');
        ort = mod.default ?? mod;
        // Errors only: the runtime otherwise warns on every start that this server has no GPU.
        try { ort.env.logLevel = 'error'; } catch { /* older runtime */ }
        sharp = (await import('sharp')).default;
        await session('screen');
        parentPort.postMessage({ type: 'ready', ok: true });
    } catch (err) {
        parentPort.postMessage({ type: 'ready', ok: false, error: err.message });
    }
}

parentPort.on('message', async (msg) => {
    if (msg?.type !== 'classify') return;
    const started = Date.now();
    try {
        const buf = Buffer.from(msg.buf.buffer, msg.buf.byteOffset, msg.buf.byteLength);
        const review = Number(msg.review);
        const scores = await classify(buf, Number.isFinite(review) ? review : 0.6);
        parentPort.postMessage({ type: 'result', id: msg.id, ok: true, scores, ms: Date.now() - started });
    } catch (err) {
        parentPort.postMessage({ type: 'result', id: msg.id, ok: false, error: err.message, ms: Date.now() - started });
    }
});

boot();
