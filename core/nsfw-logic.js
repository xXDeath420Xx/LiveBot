/*
 * NSFW protection — the pure parts (no Discord, DB, model or worker access; unit-tested in
 * tests/nsfw-protection.test.js). The live side is core/nsfw-protection.js; the classifier (worker pool,
 * models) is core/nsfw-classifier.js + core/nsfw-worker.js.
 *
 * Two local models, no paid API and no per-scan cost:
 *
 *   screen   Marqo nsfw-image-detection-384 (ViT-tiny, 384px, Apache-2.0; ONNX export by KanariKanaru).
 *            ~0.2 s per image on server1. Runs on every image; below the review threshold the image is
 *            clean and nothing else runs.
 *   judge    Falconsai nsfw_image_detection (ViT-base, 224px, Apache-2.0; int8 ONNX export by
 *            onnx-community). A different architecture trained on different data. Runs only on images the
 *            screen scored at or above the review threshold, on the image AND its mirror image.
 *
 * decide(): an action needs BOTH models at or above the act threshold on BOTH the image and its mirror
 * (the screen's mirror score is taken too) — four independent readings agreeing. Borderline (logged and
 * queued for a human, never acted on) needs both models at or above the review threshold: on 1,200 real
 * avatars from our two largest servers the screen alone scored 0.9+ on 5% (drawn and stylised pictures)
 * while the second model cleared all but a handful, so a screen-only hit is not worth a human's time.
 * Without the second model installed, only a screen score at the act threshold is queued.
 *
 * Suspected CSAM: no special detector is built. If a model ever reports a label that suggests minors
 * (neither of these two has one — the check guards a future model swap), nothing about the detection is
 * stored: the image is removed and staff are told to report it to Discord Trust & Safety.
 */

export const MODELS = Object.freeze({
    screen: Object.freeze({
        id: 'marqo-nsfw-384',
        name: 'Marqo NSFW image detection 384 (ViT-tiny)',
        file: 'models/nsfw/marqo-nsfw-384.onnx',
        sha256: 'e9350e576608afe4b57a089ffeb0ebafa1389cdcea4882dd61df28c45f1c24d2',
        size: 384,
        mean: [0.5, 0.5, 0.5],
        std: [0.5, 0.5, 0.5],
        labels: ['nsfw', 'safe'],
        nsfwLabels: ['nsfw'],
        licence: 'Apache-2.0',
    }),
    judge: Object.freeze({
        id: 'falconsai-nsfw-vit-int8',
        name: 'Falconsai NSFW image detection (ViT-base, int8)',
        file: 'models/nsfw/falconsai-nsfw-vit-int8.onnx',
        sha256: 'd9afb1e057104e6cc8616d174f0f6a8b8b0389c839eea7d5efa4bdf1a77efd27',
        size: 224,
        mean: [0.5, 0.5, 0.5],
        std: [0.5, 0.5, 0.5],
        labels: ['normal', 'nsfw'],
        nsfwLabels: ['nsfw'],
        licence: 'Apache-2.0',
    }),
});

export const AVATAR_ACTIONS = Object.freeze(['log', 'flag', 'kick', 'ban']);
export const IMAGE_ACTIONS = Object.freeze(['alert', 'delete', 'timeout']);
export const DEFAULT_ACT = 0.90;
export const DEFAULT_REVIEW = 0.60;
export const MIN_ACT = 0.80;              // below this two models agreeing is not "high confidence"
export const MIN_REVIEW = 0.30;
export const MAX_THRESHOLD = 0.99;
export const DEFAULT_AVATAR_CAP = 1000;   // avatar scans per server per day
export const DEFAULT_IMAGE_CAP = 2000;    // chat-image scans per server per day
export const MIN_CAP = 10;
export const MAX_CAP = 50000;
export const MAX_IMAGES_PER_MESSAGE = 4;
export const REVIEW_KINDS = Object.freeze({ avatar: 'nsfw_avatar', image: 'nsfw_image' });
export const SURFACES = Object.freeze(['avatar', 'image']);

// A label that suggests minors. Matched on whole words of a model's label names.
const MINOR_LABEL = /(^|[^a-z])(child|children|minor|minors|underage|under_age|teen|kid|kids|loli|lolicon|shota|csam|cp)([^a-z]|$)/i;

// ── maths ───────────────────────────────────────────────────────────────────

/** Numerically stable softmax. */
export function softmax(logits) {
    const arr = Array.from(logits ?? [], Number);
    if (!arr.length || arr.some(v => !Number.isFinite(v))) return [];
    const max = Math.max(...arr);
    const exps = arr.map(v => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(v => v / sum);
}

/** Probability mass on a model's NSFW labels. */
export function nsfwProbability(probs, model) {
    let p = 0;
    (model.labels || []).forEach((label, i) => { if (model.nsfwLabels.includes(label)) p += Number(probs[i] ?? 0); });
    return Math.min(1, Math.max(0, p));
}

/** True when a label that suggests minors carries at least `min` of the probability. */
export function minorSuspected(probs, model, min = 0.5) {
    return (model.labels || []).some((label, i) => MINOR_LABEL.test(String(label)) && Number(probs[i] ?? 0) >= min);
}

/** Does any label of this model name minors? (Status page: says the CSAM path can trigger.) */
export const modelHasMinorLabels = (model) => (model.labels || []).some(l => MINOR_LABEL.test(String(l)));

/**
 * Interleaved RGB bytes (size x size x 3) -> normalised planar Float32Array (NCHW, batch 1).
 * @param {Uint8Array|Buffer} rgb
 */
export function toTensorData(rgb, size, mean = [0.5, 0.5, 0.5], std = [0.5, 0.5, 0.5]) {
    const plane = size * size;
    if (!rgb || rgb.length < plane * 3) throw new Error(`expected ${plane * 3} bytes, got ${rgb?.length ?? 0}`);
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c];
    }
    return out;
}

/** Which frames of an animated image to look at: the first, and the middle one. */
export function framesToCheck(pages) {
    const n = Math.max(1, Math.floor(Number(pages) || 1));
    return n > 2 ? [0, Math.floor(n / 2)] : n === 2 ? [0, 1] : [0];
}

// ── thresholds + the two-stage decision ─────────────────────────────────────

const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Act / review thresholds, clamped; review never above act. */
export function normaliseThresholds(act, review) {
    const a = round3(clamp(act, MIN_ACT, MAX_THRESHOLD, DEFAULT_ACT));
    const r = round3(clamp(review, MIN_REVIEW, MAX_THRESHOLD, DEFAULT_REVIEW));
    return { act: a, review: Math.min(r, a) };
}

const finite = (vals) => vals.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
const lowest = (...vals) => { const n = finite(vals); return n.length ? Math.min(...n) : null; };
const highest = (...vals) => { const n = finite(vals); return n.length ? Math.max(...n) : null; };

/**
 * The two-stage decision.
 * @param {{ screen:number|null, screenFlip?:number|null, judge?:number|null, judgeFlip?:number|null, minor?:boolean }} s
 * @param {{ act:number, review:number }} t
 * @returns {{ verdict:'nsfw'|'review'|'clean'|'minor', confidence:number, why:string }}
 */
export function decide(s, t) {
    const { act, review } = normaliseThresholds(t?.act, t?.review);
    const screen = Number(s?.screen);
    if (s?.minor) return { verdict: 'minor', confidence: 1, why: 'a label suggesting minors' };
    if (!Number.isFinite(screen)) return { verdict: 'clean', confidence: 0, why: 'not scored' };
    if (screen < review) return { verdict: 'clean', confidence: screen, why: `screen ${pct(screen)} is under review ${pct(review)}` };
    const screenMin = lowest(screen, s.screenFlip);
    const judgeMin = lowest(s.judge, s.judgeFlip);
    const judgeMax = highest(s.judge, s.judgeFlip);
    if (judgeMin == null) {
        if (screen < act) return { verdict: 'clean', confidence: screen, why: `screen ${pct(screen)} only (no second model), under act ${pct(act)}` };
        return { verdict: 'review', confidence: screen, why: `screen ${pct(screen)}; the second model did not run, so this is never acted on` };
    }
    if (screenMin >= act && judgeMin >= act) {
        return { verdict: 'nsfw', confidence: Math.min(screenMin, judgeMin), why: `both models ${pct(Math.min(screenMin, judgeMin))} or more (act ${pct(act)})` };
    }
    if (judgeMax < review) {
        return { verdict: 'clean', confidence: judgeMax, why: `the second model cleared it (${pct(judgeMax)}, under review ${pct(review)})` };
    }
    const weak = screenMin < act ? `screen ${pct(screenMin)}` : `second model ${pct(judgeMin)}`;
    return { verdict: 'review', confidence: Math.min(screen, judgeMax), why: `${weak} is under act ${pct(act)}: borderline` };
}

export const pct = (n) => `${Math.round(Number(n || 0) * 100)}%`;

/** One plain-ASCII line of scores, e.g. "screen 97% (mirror 96%), second model 95% (mirror 94%)". */
export function scoreLine(s) {
    if (!s) return 'not scored';
    const part = (label, a, b) => (a == null ? null : `${label} ${pct(a)}${b != null ? ` (mirror ${pct(b)})` : ''}`);
    return [part('screen', s.screen, s.screenFlip), part('second model', s.judge, s.judgeFlip)].filter(Boolean).join(', ') || 'not scored';
}

// ── settings ────────────────────────────────────────────────────────────────

const bool = (v, d = false) => (v == null ? d : !!Number(v));
const pick = (v, list, d) => (list.includes(String(v ?? '').toLowerCase()) ? String(v).toLowerCase() : d);
const cap = (v, d) => Math.round(clamp(v, MIN_CAP, MAX_CAP, d));

/** join_gate_config nsfw_avatar_* -> settings. Off until a server switches it on; log-only by default. */
export function avatarSettingsFrom(row) {
    const r = row || {};
    const t = normaliseThresholds(r.nsfw_avatar_act_threshold ?? DEFAULT_ACT, r.nsfw_avatar_review_threshold ?? DEFAULT_REVIEW);
    return {
        enabled: bool(r.nsfw_avatar_enabled),
        action: pick(r.nsfw_avatar_action, AVATAR_ACTIONS, 'log'),
        act: t.act,
        review: t.review,
        dailyCap: cap(r.nsfw_avatar_daily_cap, DEFAULT_AVATAR_CAP),
        dm: bool(r.nsfw_avatar_dm, true),
    };
}

/** phishing_config nsfw_img_* -> settings. Off until a server switches it on; alert-only by default. */
export function imageSettingsFrom(row) {
    const r = row || {};
    const t = normaliseThresholds(r.nsfw_img_act_threshold ?? DEFAULT_ACT, r.nsfw_img_review_threshold ?? DEFAULT_REVIEW);
    return {
        enabled: bool(r.nsfw_img_enabled),
        action: pick(r.nsfw_img_action, IMAGE_ACTIONS, 'alert'),
        timeoutMinutes: Math.round(clamp(r.nsfw_img_timeout_minutes, 1, 40320, 60)),
        act: t.act,
        review: t.review,
        reviewAlerts: bool(r.nsfw_img_review_alerts, false),
        dailyCap: cap(r.nsfw_img_daily_cap, DEFAULT_IMAGE_CAP),
    };
}

/**
 * Validate a settings patch for one surface -> column values.
 * patch keys: enabled, action, act, review, dailyCap, dm (avatars), timeoutMinutes, reviewAlerts (images)
 * @returns {{ ok:true, values:object } | { ok:false, error:string }}
 */
export function cleanNsfwPatch(surface, patch, current = null) {
    const p = patch || {};
    const prefix = surface === 'avatar' ? 'nsfw_avatar_' : 'nsfw_img_';
    const actions = surface === 'avatar' ? AVATAR_ACTIONS : IMAGE_ACTIONS;
    const values = {};
    if (p.enabled !== undefined) values[`${prefix}enabled`] = p.enabled ? 1 : 0;
    if (p.action !== undefined) {
        if (!actions.includes(String(p.action))) return { ok: false, error: `Action must be one of ${actions.join(', ')}.` };
        values[`${prefix}action`] = String(p.action);
    }
    if (p.act !== undefined || p.review !== undefined) {
        for (const [k, lo] of [['act', MIN_ACT], ['review', MIN_REVIEW]]) {
            if (p[k] === undefined) continue;
            const n = Number(p[k]);
            if (!Number.isFinite(n) || n < lo || n > MAX_THRESHOLD) return { ok: false, error: `The ${k} threshold goes from ${lo.toFixed(2)} to ${MAX_THRESHOLD.toFixed(2)}.` };
        }
        const act = p.act ?? current?.act ?? DEFAULT_ACT;
        const review = p.review ?? current?.review ?? DEFAULT_REVIEW;
        if (Number(review) > Number(act)) return { ok: false, error: 'The review threshold cannot be above the act threshold.' };
        const t = normaliseThresholds(act, review);
        values[`${prefix}act_threshold`] = t.act;
        values[`${prefix}review_threshold`] = t.review;
    }
    if (p.dailyCap !== undefined) {
        const n = Math.round(Number(p.dailyCap));
        if (!Number.isFinite(n) || n < MIN_CAP || n > MAX_CAP) return { ok: false, error: `The daily cap goes from ${MIN_CAP} to ${MAX_CAP} scans.` };
        values[`${prefix}daily_cap`] = n;
    }
    if (surface === 'avatar' && p.dm !== undefined) values.nsfw_avatar_dm = p.dm ? 1 : 0;
    if (surface === 'image') {
        if (p.timeoutMinutes !== undefined) {
            const n = Math.round(Number(p.timeoutMinutes));
            if (!Number.isFinite(n) || n < 1 || n > 40320) return { ok: false, error: 'Timeout must be 1 to 40320 minutes (28 days).' };
            values.nsfw_img_timeout_minutes = n;
        }
        if (p.reviewAlerts !== undefined) values.nsfw_img_review_alerts = p.reviewAlerts ? 1 : 0;
    }
    return { ok: true, values };
}

// ── metering + the daily cap ────────────────────────────────────────────────

/** UTC day, YYYY-MM-DD (the server_stats `date`). */
export const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export const METER_FIELDS = Object.freeze(['scanned', 'cached', 'nsfw', 'review', 'capped', 'dropped', 'errors']);
export const emptyMeter = () => Object.fromEntries(METER_FIELDS.map(f => [f, 0]));

/**
 * May one more image be scanned today? `used` = scans already counted today (scans only: cache hits and
 * images skipped by the safe list cost no CPU and do not count).
 * @returns {{ allowed:boolean, remaining:number }}
 */
export function capCheck(used, dailyCap) {
    const limit = Math.max(MIN_CAP, Number(dailyCap) || 0);
    const u = Math.max(0, Number(used) || 0);
    return { allowed: u < limit, remaining: Math.max(0, limit - u) };
}

/**
 * server_stats columns the meter adds to (migrations/330_nsfw_cleanup.js). Skipped = over the daily cap
 * or dropped because the classifier was overloaded (the live counters keep the two apart).
 */
export const STATS_COLUMNS = Object.freeze({
    avatar: { scanned: 'nsfw_avatar_scans', nsfw: 'nsfw_avatar_hits', review: 'nsfw_avatar_reviews', capped: 'nsfw_avatar_skipped', dropped: 'nsfw_avatar_skipped' },
    image: { scanned: 'nsfw_image_scans', nsfw: 'nsfw_image_hits', review: 'nsfw_image_reviews', capped: 'nsfw_image_skipped', dropped: 'nsfw_image_skipped' },
});
export const ALL_STATS_COLUMNS = Object.freeze([...new Set(SURFACES.flatMap(s => Object.values(STATS_COLUMNS[s])))]);

/**
 * Pending meter increments -> one upsert per (guild, day): { columns, values } with column -> amount.
 * @param {{ avatar?:object, image?:object }} pending  surface -> METER_FIELDS counts
 */
export function statsIncrements(pending) {
    const add = {};
    for (const surface of SURFACES) {
        const m = pending?.[surface];
        if (!m) continue;
        for (const [field, col] of Object.entries(STATS_COLUMNS[surface])) {
            const n = Number(m[field] || 0);
            if (n > 0) add[col] = (add[col] || 0) + n;
        }
    }
    return add;
}

// ── review queue: overturn and decisions ────────────────────────────────────

/**
 * What overturning an automatic action undoes. Every overturn also remembers the image as safe.
 * @param {{ status:string, action_taken?:string|null }} row
 * @returns {{ ok:boolean, undo?:'unban'|'untimeout'|'unflag'|null, note?:string, error?:string }}
 */
export function overturnPlan(row) {
    if (!row) return { ok: false, error: 'Nothing queued for that member.' };
    if (row.status === 'overturned') return { ok: false, error: 'Already overturned.' };
    if (row.status === 'safe') return { ok: false, error: 'Already marked not NSFW.' };
    const action = String(row.action_taken || '');
    if (!['actioned', 'banned', 'kicked', 'pending', 'failed', 'skipped', 'gone'].includes(row.status)) {
        return { ok: false, error: `Cannot overturn a ${row.status} entry.` };
    }
    const undo = { ban: 'unban', banned: 'unban', timeout: 'untimeout', flag: 'unflag' }[action] ?? null;
    const note = action === 'kick' ? 'Kicks cannot be undone; they can join again.'
        : action === 'delete' ? 'The deleted message cannot be restored.'
            : undo ? null : 'Nothing was done to them; the image is remembered as safe.';
    return { ok: true, undo, note };
}

/** Decisions staff can make on a queue entry, by its status. */
export function decisionsFor(row) {
    if (!row) return [];
    if (row.status === 'pending' || row.status === 'failed') return ['ban', 'kick', 'safe', 'skip'];
    if (row.status === 'actioned' || row.status === 'banned' || row.status === 'kicked') return ['overturn'];
    return [];
}

/** join_gate_events.action for an avatar outcome. */
export function avatarEventAction(outcome) {
    return { ban: 'nsfw_banned', kick: 'nsfw_kicked', flag: 'nsfw_flagged', queue: 'nsfw_queued', overturn: 'nsfw_overturned' }[outcome] ?? 'nsfw_logged';
}

/** Audit-log reason (plain ASCII). */
export function nsfwReason(kind, extra = '') {
    const base = { avatar: 'NSFW avatar', image: 'NSFW image', minor: 'Removed: report to Discord Trust and Safety', review: 'NSFW review',
        overturn: 'NSFW action overturned' }[kind] || 'NSFW protection';
    const text = extra ? `${base} (${extra})` : base;
    return text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, 500);
}

/** An age-restricted (NSFW) channel, or a thread or forum post inside one. */
export function isAgeRestricted(channel) {
    if (!channel) return false;
    if (channel.nsfw) return true;
    const parent = channel.parent ?? null;
    return !!(parent && parent.nsfw);
}

/**
 * The pieces of a stored review row for an NSFW detection. Thumbnail-free: avatar rows keep the CDN URL
 * of the avatar (Discord's copy, not ours) so staff can look; image rows keep nothing that shows the image.
 */
export function evidenceDetail({ scores, decision, action, outcome }) {
    const parts = [scoreLine(scores)];
    if (decision?.verdict) parts.push(decision.verdict === 'nsfw' ? 'both models agree' : 'borderline');
    if (action) parts.push(`action ${action}`);
    if (outcome) parts.push(outcome);
    return parts.join('; ').replace(/[^\x20-\x7E]/g, '').slice(0, 255);
}

export default {
    MODELS, AVATAR_ACTIONS, IMAGE_ACTIONS, softmax, nsfwProbability, minorSuspected, modelHasMinorLabels, toTensorData,
    framesToCheck, normaliseThresholds, decide, scoreLine, avatarSettingsFrom, imageSettingsFrom, cleanNsfwPatch, dayKey,
    emptyMeter, capCheck, statsIncrements, overturnPlan, decisionsFor, avatarEventAction, nsfwReason, isAgeRestricted,
    evidenceDetail, pct,
};
