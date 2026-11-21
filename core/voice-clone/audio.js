/*
 * Audio handling for the own-voice feature: decode what the browser recorded into plain WAV, and talk to the two local
 * services that look at it.
 *
 *   sniffAudio(buf) → 'webm' | 'ogg' | 'wav' | 'mp4' | null      by content, never by name
 *   toWav(buf, { rate = 22050, trim = false }) → Buffer          ffmpeg, mono 16-bit; pipe in and out only (no files, no
 *                                                                network protocols), 20 s timeout, nice 10, 2 threads
 *   wavInfo(buf) → { rate, channels, bits, durationMs }
 *   createSidecar({ socket }) → { health, embed(wav), watermark(wav, id), detect(wav) }   Unix socket HTTP (sidecar/server.py)
 *   transcribe(wav, { url }) → text                               whisper.cpp server on loopback (whisper-accurate, small.en)
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { SIDECAR_SOCKET, ASR_URL } from './constants.js';

export function sniffAudio(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf.readUInt32BE(0) === 0x1A45DFA3) return 'webm';
    if (buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    if (buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
    if (buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
    if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return 'mp3';
    return null;
}

/** What the browser's MediaRecorder makes. Files from elsewhere (mp3, flac) are only read by the owner's detect tool. */
export const BROWSER_FORMATS = Object.freeze(['webm', 'ogg', 'mp4', 'wav']);

const TRIM = 'silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.25:start_threshold=-45dB,areverse';

export function toWav(input, { rate = 22050, trim = false, any = false, timeoutMs = 20_000, ffmpeg = 'ffmpeg' } = {}) {
    return new Promise((resolve, reject) => {
        const kind = sniffAudio(input);
        if (!kind || (!any && !BROWSER_FORMATS.includes(kind))) { reject(new Error('not an audio recording')); return; }
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-threads', '2', '-i', 'pipe:0',
            ...(trim ? ['-af', TRIM] : []), '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', '-f', 'wav', '-map_metadata', '-1', 'pipe:1'];
        const p = spawn('nice', ['-n', '10', ffmpeg, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        let err = '';
        let size = 0;
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('audio decode timed out')); }, timeoutMs);
        p.stdout.on('data', (d) => { size += d.length; if (size > 64 * 1024 * 1024) { try { p.kill('SIGKILL'); } catch { /* gone */ } } else out.push(d); });
        p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) { reject(new Error(`audio decode failed (${String(err).trim().slice(0, 160) || code})`)); return; }
            const wav = Buffer.concat(out);
            // ffmpeg writes a streaming header (sizes 0xFFFFFFFF) to a pipe: fix the sizes so every reader agrees.
            resolve(fixWavHeader(wav));
        });
        p.stdin.on('error', () => {});
        p.stdin.end(input);
    });
}

export function fixWavHeader(buf) {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const len = buf.readUInt32LE(off + 4);
        if (id === 'data') {
            const real = buf.length - off - 8;
            if (len !== real) buf.writeUInt32LE(real, off + 4);
            buf.writeUInt32LE(buf.length - 8, 4);
            return buf;
        }
        off += 8 + len + (len % 2);
    }
    return buf;
}

export function wavInfo(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let off = 12, fmt = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const len = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
        if (id === 'data' && fmt) {
            const bytes = Math.min(len, buf.length - off - 8);
            return { ...fmt, durationMs: Math.round((bytes / (fmt.channels * (fmt.bits / 8))) / fmt.rate * 1000) };
        }
        off += 8 + len + (len % 2);
    }
    return null;
}

function unixRequest(socket, method, path, body = null, { timeoutMs = 60_000, binary = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: socket, method, path, headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {} }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (res.statusCode !== 200) {
                    let msg = `sidecar ${res.statusCode}`;
                    try { msg = JSON.parse(buf.toString()).error || msg; } catch { /* not json */ }
                    reject(Object.assign(new Error(msg), { status: res.statusCode }));
                    return;
                }
                if (binary) resolve(buf);
                else { try { resolve(JSON.parse(buf.toString())); } catch (e) { reject(e); } }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('sidecar timed out')));
        req.on('error', reject);
        if (body) req.end(body); else req.end();
    });
}

export function createSidecar({ socket = SIDECAR_SOCKET } = {}) {
    return {
        async health() { try { return (await unixRequest(socket, 'GET', '/health', null, { timeoutMs: 3000 })).ok === true; } catch { return false; } },
        embed: (wav) => unixRequest(socket, 'POST', '/embed', wav),
        watermark: (wav, wmId) => unixRequest(socket, 'POST', `/watermark?msg=${Number(wmId) & 0xFFFF}`, wav, { binary: true }),
        detect: (wav) => unixRequest(socket, 'POST', '/detect', wav),
    };
}

export async function transcribe(wav, { url = ASR_URL, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetchImpl(url, { method: 'POST', body: fd, signal: ac.signal });
        if (!r.ok) throw new Error(`speech recognition answered ${r.status}`);
        const j = await r.json();
        return String(j?.text ?? '').trim();
    } finally { clearTimeout(t); }
}

export default { sniffAudio, toWav, fixWavHeader, wavInfo, createSidecar, transcribe };
