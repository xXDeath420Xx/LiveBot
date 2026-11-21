/*
 * Own-voice feature (invite-only): the rules, in one place. Routes (dashboard/routes/voice-clone.js), the worker API
 * (worker-api.js), synthesis (synth.js) and /privacy (core/privacy-manager.js) all go through this.
 *
 *   createVoiceCloneService({ store, files, sidecar, transcribe, decode, logger, ownerLive, prompts, now })
 *
 * The person:   state(user) · signConsent(user, body, req) · startChallenge(user) · submitChallengeClip(user, index, audio)
 *               nextPrompt(user) · addTake(user, promptIndex, audio) · removeTake(user, sampleId) · startTraining(user)
 *               cancelTraining(user) · approve(user) · saveSettings(user, body) · deleteVoice(voiceId, opts)
 * The owner:    listInvites · invite · revokeInvite · adminOverview · adminApprove · adminAllowTraining · suspend · unsuspend
 *               detectClip(audio)
 * The worker:   used by worker-api.js (lease, dataset, heartbeat, artifact, fail, purged)
 * Housekeeping: runJanitor()
 *
 * Every decision about a person's voice is written to voice_clone_events. Errors meant for the person are thrown as
 * VoiceError (message in plain words, status for the HTTP answer).
 */
import crypto from 'node:crypto';
import { STATUS, LIMITS, BASE_MODEL, OPEN_JOB_STATES } from './constants.js';
import { CONSENT_VERSION, CONSENT_SHA256 } from './consent-text.js';
import { inviteGate, regionGate, validateConsentForm } from './gate.js';
import { makeChallenge, checkReading, checkScriptTake } from './challenge.js';
import { centroids, loadThresholds, consentConsistency, sampleDecision, trainingDecision, crossAccountMatch, scores, bothAtLeast } from './scoring.js';
import * as vcrypto from './crypto.js';

export class VoiceError extends Error {
    constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const SPEED = Object.freeze({ slower: 1.15, normal: 1.0, faster: 0.9 });
const CLARITY = Object.freeze({ clean: { noiseScale: 0.45, noiseW: 0.6 }, natural: { noiseScale: 0.667, noiseW: 0.8 } });
export const TUNING_CHOICES = Object.freeze({ speed: Object.keys(SPEED), clarity: Object.keys(CLARITY) });

export function tuningFor({ speed = 'normal', clarity = 'clean' } = {}) {
    const s = SPEED[speed] ? speed : 'normal';
    const c = CLARITY[clarity] ? clarity : 'clean';
    return { speed: s, clarity: c, lengthScale: SPEED[s], ...CLARITY[c] };
}

const newVoiceId = () => `vc${crypto.randomBytes(12).toString('hex')}`;

export function createVoiceCloneService({
    store, files, sidecar, transcribe, decode, logger = null, ownerLive = async () => true, prompts = [], now = () => Date.now(),
    thresholds = () => loadThresholds(), env = process.env,
} = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[VoiceClone] ${msg}`, meta); } catch { /* ignore */ } };
    const challenges = new Map();     // userId -> { sentences, expiresAt, results: [], voiceId }
    const busy = new Map();           // userId -> Promise (one heavy check at a time per person)
    let heavy = 0;                    // server-wide: at most 2 recordings analysed at once

    const event = (e) => store.addEvent(e).catch((err) => log('warn', 'event not written', { error: err?.message }));

    async function oneAtATime(userId, fn) {
        if (busy.has(userId)) throw new VoiceError('Still checking your last recording. Wait a moment and try again.', 429);
        if (heavy >= 2) throw new VoiceError('The server is checking other recordings. Try again in a few seconds.', 429);
        heavy++;
        const p = Promise.resolve().then(fn);
        busy.set(userId, p);
        try { return await p; } finally { heavy--; busy.delete(userId); }
    }

    function dataKey(voice) {
        try { return vcrypto.unwrapKey(voice.data_key_encrypted, voice.id, env); } catch { throw new VoiceError('This voice has no key any more (it was deleted).', 410); }
    }
    function consentCentroids(voice, key = dataKey(voice)) {
        if (!voice.centroid_encrypted) return null;
        return vcrypto.openJson(voice.centroid_encrypted, key, voice.id);
    }

    async function requireInvite(userId) {
        const g = inviteGate(await store.getInvite(userId));
        if (!g.ok) throw new VoiceError(g.reason, 403, { code: 'not_invited' });
    }
    async function requireVoice(userId, statuses = null) {
        await requireInvite(userId);
        const v = await store.liveVoiceOf(userId);
        if (!v) throw new VoiceError('You have no voice yet. Start on the Your voice page.', 404);
        if (statuses && !statuses.includes(v.status)) throw new VoiceError(statusMessage(v.status), 409);
        return v;
    }
    function statusMessage(status) {
        return ({
            draft: 'Finish the live check first.',
            consent_ok: 'Your voice is not trained yet.',
            queued: 'Your voice is waiting to be trained.',
            training: 'Your voice is being trained.',
            review: 'Your voice is waiting for approval.',
            active: 'Your voice is already in use.',
            suspended: 'Your voice is suspended. Contact support@certifriedmultitool.com.',
        })[status] || 'That cannot be done right now.';
    }

    // ── what the page shows ──

    async function state(user) {
        const userId = String(user.id);
        const invite = await store.getInvite(userId);
        const gate = inviteGate(invite);
        const out = { invited: gate.ok, inviteReason: gate.reason, consentVersion: CONSENT_VERSION, kek: vcrypto.kekAvailable(env), voice: null };
        if (!gate.ok) return out;
        out.sidecar = await sidecar.health();
        const v = await store.liveVoiceOf(userId);
        if (!v) { out.atCapacity = (await store.countLive()) >= LIMITS.voicesTotal; return out; }
        const summary = await store.sampleSummary(v.id);
        const job = await store.latestJobFor(v.id);
        const lock = await consentLockout(userId);
        out.voice = {
            id: v.id, status: v.status, displayName: v.display_name, createdAt: v.created_at, approvedAt: v.approved_at, lastUsedAt: v.last_used_at,
            userApproved: !!v.user_approved_at, adminApproved: !!v.admin_approved_at, reviewNote: v.review_note, keepSamples: !!v.keep_samples,
            tuning: tuningFor(v.tuning || {}), features: { automations: !!v.features?.automations },
            minutes: Math.round(summary.ms / 600) / 100, takes: summary.count,
            needMinutes: LIMITS.minTrainingMinutes, maxMinutes: LIMITS.maxTrainingMinutes,
            samplesExpireAt: summary.firstAt ? new Date(new Date(summary.firstAt).getTime() + LIMITS.sampleRetentionDays * 86400_000) : null,
            job: job ? {
                state: job.state, step: job.step, totalSteps: job.total_steps, etaS: job.eta_s, pauseReason: job.pause_reason, error: job.error,
                purged: !!job.purge_receipt_at, ahead: OPEN_JOB_STATES.includes(job.state) ? await store.queuePosition(job.id) : 0, createdAt: job.created_at,
            } : null,
            consentLockedUntil: lock.lockedUntil, consentAttemptsLeft: lock.left,
            legacy: !!v.legacy_voice_id, consentMethod: (await store.consentById(v.consent_id))?.consent_method || 'live_check',
            viewerText: v.features?.viewerText?.on === true, iSaid: v.features?.iSaid?.on ?? (v.features?.viewerText?.on === true),
        };
        return out;
    }

    // ── consent ──

    async function signConsent(user, body, req = {}) {
        const userId = String(user.id);
        await requireInvite(userId);
        if (!vcrypto.kekAvailable(env)) throw new VoiceError('Your voice is not switched on on this server yet (no encryption key).', 503);
        if (await store.liveVoiceOf(userId)) throw new VoiceError('You already have a voice. Delete it first to start again.', 409);
        if ((await store.countLive()) >= LIMITS.voicesTotal) throw new VoiceError('No more voices can be made right now.', 409);
        const form = validateConsentForm(body);
        if (!form.ok) throw new VoiceError(form.errors.join(' '), 400, { errors: form.errors });
        const region = regionGate({ state: form.value.state, cfCountry: req.cfCountry, cfRegion: req.cfRegion });
        if (!region.ok) {
            await event({ userId, actor: 'user', event: 'consent_region_blocked', detail: { code: region.code, state: form.value.state, cfCountry: req.cfCountry || null, cfRegion: req.cfRegion || null } });
            throw new VoiceError(region.reason, 403, { code: region.code });
        }
        const th = thresholds();
        const voiceId = newVoiceId();
        const key = vcrypto.newDataKey();
        let wmId = null;
        for (let i = 0; i < 50 && wmId == null; i++) {
            const n = crypto.randomInt(1, 0xFFFF);
            if (!(await store.wmTaken(n))) wmId = n;
        }
        if (wmId == null) throw new VoiceError('Could not reserve a watermark for the voice. Try again.', 500);
        const consentId = await store.addConsent({
            userId, voiceId, textVersion: CONSENT_VERSION, textSha256: CONSENT_SHA256,
            typedNameEncrypted: vcrypto.sealJson({ name: form.value.typedName }, key, voiceId),
            ageAttested: true, ownVoiceAttested: true, state: form.value.state, cfCountry: req.cfCountry || null, cfRegion: req.cfRegion || null,
            ipHash: req.ip ? vcrypto.ipHash(req.ip, env) : null, keepSamples: form.value.keepSamples, thresholdVersion: th.version,
        });
        try {
            await store.createVoice({
                id: voiceId, ownerUserId: userId, displayName: String(user.global_name || user.username || 'My voice').slice(0, 60), baseModel: BASE_MODEL.sha256,
                dataKeyEncrypted: vcrypto.wrapKey(key, voiceId, env), wmId, tuning: { speed: 'normal', clarity: 'clean' }, features: { automations: false },
                consentId, keepSamples: form.value.keepSamples,
            });
        } catch (err) {
            await store.revokeConsents({ voiceId, reason: 'not_created' });
            if (/Duplicate/i.test(err?.message || '')) throw new VoiceError('You already have a voice. Delete it first to start again.', 409);
            throw err;
        }
        await event({ voiceId, userId, actor: 'user', event: 'consent_signed', detail: { consentId, version: CONSENT_VERSION, state: form.value.state, keepSamples: form.value.keepSamples } });
        return { voiceId, consentId };
    }

    async function consentLockout(userId) {
        const today = await store.countEvents({ userId, event: 'consent_check_failed', hours: 24 })
            + await store.countEvents({ userId, event: 'consent_check_passed', hours: 24 });
        const last = await store.lastEvents({ userId, events: ['consent_check_failed', 'consent_check_passed'], limit: LIMITS.consentLockoutAfterFails });
        const threeFails = last.length >= LIMITS.consentLockoutAfterFails && last.every((e) => e.event === 'consent_check_failed');
        const lockedUntil = threeFails ? new Date(new Date(last[0].created_at).getTime() + 86400_000) : null;
        return {
            left: Math.max(0, LIMITS.consentAttemptsPerDay - today),
            lockedUntil: lockedUntil && lockedUntil.getTime() > now() ? lockedUntil : null,
        };
    }

    async function startChallenge(user) {
        const userId = String(user.id);
        const v = await requireVoice(userId, [STATUS.DRAFT]);
        if (v.legacy_voice_id) throw new VoiceError('Your consent is on file; there is no live check for this voice.', 409);
        const lock = await consentLockout(userId);
        if (lock.lockedUntil) throw new VoiceError('The live check did not match three times in a row, so it is paused for a day.', 429, { lockedUntil: lock.lockedUntil });
        if (lock.left <= 0) throw new VoiceError('You have used today\'s 5 live checks. Try again tomorrow.', 429);
        if (!(await sidecar.health())) throw new VoiceError('The voice checker is not running right now. Try again later.', 503);
        const c = makeChallenge();
        challenges.set(userId, { voiceId: v.id, sentences: c.sentences, expiresAt: now() + LIMITS.challengeTtlMs, results: [] });
        return { sentences: c.sentences.map((s) => s.text), expiresInMs: LIMITS.challengeTtlMs };
    }

    async function analyse(audio, { minS = LIMITS.clipMinSeconds, maxS = LIMITS.clipMaxSeconds } = {}) {
        if (!Buffer.isBuffer(audio) || !audio.length) throw new VoiceError('The recording was empty.', 400);
        if (audio.length > LIMITS.clipMaxBytes) throw new VoiceError('That recording is too long.', 413);
        let w16;
        try { w16 = await decode(audio, { rate: 16000 }); } catch { throw new VoiceError('That recording could not be read. Record it again.', 400); }
        const emb = await sidecar.embed(w16).catch((err) => {
            if (err?.status === 400) throw new VoiceError('That recording was too short.', 400);
            throw new VoiceError('The voice checker failed. Try again in a minute.', 503);
        });
        if (emb.duration_s < minS) throw new VoiceError('That recording was too short. Read the whole sentence.', 400, { reasonCode: 'short' });
        if (emb.duration_s > maxS) throw new VoiceError('That recording was too long. Read just the one sentence.', 400, { reasonCode: 'long' });
        const wm = await sidecar.detect(w16).catch(() => null);
        if (!wm) throw new VoiceError('The voice checker failed. Try again in a minute.', 503);
        const text = await transcribe(w16).catch(() => null);
        if (text == null) throw new VoiceError('Speech recognition is not running right now. Try again later.', 503);
        return { w16, emb, wm, text };
    }

    async function submitChallengeClip(user, index, audio) {
        const userId = String(user.id);
        const v = await requireVoice(userId, [STATUS.DRAFT]);
        const ch = challenges.get(userId);
        if (!ch || ch.voiceId !== v.id) throw new VoiceError('Start the live check again.', 409);
        if (now() > ch.expiresAt) { challenges.delete(userId); throw new VoiceError('The live check timed out (2 minutes). Start it again.', 409); }
        if (Number(index) !== ch.results.length || index > 2) throw new VoiceError('Record the sentences in order.', 409);
        const sentence = ch.sentences[index];
        return oneAtATime(userId, async () => {
            const a = await analyse(audio, { minS: 1.2, maxS: 20 });
            const reading = checkReading(sentence, a.text);
            const marked = a.wm.prob >= 0.5;
            ch.results.push({ reading, marked, emb: { redimnet: a.emb.redimnet, ecapa: a.emb.ecapa }, clip: a.emb.clip_ratio });
            if (ch.results.length < 3) return { done: false, next: ch.results.length, heard: reading.heard, ok: reading.ok && !marked };
            challenges.delete(userId);
            return finishChallenge(user, v, ch);
        });
    }

    async function finishChallenge(user, v, ch) {
        const userId = String(user.id);
        const th = thresholds();
        const reasons = [];
        if (ch.results.some((r) => r.marked)) reasons.push('one of the recordings carries CertiFried\'s watermark (it was made by a cloned voice)');
        const misread = ch.results.filter((r) => !r.reading.ok);
        if (misread.length) reasons.push(`${misread.length === 1 ? 'one sentence was' : `${misread.length} sentences were`} not heard as shown, or the four numbers did not match`);
        const embs = ch.results.map((r) => r.emb);
        const consistency = consentConsistency(embs, th);
        if (!consistency.ok) reasons.push('the three recordings do not sound like one person');
        const cc = centroids(embs);
        let cross = null;
        if (!reasons.length) {
            cross = await crossAccountCheck(cc, userId);
            if (cross) reasons.push('this voice is too close to a voice that belongs to another account');
        }
        const wer = Math.round((ch.results.reduce((s, r) => s + r.reading.wer, 0) / 3) * 1000) / 1000;
        const minPair = { redimnet: Math.min(...consistency.pairs.map((p) => p.redimnet)), ecapa: Math.min(...consistency.pairs.map((p) => p.ecapa)) };
        if (reasons.length) {
            await event({ voiceId: v.id, userId, actor: 'system', event: 'consent_check_failed', detail: { reasons, wer, minPair, cross: cross ? { voiceId: cross.voiceId, scores: cross.scores } : null, thresholdVersion: th.version } });
            if (cross) await event({ voiceId: v.id, userId, actor: 'system', event: 'cross_account_match', detail: { otherVoiceId: cross.voiceId, scores: cross.scores } });
            const lock = await consentLockout(userId);
            return { done: true, passed: false, reasons, attemptsLeft: lock.left, lockedUntil: lock.lockedUntil };
        }
        const key = dataKey(v);
        await store.updateVoice(v.id, { centroid_encrypted: vcrypto.sealJson({ consent: cc, thresholdVersion: th.version }, key, v.id), status: STATUS.CONSENT_OK });
        await store.verifyConsent(v.consent_id, { wer, redimnet: minPair.redimnet, ecapa: minPair.ecapa, thresholdVersion: th.version });
        await event({ voiceId: v.id, userId, actor: 'system', event: 'consent_check_passed', detail: { wer, minPair, thresholdVersion: th.version } });
        return { done: true, passed: true };
    }

    async function crossAccountCheck(cc, userId) {
        const others = [];
        for (const row of await store.voicesWithCentroid()) {
            if (String(row.owner_user_id) === String(userId)) continue;
            try {
                const k = vcrypto.unwrapKey(row.data_key_encrypted, row.id, env);
                others.push({ voiceId: row.id, ownerUserId: row.owner_user_id, centroids: vcrypto.openJson(row.centroid_encrypted, k, row.id).consent });
            } catch { /* deleted under us */ }
        }
        return crossAccountMatch(cc, others, userId, thresholds());
    }

    // ── recording ──

    async function nextPrompt(user) {
        const v = await requireVoice(String(user.id), [STATUS.CONSENT_OK, STATUS.REVIEW, STATUS.ACTIVE]);
        const taken = new Set((await store.listSamples(v.id, { kind: 'recorded' })).filter((s) => s.status === 'ok').map((s) => s.prompt_index));
        let i = 0;
        while (taken.has(i) && i < prompts.length) i++;
        if (i >= prompts.length) i = Math.floor(Math.random() * prompts.length);
        return { index: i, text: prompts[i], total: prompts.length };
    }

    async function addTake(user, promptIndex, audio) {
        const userId = String(user.id);
        const v = await requireVoice(userId, [STATUS.CONSENT_OK, STATUS.REVIEW, STATUS.ACTIVE]);
        const idx = Number(promptIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= prompts.length) throw new VoiceError('Unknown sentence. Reload the page.', 400);
        const summary = await store.sampleSummary(v.id);
        if (summary.ms >= LIMITS.maxTrainingMinutes * 60_000) throw new VoiceError('You have recorded the 60 minutes a voice can use.', 409);
        return oneAtATime(userId, async () => {
            const a = await analyse(audio);
            const key = dataKey(v);
            const cc = consentCentroids(v, key)?.consent;
            if (!cc) throw new VoiceError('Finish the live check first.', 409);
            const checks = { clip: a.emb.clip_ratio, rmsDb: a.emb.rms_db, wm: a.wm.prob };
            let reason = null;
            if (a.wm.prob >= 0.5) reason = 'This recording carries CertiFried\'s watermark, so it was made by a cloned voice.';
            else if (a.emb.clip_ratio > 0.005) reason = 'Too loud: the sound clipped. Move back from the mic a little.';
            else if (a.emb.rms_db < -38) reason = 'Too quiet. Move closer to the mic.';
            const take = checkScriptTake(prompts[idx], a.text);
            if (!reason && !take.ok) reason = 'That did not sound like the sentence shown. Read it again, word for word.';
            const dec = sampleDecision(a.emb, cc, thresholds());
            if (!reason && dec.decision !== 'ok') reason = 'This does not sound like your live check. Record it again in the same room and mic.';
            const base = { voiceId: v.id, kind: 'recorded', promptIndex: idx, promptText: prompts[idx], durationMs: a.emb.duration_s * 1000, asrWer: take.wer,
                scoreRedimnet: dec.scores.redimnet, scoreEcapa: dec.scores.ecapa };
            if (reason) {
                await store.addSample({ ...base, checks, status: 'rejected', reason: reason.slice(0, 160) });
                return { ok: false, reason, summary: await store.sampleSummary(v.id) };
            }
            const wav = await decode(audio, { rate: 22050, trim: true });
            checks.embSealed = vcrypto.sealJson({ redimnet: a.emb.redimnet, ecapa: a.emb.ecapa }, key, v.id);
            const id = await store.addSample({ ...base, sha256: vcrypto.sha256(wav), checks, status: 'ok' });
            const fileName = await files.writeSample(v.id, id, vcrypto.seal(wav, key, v.id));
            await store.setSampleFile(v.id, id, fileName);
            return { ok: true, sampleId: id, summary: await store.sampleSummary(v.id) };
        });
    }

    async function removeTake(user, sampleId) {
        const v = await requireVoice(String(user.id), [STATUS.CONSENT_OK, STATUS.REVIEW, STATUS.ACTIVE]);
        const s = (await store.listSamples(v.id)).find((x) => Number(x.id) === Number(sampleId));
        if (!s) throw new VoiceError('No such recording.', 404);
        if (s.file_name) await files.removeSample(v.id, s.file_name);
        await store.deleteSample(v.id, s.id);
        return { ok: true, summary: await store.sampleSummary(v.id) };
    }

    // ── training ──

    async function startTraining(user) {
        const userId = String(user.id);
        const v = await requireVoice(userId, [STATUS.CONSENT_OK, STATUS.REVIEW, STATUS.ACTIVE]);
        if (await store.openJobFor(v.id)) throw new VoiceError('Your voice is already waiting to be trained.', 409);
        const summary = await store.sampleSummary(v.id);
        if (summary.ms < LIMITS.minTrainingMinutes * 60_000) throw new VoiceError(`Record at least ${LIMITS.minTrainingMinutes} minutes first.`, 409);
        if ((await store.runsInDays(v.id, 30)) >= LIMITS.trainingRunsPer30Days) throw new VoiceError('A voice can be trained 3 times in 30 days.', 429);
        const key = dataKey(v);
        const cc = consentCentroids(v, key)?.consent;
        const embs = (await store.listSamples(v.id, { kind: 'recorded' })).filter((s) => s.status === 'ok' && s.checks?.embSealed)
            .map((s) => { try { return vcrypto.openJson(s.checks.embSealed, key, v.id); } catch { return null; } }).filter(Boolean);
        const dec = trainingDecision(centroids(embs), cc, thresholds());
        if (dec.decision === 'fail') {
            await event({ voiceId: v.id, userId, actor: 'system', event: 'training_refused', detail: { scores: dec.scores } });
            throw new VoiceError('Your recordings as a whole do not match your live check closely enough. Record again in the room and with the mic you used for the live check.', 409);
        }
        if (dec.decision === 'review' && !v.review_note?.startsWith('allowed:')) {
            await store.updateVoice(v.id, { review_note: `review: recordings centroid ${dec.scores.redimnet}/${dec.scores.ecapa}` });
            await event({ voiceId: v.id, userId, actor: 'system', event: 'training_needs_review', detail: { scores: dec.scores } });
            throw new VoiceError('Your recordings need a quick check by the CertiFried owner before training. You will see it here once that is done.', 409, { code: 'review' });
        }
        const jobId = await store.createJob(v.id, LIMITS.trainSteps);
        await store.setVoiceStatus(v.id, STATUS.QUEUED);
        await event({ voiceId: v.id, userId, actor: 'user', event: 'training_queued', detail: { jobId, minutes: Math.round(summary.ms / 60000), scores: dec.scores } });
        return { jobId };
    }

    async function cancelTraining(user) {
        const userId = String(user.id);
        const v = await requireVoice(userId, [STATUS.QUEUED, STATUS.TRAINING]);
        const n = await store.cancelOpenJobs(v.id, 'cancelled by the voice owner');
        await store.setVoiceStatus(v.id, v.model_sha256 ? STATUS.REVIEW : STATUS.CONSENT_OK);
        await event({ voiceId: v.id, userId, actor: 'user', event: 'training_cancelled', detail: { jobs: n } });
        return { ok: true };
    }

    async function maybeActivate(voiceId) {
        const v = await store.voiceById(voiceId);
        if (v?.status === STATUS.REVIEW && v.user_approved_at && v.admin_approved_at) {
            await store.updateVoice(voiceId, { status: STATUS.ACTIVE, approved_at: 'NOW()' });
            await event({ voiceId, userId: v.owner_user_id, actor: 'system', event: 'voice_active' });
            return true;
        }
        return false;
    }

    async function approve(user) {
        const v = await requireVoice(String(user.id), [STATUS.REVIEW]);
        await store.updateVoice(v.id, { user_approved_at: 'NOW()' });
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'user', event: 'voice_user_approved' });
        return { active: await maybeActivate(v.id) };
    }

    async function saveSettings(user, body = {}) {
        const v = await requireVoice(String(user.id));
        if (v.status === STATUS.SUSPENDED) throw new VoiceError(statusMessage(v.status), 409);
        const tuning = tuningFor({ speed: body.speed ?? v.tuning?.speed, clarity: body.clarity ?? v.tuning?.clarity });
        const features = { ...(v.features || {}), automations: body.automations === undefined ? !!v.features?.automations : body.automations === true };
        const keep = body.keepSamples === undefined ? !!v.keep_samples : body.keepSamples === true;
        await store.updateVoice(v.id, { tuning: { ...(v.tuning || {}), speed: tuning.speed, clarity: tuning.clarity }, features, keep_samples: keep ? 1 : 0 });
        for (const which of ['viewerText', 'iSaid']) {
            if (typeof body[which] === 'boolean') await setOptIn({ userId: String(user.id), role: 'voice_owner' }, v.id, which, body[which]);
        }
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'user', event: 'voice_settings', detail: { tuning: { speed: tuning.speed, clarity: tuning.clarity }, features, keepSamples: keep } });
        return { ok: true, tuning, features, keepSamples: keep };
    }

    // ── the voice owner's opt-ins (policy.js): other people's text in their own places; "I said" in the reader ──
    const optInListeners = new Set();
    async function setOptIn(actor, voiceId, which, on) {
        if (!['viewerText', 'iSaid'].includes(which)) throw new VoiceError('Unknown setting.', 400);
        const v = await store.voiceById(voiceId);
        if (!v || v.status === STATUS.DELETED) throw new VoiceError('No such voice.', 404);
        const isOwner = String(actor?.userId) === String(v.owner_user_id);
        if (!isOwner && actor?.role !== 'admin') throw new VoiceError('Only the voice’s owner can change this.', 403);
        const features = { ...(v.features || {}), [which]: { on: on === true, by: String(actor.userId), role: isOwner ? 'voice_owner' : 'admin', at: new Date(now()).toISOString() } };
        await store.updateVoice(v.id, { features });
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: isOwner ? 'user' : 'admin', event: `optin_${which}`, detail: { on: on === true, by: String(actor.userId) } });
        for (const fn of optInListeners) { try { fn(v); } catch { /* ignore */ } }
        return { ok: true, features };
    }

    // ── deletion (design 2.7, 3.3): synthesis stops at once, files go now, backups age out within 7 days ──

    const deleteHooks = new Set();   // legacy.js registers: remove a legacy piper_models voice with its record
    const evictors = new Set();   // synth.js registers: (voiceId) => drop warm workers and /dev/shm copies
    const onEvict = (fn) => { evictors.add(fn); return () => evictors.delete(fn); };
    async function evict(voiceId) {
        for (const fn of evictors) { try { await fn(voiceId); } catch (err) { log('warn', 'evict failed', { error: err?.message }); } }
        await files.wipeShm(voiceId).catch(() => 0);
    }

    async function deleteVoice(voiceId, { actor = 'user', reason = 'user_request', byUserId = null } = {}) {
        const v = await store.voiceById(voiceId);
        if (!v) throw new VoiceError('No such voice.', 404);
        if (v.status === STATUS.DELETED && v.files_removed_at) return { alreadyDeleted: true, deletedAt: v.deleted_at };
        // 1. stop: nothing resolves a deleted voice (synth.js reads the status on every call)
        await store.updateVoice(v.id, { status: STATUS.DELETED, deleted_at: v.deleted_at ? v.deleted_at : 'NOW()', delete_reason: String(reason).slice(0, 40) });
        await evict(v.id);
        // 2. a training job stops at its next heartbeat; the worker wipes its folders and sends a purge receipt
        const jobs = await store.cancelOpenJobs(v.id, 'voice deleted');
        challenges.delete(String(v.owner_user_id));
        // 3. files, keys and voiceprints
        const dirExisted = await files.removeVoiceDir(v.id);
        for (const fn of deleteHooks) { try { await fn(v); } catch (err) { log('warn', 'delete hook failed', { error: err?.message }); } }
        const purged = await store.markSamplesPurged(v.id);
        await store.updateVoice(v.id, { data_key_encrypted: null, centroid_encrypted: null, model_json: null, files_removed_at: 'NOW()' });
        await store.revokeConsents({ voiceId: v.id, reason: String(reason).slice(0, 40) });
        const at = new Date(now());
        const detail = { reason, jobsCancelled: jobs, samplesPurged: purged, dirExisted, backupsExpireBy: new Date(at.getTime() + LIMITS.deletionBackupDays * 86400_000) };
        await event({ voiceId: v.id, userId: byUserId || v.owner_user_id, actor, event: 'voice_deleted', detail });
        log('info', 'voice deleted', { voiceId: v.id, actor, reason });
        return { deletedAt: at, filesRemovedAt: at, backupsExpireBy: detail.backupsExpireBy, jobsCancelled: jobs };
    }

    async function deleteOwn(user, { confirm }) {
        if (String(confirm || '').trim().toLowerCase() !== 'delete') throw new VoiceError('Type delete to confirm.', 400);
        const v = await store.liveVoiceOf(String(user.id));
        if (!v) throw new VoiceError('You have no voice to delete.', 404);
        return deleteVoice(v.id, { actor: 'user', reason: 'user_request', byUserId: user.id });
    }

    /** /privacy delete and account deletion. */
    async function deleteAllForUser(userId, reason = 'privacy_delete') {
        const v = await store.liveVoiceOf(String(userId));
        let deleted = 0;
        if (v) { await deleteVoice(v.id, { actor: 'user', reason, byUserId: userId }); deleted = 1; }
        await store.revokeConsents({ userId, reason });
        return { voices: deleted };
    }

    async function exportFor(userId) {
        const v = await store.liveVoiceOf(String(userId));
        const consents = (await store.consentsOf(userId)).map((c) => ({
            id: c.id, textVersion: c.text_version, textSha256: c.text_sha256, state: c.residence_state, ageAttested: !!c.age_attested,
            signedAt: c.created_at, liveCheckPassedAt: c.verified_at, withdrawnAt: c.revoked_at, withdrawReason: c.revoke_reason,
        }));
        if (!v) return { voice: null, samples: [], consents };
        const samples = (await store.listSamples(v.id)).map((s) => ({ id: s.id, recordedAt: s.created_at, durationMs: s.duration_ms, status: s.status, sentence: s.prompt_text, purgedAt: s.purged_at }));
        return {
            voice: { id: v.id, status: v.status, createdAt: v.created_at, trainedAt: v.trained_at, approvedAt: v.approved_at, lastUsedAt: v.last_used_at, keepSamples: !!v.keep_samples, features: v.features },
            samples, consents,
            note: 'The voice model, the voiceprints and the encryption keys are never exported.',
        };
    }

    // ── owner (super-admin) ──

    async function invite(adminId, userId, note = null) {
        if (!/^\d{15,20}$/.test(String(userId))) throw new VoiceError('Enter a Discord user ID (15 to 20 digits).', 400);
        await store.addInvite(String(userId), String(adminId), note ? String(note).slice(0, 200) : null);
        await event({ userId, actor: 'admin', event: 'invite_added', detail: { by: String(adminId), note } });
        return { ok: true };
    }
    async function revokeInvite(adminId, userId, { deleteVoiceToo = true } = {}) {
        const ok = await store.revokeInvite(String(userId), String(adminId));
        await event({ userId, actor: 'admin', event: 'invite_revoked', detail: { by: String(adminId) } });
        let deleted = null;
        if (deleteVoiceToo) {
            const v = await store.liveVoiceOf(String(userId));
            if (v) deleted = await deleteVoice(v.id, { actor: 'admin', reason: 'invite_revoked', byUserId: adminId });
        }
        return { ok, deleted };
    }
    async function adminOverview() {
        const voices = [];
        for (const v of await store.listVoices()) {
            const c = v.consent_id ? await store.consentById(v.consent_id) : null;
            voices.push({
                id: v.id, owner: v.owner_user_id, name: v.display_name, status: v.status, wmId: v.wm_id, createdAt: v.created_at, trainedAt: v.trained_at,
                userApproved: !!v.user_approved_at, adminApproved: !!v.admin_approved_at, lastUsedAt: v.last_used_at, deletedAt: v.deleted_at, reviewNote: v.review_note,
                deleteReason: v.delete_reason, legacyVoiceId: v.legacy_voice_id || null, modelSource: v.model_source || 'trained', hasModel: !!v.model_sha256,
                viewerText: v.features?.viewerText || null, iSaid: v.features?.iSaid || null,
                consent: c ? { method: c.consent_method, complete: !!c.verified_at, attested: !!c.attested_by, state: c.residence_state, withdrawn: !!c.revoked_at,
                    channel: c.consent_channel, givenAt: c.consent_given_at, evidence: (c.evidence || []).map((e) => e.sha256) } : null,
            });
        }
        return { invites: await store.listInvites(), voices, jobs: await store.listJobs(30), events: await store.listEvents({ limit: 60 }), thresholds: thresholds().version };
    }
    async function adminApprove(adminId, voiceId) {
        const v = await store.voiceById(voiceId);
        if (!v || v.status !== STATUS.REVIEW) throw new VoiceError('That voice is not waiting for approval.', 409);
        await store.updateVoice(v.id, { admin_approved_at: 'NOW()' });
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'admin', event: 'voice_admin_approved', detail: { by: String(adminId) } });
        return { active: await maybeActivate(v.id) };
    }
    async function adminAllowTraining(adminId, voiceId) {
        const v = await store.voiceById(voiceId);
        if (!v || !v.review_note?.startsWith('review:')) throw new VoiceError('That voice is not waiting for a check.', 409);
        await store.updateVoice(v.id, { review_note: `allowed: ${v.review_note.slice(8, 200)}` });
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'admin', event: 'training_review_allowed', detail: { by: String(adminId) } });
        return { ok: true };
    }
    async function suspend(adminId, voiceId, note = null) {
        const v = await store.voiceById(voiceId);
        if (!v || v.status === STATUS.DELETED) throw new VoiceError('No such voice.', 404);
        await store.updateVoice(v.id, { status: STATUS.SUSPENDED, suspended_at: 'NOW()', review_note: note ? `suspended: ${String(note).slice(0, 180)}` : v.review_note });
        await evict(v.id);
        await store.cancelOpenJobs(v.id, 'voice suspended');
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'admin', event: 'voice_suspended', detail: { by: String(adminId), note } });
        return { ok: true };
    }
    async function unsuspend(adminId, voiceId) {
        const v = await store.voiceById(voiceId);
        if (!v || v.status !== STATUS.SUSPENDED) throw new VoiceError('That voice is not suspended.', 409);
        const back = v.approved_at ? STATUS.ACTIVE : (v.model_sha256 ? STATUS.REVIEW : (v.centroid_encrypted ? STATUS.CONSENT_OK : STATUS.DRAFT));
        await store.updateVoice(v.id, { status: back, suspended_at: null });
        await event({ voiceId: v.id, userId: v.owner_user_id, actor: 'admin', event: 'voice_unsuspended', detail: { by: String(adminId), status: back } });
        return { ok: true, status: back };
    }
    async function detectClip(audio) {
        if (!Buffer.isBuffer(audio) || !audio.length || audio.length > 10 * 1024 * 1024) throw new VoiceError('Upload a clip of at most 10 MB.', 400);
        let w16;
        try { w16 = await decodeAny(audio); } catch { throw new VoiceError('That file could not be read as audio.', 400); }
        const d = await sidecar.detect(w16);
        const marked = d.prob >= 0.5;
        const v = marked ? await store.voiceByWm(d.message) : null;
        return { madeByCertiFried: marked, confidence: d.prob, wmId: marked ? d.message : null,
            voice: v ? { id: v.id, owner: v.owner_user_id, status: v.status, name: v.display_name } : null };
    }
    async function decodeAny(audio) { return decode(audio, { rate: 16000, any: true }); }

    // ── housekeeping (every 10 minutes from index.js; the retention sweeper then removes old rows) ──

    async function purgeSamples(voiceId, { all }) {
        const rows = (await store.listSamples(voiceId)).filter((s) => s.status !== 'purged');
        const expired = new Set(await store.expiredSampleIds(voiceId, LIMITS.sampleRetentionDays));
        const target = all ? rows : rows.filter((s) => expired.has(Number(s.id)));
        for (const s of target) if (s.file_name) await files.removeSample(voiceId, s.file_name);
        const n = target.length ? await store.markSamplesPurged(voiceId, target.map((s) => Number(s.id))) : 0;
        if (n) await event({ voiceId, actor: 'system', event: 'samples_purged', detail: { count: n, rule: all ? '7 days after training' : '30-day cap' } });
        return n;
    }

    async function runJanitor() {
        const out = { samplesPurged: 0, idleDeleted: 0, draftsDeleted: 0 };
        for (const voiceId of await store.voicesWithSamplesToPurge(LIMITS.sampleRetentionDays, LIMITS.samplePurgeAfterTrainingDays)) {
            const v = await store.voiceById(voiceId);
            if (!v) continue;
            const afterTraining = !v.keep_samples && v.trained_at && (now() - new Date(v.trained_at).getTime()) > LIMITS.samplePurgeAfterTrainingDays * 86400_000
                && !(await store.openJobFor(v.id));
            out.samplesPurged += await purgeSamples(v.id, { all: !!afterTraining });
        }
        for (const voiceId of await store.idleVoices(LIMITS.voiceIdleDays)) {
            await deleteVoice(voiceId, { actor: 'system', reason: 'idle_365_days' });
            out.idleDeleted++;
        }
        for (const v of await store.listVoices()) {
            if (v.status === STATUS.DRAFT && now() - new Date(v.created_at).getTime() > 7 * 86400_000) {
                await deleteVoice(v.id, { actor: 'system', reason: 'live_check_not_finished' });
                out.draftsDeleted++;
            }
        }
        return out;
    }

    return {
        VoiceError, state, signConsent, startChallenge, submitChallengeClip, nextPrompt, addTake, removeTake, startTraining, cancelTraining,
        approve, saveSettings, deleteVoice, deleteOwn, deleteAllForUser, exportFor, invite, revokeInvite, adminOverview, adminApprove,
        adminAllowTraining, suspend, unsuspend, detectClip, onEvict, evict, runJanitor, purgeSamples, setOptIn,
        onDeleted: (fn) => { deleteHooks.add(fn); return () => deleteHooks.delete(fn); }, onOptIn: (fn) => { optInListeners.add(fn); return () => optInListeners.delete(fn); }, dataKey, consentCentroids, maybeActivate, statusMessage,
        thresholds, event, scoresAgainstConsent: (emb, cc) => scores(emb, cc), passesLow: (sc) => bothAtLeast(sc, thresholds(), 'tLo'),
        ownerLive, _challenges: challenges,
    };
}

export default { createVoiceCloneService, VoiceError, tuningFor, TUNING_CHOICES };
