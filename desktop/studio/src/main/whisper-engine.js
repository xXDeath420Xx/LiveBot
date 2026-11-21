'use strict';
/*
 * Voice commands (0.2.12): Whisper speech recognition on this PC, through whisper.cpp's whisper-server.
 *
 * Nothing leaves the PC: whisper-server listens on 127.0.0.1 only (a free port picked at start), Studio posts each speech
 * segment to it as a WAV in memory, and it answers with the words. The only downloads are the model and, for the graphics
 * card, NVIDIA's CUDA runtime, each once, each checked against the SHA-256 written below before it is used.
 *
 * The program: whisper.cpp v1.9.5 (MIT, github.com/ggml-org/whisper.cpp), built for Studio by scripts/build-whisper.ps1
 * with ggml's loadable backends: whisper-server.exe and the processor backends for every x64 CPU ship unpacked in the
 * installer (src/voice/whisper, about 12 MB). The graphics card backend, ggml-cuda.dll (CUDA 12.9; sm_75 as PTX, sm_86,
 * sm_89 and native sm_120a for GeForce RTX 50 / Blackwell), is 88 MB, so it is downloaded on first use from CertiFried's
 * download site together with NVIDIA's CUDA runtime from NVIDIA's own site, and loaded through GGML_BACKEND_PATH with the
 * runtime on the helper's PATH. The processor path passes --no-gpu and never loads it.
 *
 *   createWhisperEngine({ binDir, dataDir, logger, spawnImpl, fetchImpl, now, gpuProbe })
 *     await start({ prefer: 'auto' | 'cpu', onProgress })   downloads what is missing, starts whisper-server, warms it up;
 *                                       auto tries the graphics card first and falls back to the processor, also when a
 *                                       graphics card download fails or does not pass its check (0.2.13; status().gpuFailed
 *                                       says why). Resolves { device: 'cuda' | 'cpu', gpuName, model, gpuFailed }. Rejects with .code:
 *                                       no_engine (files missing), download_failed, checksum, start_failed
 *     await transcribe(samples: Float32Array 16 kHz, { prompt })  { text, noSpeech, avgLogprob, ms }
 *     stop()
 *     status()                          { state: off|downloading|starting|ready|error, device, model, progress, error }
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn: defaultSpawn, execFile } = require('node:child_process');
const { FEED } = require('./site');

// Models: ggml conversions published by the whisper.cpp project on Hugging Face (huggingface.co/ggerganov/whisper.cpp).
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODELS = Object.freeze({
    // graphics card: Whisper large-v3-turbo, 5-bit (about 550 MB)
    'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
    // processor only: English base model (about 140 MB)
    'base.en': { file: 'ggml-base.en.bin', size: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
});
const MODEL_FOR = Object.freeze({ cuda: 'large-v3-turbo-q5_0', cpu: 'base.en' });

// NVIDIA's CUDA 12.9 redistributable runtime, from NVIDIA's own download site (developer.download.nvidia.com/compute/cuda/redist,
// manifest redistrib_12.9.1.json). Only these three DLLs are kept.
const NV = 'https://developer.download.nvidia.com/compute/cuda/redist/';
const CUDA_RUNTIME = Object.freeze({
    version: '12.9.1',
    parts: [
        { url: `${NV}cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.79-archive.zip`, size: 3521238, sha256: '179e9c43b0735ffe67207b3da556eb5a0c50f3047961882b7657d3b822d34ef8',
            members: ['cuda_cudart-windows-x86_64-12.9.79-archive/bin/cudart64_12.dll'] },
        { url: `${NV}libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.1.4-archive.zip`, size: 549755186, sha256: 'd534d98b0b453a98914dbf3adf47d7e84b55037abf02f87466439e1dcef581ed',
            members: ['libcublas-windows-x86_64-12.9.1.4-archive/bin/cublas64_12.dll', 'libcublas-windows-x86_64-12.9.1.4-archive/bin/cublasLt64_12.dll'] },
    ],
});
const CUDA_DLLS = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'];
// ggml-cuda.dll of the bundled whisper.cpp build (it must come from the same build as src/voice/whisper/ggml-base.dll).
const GPU_BACKEND = Object.freeze({
    url: `${FEED}CertiFried-Studio-Voice-CUDA-1.9.5-cu12.9-b1.zip`,
    size: 74462958, sha256: 'cc9afe7ee937acad8cbe313ba7f1604f32fa5c13be1adbca79e18a5c6cc29255', members: ['ggml-cuda.dll'], strip: 0,
});

const READY_MS = 90000;
const REQUEST_MS = 20000;

function err(code, message) { const e = new Error(message || code); e.code = code; return e; }

/** 16-bit mono WAV in memory. */
function wavBytes(samples, rate = 16000) {
    const n = samples.length;
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        b.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2);
    }
    return b;
}

async function sha256File(file) {
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => { fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject); });
    return h.digest('hex');
}

/** Download to dest through a .part file; the hash is checked before the rename, so a file in place is always whole. */
async function download({ url, dest, sha256, size, fetchImpl = globalThis.fetch, onProgress = () => {}, signal }) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    await fsp.rm(part, { force: true });
    let res;
    try { res = await fetchImpl(url, { redirect: 'follow', signal }); } catch (e) { throw err('download_failed', `Could not download ${path.basename(dest)}: ${e.message}`); }
    if (!res.ok || !res.body) throw err('download_failed', `Could not download ${path.basename(dest)} (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || size || 0;
    const h = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0;
    let lastReport = 0;
    try {
        for await (const chunk of res.body) {
            const buf = Buffer.from(chunk);
            h.update(buf);
            got += buf.length;
            if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
            const t = Date.now();
            if (t - lastReport > 250) { lastReport = t; onProgress(got, total); }
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
        out.destroy();
        await fsp.rm(part, { force: true });
        throw err('download_failed', `The download of ${path.basename(dest)} stopped: ${e.message}`);
    }
    onProgress(got, total);
    const digest = h.digest('hex');
    if (digest !== sha256) { await fsp.rm(part, { force: true }); throw err('checksum', `${path.basename(dest)} did not match its checksum, so it was deleted.`); }
    await fsp.rename(part, dest);
    return dest;
}

/** Windows' own tar (bsdtar) unpacks zip files; only the named members are taken, without their folders. */
function unzipMembers(zip, destDir, members, { strip = 2, tarPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') } = {}) {
    return new Promise((resolve, reject) => {
        execFile(tarPath, ['-xf', zip, '-C', destDir, '--strip-components', String(strip), ...members], { windowsHide: true, timeout: 300000 }, (e) => (e ? reject(err('download_failed', `Could not unpack ${path.basename(zip)}: ${e.message}`)) : resolve()));
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

/** Is there an NVIDIA graphics card? nvidia-smi comes with every NVIDIA driver. Resolves its name or null. */
function nvidiaGpu() {
    return new Promise((resolve) => {
        const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
        execFile(fs.existsSync(exe) ? exe : 'nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { windowsHide: true, timeout: 10000 }, (e, out) => {
            if (e) return resolve(null);
            const line = String(out || '').split(/\r?\n/).find((l) => l.trim());
            resolve(line ? { name: line.split(',')[0].trim(), driver: (line.split(',')[1] || '').trim() } : null);
        });
    });
}

function createWhisperEngine({ binDir, dataDir, logger = null, spawnImpl = defaultSpawn, fetchImpl = globalThis.fetch, gpuProbe = nvidiaGpu, threads = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 2)) } = {}) {
    let proc = null;
    let port = 0;
    let state = 'off';
    let device = null;
    let gpuName = null;
    let model = null;
    let progress = null;
    let error = null;
    let busy = Promise.resolve();
    let stopping = false;
    let gen = 0;               // bumped by every start and stop: a start that was overtaken cleans up after itself
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[whisper] ${m}`, meta); } catch { /* ignore */ } };
    const pidFile = path.join(dataDir, 'whisper-server.pid');
    const modelsDir = path.join(dataDir, 'models');
    const cudaDir = path.join(dataDir, `cuda-${CUDA_RUNTIME.version}`);
    const serverExe = path.join(binDir, 'whisper-server.exe');

    let gpuFailed = null;              // why the graphics card is not used this time (0.2.13), or null
    function status() { return { state, device, gpuName, model, progress, error, gpuFailed }; }

    async function ensureModel(name, onProgress) {
        const m = MODELS[name];
        const dest = path.join(modelsDir, m.file);
        if (fs.existsSync(dest)) {
            const st = fs.statSync(dest);
            const okFile = `${dest}.ok`;
            // hashed once after download; afterwards size + the marker (re-hashing 550 MB at every start would cost seconds)
            if (st.size === m.size && fs.existsSync(okFile)) return dest;
            if (st.size === m.size && (await sha256File(dest)) === m.sha256) { fs.writeFileSync(okFile, m.sha256); return dest; }
            await fsp.rm(dest, { force: true });
        }
        state = 'downloading';
        await download({ url: HF + m.file, dest, sha256: m.sha256, size: m.size, fetchImpl, onProgress: (got, total) => { progress = { what: 'model', got, total }; onProgress(status()); } });
        fs.writeFileSync(`${dest}.ok`, m.sha256);
        progress = null;
        return dest;
    }

    const NEEDED = [...CUDA_DLLS, 'ggml-cuda.dll'];
    const backendMark = () => path.join(cudaDir, `backend-${GPU_BACKEND.sha256.slice(0, 12)}.ok`);
    async function ensureCuda(onProgress) {
        const runtimeThere = CUDA_DLLS.every((f) => fs.existsSync(path.join(cudaDir, f))) && fs.existsSync(path.join(cudaDir, 'complete.json'));
        const backendThere = fs.existsSync(path.join(cudaDir, 'ggml-cuda.dll')) && fs.existsSync(backendMark());
        if (runtimeThere && backendThere) return cudaDir;
        await fsp.mkdir(cudaDir, { recursive: true });
        const tmp = path.join(dataDir, 'downloads');
        let done = 0;
        // a newer Studio with a rebuilt ggml-cuda.dll fetches only that; NVIDIA's runtime stays
        const parts = [...(runtimeThere ? [] : CUDA_RUNTIME.parts), ...(backendThere ? [] : [GPU_BACKEND])];
        const total = parts.reduce((a, p) => a + p.size, 0);
        if (!backendThere) { for (const f of fs.readdirSync(cudaDir)) if (/^backend-[0-9a-f]+\.ok$/.test(f)) await fsp.rm(path.join(cudaDir, f), { force: true }); }
        for (const part of parts) {
            const zip = path.join(tmp, path.basename(new URL(part.url).pathname));
            state = 'downloading';
            if (!(fs.existsSync(zip) && fs.statSync(zip).size === part.size && (await sha256File(zip)) === part.sha256)) {
                await download({ url: part.url, dest: zip, sha256: part.sha256, size: part.size, fetchImpl, onProgress: (got) => { progress = { what: 'cuda', got: done + got, total }; onProgress(status()); } });
            }
            await unzipMembers(zip, cudaDir, part.members, { strip: part.strip ?? 2 });
            done += part.size;
            await fsp.rm(zip, { force: true });
        }
        if (!NEEDED.every((f) => fs.existsSync(path.join(cudaDir, f)))) throw err('download_failed', 'The graphics card files were not complete after unpacking.');
        fs.writeFileSync(path.join(cudaDir, 'complete.json'), JSON.stringify({ version: CUDA_RUNTIME.version, at: new Date().toISOString() }));
        fs.writeFileSync(backendMark(), GPU_BACKEND.sha256);
        progress = null;
        return cudaDir;
    }

    function launch({ useGpu, modelPath }) {
        return new Promise((resolve, reject) => {
            const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'en', '-nt', '-nf'];
            if (!useGpu) args.push('-ng');
            const env = { ...process.env };
            const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
            delete env.GGML_BACKEND_PATH;
            if (useGpu) { env[pathKey] = `${cudaDir};${binDir};${env[pathKey] || ''}`; env.GGML_BACKEND_PATH = path.join(cudaDir, 'ggml-cuda.dll'); }
            else env[pathKey] = `${binDir};${env[pathKey] || ''}`;
            const p = spawnImpl(serverExe, args, { cwd: binDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            proc = p;
            let text = '';
            let usedGpu = false;
            let settled = false;
            const timer = setTimeout(() => done(err('start_failed', 'Whisper took too long to start.')), READY_MS);
            const onData = (d) => {
                text = (text + String(d)).slice(-8000);
                if (/using CUDA\d* backend/i.test(text)) usedGpu = true;
            };
            // whisper-server prints "listening" to stdout, which a pipe buffers: ask it over HTTP instead
            const poll = async () => {
                if (settled) return;
                try {
                    const r = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
                    if (r.ok) { try { await r.arrayBuffer(); } catch { /* ignore */ } done(null); return; }
                } catch { /* not yet */ }
                setTimeout(poll, 100);
            };
            setTimeout(poll, 100);
            function done(e) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (e) { try { p.kill(); } catch { /* gone */ } if (proc === p) proc = null; e.detail = text.slice(-1500); reject(e); return; }
                resolve({ usedGpu });
            }
            p.stdout.on('data', onData);
            p.stderr.on('data', onData);
            p.on('error', (e) => done(err('start_failed', `Whisper could not start: ${e.message}`)));
            p.on('exit', (code) => {
                if (!settled) done(err('start_failed', `Whisper stopped while starting (code ${code}).`));
                if (proc === p) {
                    proc = null;
                    if (!stopping && state === 'ready') { state = 'error'; error = 'Whisper stopped.'; log('warn', 'whisper-server exited', { code }); onExit?.(code); }
                }
            });
        });
    }

    let onExit = null;

    async function post(samples, { prompt = '' } = {}) {
        const form = new FormData();
        form.append('file', new Blob([wavBytes(samples)], { type: 'audio/wav' }), 'speech.wav');
        form.append('response_format', 'verbose_json');
        form.append('temperature', '0');
        form.append('language', 'en');
        if (prompt) form.append('prompt', prompt);
        // On the processor, encode only as much of Whisper's 30 s window as the segment needs (50 steps a second, at least
        // 512): about 180 ms instead of 490 ms for a short command on a 16-core CPU. The graphics card does the full window
        // in under 100 ms, which is a little more accurate.
        if (device === 'cpu') form.append('audio_ctx', String(Math.min(1500, Math.max(512, Math.ceil((samples.length / 16000) * 50) + 100))));
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQUEST_MS);
        try {
            const res = await fetchImpl(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: ctl.signal });
            if (!res.ok) throw err('transcribe_failed', `Whisper answered HTTP ${res.status}`);
            return await res.json();
        } finally { clearTimeout(timer); }
    }

    /**
     * A whisper-server left from a Studio that did not close normally (Windows does not end a child with its parent):
     * ended by its process id, and only when that id is still whisper-server.exe.
     */
    async function endLeftover() {
        let pid = 0;
        try { pid = Number(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid) || 0; } catch { return; }
        await fsp.rm(pidFile, { force: true });
        if (!pid || pid === process.pid) return;
        const image = await new Promise((resolve) => execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 },
            (e, out) => resolve(e ? '' : (String(out).match(/^"([^"]+)","(\d+)"/m) || []).slice(1))));
        if (Array.isArray(image) && image[0]?.toLowerCase() === 'whisper-server.exe' && Number(image[1]) === pid) {
            try { process.kill(pid); log('info', 'ended a whisper-server left from before', { pid }); } catch { /* gone */ }
        }
    }

    async function startOn(useGpu, onProgress, my) {
        const name = MODEL_FOR[useGpu ? 'cuda' : 'cpu'];
        const modelPath = await ensureModel(name, onProgress);
        if (my !== gen) throw err('cancelled', 'Stopped.');
        state = 'starting';
        onProgress(status());
        port = await freePort();
        const r = await launch({ useGpu, modelPath });
        if (my !== gen) { stopProc(); throw err('cancelled', 'Stopped.'); }
        if (proc?.pid) { try { fs.writeFileSync(pidFile, JSON.stringify({ pid: proc.pid, at: new Date().toISOString() })); } catch { /* ignore */ } }
        if (useGpu && !r.usedGpu) { stopProc(); throw err('start_failed', 'The graphics card could not be used by Whisper.'); }
        model = name;
        device = useGpu ? 'cuda' : 'cpu';
        // warm up: the first run loads kernels and buffers
        await post(new Float32Array(16000)).catch(() => {});
        if (my !== gen) { stopProc(); throw err('cancelled', 'Stopped.'); }
        state = 'ready';
        error = null;
        onProgress(status());
        return { device, gpuName, model, gpuFailed: useGpu ? null : gpuFailed };
    }

    function stopProc() {
        const p = proc;
        proc = null;
        if (p) { try { p.kill(); } catch { /* gone */ } try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ } }
    }

    return {
        status,
        set onExit(fn) { onExit = fn; },
        async start({ prefer = 'auto', onProgress = () => {} } = {}) {
            const my = ++gen;
            stopping = false;
            error = null;
            gpuFailed = null;
            stopProc();
            if (!fs.existsSync(serverExe)) { state = 'error'; error = 'The Whisper files are missing from this copy of Studio.'; throw err('no_engine', error); }
            await endLeftover();
            let gpu = null;
            if (prefer !== 'cpu') {
                gpu = await gpuProbe();
                gpuName = gpu?.name || null;
            }
            if (gpu && GPU_BACKEND.sha256) {
                try {
                    await ensureCuda(onProgress);
                    return await startOn(true, onProgress, my);
                } catch (e) {
                    if (e.code === 'cancelled') throw e;
                    // 0.2.13: a failed or wrong graphics card download no longer ends Whisper for the session (which left Windows
                    // speech recognition); Whisper base.en on the processor comes first, and is tried again on the next start.
                    gpuFailed = { code: e.code || 'start_failed', message: String(e.message || 'The graphics card could not be used.').slice(0, 300) };
                    log('warn', 'graphics card not usable; using the processor', { error: e.code || e.message, detail: e.detail ? String(e.detail).slice(-400) : undefined });
                }
            }
            try {
                return await startOn(false, onProgress, my);
            } catch (e) {
                if (e.code === 'cancelled') throw e;
                state = 'error';
                error = e.message;
                log('warn', 'whisper could not start', { error: e.message, detail: e.detail ? String(e.detail).slice(-400) : undefined });
                throw e;
            }
        },
        transcribe(samples, opts = {}) {
            const job = busy.then(async () => {
                if (state !== 'ready' || !proc) throw err('not_ready', 'Whisper is not running.');
                const t0 = Date.now();
                const j = await post(samples, opts);
                const segs = Array.isArray(j?.segments) ? j.segments : [];
                const noSpeech = segs.length ? Math.min(...segs.map((s) => Number(s.no_speech_prob) || 0)) : null;
                const lp = segs.length ? segs.reduce((a, s) => a + (Number(s.avg_logprob) || 0), 0) / segs.length : null;
                return { text: String(j?.text ?? segs.map((s) => s.text).join(' ')).trim(), noSpeech, avgLogprob: lp, ms: Date.now() - t0 };
            });
            busy = job.catch(() => {});
            return job;
        },
        stop() { gen += 1; stopping = true; stopProc(); state = 'off'; device = null; progress = null; },
    };
}

module.exports = { createWhisperEngine, download, wavBytes, nvidiaGpu, unzipMembers, MODELS, MODEL_FOR, CUDA_RUNTIME, CUDA_DLLS, GPU_BACKEND };
