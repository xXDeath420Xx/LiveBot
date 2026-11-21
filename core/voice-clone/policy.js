/*
 * Where a cloned voice may speak.
 *
 * 2026-11-20: viewer text was never spoken in a cloned voice. 2026-11-21 (owner decision): that blanket rule became a
 * VOICE-OWNER OPT-IN, off by default:
 *
 *   Always allowed      the voice owner's own automation ("Speak text on stream", voice "My own voice") with fixed text;
 *                       the voice owner's own messages read by the Discord channel reader; the owner's own preview.
 *   With the opt-in     (features.viewerText.on, set only by the voice's owner or a super-admin, recorded with who and
 *                       when): other people's text in the voice owner's OWN places only - their stream bot profile's
 *                       !tts / Speak text with variables / alert read-aloud, and the channel reader in Discord servers
 *                       the voice owner owns or manages. Never in anyone else's profile or server.
 *   Never               bot replies; any place not listed here.
 *   "I said"            the channel reader says "I said" instead of "<name> says" when it reads the voice owner's own
 *                       message in their own voice: per-voice toggle features.iSaid.on, which defaults to the opt-in.
 *
 *   isOwnVoice(v) · hasTemplateVars(text) · viewerTextOn(features) · iSaidOn(features)
 *   ownVoiceStepError(step) → string | null              only an empty step is refused at save time now
 *   mayUseOwnVoice({ feature, text, profileOwnerId, voiceOwnerId, viewerTextAllowed }) → { ok, reason }
 *   readerVoiceAllowed({ voiceOwnerId, authorId, viewerTextAllowed, ownerManagesGuild }) → bool
 *   withOwnVoiceOption(catalog, enabled) → catalog
 * Pure; tested in tests/voice-clone.test.js.
 */
import { OWN_VOICE_ID } from './constants.js';

export const FEATURES = Object.freeze({ AUTOMATION: 'automation', PREVIEW: 'preview' });
/** Places where other people's text can be spoken: allowed only with the voice owner's opt-in, in their own places. */
export const VIEWER_TEXT_FEATURES = Object.freeze(['viewer_tts', 'alert', 'chat_reader', 'media_default']);
/** Never, opt-in or not. */
export const NEVER_FEATURES = Object.freeze(['bot_reply']);

export const isOwnVoice = (v) => String(v || '') === OWN_VOICE_ID;
export const hasTemplateVars = (text) => /[{}]/.test(String(text ?? ''));
export const viewerTextOn = (features) => features?.viewerText?.on === true;
export function iSaidOn(features) {
    const v = features?.iSaid?.on;
    return v === true || v === false ? v : viewerTextOn(features);
}

export const OWN_VOICE_TEMPLATE_ERROR = '"My own voice" reads variables such as {message} only when you have allowed your voice for other people\'s messages on the Your voice page; otherwise it reads the text with your default voice.';

export function ownVoiceStepError(step) {
    if (!isOwnVoice(step?.voice)) return null;
    if (!String(step?.text ?? '').trim()) return 'enter what your voice should say.';
    return null;
}

export function mayUseOwnVoice({ feature, text, profileOwnerId, voiceOwnerId, viewerTextAllowed = false } = {}) {
    if (NEVER_FEATURES.includes(feature)) return { ok: false, reason: 'a cloned voice never speaks bot replies' };
    const known = feature === FEATURES.AUTOMATION || feature === FEATURES.PREVIEW || VIEWER_TEXT_FEATURES.includes(feature);
    if (!known) return { ok: false, reason: 'not a place this voice may speak' };
    if (!voiceOwnerId || String(profileOwnerId || '') !== String(voiceOwnerId)) return { ok: false, reason: 'only the voice\'s owner can use it, in their own places' };
    const viewerText = VIEWER_TEXT_FEATURES.includes(feature) || (feature === FEATURES.AUTOMATION && hasTemplateVars(text));
    if (viewerText && viewerTextAllowed !== true) return { ok: false, reason: 'the voice\'s owner has not allowed it for other people\'s messages' };
    return { ok: true, reason: null };
}

/** The Discord channel reader: may it read this author's message in this owner's voice? */
export function readerVoiceAllowed({ voiceOwnerId, authorId, viewerTextAllowed = false, ownerManagesGuild = false } = {}) {
    if (!voiceOwnerId) return true;   // a stock voice
    if (String(authorId) === String(voiceOwnerId)) return true;
    return viewerTextAllowed === true && ownerManagesGuild === true;
}

export const OWN_VOICE_LABEL = 'My own voice';

export function withOwnVoiceOption(catalog, enabled) {
    if (!enabled || !catalog?.actions) return catalog;
    return {
        ...catalog,
        actions: catalog.actions.map((a) => {
            if (a?.type !== 'tts.say') return a;
            return {
                ...a,
                fields: (a.fields || []).map((f) => (f?.name !== 'voice' ? f : {
                    ...f,
                    options: [...(f.options || []).filter((o) => o !== OWN_VOICE_ID), OWN_VOICE_ID],
                    optionLabels: { ...(f.optionLabels || {}), [OWN_VOICE_ID]: OWN_VOICE_LABEL },
                })),
            };
        }),
    };
}

export default { FEATURES, VIEWER_TEXT_FEATURES, NEVER_FEATURES, isOwnVoice, hasTemplateVars, viewerTextOn, iSaidOn, ownVoiceStepError, mayUseOwnVoice, readerVoiceAllowed, withOwnVoiceOption, OWN_VOICE_TEMPLATE_ERROR, OWN_VOICE_LABEL };
