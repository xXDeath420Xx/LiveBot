/*
 * Avatar protection — the rules (pure: no Discord, no database, no sharp, so they are unit-tested in
 * tests/avatar-protection.test.js). The live side is core/avatar-protection.js; the image decoding
 * that produces the fingerprints scored here is avatarFingerprint() in core/image-fingerprint.js.
 *
 * WHY A DIFFERENT FINGERPRINT FROM THE SCAM-IMAGE BLOCKLIST. The blocklist's 64-bit dHash plus colour
 * grid is tuned for "is this the same screenshot", acting on a yes/no. Avatar protection needs a
 * SCORE (Hashbot's slider runs 0.70-1.00) and has to survive what impersonators actually do to a
 * staff avatar: re-upload it (Discord re-encodes to WebP), screenshot the round crop, zoom in a
 * little, mirror it. First measured on 783 real member avatars from four servers (306,153 unrelated pairs):
 *
 *   256-bit dHash (17x16)   unrelated pairs: 1 in 10,000 within 71 bits, 1 in 1,000 within 87
 *   re-encode WebP / JPEG   median 3-4 bits, 90th percentile 8-11
 *   5% crop / round crop    69 / 35 bits at the FULL frame — which is why every protected image is
 *                           also stored zoomed in 3%, 6%, 9% and 12%, and mirrored, and the member's
 *                           avatar is compared full-frame and zoomed 6% against every stored variant
 *
 * The score of one comparison is 0.8 x structure + 0.2 x colour, where structure = 1 - bits/100 and
 * colour = 1 - (mean RGB difference over a 4x4 grid)/40, both clamped to [0,1]; a pair's score is the
 * best over the variants. With the variants above, over 985 real avatars from six servers (484,620
 * unrelated pairs) the only pairs at 0.70 or more were 11 accounts using the identical picture (1.00);
 * the next closest unrelated pair scored 0.54. Edited copies of 80 real avatars: re-upload median 0.98
 * (10th percentile 0.92), hue shift 0.96, a 5% zoom 0.85, 8% padding 0.85, the round crop 0.84, a
 * mirror 1.00. Hence the defaults: review from 0.75, act from 0.90 — and the 0.70 floor of the slider
 * is still well clear of unrelated avatars.
 *
 * Flat images are refused, in both directions, exactly as the blocklist refuses them: a hash with
 * almost no bits set, or a near-uniform picture whose bits are only compression noise, matches
 * unrelated flat images. The ticket-scam kit's solid-black and fully-transparent avatars are exactly
 * that kind of image, so they are matched EXACTLY instead: canonicalHash() of the decoded pixels
 * (16x16 RGBA, channels quantised to 16 levels, invisible pixels zeroed), which survives Discord's
 * re-encoding and resizing but not a change of picture. The two built-in entries are generated here
 * from synthetic pixels, so no image files are needed.
 */
import crypto from 'node:crypto';
import { NAME_ACTIONS, normaliseNameAction } from './name-filter-logic.js';

export const AVATAR_ACTIONS = NAME_ACTIONS;
export { normaliseNameAction as normaliseAvatarAction };

export const MIN_THRESHOLD = 0.70;        // the slider's floor (as Hashbot's)
export const DEFAULT_AUTO = 0.90;         // act at or above
export const DEFAULT_REVIEW = 0.75;       // queue for review at or above
export const STRUCT_SCALE = 100;          // bits of 256-bit dHash difference that score structure 0
export const COLOUR_SCALE = 40;           // mean RGB difference that scores colour 0
export const STRUCT_WEIGHT = 0.8;
export const MIN_BITS = 24;               // 256-bit dHash popcount outside [24, 232]: degenerate
export const MAX_BITS = 232;
export const MIN_CONTRAST = 6;            // greyscale standard deviation below this: flat (bits are noise)
export const PROBE_VARIANTS = 2;          // a member's avatar: full frame and zoomed 6%
export const VARIANT_LABELS = Object.freeze(['full frame', 'zoomed 6%', 'zoomed 3%', 'zoomed 9%', 'zoomed 12%', 'mirrored', 'mirrored, zoomed 6%']);
export const SUPPRESS_SCORE = 0.97;       // "not a match" covers this avatar and near-identical re-uploads of it
export const MAX_SUPPRESS = 200;          // per protected image, oldest dropped first
export const MAX_PROTECTED = 500;         // protected images per server (manual + Auto-Pilot)
export const CANON_SIZE = 16;             // canonical pixels are CANON_SIZE x CANON_SIZE RGBA

// ── fingerprint serialisation ───────────────────────────────────────────────
// One variant = 256-bit dHash (64 hex) + 4x4 RGB means (96 hex). A fingerprint = its variants, comma-joined.

const HEX_VARIANT = /^[0-9a-f]{160}$/;

/** @param {{ d: Uint32Array, c: Uint8Array }} v */
export function variantToString(v) {
    let d = '';
    for (let i = 0; i < 8; i++) d += (v.d[i] >>> 0).toString(16).padStart(8, '0');
    return d + Buffer.from(v.c).toString('hex');
}

export function variantFromString(s) {
    const str = String(s || '').trim().toLowerCase();
    if (!HEX_VARIANT.test(str)) return null;
    const d = new Uint32Array(8);
    for (let i = 0; i < 8; i++) d[i] = parseInt(str.slice(i * 8, i * 8 + 8), 16) >>> 0;
    return { d, c: new Uint8Array(Buffer.from(str.slice(64), 'hex')) };
}

export const fpToString = (variants) => variants.map(variantToString).join(',');
export const fpFromString = (s) => String(s || '').split(',').map(variantFromString).filter(Boolean);

/** Build a variant from a 256-entry 0/1 array and a 48-byte colour signature (used by the decoder and tests). */
export function variantFromBits(bits, colour) {
    const d = new Uint32Array(8);
    for (let i = 0; i < 256; i++) if (bits[i]) d[i >> 5] |= (1 << (i & 31));
    return { d, c: new Uint8Array(colour) };
}

// ── scoring ─────────────────────────────────────────────────────────────────

function popcount32(x) {
    let v = x >>> 0;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export function bitsOf(variant) {
    let n = 0;
    for (let i = 0; i < 8; i++) n += popcount32(variant.d[i]);
    return n;
}

export function hamming256(a, b) {
    let n = 0;
    for (let i = 0; i < 8; i++) n += popcount32(a.d[i] ^ b.d[i]);
    return n;
}

export function colourDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Similarity of two variants, 0-1. */
export function variantScore(a, b) {
    const structure = 1 - clamp01(hamming256(a, b) / STRUCT_SCALE);
    const colour = 1 - clamp01(colourDistance(a.c, b.c) / COLOUR_SCALE);
    return STRUCT_WEIGHT * structure + (1 - STRUCT_WEIGHT) * colour;
}

/**
 * A member's avatar against one protected image: the best score over the member's probe variants
 * (full frame, zoomed 6%) and every stored variant of the protected image.
 * @returns {{ score:number, variant:number }}  variant = index into VARIANT_LABELS of the protected side
 */
export function scoreAgainst(candidate, protectedVariants) {
    let best = { score: 0, variant: 0 };
    for (const c of candidate.slice(0, PROBE_VARIANTS)) {
        protectedVariants.forEach((p, i) => {
            const s = variantScore(c, p);
            if (s > best.score) best = { score: s, variant: i };
        });
    }
    return best;
}

export const round2 = (x) => Math.round(Number(x) * 100) / 100;

/** Thresholds clamped to [0.70, 1.00], two decimals, review never above auto. */
export function normaliseThresholds(auto, review) {
    const fix = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(1, Math.max(MIN_THRESHOLD, round2(n))) : d;
    };
    const a = fix(auto, DEFAULT_AUTO);
    const r = Math.min(fix(review, DEFAULT_REVIEW), a);
    return { auto: a, review: r };
}

/** What a score means: 'auto' (act), 'review' (queue and alert) or null (nothing). */
export function decide(score, { auto = DEFAULT_AUTO, review = DEFAULT_REVIEW } = {}) {
    if (!(score >= MIN_THRESHOLD)) return null;
    if (score >= auto) return 'auto';
    if (score >= review) return 'review';
    return null;
}

/** Is a fingerprint informative enough to match on (either side)? */
export function usableFingerprint({ bits, contrast }) {
    return bits >= MIN_BITS && bits <= MAX_BITS && contrast >= MIN_CONTRAST;
}

// ── "not a match" ───────────────────────────────────────────────────────────

/** Has staff said this avatar (or a near-identical re-upload of it) is not a match for the image? */
export function isSuppressed(candidate, suppressed) {
    if (!suppressed?.length || !candidate?.length) return false;
    return suppressed.some(s => variantScore(candidate[0], s) >= SUPPRESS_SCORE);
}

/**
 * Add one avatar's full-frame variant to an image's "not a match" list (as strings). A near-duplicate
 * of an entry already there is not added twice; past MAX_SUPPRESS the oldest go.
 * @returns {string[]}
 */
export function addSuppression(list, variantString, cap = MAX_SUPPRESS) {
    const current = (list || []).filter(s => variantFromString(s));
    const v = variantFromString(variantString);
    if (!v) return current;
    if (current.some(s => variantScore(variantFromString(s), v) >= SUPPRESS_SCORE)) return current;
    return [...current, variantToString(v)].slice(-cap);
}

/**
 * The best protected image a member's avatar matches, at or above `review`.
 * entries: [{ id, variants, protectedUserId?, suppressed? }]
 * @returns {{ entry, score, variant } | null}
 */
export function bestMatch(candidate, entries, { review = DEFAULT_REVIEW, memberId = null } = {}) {
    let best = null;
    for (const entry of entries) {
        if (memberId && entry.protectedUserId && entry.protectedUserId === memberId) continue;
        if (!entry.variants?.length) continue;
        const r = scoreAgainst(candidate, entry.variants);
        if (r.score < review || (best && r.score <= best.score)) continue;
        if (isSuppressed(candidate, entry.suppressed)) continue;
        best = { entry, score: r.score, variant: r.variant };
    }
    return best;
}

// ── exact scam avatars ──────────────────────────────────────────────────────

/**
 * The canonical form of decoded pixels (CANON_SIZE x CANON_SIZE RGBA): every channel quantised to 16
 * levels, and pixels that are (all but) invisible zeroed entirely — a transparent pixel's colour is
 * whatever the encoder left there and must not decide the hash.
 */
export function canonicalPixels(rgba) {
    const out = Buffer.alloc(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3] >> 4;
        if (a === 0) continue;
        out[i] = rgba[i] >> 4;
        out[i + 1] = rgba[i + 1] >> 4;
        out[i + 2] = rgba[i + 2] >> 4;
        out[i + 3] = a;
    }
    return out;
}

export const canonicalHash = (rgba) => crypto.createHash('sha256').update(canonicalPixels(rgba)).digest('hex');

/** 'transparent' | 'black' | null for decoded pixels. */
export function flatKind(rgba) {
    const c = canonicalPixels(rgba);
    let clear = true;
    let black = true;
    for (let i = 0; i < c.length; i += 4) {
        if (c[i + 3] !== 0) clear = false;
        if (c[i] || c[i + 1] || c[i + 2] || c[i + 3] !== 15) black = false;
        if (!clear && !black) return null;
    }
    return clear ? 'transparent' : black ? 'black' : null;
}

/** Solid-colour pixels, for the built-in entries and the tests. */
export function solidPixels(r, g, b, a, size = CANON_SIZE) {
    const px = Buffer.alloc(size * size * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
    return px;
}

/** The ticket-scam kit's avatars, matched exactly. Always present; a server can switch the check off. */
// ── export / import of the protected-image list (fingerprints only) ─────────
// No picture leaves the server: an entry is its fingerprints (the legacy dHash + colour signature every
// blocked_images row has, the canonical-pixel hash and, for protected images, the variant fingerprint) and its
// label. Imported entries carry no thumbnail, so the dashboard shows them as text and the AI second opinion
// (which needs a picture) skips them.

export const AVATAR_EXPORT_FORMAT = 'certifried.avatar-protection';
export const AVATAR_EXPORT_VERSION = 1;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX96 = /^[0-9a-f]{96}$/;

/** rows: blocked_images rows (kind avatar | scam_avatar, not removed). */
export function buildAvatarExport(rows, { guildId = null, guildName = null, now = Date.now() } = {}) {
    const entries = (rows || []).filter(r => (r.kind === 'avatar' || r.kind === 'scam_avatar') && !r.removed_at).map(r => ({
        kind: r.kind === 'scam_avatar' ? 'scam' : 'protected',
        label: r.label || null,
        dhash: r.dhash, bits: Number(r.bits_set), colour: r.colour_sig, sha: r.exact_sha,
        fingerprint: r.kind === 'avatar' ? r.avatar_fp : null,
    }));
    return { format: AVATAR_EXPORT_FORMAT, version: AVATAR_EXPORT_VERSION, exportedAt: new Date(now).toISOString(), source: { guildId, guildName }, images: entries };
}

/**
 * What importing an avatar export would do.
 * @param {object|string} input
 * @param {Array<{ kind:string, dhash:string, exact_sha:string }>} existing   this server's rows (removed ones too: they are restored by a re-add)
 * @param {{ room?:number }} [opts]   protected images that still fit under MAX_PROTECTED
 */
export function planAvatarImport(input, existing = [], { room = MAX_PROTECTED } = {}) {
    let data = input;
    if (typeof input === 'string') {
        try { data = JSON.parse(input); } catch { return { ok: false, error: 'That file is not valid JSON.' }; }
    }
    if (!data || typeof data !== 'object' || data.format !== AVATAR_EXPORT_FORMAT) {
        return { ok: false, error: 'That is not an avatar-protection export (the "format" field is missing or different).' };
    }
    if (!Number.isInteger(data.version) || data.version < 1 || data.version > AVATAR_EXPORT_VERSION) {
        return { ok: false, error: `Unsupported export version ${data.version}; this bot reads version ${AVATAR_EXPORT_VERSION}.` };
    }
    if (!Array.isArray(data.images)) return { ok: false, error: 'The file has no image list.' };
    if (data.images.length > 2 * MAX_PROTECTED) return { ok: false, error: `The file has ${data.images.length} entries; at most ${2 * MAX_PROTECTED} can be imported at once.` };
    const key = (kind, dhash, sha) => `${kind}:${dhash}:${sha}`;
    const have = new Set((existing || []).map(e => key(e.kind, e.dhash, e.exact_sha)));
    const builtin = new Set(BUILTIN_SCAM_AVATARS.map(b => b.sha));
    const out = { ok: true, add: [], duplicates: [], rejected: [], overCap: [] };
    let left = Math.max(0, room);
    for (const raw of data.images) {
        const e = raw && typeof raw === 'object' ? raw : {};
        const label = e.label ? String(e.label).slice(0, 200) : null;
        const kind = e.kind === 'scam' ? 'scam_avatar' : e.kind === 'protected' ? 'avatar' : null;
        const shown = { kind: e.kind, label };
        if (!kind) { out.rejected.push({ ...shown, why: 'unknown kind (protected or scam)' }); continue; }
        const dhash = String(e.dhash ?? '').toLowerCase();
        const colour = String(e.colour ?? '').toLowerCase();
        const sha = String(e.sha ?? '').toLowerCase();
        const bits = Number(e.bits);
        if (!HEX16.test(dhash) || !HEX96.test(colour) || !Number.isInteger(bits) || bits < 0 || bits > 64) { out.rejected.push({ ...shown, why: 'damaged fingerprint' }); continue; }
        if (kind === 'scam_avatar') {
            if (!HEX64.test(sha)) { out.rejected.push({ ...shown, why: 'a scam avatar needs its exact hash' }); continue; }
            if (builtin.has(sha)) { out.duplicates.push({ ...shown, why: 'built in' }); continue; }
        }
        let fingerprint = null;
        if (kind === 'avatar') {
            const variants = fpFromString(String(e.fingerprint ?? ''));
            if (!variants.length) { out.rejected.push({ ...shown, why: 'a protected image needs its fingerprint' }); continue; }
            fingerprint = fpToString(variants);
        }
        const exactSha = HEX64.test(sha) ? sha : '';
        const k = key(kind, dhash, exactSha);
        if (have.has(k)) { out.duplicates.push(shown); continue; }
        have.add(k);
        const entry = { kind, label, dhash, bits, colour, sha: exactSha, fingerprint };
        if (kind === 'avatar') {
            if (left <= 0) { out.overCap.push(entry); continue; }
            left--;
        }
        out.add.push(entry);
    }
    return out;
}

export const BUILTIN_SCAM_AVATARS = Object.freeze([
    Object.freeze({ key: 'black', label: 'Solid black (ticket-scam kit)', sha: canonicalHash(solidPixels(0, 0, 0, 255)) }),
    Object.freeze({ key: 'transparent', label: 'Fully transparent (ticket-scam kit)', sha: canonicalHash(solidPixels(0, 0, 0, 0)) }),
]);

/**
 * Exact scam-avatar match: the built-ins first, then stored entries ({ id, sha, label }).
 * @returns {{ builtin:boolean, key?:string, id?:number, label:string } | null}
 */
export function exactScamMatch(sha, stored = []) {
    if (!sha) return null;
    const b = BUILTIN_SCAM_AVATARS.find(x => x.sha === sha);
    if (b) return { builtin: true, key: b.key, label: b.label };
    const s = stored.find(x => x.sha === sha);
    return s ? { builtin: false, id: s.id, label: s.label || 'Known scam avatar' } : null;
}

// ── avatars of a member ─────────────────────────────────────────────────────

const CDN = 'https://cdn.discordapp.com';

/**
 * The avatars to check for one member, from plain fields. Default avatars (no hash) are left to the
 * join gate's own default-avatar rule. Static PNG keeps transparency (JPEG would flatten it to black).
 * @param {{ userId:string, guildId:string, userAvatar?:string|null, guildAvatar?:string|null }} m
 * @returns {Array<{ scope:'global'|'server', hash:string, key:string, url:string }>}
 */
export function avatarTargets({ userId, guildId, userAvatar = null, guildAvatar = null }, size = 128) {
    const out = [];
    if (userAvatar) out.push({ scope: 'global', hash: userAvatar, key: `global:${userAvatar}`, url: `${CDN}/avatars/${userId}/${userAvatar}.png?size=${size}` });
    if (guildAvatar && guildAvatar !== userAvatar) {
        out.push({ scope: 'server', hash: guildAvatar, key: `server:${guildAvatar}`, url: `${CDN}/guilds/${guildId}/users/${userId}/avatars/${guildAvatar}.png?size=${size}` });
    }
    return out;
}

export const serverIconUrl = (guildId, icon, size = 128) => (icon ? `${CDN}/icons/${guildId}/${icon}.png?size=${size}` : null);

/** 16 hex chars standing for "this exact avatar" (name_filter_reviews.names_hash for avatar rows). */
export const avatarKeyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

/** Which avatars to keep for one source member: 'global' | 'server' | 'both'. */
export function pickScopes(targets, scope = 'both') {
    if (scope === 'global') return targets.filter(t => t.scope === 'global');
    if (scope === 'server') return targets.filter(t => t.scope === 'server');
    return targets;
}

// ── cleanse & Auto-Pilot planning ───────────────────────────────────────────

/**
 * Cleanse: who goes to the review queue. candidates: [{ id, bot, owner, staff, exempt, protectedSelf,
 * match: { kind:'scam'|'image', decision, key } | null, safeHash }]. A member marked "not a match"
 * for this exact avatar (safeHash === avatarKeyHash(match.key)) is skipped.
 */
export function planAvatarCleanse(candidates) {
    const out = { queue: [], skipped: { bots: [], staff: [], exempt: [], protected: [], safe: [] }, clean: 0 };
    for (const c of candidates) {
        if (c.bot) { out.skipped.bots.push(c.id); continue; }
        if (!c.match) { out.clean++; continue; }
        if (c.owner || c.staff) out.skipped.staff.push(c.id);
        else if (c.protectedSelf) out.skipped.protected.push(c.id);
        else if (c.exempt) out.skipped.exempt.push(c.id);
        else if (c.safeHash && c.safeHash === avatarKeyHash(c.match.key)) out.skipped.safe.push(c.id);
        else out.queue.push(c);
    }
    return out;
}

/**
 * Force mode: act now on near-exact matches (and exact scam avatars) whose configured action is not
 * log-only; everything else goes to the review queue.
 */
export function splitAvatarForce(queue, { action = 'log', scamAction = 'log' } = {}) {
    const act = [];
    const review = [];
    for (const c of queue) {
        const a = c.match.kind === 'scam' ? scamAction : c.match.decision === 'auto' ? action : 'log';
        (a === 'log' ? review : act).push(c);
    }
    return { act, review };
}

/**
 * Which members of a large list to fetch avatars for, and how many downloads that takes: members
 * sharing an avatar URL (the same account in two lists) and avatars already fingerprinted are fetched once.
 * @returns {{ jobs: Array<{ url, key, scope }>, members: number, avatars: number }}
 */
export function planAvatarDownloads(memberTargets, cached = new Set()) {
    const seen = new Set();
    const jobs = [];
    let avatars = 0;
    for (const targets of memberTargets) {
        for (const t of targets) {
            avatars++;
            if (seen.has(t.url) || cached.has(t.url)) continue;
            seen.add(t.url);
            jobs.push({ url: t.url, key: t.key, scope: t.scope });
        }
    }
    return { jobs, members: memberTargets.length, avatars };
}

/**
 * Auto-Pilot: the protected images that should exist for covered staff, against what does.
 * protectedMembers: [{ id, targets: avatarTargets(...) }]   (default avatars have no target: skipped)
 * existing:         [{ id, userId, key, removed }]          (removed = deleted by staff: never recreated)
 * @returns {{ create: Array<{ userId, key, scope, url }>, retire: number[] }}
 */
export function planAvatarAutoPilot({ protectedMembers, existing }) {
    const have = new Map(existing.map(r => [`${r.userId}|${r.key}`, r]));
    const want = new Map();
    for (const m of protectedMembers) {
        for (const t of m.targets) {
            const id = `${m.id}|${t.key}`;
            if (!want.has(id)) want.set(id, { userId: m.id, key: t.key, scope: t.scope, url: t.url });
        }
    }
    const create = [...want.entries()].filter(([id]) => !have.has(id)).map(([, v]) => v);
    const retire = existing.filter(r => !r.removed && !want.has(`${r.userId}|${r.key}`)).map(r => r.id);
    return { create, retire };
}

// ── outcomes ────────────────────────────────────────────────────────────────

const pct = (s) => `${Math.round(Number(s) * 100)}%`;

/** Audit-log reason: plain ASCII, never the member's name or the image label (they can hold anything). */
export function avatarReason(match, source = 'auto') {
    const suffix = source === 'review' ? ' (review)' : source === 'cleanse' ? ' (cleanse)' : source === 'ai' ? ' (AI confirmed)' : '';
    if (match?.kind === 'scam') {
        return `Avatar protection: known scam avatar${match.builtinKey ? ` (${match.builtinKey})` : ''}${suffix}`;
    }
    return `Avatar protection: avatar matches protected image #${match?.imageId ?? '?'} (${pct(match?.score ?? 0)})${suffix}`;
}

/** join_gate_events.action for an outcome. */
export function avatarEventAction(action) {
    return { ban: 'avatar_banned', kick: 'avatar_kicked', timeout: 'avatar_timeout', flag: 'avatar_flagged', queue: 'avatar_queued' }[action] ?? 'avatar_logged';
}

export const scoreText = pct;

export default {
    AVATAR_ACTIONS, variantToString, variantFromString, fpToString, fpFromString, variantFromBits, bitsOf, hamming256,
    colourDistance, variantScore, scoreAgainst, normaliseThresholds, decide, usableFingerprint, isSuppressed, addSuppression,
    bestMatch, canonicalPixels, canonicalHash, flatKind, solidPixels, BUILTIN_SCAM_AVATARS, exactScamMatch, avatarTargets,
    serverIconUrl, avatarKeyHash, pickScopes, planAvatarCleanse, splitAvatarForce, planAvatarDownloads, planAvatarAutoPilot,
    avatarReason, avatarEventAction, scoreText,
};
