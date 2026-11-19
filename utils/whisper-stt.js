/*
 * Speech-to-text against the local whisper.cpp servers (ecosystem.whisper.config.cjs).
 *
 * Audio never leaves this machine. Two servers, chosen per guild:
 *   fast      base.en on 127.0.0.1:8178 — ~1s for a 6s phrase; the default, keeps captions live
 *   accurate  small.en on 127.0.0.1:8179 — ~3s for a 6s phrase; better with names and slang
 *
 * Whisper is trained on subtitled video, so given near-silence or noise it confidently "hears"
 * subtitle boilerplate ("Thank you.", "[BLANK_AUDIO]", "Thanks for watching!"). Those are
 * filtered here so a quiet mic never posts a phantom caption.
 */

import logger from './logger.js';

const SERVERS = {
    fast: process.env.WHISPER_FAST_URL || 'http://127.0.0.1:8178/inference',
    accurate: process.env.WHISPER_ACCURATE_URL || 'http://127.0.0.1:8179/inference',
};

// Per server, how many requests may run at once. whisper-server processes one at a time anyway;
// queueing here keeps a busy channel from piling up timed-out HTTP requests.
const MAX_CONCURRENT = 1;
const MAX_QUEUED = 30;
const REQUEST_TIMEOUT_MS = 30_000;

const queues = { fast: { active: 0, waiting: [] }, accurate: { active: 0, waiting: [] } };

const HALLUCINATIONS = [
    /^\[.*\]$/,                       // [BLANK_AUDIO], [MUSIC], [ Silence ]
    /^\(.*\)$/,                       // (music), (keyboard clicking)
    /^\*.*\*$/,                       // *sigh*
    /^(thank you|thanks)( so much)?( for watching| for listening)?[.!]*$/i,
    /^(please )?(like and )?subscribe[.!]*$/i,
    /^you[.!]*$/i,
    /^\.+$/,
];

// Words that carry no content on their own. "yes"/"no" are deliberately absent — they're answers.
const FILLER_WORDS = new Set([
    'mm', 'mmm', 'hmm', 'hm', 'mhm', 'mmhmm', 'mm-hmm', 'uh-huh', 'uh', 'uhh', 'um', 'umm', 'er', 'erm',
    'ah', 'ahh', 'oh', 'ohh', 'huh', 'yeah', 'yea', 'yep', 'yup', 'okay', 'ok', 'k', 'right', 'so',
    'well', 'like', 'alright', 'cool', 'nice', 'wow', 'lol', 'haha', 'ha',
]);

/** "Mm-hmm.", "Yeah, yeah.", "Okay." — a phrase of at most three filler words. */
export function isFiller(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 3 && words.every(w => FILLER_WORDS.has(w));
}

export function isHallucination(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    return HALLUCINATIONS.some(re => re.test(t));
}

/**
 * 48 kHz stereo s16le (what Discord's Opus decodes to) → 16 kHz mono s16le (what Whisper wants).
 * Averages the channels, then each 3 samples — the averaging doubles as the anti-alias filter,
 * which is plenty for speech.
 */
export function downmixTo16kMono(pcm48kStereo) {
    const frames = Math.floor(pcm48kStereo.length / 4);
    const outSamples = Math.floor(frames / 3);
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
        let sum = 0;
        for (let j = 0; j < 3; j++) {
            const o = (i * 3 + j) * 4;
            sum += pcm48kStereo.readInt16LE(o) + pcm48kStereo.readInt16LE(o + 2);
        }
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
    }
    return out;
}

/** Root-mean-square level of s16le mono PCM, 0..1. Used to skip clips that are just mic noise. */
export function rmsLevel(pcmMono) {
    const n = Math.floor(pcmMono.length / 2);
    if (!n) return 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const s = pcmMono.readInt16LE(i * 2) / 32768;
        acc += s * s;
    }
    return Math.sqrt(acc / n);
}

export function wavFromPcm16kMono(pcm) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);       // fmt chunk size
    header.writeUInt16LE(1, 20);        // PCM
    header.writeUInt16LE(1, 22);        // mono
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(16000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

async function runQueued(model, task) {
    const q = queues[model];
    if (q.active >= MAX_CONCURRENT) {
        if (q.waiting.length >= MAX_QUEUED) {
            throw new Error(`Whisper (${model}) is backed up — phrase dropped`);
        }
        await new Promise(resolve => q.waiting.push(resolve));
    }
    q.active++;
    try {
        return await task();
    } finally {
        q.active--;
        q.waiting.shift()?.();
    }
}

/**
 * Transcribe 16 kHz mono s16le PCM.
 * @param {Buffer} pcm
 * @param {'fast'|'accurate'} model
 * @returns {Promise<string>} cleaned text, '' when nothing real was said
 */
export async function transcribePcm(pcm, model = 'fast') {
    const key = model === 'accurate' ? 'accurate' : 'fast';
    return runQueued(key, async () => {
        const form = new FormData();
        form.append('file', new Blob([wavFromPcm16kMono(pcm)], { type: 'audio/wav' }), 'speech.wav');
        form.append('response_format', 'json');
        form.append('temperature', '0');

        const res = await fetch(SERVERS[key], { method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Whisper (${key}) HTTP ${res.status}`);
        const body = await res.json();
        const text = String(body?.text || '').replace(/\s+/g, ' ').trim();
        return isHallucination(text) ? '' : text;
    });
}

/** Is the server for this model answering? Used by /voice transcribe status and before starting. */
export async function whisperAvailable(model = 'fast') {
    const url = SERVERS[model === 'accurate' ? 'accurate' : 'fast'].replace(/\/inference$/, '/');
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch (err) {
        logger.debug(`[Whisper] ${model} server unreachable: ${err.message}`);
        return false;
    }
}

export default { transcribePcm, whisperAvailable, downmixTo16kMono, rmsLevel, isHallucination, isFiller };
