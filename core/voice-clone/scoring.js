/*
 * Speaker-verification maths and decisions (design 2.2). Two models must agree: ReDimNet b2 and SpeechBrain ECAPA-TDNN.
 * Embeddings arrive L2-normalised from the sidecar.
 *
 *   cosine(a, b), centroid(list)              centroid = the normalised mean
 *   loadThresholds() → { version, redimnet: { tHi, tLo }, ecapa: { tHi, tLo }, ... }   thresholds.json (calibration)
 *   bothAtLeast(scores, t, key)               scores { redimnet, ecapa } both >= the model's tHi or tLo
 *   consentConsistency(clipEmbs, th)          every live-check clip against the centroid of the other two >= tLo on both
 *   sampleDecision(emb, consentCentroid, th)  'ok' | 'reject'   one recording vs the consent voiceprint (tLo on both)
 *   trainingDecision(sampleC, consentC, th)   'pass' (tHi on both) | 'review' (tLo on both) | 'fail'
 *   crossAccountMatch(c, others, th)          the first voice of ANOTHER account at tHi on both, or null
 * Pure apart from loadThresholds (reads one JSON file next to this module).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODELS = Object.freeze(['redimnet', 'ecapa']);

// Used only when thresholds.json is missing; stricter than any calibrated value so nothing passes by accident.
const FALLBACK = Object.freeze({ version: 'uncalibrated', redimnet: { tHi: 0.80, tLo: 0.70 }, ecapa: { tHi: 0.80, tLo: 0.70 } });

export function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function centroid(list) {
    const vs = (list || []).filter((v) => Array.isArray(v) && v.length);
    if (!vs.length) return null;
    const n = vs[0].length;
    const m = new Array(n).fill(0);
    for (const v of vs) {
        let norm = 0;
        for (let i = 0; i < n; i++) norm += v[i] * v[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < n; i++) m[i] += v[i] / norm;
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += m[i] * m[i];
    norm = Math.sqrt(norm) || 1;
    return m.map((x) => x / norm);
}

/** { redimnet, ecapa } centroids from a list of { redimnet, ecapa } embeddings. */
export function centroids(embs) {
    return Object.fromEntries(MODELS.map((k) => [k, centroid((embs || []).map((e) => e?.[k]))]));
}

export function scores(a, b) {
    return Object.fromEntries(MODELS.map((k) => [k, Math.round(cosine(a?.[k], b?.[k]) * 10000) / 10000]));
}

let cached = null;
export function loadThresholds({ file = path.join(HERE, 'thresholds.json'), fresh = false } = {}) {
    if (cached && !fresh) return cached;
    try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const k of MODELS) {
            const m = t[k];
            if (!m || !(m.tHi > 0 && m.tHi < 1) || !(m.tLo > 0 && m.tLo <= m.tHi)) throw new Error(`bad ${k} thresholds`);
        }
        cached = t;
    } catch {
        cached = FALLBACK;
    }
    return cached;
}

export function bothAtLeast(sc, th, key) {
    return MODELS.every((k) => Number(sc?.[k]) >= Number(th?.[k]?.[key]));
}

export function consentConsistency(clipEmbs, th) {
    const list = clipEmbs || [];
    if (list.length < 3) return { ok: false, pairs: [] };
    const pairs = list.map((e, i) => scores(e, centroids(list.filter((_, j) => j !== i))));
    return { ok: pairs.every((p) => bothAtLeast(p, th, 'tLo')), pairs };
}

export function sampleDecision(emb, consentC, th) {
    const sc = scores(emb, consentC);
    return { decision: bothAtLeast(sc, th, 'tLo') ? 'ok' : 'reject', scores: sc };
}

export function trainingDecision(sampleC, consentC, th) {
    const sc = scores(sampleC, consentC);
    if (bothAtLeast(sc, th, 'tHi')) return { decision: 'pass', scores: sc };
    if (bothAtLeast(sc, th, 'tLo')) return { decision: 'review', scores: sc };
    return { decision: 'fail', scores: sc };
}

/** others: [{ voiceId, ownerUserId, centroids }]. */
export function crossAccountMatch(c, others, ownerUserId, th) {
    for (const o of others || []) {
        if (String(o.ownerUserId) === String(ownerUserId)) continue;
        const sc = scores(c, o.centroids);
        if (bothAtLeast(sc, th, 'tHi')) return { voiceId: o.voiceId, scores: sc };
    }
    return null;
}

export default { MODELS, cosine, centroid, centroids, scores, loadThresholds, bothAtLeast, consentConsistency, sampleDecision, trainingDecision, crossAccountMatch };
