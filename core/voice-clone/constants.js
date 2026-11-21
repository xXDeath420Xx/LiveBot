/*
 * Own-voice feature (voice cloning, invite-only): fixed limits and lists. Pure data.
 *
 * Owner decisions of 2026-11-20 (they override docs voice-cloning-design.md where they differ):
 *   - permanently invite-only: only Discord accounts the owner adds on /super-admin/voice can use it, no self sign-up;
 *   - 18+ by self-declaration; United States only, Illinois and Texas blocked (declared state at consent);
 *   - one voice per person, 500 voices in all; nothing is ever charged (capacity limits only);
 *   - viewer text (!tts, alert messages) is never spoken in a cloned voice: only the voice owner's own automations,
 *     with fixed text the owner typed (core/voice-clone/policy.js);
 *   - training on the owner's PC only, 02:00-14:00 Pacific, at most 4 GPU-hours a day, never while the owner is live
 *     (the cf_quiet query), gaming or under GPU / Ollama load; the PC worker encrypts each job's workspace with its own
 *     in-memory key and refuses to run without its owner-only scratch folders (windows/voice-worker; this replaced the
 *     BitLocker requirement on 2026-11-21).
 */
import path from 'node:path';
import os from 'node:os';

export const STATUS = Object.freeze({
    DRAFT: 'draft',                 // consent signed, live check not passed yet
    CONSENT_OK: 'consent_ok',       // live check passed: recording
    QUEUED: 'queued',
    TRAINING: 'training',
    REVIEW: 'review',               // trained; the voice's owner and the CertiFried owner both have to approve it
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    DELETED: 'deleted',             // tombstone: no files, no keys, no voiceprint
});
export const STATUSES = Object.freeze(Object.values(STATUS));

export const JOB_STATE = Object.freeze({
    QUEUED: 'queued', LEASED: 'leased', RUNNING: 'running', PAUSED: 'paused', UPLOADING: 'uploading',
    CHECKING: 'checking', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled',
});
export const JOB_STATES = Object.freeze(Object.values(JOB_STATE));
export const OPEN_JOB_STATES = Object.freeze(['queued', 'leased', 'running', 'paused', 'uploading', 'checking']);

export const LIMITS = Object.freeze({
    voicesPerUser: 1,
    voicesTotal: 500,
    consentAttemptsPerDay: 5,
    consentLockoutAfterFails: 3,       // in a row: 24 h lockout
    challengeTtlMs: 120_000,
    challengeStartWithinMs: 10_000,    // recording must start within 10 s of the sentence showing (client enforces; server checks the 120 s)
    clipMaxBytes: 4 * 1024 * 1024,     // one recorded take (Opus/WebM from the browser)
    clipMaxSeconds: 30,
    clipMinSeconds: 1.2,
    minTrainingMinutes: 15,
    maxTrainingMinutes: 60,
    trainingRunsPer30Days: 3,
    utteranceChars: 300,
    charsPerDay: 20_000,
    audioMsPerDay: 30 * 60_000,
    requestsPerMinute: 60,
    maxWer: 0.20,                      // consent sentences
    maxSampleWer: 0.35,                // script takes (Whisper small.en on a phone mic is not perfect)
    sampleRetentionDays: 30,           // hard cap from upload, whatever the state
    samplePurgeAfterTrainingDays: 7,
    voiceIdleDays: 365,
    deletionBackupDays: 7,             // backup copies age out within this
    leaseMs: 120_000,
    maxJobAttempts: 3,
    trainSteps: 3000,
});

export const GPU_WINDOW = Object.freeze({ tz: 'America/Los_Angeles', startHour: 2, endHour: 14, maxSecondsPerDay: 4 * 3600 });

/** The LibriTTS-R medium Piper checkpoint (CC BY 4.0) every voice is fine-tuned from; SHA-256 of best.ckpt. */
export const BASE_MODEL = Object.freeze({
    name: 'rhasspy/piper-checkpoints en/en_US/libritts_r/medium/best.ckpt',
    url: 'https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/en/en_US/libritts_r/medium/best.ckpt',
    sha256: 'e0f93367abeb352bdc2190415a8b8a98f6128cfc0f549407aa80aca80bcbc1af',
    bytes: 933457381,
    licence: 'CC BY 4.0 (LibriTTS-R, Koizumi et al. 2023; Piper checkpoint by rhasspy)',
});

/** US states and DC for the residence question. IL and TX are listed but blocked. */
export const US_STATES = Object.freeze([
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
    ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
    ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
    ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
    ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
    ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
    ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
]);
export const BLOCKED_STATES = Object.freeze(['IL', 'TX']);
export const BLOCKED_STATE_REASON = Object.freeze({
    IL: 'Your voice is not available to people who live in Illinois.',
    TX: 'Your voice is not available to people who live in Texas.',
});

/** The reserved voice value of "Speak text on stream" for the owner's own voice (never in a shared voice list). */
export const OWN_VOICE_ID = 'myvoice';

export const DATA_DIR = process.env.VOICE_DATA_DIR || path.join(os.homedir(), 'certifried-data', 'voice');
export const SHM_DIR = process.env.VOICE_SHM_DIR || '/dev/shm/certifried-voice';
export const SIDECAR_SOCKET = process.env.VOICE_SIDECAR_SOCKET || path.join(DATA_DIR, 'run', 'sidecar.sock');
export const WORKER_API_PORT = Number(process.env.VOICE_WORKER_API_PORT || 4650);
export const ASR_URL = process.env.VOICE_ASR_URL || 'http://127.0.0.1:8179/inference';   // whisper-accurate (small.en), loopback

export default {
    STATUS, STATUSES, JOB_STATE, JOB_STATES, OPEN_JOB_STATES, LIMITS, GPU_WINDOW, BASE_MODEL, US_STATES, BLOCKED_STATES, BLOCKED_STATE_REASON,
    OWN_VOICE_ID, DATA_DIR, SHM_DIR, SIDECAR_SOCKET, WORKER_API_PORT, ASR_URL,
};
