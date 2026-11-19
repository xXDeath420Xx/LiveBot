/*
 * Voice recording — the pure half of core/voice-recorder.js (no Discord, no ffmpeg, no database).
 *
 * A recording is ONE mixed track: everyone who speaks is decoded to PCM and summed onto a single
 * timeline, which streams into ffmpeg as it goes. One file is what people expect to download and play,
 * and it keeps memory flat however long the recording runs (only the last second of the timeline is
 * held, to absorb network jitter, before it is written).
 *
 * Placement: Discord only sends packets while someone talks. Each speaker has a clock: the first packet
 * of a burst lands at "now" on the recording timeline, the following ones follow it back to back
 * (20 ms each) so jitter doesn't chop words up; when a speaker's packets fall too far behind real time
 * (a pause, lost packets) the next one re-anchors to "now".
 *
 * Output format: mono Opus in Ogg at 32 kbit/s (VoIP mode) — clear speech, ~14 MB per hour — and the
 * length is capped so the file always fits the server's Discord upload limit.
 */

export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960;            // 20 ms of mono audio
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
export const OPUS_BITRATE = 32000;
export const DEFAULT_MAX_MINUTES = 30;
export const HARD_MAX_MINUTES = 120;

const MIB = 1024 * 1024;

/** Discord's attachment limit for a bot in a server of this boost tier. */
export function uploadLimitBytes(premiumTier) {
    const tier = Number(premiumTier) || 0;
    if (tier >= 3) return 100 * MIB;
    if (tier === 2) return 50 * MIB;
    return 10 * MIB;
}

/** Longest recording (whole minutes) whose file fits `limitBytes`, with headroom for Ogg overhead and VBR peaks. */
export function maxMinutesForLimit(limitBytes, bitrate = OPUS_BITRATE) {
    const bytesPerSec = (bitrate / 8) * 1.05;
    return Math.max(1, Math.floor((limitBytes * 0.9) / bytesPerSec / 60));
}

/**
 * The cap for one recording: what was asked for (if anything), never above the server's configured
 * maximum (default 30), the upload limit, or HARD_MAX_MINUTES.
 */
export function effectiveMaxMinutes({ requested = null, configured = null, premiumTier = 0 } = {}) {
    const serverMax = Number(configured) > 0 ? Math.floor(Number(configured)) : DEFAULT_MAX_MINUTES;
    const wanted = Number(requested) > 0 ? Math.floor(Number(requested)) : serverMax;
    return Math.max(1, Math.min(wanted, serverMax, maxMinutesForLimit(uploadLimitBytes(premiumTier)), HARD_MAX_MINUTES));
}

/** The JSON role list in record_config.allowed_role_ids (tolerates comma lists and junk). */
export function parseRoleList(value) {
    if (Array.isArray(value)) return value.map(String).filter(id => /^\d{5,25}$/.test(id));
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try { return parseRoleList(JSON.parse(text)); } catch { /* fall through */ }
    }
    return text.split(/[\s,]+/).filter(id => /^\d{5,25}$/.test(id));
}

/** Safe file name: recording-<channel>-<yyyy-mm-dd-hh-mm>.ogg */
export function recordingFileName(channelName, startedAtMs) {
    const stamp = new Date(startedAtMs).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = String(channelName || 'voice').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'voice';
    return `recording-${name}-${stamp}.ogg`;
}

export function formatDuration(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
}

/** The nickname that shows everyone in the channel that the bot is recording (Discord max 32 chars). */
export function recordingNickname(currentName) {
    const base = String(currentName || 'Bot').replace(/^🔴 REC · /, '');
    return `🔴 REC · ${base}`.slice(0, 32).trimEnd();
}

/** The consent notice posted in the voice channel's chat and the command channel when recording starts. */
export function consentNotice({ starter, channel, maxMinutes, output }) {
    return `🔴 **This voice channel is being RECORDED.** ${starter} started recording ${channel} (up to ${maxMinutes} min). `
        + `Everything said here is captured into one audio file that will be posted to ${output}. `
        + '**If you do not want to be recorded, leave the channel now.** '
        + 'Members who used `/voice privacy opt-out` are left out of the recording.';
}

/** Per-speaker timeline clock (positions in samples since the recording started). */
export class SpeakerClock {
    constructor({ maxBehindMs = 200, maxAheadMs = 500 } = {}) {
        this.nextSample = null;
        this.maxBehind = maxBehindMs * SAMPLES_PER_MS;
        this.maxAhead = maxAheadMs * SAMPLES_PER_MS;
    }

    /** Where a chunk of `samples` received at timeline position `nowSample` goes. */
    place(nowSample, samples) {
        let pos = this.nextSample;
        if (pos == null || pos < nowSample - this.maxBehind || pos > nowSample + this.maxAhead) pos = nowSample;
        this.nextSample = pos + samples;
        return pos;
    }

    /** Skip `samples` (a silence frame) without writing anything. */
    advance(nowSample, samples) {
        this.place(nowSample, samples);
    }
}

function clamp16(v) {
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * Sums PCM from any number of speakers onto one mono timeline and writes it out in order.
 * `write(buffer)` receives s16le mono 48 kHz.
 */
export class TimelineMixer {
    constructor({ write, lagMs = 1000 } = {}) {
        this.write = write;
        this.lagFrames = Math.max(1, Math.round(lagMs / 20));
        this.frames = new Map();     // frame index -> Int32Array(FRAME_SAMPLES)
        this.nextFrame = 0;          // first frame not yet written
        this.maxFrame = -1;
        this.droppedLate = 0;        // samples that arrived after their frame was written
        this.framesWritten = 0;
    }

    /** Add interleaved stereo s16le PCM (as decoded from Opus) at mono sample position `startSample`. */
    addStereo(startSample, pcm) {
        const samples = Math.floor(pcm.length / 4);
        // Int16Array needs 2-byte alignment; a decoder may hand back a slice that isn't.
        const src = pcm.byteOffset % 2 === 0 ? pcm : new Uint8Array(pcm);
        const view = new Int16Array(src.buffer, src.byteOffset, samples * 2);
        let idx = Math.max(0, Math.floor(startSample));
        for (let i = 0; i < samples; i++, idx++) {
            const frame = Math.floor(idx / FRAME_SAMPLES);
            if (frame < this.nextFrame) { this.droppedLate++; continue; }
            let acc = this.frames.get(frame);
            if (!acc) {
                acc = new Int32Array(FRAME_SAMPLES);
                this.frames.set(frame, acc);
                if (frame > this.maxFrame) this.maxFrame = frame;
            }
            acc[idx - frame * FRAME_SAMPLES] += (view[2 * i] + view[2 * i + 1]) >> 1;
        }
        return samples;
    }

    /** Write every frame before `uptoFrame` (exclusive); frames nobody spoke in are silence. */
    flushUntil(uptoFrame) {
        const end = Math.floor(uptoFrame);
        if (end <= this.nextFrame) return 0;
        const count = end - this.nextFrame;
        const out = new Int16Array(count * FRAME_SAMPLES);
        for (let f = 0; f < count; f++) {
            const key = this.nextFrame + f;
            const acc = this.frames.get(key);
            if (!acc) continue;
            const base = f * FRAME_SAMPLES;
            for (let i = 0; i < FRAME_SAMPLES; i++) out[base + i] = clamp16(acc[i]);
            this.frames.delete(key);
        }
        this.nextFrame = end;
        this.framesWritten += count;
        this.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
        return count;
    }

    /** Called on a timer: write everything older than the jitter window. */
    flushRealtime(nowSample) {
        return this.flushUntil(Math.floor(nowSample / FRAME_SAMPLES) - this.lagFrames);
    }

    /** End of recording: write everything up to `endSample` (and any audio placed after it). */
    finish(endSample) {
        return this.flushUntil(Math.max(Math.ceil(endSample / FRAME_SAMPLES), this.maxFrame + 1));
    }

    get writtenMs() {
        return this.framesWritten * 20;
    }
}
