/*
 * Who may use the own-voice feature, and whether a consent form is complete. Pure (no I/O); tested in
 * tests/voice-clone.test.js.
 *
 *   inviteGate(invite)                         → { ok, reason }   an invite row that is not revoked
 *   regionGate({ state, country, cfCountry, cfRegion })  → { ok, reason, code }
 *                                              declared state must be a US state or DC and not IL or TX; a Cloudflare
 *                                              country other than US, or a Cloudflare region of IL / TX, also blocks
 *   validateConsentForm(body)                  → { ok, errors, value: { typedName, state, ageAttested, keepSamples } }
 *   consentGate({ invite, consent, voice })    → { ok, reason }   a signed, verified, unrevoked consent for this voice
 */
import { US_STATES, BLOCKED_STATES, BLOCKED_STATE_REASON } from './constants.js';
import { CONSENT_VERSION } from './consent-text.js';

const STATE_CODES = new Set(US_STATES.map(([c]) => c));

export function inviteGate(invite) {
    if (!invite) return { ok: false, reason: 'Your voice is invite-only, and this account has not been invited.' };
    if (invite.revoked_at || invite.revokedAt) return { ok: false, reason: 'Your invite to Your voice was withdrawn.' };
    return { ok: true, reason: null };
}

export function regionGate({ state, cfCountry = null, cfRegion = null } = {}) {
    const s = String(state || '').toUpperCase();
    if (!STATE_CODES.has(s)) return { ok: false, code: 'state', reason: 'Choose the US state you live in. Your voice is only available in the United States.' };
    if (BLOCKED_STATES.includes(s)) return { ok: false, code: 'blocked_state', reason: BLOCKED_STATE_REASON[s] };
    const cc = String(cfCountry || '').toUpperCase();
    if (cc && cc !== 'XX' && cc !== 'US') {   // T1 (Tor) blocks too: the location cannot be known
        return { ok: false, code: 'country', reason: 'Your voice is only available in the United States, and this connection is from outside it.' };
    }
    const r = String(cfRegion || '').toUpperCase();
    if (cc === 'US' && BLOCKED_STATES.includes(r)) return { ok: false, code: 'blocked_region', reason: BLOCKED_STATE_REASON[r] };
    return { ok: true, code: null, reason: null };
}

export function validateConsentForm(body = {}) {
    const errors = [];
    const typedName = String(body.typedName ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (typedName.length < 3 || !/\p{L}/u.test(typedName)) errors.push('Type your full name to sign.');
    if (body.agree !== true) errors.push('Tick "I have read this and I agree".');
    if (body.ageAttested !== true) errors.push('Tick "I am 18 or older". This feature is for adults only.');
    if (body.ownVoice !== true) errors.push('Tick "This is my own voice, and only I speak in my recordings".');
    if (body.textVersion !== CONSENT_VERSION) errors.push('The consent text changed while this page was open. Reload the page and read it again.');
    const state = String(body.state || '').toUpperCase();
    if (!STATE_CODES.has(state)) errors.push('Choose the US state you live in.');
    return { ok: errors.length === 0, errors, value: { typedName, state, ageAttested: body.ageAttested === true, keepSamples: body.keepSamples === true } };
}

export function consentGate({ invite, consent, voice } = {}) {
    const inv = inviteGate(invite);
    if (!inv.ok) return inv;
    if (!consent) return { ok: false, reason: 'Sign the consent first.' };
    if (consent.revoked_at) return { ok: false, reason: 'You withdrew your consent, so this voice cannot be used.' };
    if (!consent.verified_at) return { ok: false, reason: 'Finish the live check first.' };
    if (voice && String(consent.voice_id) !== String(voice.id)) return { ok: false, reason: 'This consent belongs to another voice.' };
    if (voice && String(consent.user_id) !== String(voice.owner_user_id)) return { ok: false, reason: 'This consent belongs to someone else.' };
    return { ok: true, reason: null };
}

export default { inviteGate, regionGate, validateConsentForm, consentGate };
