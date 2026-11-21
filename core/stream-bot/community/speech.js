/*
 * Stream bot text to speech (W2.7; design §15): what may be read aloud, and in which voice.
 *
 *   maskProfanity(text, { extra, enabled }) → text   words on the built-in list (and the streamer's own) become "bleep";
 *                                                     matched the way Filtered words matches (core/word-filter-logic.js:
 *                                                     lookalike letters, leetspeak, stretched letters, wildcards)
 *   speakable(text, maxChars) → text                 links read as "a link", markup and brackets dropped, length capped
 *   prepareSpeech(text, { mask, words, maxChars })   both, in that order (also used for alert read-aloud, overlays/index.js)
 *   ttsVoices(ownerDiscordId) → [{ value, label }]   the English Piper and Kokoro voices on this server. A custom voice
 *                                                     trained from a real person (its .onnx.json "certifried.ownerId",
 *                                                     memory reference_certifried_custom_piper_voices) is offered only to
 *                                                     that person's own profile, and only after they allowed it for other
 *                                                     people's text (ownVoiceViewerText; owner decision 2026-11-21).
 *   voiceAllowed(voice, ownerDiscordId) → bool
 *   speechSynthesizer(logger) → (text, voice) → WAV bytes   Piper on this server
 *
 * The built-in list is kept rot13-encoded so the source does not spell slurs out (the same habit as
 * core/word-filter-logic.js). Pure apart from ttsVoices / voiceAllowed, which read utils/piper-tts.js.
 * Tested in tests/stream-bot-community.test.js.
 */
import fs from 'node:fs/promises';
import { compileFilter, findEntry } from '../../word-filter-logic.js';

const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const BUILT_IN_ROT13 = Object.freeze(['*shpx*', 'fuvg*', 'ohyyfuvg*', 'phag*', 'ovgpu*', 'onfgneq*', 'nffubyr*', 'qvpx', 'qvpxf', 'qvpxurnq*', 'pbpx', 'pbpxf',
    'chffl', 'chffvrf', 'gjng*', 'jnax*', 'juber*', 'fyhg*', '*avtt*', 'snt', 'sntf', 'snttbg*', 'ergneq*', 'xvxr*', 'fcvp', 'fcvpf', 'puvax*', 'genaal*',
    'qlxr*', 'encr', 'encrq', 'encvat', 'encvfg*']);
export const BUILT_IN_COUNT = BUILT_IN_ROT13.length;
const BUILT_IN = compileFilter(BUILT_IN_ROT13.map(rot13));
const cache = new Map();   // joined extra words -> compiled filter

function filterFor(extra) {
    const list = (extra || []).filter(Boolean);
    if (!list.length) return null;
    const k = list.join('\n');
    if (!cache.has(k)) { if (cache.size > 200) cache.clear(); cache.set(k, compileFilter(list)); }
    return cache.get(k);
}

/** Replace masked words with "bleep". Tokens keep their spacing; punctuation stuck to a word goes with it. */
export function maskProfanity(text, { extra = [], enabled = true } = {}) {
    const s = String(text ?? '');
    if (!enabled || !s) return s;
    const own = filterFor(extra);
    return s.replace(/\S+/g, (tok) => (findEntry(tok, BUILT_IN) || (own && findEntry(tok, own)) ? 'bleep' : tok));
}

export function speakable(text, maxChars = 200) {
    return String(text ?? '')
        .replace(/https?:\/\/\S+/gi, 'a link')
        .replace(/<[^<>]{0,40}>/g, ' ')
        .replace(/[<>{}[\]\\|`~^_*#]/g, ' ')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, Math.max(1, Number(maxChars) || 200));
}

export function prepareSpeech(text, { mask = true, words = [], maxChars = 200 } = {}) {
    return speakable(maskProfanity(speakable(text, 1000), { extra: words, enabled: mask }), maxChars);
}

let piper = null;
async function piperModule() {
    piper ||= await import('../../../utils/piper-tts.js');
    return piper;
}

/**
 * A voice trained from a real person (ownerId) reads text here (viewer text: !tts, alerts) only in that person's own
 * profile and only after they opted in (core/voice-clone, features.viewerText; owner decision 2026-11-21).
 */
export async function ownVoiceViewerText(voice, voiceOwnerId, profileOwnerId) {
    if (!profileOwnerId || String(profileOwnerId) !== String(voiceOwnerId)) return false;
    try {
        const vc = await (await import('../../voice-clone/index.js')).getVoiceClone();
        const r = vc?.legacy ? await vc.legacy.rulesFor(voice) : null;
        return !!(r && r.viewerText && String(r.ownerUserId) === String(voiceOwnerId) && !['suspended', 'deleted'].includes(r.status));
    } catch { return false; }
}

/** The English voices (Piper and Kokoro) this server has, without other people's custom voices. */
export async function ttsVoices(ownerDiscordId = null) {
    try {
        const m = await piperModule();
        const groups = (m.getVoiceOptions?.() || []).filter((g) => /English/.test(String(g?.label)));
        const out = [];
        for (const g of groups) {
            for (const v of g.voices || []) {
                const value = String(v.value);
                if (!/^[a-z0-9_-]{1,50}$/i.test(value)) continue;
                const info = m.getVoiceInfo?.(value) || null;
                if (info?.ownerId && !(await ownVoiceViewerText(value, info.ownerId, ownerDiscordId))) continue;   // a cloned voice: only its owner's profile, with their opt-in
                out.push({ value, label: `${v.label} · ${String(g.label).replace(/^(Piper|Kokoro) · /, '')}` });
            }
        }
        return out.slice(0, 120);
    } catch { return []; }
}

/** Read text aloud with Piper (utils/piper-tts.js) → WAV bytes, or null. The text is already prepared (prepareSpeech). */
export function speechSynthesizer(logger = null) {
    return async (text, voice) => {
        const m = await piperModule();
        const file = await m.synthesize(String(text).slice(0, 400), voice || 'ryan');
        if (!file) return null;
        try { return await fs.readFile(file); } finally { fs.unlink(file).catch(() => logger?.debug?.('[StreamBotSpeech] temp file left')); }
    };
}

export async function voiceAllowed(voice, ownerDiscordId = null) {
    if (!/^[a-z0-9_-]{1,50}$/i.test(String(voice || ''))) return false;
    try {
        const m = await piperModule();
        const info = m.getVoiceInfo?.(String(voice)) || null;
        if (!info) return false;
        return !info.ownerId || await ownVoiceViewerText(String(voice), info.ownerId, ownerDiscordId);   // see ttsVoices
    } catch { return false; }
}

export default { maskProfanity, speakable, prepareSpeech, ttsVoices, voiceAllowed, speechSynthesizer, BUILT_IN_COUNT };
