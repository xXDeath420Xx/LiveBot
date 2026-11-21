'use strict';
/*
 * Voice commands (0.2.12): voice activity detection. Only stretches of real speech reach the recogniser; clicks, keys,
 * game sounds and silence never do.
 *
 *   createSileroVad({ modelPath, ort? })      Silero VAD v6 (MIT, github.com/snakers4/silero-vad, src/voice/silero_vad.onnx)
 *                                             through onnxruntime-node, on the CPU, one thread. 16 kHz audio in frames of
 *                                             512 samples (32 ms):
 *     await load()                            open the model
 *     await prob(frame: Float32Array(512))    the chance (0..1) that the frame is speech; the model keeps its own state
 *     reset()                                 forget that state (between listening sessions)
 *
 *   createSegmenter(opts)                     turns per-frame chances into speech segments. Pure logic, no model:
 *     push(frame, p, at)                      one 512-sample frame, its chance and the time it arrived (ms). Returns
 *                                             null or { type: 'segment' | 'short', ... }:
 *                                               segment  { samples: Float32Array, speechMs, segmentMs, prob, endAt, startAt }
 *                                                        endAt = when the last speech frame arrived (latency starts there)
 *                                               short    a burst that crossed the threshold but held less than minSpeechMs
 *                                                        (a click, a key, a bang): { speechMs, prob }
 *                                               unclear  long enough, but the voiced frames averaged under minMeanProb:
 *                                                        music and jingles, which the model half believes are voices
 *     flush(at)                               end any segment now (push-to-talk released); same result as push
 *     reset()                                 drop everything (mode change, microphone restarted)
 *     active                                  true while inside a segment
 *
 *   Options (defaults tuned on this PC with Windows voices, clicks, keys and noise; see the 0.2.12 report):
 *     threshold 0.5      a frame at or above this starts speech
 *     negThreshold 0.35  below this counts as silence once speech started
 *     minSpeechMs 250    less speech than this in a segment and it is dropped as 'short'
 *     minSilenceMs 300   this much silence ends a segment (the main part of the delay before a command runs)
 *     padMs 200          audio kept before speech starts and after it ends, so first and last sounds are not cut
 *     maxSpeechMs 8000   a segment is cut here even if the talking goes on (long talk still gets checked, in pieces)
 *     minMeanProb 0.8    the voiced frames of a segment must average this; speech from Windows voices averaged 0.95 to
 *                        0.99, Windows' music jingles 0.6 to 0.82
 */
const FRAME = 512;
const SR = 16000;
const FRAME_MS = (FRAME / SR) * 1000;   // 32
const CONTEXT = 64;                       // Silero v5/v6 expects the last 64 samples of the previous frame in front

const DEFAULTS = Object.freeze({ threshold: 0.5, negThreshold: 0.35, minSpeechMs: 250, minSilenceMs: 300, padMs: 200, maxSpeechMs: 8000, minMeanProb: 0.8 });

function createSileroVad({ modelPath, ort = null } = {}) {
    let session = null;
    let state = null;
    let context = new Float32Array(CONTEXT);
    let lib = ort;
    let srTensor = null;
    let running = Promise.resolve();

    function fresh() {
        state = new lib.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
        context = new Float32Array(CONTEXT);
    }

    return {
        async load() {
            if (session) return;
            // 0.2.13: the official onnxruntime build carries Microsoft's 1DS telemetry uploader (mobile.events.data.microsoft.com).
            // Studio sends nothing to anyone but CertiFried, so it is switched off before onnxruntime starts (main.js sets it too).
            process.env.ORT_DISABLE_TELEMETRY = '1';
            if (!lib) lib = require('onnxruntime-node');
            session = await lib.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
            srTensor = new lib.Tensor('int64', BigInt64Array.from([BigInt(SR)]), []);
            fresh();
        },
        get loaded() { return !!session; },
        prob(frame) {
            // one frame at a time: the model's state carries from each frame to the next
            const job = running.then(async () => {
                if (!session) throw new Error('VAD not loaded');
                const x = new Float32Array(CONTEXT + FRAME);
                x.set(context, 0);
                x.set(frame.subarray(0, FRAME), CONTEXT);
                const out = await session.run({ input: new lib.Tensor('float32', x, [1, CONTEXT + FRAME]), state, sr: srTensor });
                state = out.stateN;
                context = x.slice(x.length - CONTEXT);
                return Number(out.output.data[0]) || 0;
            });
            running = job.catch(() => {});
            return job;
        },
        reset() { if (lib && session) fresh(); },
        async close() { const s = session; session = null; try { await s?.release?.(); } catch { /* ignore */ } },
    };
}

function createSegmenter(opts = {}) {
    const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) };
    if (!(o.negThreshold < o.threshold)) o.negThreshold = Math.max(0.01, o.threshold - 0.15);
    const padFrames = Math.max(0, Math.round(o.padMs / FRAME_MS));
    const silenceFrames = Math.max(1, Math.round(o.minSilenceMs / FRAME_MS));
    const maxFrames = Math.max(1, Math.round(o.maxSpeechMs / FRAME_MS));

    let pre = [];          // the last padFrames frames before speech
    let frames = null;     // frames of the current segment (null: not in one)
    let speech = 0;        // frames at or above threshold in it
    let probSum = 0;
    let silence = 0;       // frames below negThreshold in a row at the end
    let lastSpeechAt = 0;
    let startAt = 0;

    function reset() { pre = []; frames = null; speech = 0; probSum = 0; silence = 0; }

    function finish(cutTrailing) {
        const all = frames;
        const keepTail = Math.min(silence, padFrames);
        const used = cutTrailing ? all.slice(0, all.length - silence + keepTail) : all;
        const speechMs = Math.round(speech * FRAME_MS);
        const prob = speech ? Math.round((probSum / speech) * 1000) / 1000 : 0;
        const endAt = lastSpeechAt;
        const begin = startAt;
        frames = null; speech = 0; probSum = 0; silence = 0;
        pre = [];
        if (speechMs < o.minSpeechMs) return { type: 'short', speechMs, prob, endAt, startAt: begin };
        if (prob < o.minMeanProb) return { type: 'unclear', speechMs, prob, endAt, startAt: begin };
        const samples = new Float32Array(used.length * FRAME);
        used.forEach((f, i) => samples.set(f, i * FRAME));
        return { type: 'segment', samples, speechMs, segmentMs: Math.round(used.length * FRAME_MS), prob, endAt, startAt: begin };
    }

    return {
        options: o,
        get active() { return frames !== null; },
        push(frame, p, at = Date.now()) {
            const f = frame.length === FRAME ? frame : Float32Array.from(frame.subarray(0, FRAME));
            if (frames === null) {
                if (p >= o.threshold) {
                    frames = [...pre, f];
                    pre = [];
                    speech = 1; probSum = p; silence = 0; lastSpeechAt = at; startAt = at;
                } else {
                    pre.push(f);
                    if (pre.length > padFrames) pre.shift();
                }
                return null;
            }
            frames.push(f);
            if (p >= o.threshold) { speech += 1; probSum += p; }
            if (p < o.negThreshold) silence += 1;
            else { silence = 0; lastSpeechAt = at; }
            if (silence >= silenceFrames) return finish(true);
            if (frames.length >= maxFrames) return finish(false);
            return null;
        },
        flush(at = Date.now()) {
            if (frames === null) { pre = []; return null; }
            if (!silence) lastSpeechAt = at;
            return finish(true);
        },
        reset,
    };
}

module.exports = { createSileroVad, createSegmenter, FRAME, FRAME_MS, SR, VAD_DEFAULTS: DEFAULTS };
