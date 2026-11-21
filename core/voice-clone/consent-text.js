/*
 * The consent a person signs before CertiFried records their voice (own-voice feature, invite-only).
 *
 * Written to carry, in plain words:
 *   - Washington RCW 19.375 (HB 1493, 2017), biometric identifiers: notice that a voiceprint is enrolled, what for, and
 *     consent before it is enrolled; no sale, lease or disclosure; reasonable care against unauthorised access; kept no
 *     longer than needed for the purpose.
 *   - Washington My Health My Data Act, RCW 19.373: what consumer health data is collected (biometric data: voice
 *     recordings and the voiceprint made from them), the specific purpose, where it comes from, that it is shared with
 *     nobody, opt-in consent for this purpose only, and the right to see, delete and withdraw consent, with the link to
 *     the Consumer Health Data Privacy Policy (/legal/voice#health-data).
 * Not reviewed by a lawyer (owner decision 2026-11-20: no review, so the feature stays invite-only and takes the
 * strictest reading). A change to the text needs a new VERSION: earlier signatures keep the text they signed
 * (voice_clone_consents.text_version and text_sha256), and the new text is shown to everyone who signs after it.
 */
import crypto from 'node:crypto';

// v2-2026-11-21: the training computer protects recordings with per-run encryption instead of BitLocker (owner decision).
// Nobody had signed v1.
export const CONSENT_VERSION = 'v2-2026-11-21';

export const CONSENT_SECTIONS = Object.freeze([
    { heading: 'What this is', paras: [
        'CertiFried can make a computer voice that sounds like you, from recordings of you reading sentences aloud. This feature is invite-only: you can use it because the CertiFried owner invited you. Please read all of this before you agree. Saying no changes nothing else on CertiFried.',
    ] },
    { heading: 'What we collect (biometric and health data)', paras: [
        'The recordings you make on these pages: three short live-check sentences and the script sentences you read.',
        'A voiceprint: two sets of numbers, made by speaker-recognition software from your recordings, that describe how your voice sounds. Under Washington law (RCW 19.375 and the My Health My Data Act, RCW 19.373) your voiceprint is a biometric identifier, and your recordings and voiceprint are consumer health data.',
        'The voice model trained from your recordings, which can speak in your voice.',
        'A record that you agreed: this text\'s version, the name you type, the state you live in, that you said you are 18 or older, the date and time, and a scrambled (hashed) form of your IP address. It holds no audio and no voiceprint.',
        'All of it comes from you, on these pages. We do not collect it from anyone else.',
    ] },
    { heading: 'What it is used for, and nothing else', paras: [
        '1. To train one voice that sounds like you. Only you can use it, and only in your own stream bot automations, speaking words you typed yourself. It is never used to read out your viewers\' messages (such as !tts or alert messages), and nobody else can pick it.',
        '2. To check that the recordings are of you and that the voice is not someone else\'s (the live check compares your voiceprint with each recording, and with the other voices on CertiFried).',
        '3. To mark every clip your voice says with an inaudible watermark, so a clip can be recognised as made by CertiFried.',
        'We never sell, rent, lease, trade or share your recordings, your voiceprint or your voice model with anyone, and we never use them to train any other voice or for advertising.',
    ] },
    { heading: 'Where it is kept and processed', paras: [
        'On CertiFried\'s server in Virginia, USA, encrypted (AES-256-GCM, with a key for your voice alone).',
        'Training happens on a computer run by CertiFried\'s operator in Washington state, USA. It receives your recordings only over an encrypted connection and keeps them encrypted (AES-256-GCM) with a key made for that one training run and held only in memory. They are unlocked only into a private folder that only the training program\'s user account can open, while the training program reads them, and that folder is wiped the moment training stops, ends or fails. Everything is deleted when the run ends.',
        'No other company processes your voice. Cloudflare carries the website traffic, as for the rest of CertiFried.',
    ] },
    { heading: 'How long we keep it', paras: [
        'Recordings: deleted 7 days after your voice is trained, unless you tick "Keep my recordings" below (so you can train again without re-recording). Never more than 30 days from when you made them, whatever you choose.',
        'Your voiceprint and voice model: until you delete them, or 1 year after the voice was last used, whichever comes first.',
        'Deleting is immediate: the voice stops working at once and the files are removed within minutes. Encrypted copies in our backups expire within 7 days.',
        'The record that you agreed (no audio, no voiceprint) is kept for 5 years after your voice is deleted, as proof of consent.',
        'The full schedule and our Consumer Health Data Privacy Policy are at /legal/voice.',
    ] },
    { heading: 'Your rights', paras: [
        'You can see what we hold (Your voice page, and /privacy export), delete your voice and recordings, and withdraw this consent at any time on the Your voice page. Withdrawing consent deletes the voice, the recordings and the voiceprint, the same as Delete.',
        'Questions or requests: support@certifriedmultitool.com.',
    ] },
    { heading: 'Who can use this', paras: [
        'You must be 18 or older and live in the United States. It is not available to people who live in Illinois or Texas.',
        'You confirm that this is your own voice and that only you speak in the recordings you make here.',
    ] },
]);

/** The text as one string (what the hash covers). */
export function consentPlainText() {
    return [`CertiFried own-voice consent, ${CONSENT_VERSION}`, ...CONSENT_SECTIONS.flatMap((s) => [s.heading, ...s.paras])].join('\n');
}

export const CONSENT_SHA256 = crypto.createHash('sha256').update(consentPlainText(), 'utf8').digest('hex');

export default { CONSENT_VERSION, CONSENT_SECTIONS, CONSENT_SHA256, consentPlainText };
