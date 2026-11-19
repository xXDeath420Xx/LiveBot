/*
 * Stream bot music: the settings a streamer edits on the Music page (stored in the profile's settings JSON under
 * `music`, next to `studio` and `sounds`; no table). Pure.
 *
 *   DEFAULTS            what a new profile starts with
 *   OWNER_PRESET        the values the owner's Streamer.bot extension and "SR Gate" action used
 *   withDefaults(raw)   stored value → complete settings (unknown keys dropped, bad values replaced)
 *   validateSettings(input) → { ok, errors[], value }   a dashboard save (messages and limits included)
 *
 * The overlay key lives under music.overlay ({ keyEnc, keyHash, createdAt }) and is never part of a save.
 * Tested in tests/stream-bot-music.test.js.
 */
import { DEFAULT_MESSAGES, MESSAGE_KEYS } from './text.js';

export const APPROVAL_MODES = Object.freeze(['none', 'explicit', 'explicit_or_unknown', 'all']);
export const SOURCES = Object.freeze(['spotify', 'youtube', 'soundcloud', 'links', 'search', 'playlists']);
export const SOURCE_LABEL = Object.freeze({
    spotify: 'Spotify links', youtube: 'YouTube and YouTube Music links', soundcloud: 'SoundCloud links',
    links: 'Links from other sites', search: 'Song names (search)', playlists: 'Songs from your playlists',
});
const ROLE_SET = new Set(['broadcaster', 'moderator', 'vip', 'subscriber']);

export const LIMITS = Object.freeze({
    maxPerUser: [1, 100], maxQueue: [1, 500], maxDurationSec: [30, 3600], voteSkip: [1, 100], volume: [0, 100], message: 300,
});

export const DEFAULTS = Object.freeze({
    open: true,
    approval: 'none',
    approvalBypass: ['broadcaster', 'moderator'],
    allowExplicit: true,
    maxPerUser: 5,
    maxQueue: 50,
    maxDurationSec: 600,
    allowDuplicates: false,
    limitBypass: ['broadcaster', 'moderator'],
    voteSkip: 5,
    skipOwn: true,
    removeOwn: true,
    sources: ['spotify', 'youtube', 'soundcloud', 'search', 'playlists'],
    volume: 70,
    fallbackPlaylistId: null,
    defaultPlaylistId: null,
    card: true,
    mention: true,
    spotifyDirect: false,
    messages: {},
});

/** From the owner's Streamer.bot setup: 5 per viewer, 10 minutes, no duplicates, 10 votes, explicit or unrated songs wait for a mod. */
export const OWNER_PRESET = Object.freeze({ approval: 'explicit_or_unknown', maxPerUser: 5, maxDurationSec: 600, allowDuplicates: false, voteSkip: 10, allowExplicit: true, skipOwn: true, removeOwn: true });

const int = (v, [lo, hi], d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, n)) : d;
};
const bool = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
const roles = (v, d) => (Array.isArray(v) ? [...new Set(v.filter((r) => ROLE_SET.has(r)))] : d);
const idOrNull = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);

/** Stored value → complete settings. */
export function withDefaults(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = {
        open: bool(r.open, DEFAULTS.open),
        approval: APPROVAL_MODES.includes(r.approval) ? r.approval : DEFAULTS.approval,
        approvalBypass: roles(r.approvalBypass, [...DEFAULTS.approvalBypass]),
        allowExplicit: bool(r.allowExplicit, DEFAULTS.allowExplicit),
        maxPerUser: int(r.maxPerUser, LIMITS.maxPerUser, DEFAULTS.maxPerUser),
        maxQueue: int(r.maxQueue, LIMITS.maxQueue, DEFAULTS.maxQueue),
        maxDurationSec: int(r.maxDurationSec, LIMITS.maxDurationSec, DEFAULTS.maxDurationSec),
        allowDuplicates: bool(r.allowDuplicates, DEFAULTS.allowDuplicates),
        limitBypass: roles(r.limitBypass, [...DEFAULTS.limitBypass]),
        voteSkip: int(r.voteSkip, LIMITS.voteSkip, DEFAULTS.voteSkip),
        skipOwn: bool(r.skipOwn, DEFAULTS.skipOwn),
        removeOwn: bool(r.removeOwn, DEFAULTS.removeOwn),
        sources: Array.isArray(r.sources) ? SOURCES.filter((s) => r.sources.includes(s)) : [...DEFAULTS.sources],
        volume: int(r.volume, LIMITS.volume, DEFAULTS.volume),
        fallbackPlaylistId: idOrNull(r.fallbackPlaylistId),
        defaultPlaylistId: idOrNull(r.defaultPlaylistId),
        card: bool(r.card, DEFAULTS.card),
        mention: bool(r.mention, DEFAULTS.mention),
        spotifyDirect: bool(r.spotifyDirect, DEFAULTS.spotifyDirect),
        messages: {},
    };
    if (r.messages && typeof r.messages === 'object') {
        for (const k of MESSAGE_KEYS) {
            const t = r.messages[k];
            if (typeof t === 'string' && t.trim() && t.trim() !== DEFAULT_MESSAGES[k]) out.messages[k] = t.trim().slice(0, LIMITS.message);
        }
    }
    return out;
}

/** A save from the Music page. Errors name the field in plain words. */
export function validateSettings(input = {}) {
    const errors = [];
    const s = input && typeof input === 'object' ? input : {};
    const check = (key, [lo, hi], label) => {
        if (s[key] === undefined) return;
        const n = Number(s[key]);
        if (!Number.isFinite(n) || String(s[key]).trim() === '' || n < lo || n > hi) errors.push(`${label}: a number from ${lo} to ${hi}.`);
    };
    check('maxPerUser', LIMITS.maxPerUser, 'Songs per viewer');
    check('maxQueue', LIMITS.maxQueue, 'Songs in the queue');
    check('maxDurationSec', LIMITS.maxDurationSec, 'Longest song (seconds)');
    check('voteSkip', LIMITS.voteSkip, 'Votes to skip');
    check('volume', LIMITS.volume, 'Volume');
    if (s.approval !== undefined && !APPROVAL_MODES.includes(s.approval)) errors.push('Approval: pick one of the options.');
    if (s.sources !== undefined && (!Array.isArray(s.sources) || !s.sources.some((x) => SOURCES.includes(x)))) errors.push('Allowed sources: tick at least one.');
    if (s.messages && typeof s.messages === 'object') {
        for (const [k, v] of Object.entries(s.messages)) {
            if (!MESSAGE_KEYS.includes(k)) continue;
            if (typeof v === 'string' && v.length > LIMITS.message) errors.push(`Reply "${k}": at most ${LIMITS.message} characters.`);
        }
    }
    return { ok: !errors.length, errors, value: withDefaults(s) };
}

/** The reply text for a key, with the streamer's own wording when they set one. */
export const messageFor = (settings, key) => settings?.messages?.[key] || DEFAULT_MESSAGES[key] || '';

export default { DEFAULTS, OWNER_PRESET, APPROVAL_MODES, SOURCES, SOURCE_LABEL, LIMITS, withDefaults, validateSettings, messageFor };
