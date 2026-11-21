/*
 * Speaking in a person's own voice (design 5.5), with every rule checked on every call:
 *
 *   policy (core/voice-clone/policy.js)  the owner's own automation and preview; other people's text only with the
 *                                       owner's opt-in (features.viewerText), in the owner's own profile
 *   status                              read from the database each time: a deleted or suspended voice stops at once
 *   limits                              300 characters a line, 20,000 characters and 30 minutes of audio a day,
 *                                       60 lines a minute; 4 renders at once across the server
 *   watermark                           every clip gets the voice's AudioSeal mark before it leaves; if the sidecar
 *                                       cannot mark it, nothing is played (fail closed)
 *
 *   createOwnVoiceSynth({ service, store, files, sidecar, piper, logger })
 *     .synthesize(ownerUserId, text, { feature, profileOwnerId }) → { wav: Buffer, durationMs }   (throws VoiceError)
 *     .available(ownerUserId, feature) → bool         an active voice with that use switched on
 *     .stop()
 * The decrypted model lives only in /dev/shm (mode 0600) while in use, and is removed after 15 minutes idle, on delete
 * and on suspend (service.onEvict).
 */
import fs from 'node:fs/promises';
import { STATUS, LIMITS } from './constants.js';
import { mayUseOwnVoice, FEATURES, viewerTextOn } from './policy.js';
import { tuningFor, VoiceError } from './service.js';
import { wavInfo } from './audio.js';
import * as vcrypto from './crypto.js';

const IDLE_MS = 15 * 60_000;

export function createOwnVoiceSynth({ service, store, files, sidecar, piper, logger = null, now = () => Date.now() } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[VoiceClone] ${msg}`, meta); } catch { /* ignore */ } };
    const warm = new Map();      // voiceId -> { path, sha, lastUse }
    const perMinute = new Map(); // voiceId -> [timestamps]
    let running = 0;

    async function dropVoice(voiceId) {
        const w = warm.get(voiceId);
        warm.delete(voiceId);
        if (w?.path) { try { piper.stop(w.path); } catch { /* not running */ } }
        await files.wipeShm(voiceId).catch(() => 0);
    }
    service.onEvict(dropVoice);

    const timer = setInterval(() => {
        for (const [id, w] of warm) if (now() - w.lastUse > IDLE_MS) dropVoice(id).catch(() => {});
    }, 60_000);
    timer.unref?.();

    function usable(v, feature) {
        if (!v) return false;
        if (feature === FEATURES.PREVIEW) return v.status === STATUS.REVIEW || v.status === STATUS.ACTIVE;
        return v.status === STATUS.ACTIVE && !!v.features?.automations;
    }

    async function available(ownerUserId, feature = FEATURES.AUTOMATION) {
        try { return usable(await store.liveVoiceOf(String(ownerUserId)), feature); } catch { return false; }
    }
    /** The voice owner allowed other people's text in their own places (features.viewerText, opt-in). */
    async function allowsViewerText(ownerUserId) {
        try { const v = await store.liveVoiceOf(String(ownerUserId)); return usable(v, FEATURES.AUTOMATION) && viewerTextOn(v.features); } catch { return false; }
    }

    async function modelPath(v) {
        const w = warm.get(v.id);
        if (w && w.sha === v.model_sha256) {
            try { await fs.access(w.path); w.lastUse = now(); return w.path; } catch { /* wiped: decrypt again */ }
        }
        if (w) await dropVoice(v.id);
        if (!v.model_sha256 || !v.model_json) throw new VoiceError('This voice has no trained model.', 409, { code: 'unavailable' });
        const key = service.dataKey(v);
        const onnx = vcrypto.open(await files.readModel(v.id, v.model_sha256), key, v.id);
        if (vcrypto.sha256(onnx) !== v.model_sha256) throw new VoiceError('The voice model failed its integrity check.', 500, { code: 'unavailable' });
        const p = await files.shmModel(v.id, v.model_sha256, onnx, v.model_json);
        warm.set(v.id, { path: p, sha: v.model_sha256, lastUse: now() });
        return p;
    }

    async function synthesize(ownerUserId, text, { feature = FEATURES.AUTOMATION, profileOwnerId = null } = {}) {
        const owner = String(ownerUserId || '');
        const words = String(text ?? '').replace(/\s+/g, ' ').trim();
        const v = await store.liveVoiceOf(owner);
        const gate = mayUseOwnVoice({ feature, text: words, profileOwnerId: profileOwnerId ?? owner, voiceOwnerId: v?.owner_user_id, viewerTextAllowed: viewerTextOn(v?.features) });
        if (!gate.ok) throw new VoiceError(`Your voice cannot speak here: ${gate.reason}.`, 403, { code: 'policy' });
        if (!usable(v, feature)) throw new VoiceError('Your voice is not active, or not switched on for automations.', 409, { code: 'unavailable' });
        if (!words) throw new VoiceError('Nothing to say.', 400);
        if (words.length > LIMITS.utteranceChars) throw new VoiceError(`Your voice reads at most ${LIMITS.utteranceChars} characters at a time.`, 400);
        const t = now();
        const recent = (perMinute.get(v.id) || []).filter((x) => t - x < 60_000);
        if (recent.length >= LIMITS.requestsPerMinute) throw new VoiceError('Your voice is speaking too often (60 lines a minute at most).', 429, { code: 'limit' });
        const day = new Date(t).toISOString().slice(0, 10);
        const used = await store.usageOn(owner, day);
        if (Number(used.chars) + words.length > LIMITS.charsPerDay || Number(used.audio_ms) >= LIMITS.audioMsPerDay) {
            throw new VoiceError('Your voice has spoken its daily limit (20,000 characters or 30 minutes). It carries on tomorrow.', 429, { code: 'limit' });
        }
        if (running >= 4) throw new VoiceError('Too many voices are speaking right now. Try again in a moment.', 429, { code: 'busy' });
        running++;
        recent.push(t);
        perMinute.set(v.id, recent);
        let file = null;
        try {
            const p = await modelPath(v);
            const tuning = tuningFor(v.tuning || {});
            file = await piper.speak(words, p, { lengthScale: tuning.lengthScale, noiseScale: tuning.noiseScale, noiseW: tuning.noiseW });
            const raw = await fs.readFile(file);
            let marked;
            try { marked = await sidecar.watermark(raw, v.wm_id); } catch (err) {
                log('warn', 'watermark failed; not playing the clip', { voiceId: v.id, error: err?.message });
                throw new VoiceError('Your voice could not be watermarked, so it was not played.', 503, { code: 'unavailable' });
            }
            const info = wavInfo(marked);
            if (!info) throw new VoiceError('Your voice produced no audio.', 500, { code: 'unavailable' });
            // re-read the status after rendering: a delete during the render must not play
            const again = await store.voiceById(v.id);
            if (!usable(again, feature)) throw new VoiceError('Your voice was switched off while it was speaking.', 409, { code: 'unavailable' });
            await store.addUsage(owner, day, words.length, info.durationMs);
            if (!v.last_used_at || t - new Date(v.last_used_at).getTime() > 60_000) await store.updateVoice(v.id, { last_used_at: 'NOW()' });
            return { wav: marked, durationMs: info.durationMs };
        } finally {
            running--;
            if (file) fs.unlink(file).catch(() => {});
        }
    }

    return { synthesize, available, allowsViewerText, dropVoice, stop: () => clearInterval(timer), _warm: warm };
}

export default { createOwnVoiceSynth };
