/*
 * Own voices that existed before the live check (owner decisions of 2026-11-21): Bear's voice, trained by CertiFried
 * from Bear's readings of a script, live since 2026-10-14 as piper_models/en_GB/bear.
 *
 *   createLegacyVoice(adminId, { userId, legacyVoiceId, displayName, espeakVoice, tuning })
 *       a voice row that governs the piper_models voice: its consent record, opt-ins, deletion and retraining.
 *   recordWrittenConsent(adminId, voiceId, { text, givenAt, channel, evidence: [{ name, buf }], note })
 *       consent_method 'written_on_file': the person's own words stored verbatim, the screenshots kept with their SHA-256,
 *       recorded_by the admin. No live check, for this legacy voice only. Withdrawal and deletion work as for any voice.
 *   attestLegacy(adminId, voiceId, { state, age18 })
 *       the 18+ and residence declaration, recorded as attested by the owner on the person's behalf; the region rule
 *       applies (US only, not IL or TX). Training stays held until this is done.
 *   importLegacySamples(adminId, voiceId, [{ name, wav, text }])
 *       the person's existing recordings (never synthetic or zero-shot output): checked for one speaker and our watermark,
 *       stored encrypted like any recording; their centroid becomes the reference voiceprint.
 *   queueLegacyTraining(adminId, voiceId) → { queued, waitingFor[] }   gated on the consent record and attestation
 *   uploadOwnerModel(adminId, voiceId, { onnx, json, sha256, attestation })   a model the voice owner trained themselves
 *   setOptIn(actor, voiceId, 'viewerText' | 'iSaid', on)               recorded with who and when
 *   adminSample(voiceId, which: 'current' | 'new', text) → WAV         A/B listening on the owner console
 *   rulesFor(piperVoiceName) → { voiceId, ownerUserId, status, viewerText, iSaid } | null   (cached 60 s; the reader and
 *                                                                                           the stream bot ask this)
 *   onDelete(v): removes the piper_models voice and its preview when a legacy voice is deleted or withdrawn.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS, LIMITS, BASE_MODEL, DATA_DIR } from './constants.js';
import { CONSENT_VERSION, CONSENT_SHA256 } from './consent-text.js';
import { regionGate } from './gate.js';
import { centroids, scores, bothAtLeast, crossAccountMatch } from './scoring.js';
import { viewerTextOn, iSaidOn } from './policy.js';
import { fixModelJson } from './worker-api.js';
import { tuningFor, VoiceError } from './service.js';
import * as vcrypto from './crypto.js';

export const LEGACY_MIN_MINUTES = 5;
const EVIDENCE_DIR = process.env.VOICE_EVIDENCE_DIR || path.join(path.dirname(DATA_DIR), 'voice-consent-evidence');

export function createLegacy({ service, store, files, sidecar, decode, piper, piperModelsDir, logger = null, env = process.env, now = () => Date.now(), evidenceDir = EVIDENCE_DIR } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[VoiceClone] ${msg}`, meta); } catch { /* ignore */ } };
    const cache = new Map();   // piper voice name -> { at, rules }
    const event = (e) => service.event(e);

    async function voiceOr404(voiceId) {
        const v = await store.voiceById(voiceId);
        if (!v || v.status === STATUS.DELETED) throw new VoiceError('No such voice.', 404);
        return v;
    }

    async function createLegacyVoice(adminId, { userId, legacyVoiceId, displayName, espeakVoice = 'en-us', tuning = {} }) {
        if (!/^\d{15,20}$/.test(String(userId))) throw new VoiceError('Enter a Discord user ID.', 400);
        if (!/^[a-z0-9_-]{1,50}$/i.test(String(legacyVoiceId))) throw new VoiceError('Enter the piper_models voice id.', 400);
        if (await store.liveVoiceOf(userId)) throw new VoiceError('That person already has a voice.', 409);
        if (await store.voiceByLegacy(legacyVoiceId)) throw new VoiceError('That piper voice already has a record.', 409);
        if (!(await store.getInvite(userId))) await service.invite(adminId, userId, 'Invited with their pre-existing voice');
        const voiceId = `vc${crypto.randomBytes(12).toString('hex')}`;
        const key = vcrypto.newDataKey();
        let wmId = null;
        for (let i = 0; i < 50 && wmId == null; i++) { const n = crypto.randomInt(1, 0xFFFF); if (!(await store.wmTaken(n))) wmId = n; }
        const consentId = await store.addConsent({
            userId, voiceId, textVersion: CONSENT_VERSION, textSha256: CONSENT_SHA256,
            typedNameEncrypted: vcrypto.sealJson({ name: '(written consent on file; no typed signature)' }, key, voiceId),
            ageAttested: false, ownVoiceAttested: false, state: null, keepSamples: false, thresholdVersion: service.thresholds().version,
            consentMethod: 'written_on_file', recordedBy: String(adminId), note: 'PENDING: the written consent has not been stored yet.',
        });
        await store.createVoice({
            id: voiceId, ownerUserId: userId, displayName: String(displayName || legacyVoiceId).slice(0, 60), baseModel: BASE_MODEL.sha256,
            dataKeyEncrypted: vcrypto.wrapKey(key, voiceId, env), wmId,
            tuning: { ...tuning, espeak: espeakVoice }, features: { automations: false }, consentId, keepSamples: false,
        });
        await store.updateVoice(voiceId, { legacy_voice_id: legacyVoiceId });
        cache.delete(legacyVoiceId);
        await event({ voiceId, userId, actor: 'admin', event: 'legacy_voice_created', detail: { by: String(adminId), legacyVoiceId } });
        return { voiceId, consentId };
    }

    async function recordWrittenConsent(adminId, voiceId, { text, givenAt, channel = 'Discord DM to the owner', evidence = [], note = '' }) {
        const v = await voiceOr404(voiceId);
        const c = await store.consentById(v.consent_id);
        if (!c || c.consent_method !== 'written_on_file') throw new VoiceError('This voice does not use a written consent on file.', 409);
        if (!String(text || '').trim()) throw new VoiceError('Paste the consent text, verbatim.', 400);
        await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
        const stored = [];
        for (const e of evidence) {
            const ext = (String(e.name || '').match(/\.(jpe?g|png|webp|gif|pdf)$/i)?.[1] || 'bin').toLowerCase();
            const sha = vcrypto.sha256(e.buf);
            const file = `consent-${c.id}-${sha.slice(0, 16)}.${ext}`;
            await fs.writeFile(path.join(evidenceDir, file), e.buf, { mode: 0o600 });
            stored.push({ file, sha256: sha, bytes: e.buf.length, original: String(e.name || '').slice(0, 120) });
        }
        await store.updateConsent(c.id, {
            consent_text: String(text), consent_given_at: String(givenAt || '').slice(0, 80), consent_channel: String(channel).slice(0, 80),
            recorded_by: String(adminId), evidence: stored, note: String(note || '').slice(0, 1000), verified_at: 'NOW()',
        });
        await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'written_consent_recorded', detail: { by: String(adminId), consentId: c.id, evidence: stored.map((x) => x.sha256) } });
        return { consentId: c.id, evidence: stored };
    }

    async function addEvidence(adminId, voiceId, name, buf) {
        const v = await voiceOr404(voiceId);
        const c = await store.consentById(v.consent_id);
        if (!c || c.consent_method !== 'written_on_file') throw new VoiceError('Only for a written consent on file.', 409);
        if (!Buffer.isBuffer(buf) || !buf.length || buf.length > 15 * 1024 * 1024) throw new VoiceError('Upload an image or PDF of at most 15 MB.', 400);
        await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
        const ext = (String(name || '').match(/\.(jpe?g|png|webp|gif|pdf)$/i)?.[1] || 'bin').toLowerCase();
        const sha = vcrypto.sha256(buf);
        const file = `consent-${c.id}-${sha.slice(0, 16)}.${ext}`;
        await fs.writeFile(path.join(evidenceDir, file), buf, { mode: 0o600 });
        const list = [...(c.evidence || []).filter((e) => e.sha256 !== sha), { file, sha256: sha, bytes: buf.length, original: String(name || '').slice(0, 120) }];
        await store.updateConsent(c.id, { evidence: list });
        await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'consent_evidence_added', detail: { by: String(adminId), sha256: sha } });
        return { sha256: sha, file };
    }

    /**
     * The owner's attestation on the person's behalf: 18+ (required) and residence. `state` is a US state and must pass the
     * region rule; `regionException` ({ region, basis }) is the super-admin-only exception to the US-only rule for this one
     * person (the routes allow it only from the owner console), recorded with its basis, who and when, and audited.
     */
    async function attestLegacy(adminId, voiceId, { state = null, age18, regionException = null }) {
        const v = await voiceOr404(voiceId);
        const c = await store.consentById(v.consent_id);
        if (!c || c.consent_method !== 'written_on_file') throw new VoiceError('Only for a written consent on file.', 409);
        if (age18 !== true) throw new VoiceError('The 18+ declaration is required.', 400);
        const fields = { age_attested: 1, own_voice_attested: 1, attested_by: String(adminId), attested_at: 'NOW()' };
        if (regionException) {
            const region = String(regionException.region || '').trim().slice(0, 120);
            const basis = String(regionException.basis || '').trim().slice(0, 300);
            if (!region || !basis) throw new VoiceError('A region exception needs the region and its basis.', 400);
            Object.assign(fields, { residence_state: null, residence_country: region.slice(0, 2).toUpperCase(), region_exception: region, region_exception_basis: basis,
                region_exception_by: String(adminId), region_exception_at: 'NOW()' });
            await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'region_exception_granted', detail: { by: String(adminId), region, basis } });
        } else {
            const region = regionGate({ state });
            if (!region.ok) {
                await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'consent_region_blocked', detail: { state, code: region.code, onBehalf: true } });
                throw new VoiceError(region.reason, 403, { code: region.code });
            }
            fields.residence_state = String(state).toUpperCase();
        }
        await store.updateConsent(c.id, fields);
        if (v.status === STATUS.DRAFT && c.verified_at) await store.setVoiceStatus(v.id, STATUS.CONSENT_OK, [STATUS.DRAFT]);
        await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'legacy_attested', detail: { by: String(adminId), age18: true, state: fields.residence_state, regionException: fields.region_exception || null, onBehalfOf: v.owner_user_id } });
        return queueLegacyTraining(adminId, voiceId);
    }

    async function importLegacySamples(adminId, voiceId, items) {
        const v = await voiceOr404(voiceId);
        const key = service.dataKey(v);
        const th = service.thresholds();
        const analysed = [];
        for (const it of items) {
            try {
                const w16 = await decode(it.wav, { rate: 16000 });
                const emb = await sidecar.embed(w16);
                const wm = await sidecar.detect(w16);
                if (wm.prob >= 0.5) { analysed.push({ it, skip: 'carries a CertiFried watermark' }); continue; }
                if (emb.clip_ratio > 0.01) { analysed.push({ it, skip: 'clipping' }); continue; }
                analysed.push({ it, emb });
            } catch (err) { analysed.push({ it, skip: `unreadable (${String(err?.message).slice(0, 60)})` }); }
        }
        const ok = analysed.filter((a) => a.emb);
        if (ok.length < 20) throw new VoiceError(`Only ${ok.length} usable recordings.`, 400);
        const ref = centroids(ok.map((a) => a.emb));
        const cross = await (async () => {
            const others = [];
            for (const row of await store.voicesWithCentroid()) {
                if (row.id === v.id) continue;
                try { const k = vcrypto.unwrapKey(row.data_key_encrypted, row.id, env); others.push({ voiceId: row.id, ownerUserId: row.owner_user_id, centroids: vcrypto.openJson(row.centroid_encrypted, k, row.id).consent }); } catch { /* gone */ }
            }
            return crossAccountMatch(ref, others, v.owner_user_id, th);
        })();
        if (cross) throw new VoiceError('These recordings match a voice that belongs to another account.', 409);
        let kept = 0, keptMs = 0;
        const rejected = analysed.filter((a) => a.skip).map((a) => ({ name: a.it.name, reason: a.skip }));
        for (const a of ok) {
            const sc = scores(a.emb, ref);
            if (!bothAtLeast(sc, th, 'tLo')) { rejected.push({ name: a.it.name, reason: `not the same speaker (${sc.redimnet}/${sc.ecapa})` }); continue; }
            const wav = await decode(a.it.wav, { rate: 22050 });
            const id = await store.addSample({ voiceId: v.id, kind: 'recorded', promptIndex: null, promptText: String(a.it.text).slice(0, 400), durationMs: a.emb.duration_s * 1000,
                sha256: vcrypto.sha256(wav), scoreRedimnet: sc.redimnet, scoreEcapa: sc.ecapa,
                checks: { source: 'legacy_import', file: String(a.it.name).slice(0, 80), embSealed: vcrypto.sealJson({ redimnet: a.emb.redimnet, ecapa: a.emb.ecapa }, key, v.id) }, status: 'ok' });
            await store.setSampleFile(v.id, id, await files.writeSample(v.id, id, vcrypto.seal(wav, key, v.id)));
            kept++; keptMs += a.emb.duration_s * 1000;
        }
        await store.updateVoice(v.id, { centroid_encrypted: vcrypto.sealJson({ consent: ref, source: 'legacy_recordings', thresholdVersion: th.version }, key, v.id) });
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'admin', event: 'legacy_samples_imported', detail: { by: String(adminId), kept, minutes: Math.round(keptMs / 600) / 100, rejected: rejected.slice(0, 40) } });
        return { kept, minutes: Math.round(keptMs / 600) / 100, rejected };
    }

    async function queueLegacyTraining(adminId, voiceId) {
        const v = await voiceOr404(voiceId);
        const c = await store.consentById(v.consent_id);
        const waitingFor = [];
        if (!c?.verified_at || c.revoked_at) waitingFor.push('the written consent record');
        if (!c?.attested_by || !(c?.residence_state || c?.region_exception)) waitingFor.push('the 18+ and residence declaration (attested by the owner)');
        const sum = await store.sampleSummary(v.id);
        if (sum.ms < LEGACY_MIN_MINUTES * 60_000) waitingFor.push(`at least ${LEGACY_MIN_MINUTES} minutes of the person's recordings (now ${Math.round(sum.ms / 600) / 100})`);
        if (await store.openJobFor(v.id)) return { queued: true, already: true, waitingFor: [] };
        if (waitingFor.length) {
            await event({ voiceId, userId: v.owner_user_id, actor: 'system', event: 'legacy_training_held', detail: { waitingFor } });
            return { queued: false, waitingFor };
        }
        const jobId = await store.createJob(v.id, LIMITS.trainSteps);
        await store.setVoiceStatus(v.id, STATUS.QUEUED, [STATUS.CONSENT_OK, STATUS.REVIEW, STATUS.ACTIVE]);
        await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'training_queued', detail: { by: String(adminId), jobId, minutes: Math.round(sum.ms / 600) / 100, legacy: true } });
        return { queued: true, jobId, waitingFor: [] };
    }

    async function uploadOwnerModel(adminId, voiceId, { onnx, json, attestation = {} }) {
        const v = await voiceOr404(voiceId);
        if (!Buffer.isBuffer(onnx) || onnx.length < 1_000_000) throw new VoiceError('Upload the .onnx model.', 400);
        const a = {
            baseModel: String(attestation.baseModel || '').slice(0, 200), baseSha256: String(attestation.baseSha256 || '').slice(0, 64),
            licence: String(attestation.licence || '').slice(0, 200), tool: String(attestation.tool || '').slice(0, 200),
            attestedBy: String(adminId), attestedAt: new Date(now()).toISOString(), onnxSha256: vcrypto.sha256(onnx),
        };
        if (!a.baseModel || !a.licence) throw new VoiceError('State the base model and its licence (attestation).', 400);
        const key = service.dataKey(v);
        let fixed;
        try { fixed = fixModelJson(Buffer.isBuffer(json) ? json.toString('utf8') : String(json), { ownerId: v.owner_user_id, tuning: v.tuning }); } catch { throw new VoiceError('The .onnx.json is not valid JSON.', 400); }
        await files.writeModel(v.id, a.onnxSha256, vcrypto.seal(onnx, key, v.id));
        await files.removeOtherModels(v.id, a.onnxSha256);
        await store.cancelOpenJobs(v.id, 'a model supplied by the voice owner was uploaded');
        await store.updateVoice(v.id, { model_sha256: a.onnxSha256, model_json: fixed, model_source: 'owner_supplied', model_attestation: a, trained_at: 'NOW()',
            status: STATUS.REVIEW, user_approved_at: null, admin_approved_at: null, approved_at: null });
        await service.evict(v.id);
        await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'owner_model_uploaded', detail: a });
        return { ok: true, sha256: a.onnxSha256 };
    }

    async function setOptIn(actor, voiceId, which, on) { return service.setOptIn(actor, voiceId, which, on); }
    service.onOptIn((v) => { if (v?.legacy_voice_id) cache.delete(v.legacy_voice_id); });
    service.onDeleted((v) => onDelete(v));

    /** Discord servers where the reader may use this voice for other people (with the opt-in) besides the owner's own. */
    async function setReaderGuilds(adminId, voiceId, guildIds) {
        const v = await voiceOr404(voiceId);
        const ids = [...new Set((guildIds || []).map(String).filter((g) => /^\d{15,20}$/.test(g)))].slice(0, 50);
        const features = { ...(v.features || {}), readerGuilds: { ids, by: String(adminId), at: new Date(now()).toISOString() } };
        await store.updateVoice(v.id, { features });
        if (v.legacy_voice_id) cache.delete(v.legacy_voice_id);
        await event({ voiceId, userId: v.owner_user_id, actor: 'admin', event: 'reader_guilds_set', detail: { by: String(adminId), ids } });
        return { ok: true, ids };
    }

    async function rulesFor(name) {
        const k = String(name || '');
        const hit = cache.get(k);
        if (hit && now() - hit.at < 60_000) return hit.rules;
        let rules = null;
        try {
            const v = await store.voiceByLegacy(k);
            if (v) rules = { voiceId: v.id, ownerUserId: String(v.owner_user_id), status: v.status, viewerText: viewerTextOn(v.features) && v.status !== STATUS.SUSPENDED, iSaid: iSaidOn(v.features), wmId: v.wm_id,
                readerGuilds: Array.isArray(v.features?.readerGuilds?.ids) ? v.features.readerGuilds.ids.map(String) : [] };
        } catch { rules = null; }
        cache.set(k, { at: now(), rules });
        return rules;
    }

    async function legacyModelPath(legacyVoiceId) {
        const base = piperModelsDir;
        for (const locale of await fs.readdir(base).catch(() => [])) {
            const dir = path.join(base, locale, legacyVoiceId);
            try { await fs.access(dir); return dir; } catch { /* next */ }
        }
        return null;
    }

    async function onDelete(v) {
        if (!v?.legacy_voice_id) return null;
        cache.delete(v.legacy_voice_id);
        const dir = await legacyModelPath(v.legacy_voice_id);
        if (dir) {
            for (const f of await fs.readdir(dir, { recursive: true }).catch(() => [])) if (String(f).endsWith('.onnx')) { try { piper.stop(path.join(dir, f)); } catch { /* not running */ } }
            await fs.rm(dir, { recursive: true, force: true });
        }
        await fs.rm(path.join(piperModelsDir, 'previews', `${v.legacy_voice_id}.wav`), { force: true });
        log('info', 'legacy piper voice removed with its record', { voiceId: v.id, legacy: v.legacy_voice_id });
        return dir;
    }

    async function adminSample(voiceId, which, text) {
        const v = await voiceOr404(voiceId);
        const words = String(text || 'Hello everyone, welcome back to the stream.').replace(/\s+/g, ' ').trim().slice(0, 300);
        let modelPath;
        if (which === 'current') {
            const dir = v.legacy_voice_id ? await legacyModelPath(v.legacy_voice_id) : null;
            const onnx = dir ? (await fs.readdir(dir, { recursive: true })).find((f) => String(f).endsWith('.onnx')) : null;
            if (!onnx) throw new VoiceError('No current voice file.', 404);
            modelPath = path.join(dir, onnx);
        } else {
            if (!v.model_sha256 || !v.model_json) throw new VoiceError('No new model yet.', 404);
            const onnx = vcrypto.open(await files.readModel(v.id, v.model_sha256), service.dataKey(v), v.id);
            modelPath = await files.shmModel(v.id, v.model_sha256, onnx, v.model_json);
        }
        const t = tuningFor(v.tuning || {});
        const file = await piper.speak(words, modelPath, { lengthScale: t.lengthScale, noiseScale: t.noiseScale, noiseW: t.noiseW });
        try { return await sidecar.watermark(await fs.readFile(file), v.wm_id); } finally { fs.unlink(file).catch(() => {}); }
    }

    return { createLegacyVoice, recordWrittenConsent, addEvidence, attestLegacy, setReaderGuilds, importLegacySamples, queueLegacyTraining, uploadOwnerModel, setOptIn, rulesFor, onDelete, adminSample, evidenceDir };
}

export default { createLegacy, LEGACY_MIN_MINUTES };
