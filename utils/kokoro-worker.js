/*
 * Kokoro worker — the child process that holds the Kokoro-82M model (started and stopped by
 * utils/kokoro-tts.js; one per bot process, shared by every bot in it).
 *
 * Why a child process and not a worker thread: the model adds ~0.7-1.2 GB of RSS, and pm2 recycles
 * CertiFriedUtility at 3000 MB (ecosystem.config.cjs) — counted against the main pid only, so here it
 * cannot push the bots into a restart. A native crash in onnxruntime also takes down only this
 * process, not all 44 bots, and the parent runs it at a lower CPU priority than the bots.
 *
 * Messages (advanced serialization, so audio crosses as a Float32Array, not JSON):
 *   in   { type:'synth', id, text, voice, speed }
 *   out  { type:'ready', ok, error?, loadMs }       once, after the model loaded (or failed to)
 *        { type:'chunk', id, index, audio, rate }    one per sentence, in order
 *        { type:'done', id, ms, chunks }              | { type:'error', id, error }
 *
 * kokoro-js normally ignores session_options, so the model and tokenizer are built here and handed
 * to the KokoroTTS constructor, which is what lets the ONNX thread count be capped. stream() is fed
 * a TextSplitterStream that is closed straight away: given a plain string it never finishes.
 */
import path from 'node:path';

const ROOT = process.env.KOKORO_ROOT || process.cwd();
const THREADS = Math.min(4, Math.max(1, Number(process.env.KOKORO_THREADS) || 4));

const send = (msg) => { try { process.send?.(msg); } catch { /* parent gone */ } };
process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (err) => { send({ type: 'ready', ok: false, error: err.message }); process.exit(1); });

let tts;
let TextSplitterStream;
const jobs = [];
let busy = false;

async function load() {
    const t0 = performance.now();
    try {
        const kokoro = await import('kokoro-js');
        const hf = await import('@huggingface/transformers');
        TextSplitterStream = kokoro.TextSplitterStream;
        // Local files only (models/kokoro, installed by the deploy): never download at run time.
        hf.env.allowRemoteModels = false;
        hf.env.allowLocalModels = true;
        hf.env.localModelPath = path.join(ROOT, 'models') + path.sep;
        const model = await hf.StyleTextToSpeech2Model.from_pretrained('kokoro', {
            dtype: 'fp32',
            device: 'cpu',
            session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1, executionMode: 'sequential', logSeverityLevel: 3 },
        });
        const tokenizer = await hf.AutoTokenizer.from_pretrained('kokoro');
        tts = new kokoro.KokoroTTS(model, tokenizer);
        send({ type: 'ready', ok: true, loadMs: Math.round(performance.now() - t0) });
    } catch (err) {
        send({ type: 'ready', ok: false, error: err.message });
        process.exit(1);
    }
}

async function synth({ id, text, voice, speed }) {
    const t0 = performance.now();
    let index = 0;
    try {
        const splitter = new TextSplitterStream();
        splitter.push(text);
        splitter.close();
        for await (const { audio } of tts.stream(splitter, { voice, speed: speed || 1 })) {
            send({ type: 'chunk', id, index: index++, audio: audio.audio, rate: audio.sampling_rate });
        }
        send({ type: 'done', id, ms: Math.round(performance.now() - t0), chunks: index });
    } catch (err) {
        send({ type: 'error', id, error: err.message });
    }
}

async function pump() {
    if (busy || !tts) return;
    busy = true;
    while (jobs.length) await synth(jobs.shift());
    busy = false;
}

process.on('message', (msg) => {
    if (msg?.type !== 'synth') return;
    jobs.push(msg);
    pump();
});

await load();
pump();
