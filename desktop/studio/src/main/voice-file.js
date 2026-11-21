'use strict';
/*
 * Voice commands (0.2.12): a WAV file as the voice input, instead of the microphone. Used by the self-test
 * (scripts/voice-selftest.js) and by Studio when it is started with CF_STUDIO_VOICE_FILE set (testing only).
 *
 *   readWav(file)                         16 kHz mono Float32Array from a PCM WAV (8/16/24/32-bit integer or 32-bit float,
 *                                         any rate, any number of channels: mixed down and resampled)
 *   playInto(samples, feed, { chunkMs = 32, realtime = true, signal })
 *                                         hands the audio to feed(Buffer of 16-bit PCM) in chunks, at the pace of real time
 *                                         by default (as a microphone would), resolving when it is all played
 */
const fs = require('node:fs');

function readWav(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let off = 12;
    let fmt = null;
    let data = null;
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const size = b.readUInt32LE(off + 4);
        const body = off + 8;
        if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
        else if (id === 'data') data = b.subarray(body, Math.min(b.length, body + size));
        off = body + size + (size % 2);
    }
    if (!fmt || !data) throw new Error('WAV without fmt or data');
    const isFloat = fmt.format === 3;
    const bytes = fmt.bits / 8;
    const frames = Math.floor(data.length / (bytes * fmt.channels));
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
            const p = (i * fmt.channels + c) * bytes;
            let v;
            if (isFloat) v = data.readFloatLE(p);
            else if (bytes === 2) v = data.readInt16LE(p) / 32768;
            else if (bytes === 3) v = data.readIntLE(p, 3) / 8388608;
            else if (bytes === 4) v = data.readInt32LE(p) / 2147483648;
            else v = (data[p] - 128) / 128;
            sum += v;
        }
        mono[i] = sum / fmt.channels;
    }
    if (fmt.rate === 16000) return mono;
    const ratio = fmt.rate / 16000;
    const out = new Float32Array(Math.floor(frames / ratio));
    for (let i = 0; i < out.length; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const i1 = Math.min(frames - 1, i0 + 1);
        out[i] = mono[i0] + (mono[i1] - mono[i0]) * (x - i0);
    }
    return out;
}

function toPcm16(samples, from, to) {
    const n = to - from;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, samples[from + i]));
        buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), i * 2);
    }
    return buf;
}

async function playInto(samples, feed, { chunkMs = 32, realtime = true, signal = null, onChunk = null } = {}) {
    const step = Math.max(1, Math.round((16000 * chunkMs) / 1000));
    const t0 = Date.now();
    for (let off = 0, k = 0; off < samples.length; off += step, k++) {
        if (signal?.aborted) return;
        if (realtime) {
            const due = t0 + k * chunkMs;
            const wait = due - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        const end = Math.min(samples.length, off + step);
        feed(toPcm16(samples, off, end));
        onChunk?.(end / 16000);
    }
}

module.exports = { readWav, playInto, toPcm16 };
