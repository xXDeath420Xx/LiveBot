/*
 * The training-job API for the owner's PC (design 5.3). A separate small Express app inside CertiFriedUtility that
 * listens on 127.0.0.1 only (VOICE_WORKER_API_PORT, default 4650). The PC reaches it through its own SSH local
 * forward (PC 127.0.0.1:18650 -> server 127.0.0.1:4650), so nothing is public and the PC exposes nothing.
 *
 * Auth: "Authorization: Bearer <VOICE_WORKER_TOKEN>" (constant-time compare) on every call, plus the per-lease token
 * ("X-Lease-Token") on a job's calls; only its SHA-256 is stored.
 *
 *   POST /v1/lease        { worker_id, version, gpu, local: { scratch_encrypted } } → { job: null, refusal } | { job: {...} }
 *                         refusals: owner_live (the cf_quiet query), outside_window (02:00-14:00 Pacific), daily_cap
 *                         (4 GPU-hours), scratch (the worker did not report its per-job encrypted, owner-only scratch
 *                         workspace; it replaced the BitLocker requirement on 2026-11-21)
 *   GET  /v1/jobs/:id/dataset                 tar of decrypted WAVs + metadata.csv, built in memory, never on disk here
 *   POST /v1/jobs/:id/heartbeat               { state, step, total_steps, eta_s, pause_reason, gpu_seconds }
 *                                             → { continue: true } | { cancel: true, reason } | { pause: reason }
 *   PUT  /v1/jobs/:id/artifact?part=onnx|json  X-SHA256 of the body. When both parts are in: hash checked, phoneme map
 *                                             fixed, a test sentence rendered and compared with the consent voiceprint
 *   POST /v1/jobs/:id/fail                    { error, retryable }   retryable: queued again, at most 3 attempts
 *   POST /v1/jobs/:id/purged                  { files_removed, bytes }   required: a job is only done with this receipt
 *
 *   createWorkerApi({ service, store, files, sidecar, piper, ownerLive, logger, token, now })
 *     .app (express) · .listen(port) · .expireLeases() · .close()
 */
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import { STATUS, JOB_STATE, LIMITS, BASE_MODEL, WORKER_API_PORT } from './constants.js';
import { leaseRefusal, pacificParts } from './gpu-window.js';
import { tarEntry, TAR_END } from './tar.js';
import { tuningFor } from './service.js';
import * as vcrypto from './crypto.js';

const TEST_SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it rests beside the quiet river.';

/** Fix a piper1-gpl 1.5 export for the server's older Piper binary (memory reference_certifried_custom_piper_voices). */
export function fixModelJson(json, { ownerId, tuning }) {
    const cfg = typeof json === 'string' ? JSON.parse(json) : json;
    const map = cfg.phoneme_id_map || {};
    for (const k of Object.keys(map)) if ([...k].length > 1) delete map[k];
    cfg.phoneme_id_map = map;
    const t = tuningFor(tuning || {});
    cfg.certifried = { ...(cfg.certifried || {}), ownerId: String(ownerId), private: true, lengthScale: t.lengthScale, noiseScale: t.noiseScale, noiseW: t.noiseW };
    return JSON.stringify(cfg);
}

export function createWorkerApi({ service, store, files, sidecar, piper, ownerLive, logger = null, token = process.env.VOICE_WORKER_TOKEN, env = process.env, now = () => new Date() } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[VoiceWorkerApi] ${msg}`, meta); } catch { /* ignore */ } };
    const app = express();
    app.disable('x-powered-by');
    const parts = new Map();   // jobId -> { onnxSha, json }
    const tokenBuf = token ? Buffer.from(String(token)) : null;

    function bearerOk(req) {
        if (!tokenBuf || tokenBuf.length < 32) return false;
        const h = String(req.get('authorization') || '');
        const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
        return got.length === tokenBuf.length && crypto.timingSafeEqual(got, tokenBuf);
    }
    app.use((req, res, next) => {
        const ip = req.socket.remoteAddress || '';
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).json({ error: 'loopback only' });
        if (!bearerOk(req)) return res.status(401).json({ error: 'unauthorised' });
        return next();
    });
    const json = express.json({ limit: '16kb' });
    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            log('warn', 'call failed', { path: req.path, error: err?.message });
            if (!res.headersSent) res.status(err?.status || 500).json({ error: err?.status ? err.message : 'server error' });
        }
    };
    async function jobFor(req) {
        const id = Number(req.params.id);
        const job = Number.isInteger(id) ? await store.jobById(id) : null;
        const lt = String(req.get('x-lease-token') || '');
        if (!job || !job.lease_token_hash || !lt || vcrypto.sha256(Buffer.from(lt)) !== job.lease_token_hash) {
            throw Object.assign(new Error('unknown job or lease'), { status: 404 });
        }
        return job;
    }
    const isLiveSafe = async () => { try { return await ownerLive(); } catch { return true; } };
    const today = () => pacificParts(now()).day;

    async function expireLeases() {
        let n = 0;
        for (const j of await store.expiredLeases()) {
            const v = await store.voiceById(j.voice_id);
            const dead = !v || v.status === STATUS.DELETED || v.status === STATUS.SUSPENDED;
            if (dead) await store.updateJob(j.id, { state: JOB_STATE.CANCELLED, error: 'voice gone', finished_at: 'NOW()' });
            else if (j.attempt >= LIMITS.maxJobAttempts) {
                await store.updateJob(j.id, { state: JOB_STATE.FAILED, error: 'the training computer stopped answering three times', finished_at: 'NOW()' });
                await store.setVoiceStatus(j.voice_id, v.model_sha256 ? STATUS.REVIEW : STATUS.CONSENT_OK, [STATUS.QUEUED, STATUS.TRAINING]);
            } else {
                await store.updateJob(j.id, { state: JOB_STATE.QUEUED, lease_token_hash: null, worker_id: null, leased_until: null, pause_reason: 'lease expired' });
                await store.setVoiceStatus(j.voice_id, STATUS.QUEUED, [STATUS.TRAINING]);
            }
            await service.event({ voiceId: j.voice_id, actor: 'system', event: 'job_lease_expired', detail: { jobId: j.id, attempt: j.attempt } });
            n++;
        }
        return n;
    }

    app.post('/v1/lease', json, wrap(async (req, res) => {
        await expireLeases();
        const b = req.body || {};
        if (b?.local?.scratch_encrypted !== true) return res.json({ job: null, refusal: 'scratch' });
        const refusal = leaseRefusal({ now: now(), ownerLive: await isLiveSafe(), gpuSecondsToday: await store.gpuSecondsOn(today()) });
        if (refusal) return res.json({ job: null, refusal });
        const job = await store.nextQueued();
        if (!job) return res.json({ job: null, refusal: null });
        const leaseToken = crypto.randomBytes(32).toString('base64url');
        const ok = await store.leaseJob(job.id, { tokenHash: vcrypto.sha256(Buffer.from(leaseToken)), workerId: String(b.worker_id || 'pc').slice(0, 64), leaseMs: LIMITS.leaseMs });
        if (!ok) return res.json({ job: null, refusal: null });
        await store.setVoiceStatus(job.voice_id, STATUS.TRAINING, [STATUS.QUEUED]);
        await service.event({ voiceId: job.voice_id, actor: 'worker', event: 'job_leased', detail: { jobId: job.id, worker: String(b.worker_id || '').slice(0, 64), gpu: b.gpu || null } });
        const fresh = await store.jobById(job.id);
        const voice = await store.voiceById(job.voice_id);
        const espeak = /^[a-z][a-z0-9-]{1,30}$/i.test(String(voice?.tuning?.espeak || '')) ? String(voice.tuning.espeak) : 'en-us';
        res.json({ job: {
            job_id: job.id, lease_token: leaseToken, leased_until: fresh.leased_until, attempt: fresh.attempt,
            base_model: { sha256: BASE_MODEL.sha256, url: BASE_MODEL.url, bytes: BASE_MODEL.bytes }, steps: job.total_steps || LIMITS.trainSteps,
            espeak_voice: espeak, sample_rate: 22050, quality: 'medium', checkpoint_every: 250,
        } });
    }));

    app.get('/v1/jobs/:id/dataset', wrap(async (req, res) => {
        const job = await jobFor(req);
        if (job.state === JOB_STATE.CANCELLED) return res.status(410).json({ error: 'cancelled' });
        const v = await store.voiceById(job.voice_id);
        if (!v || ![STATUS.TRAINING].includes(v.status)) return res.status(410).json({ error: 'voice not training' });
        const key = service.dataKey(v);
        const samples = (await store.listSamples(v.id, { kind: 'recorded' })).filter((s) => s.status === 'ok' && s.file_name);
        res.set({ 'content-type': 'application/x-tar', 'cache-control': 'no-store' });
        const lines = [];
        let n = 0;
        for (const s of samples) {
            const wav = vcrypto.open(await files.readSample(v.id, s.file_name), key, v.id);
            if (vcrypto.sha256(wav) !== s.sha256) { log('warn', 'sample hash mismatch, left out', { voiceId: v.id, sample: s.id }); continue; }
            res.write(tarEntry(`wavs/${s.id}.wav`, wav));
            lines.push(`${s.id}|${String(s.prompt_text || '').replace(/[|\r\n]+/g, ' ')}`);
            n++;
        }
        res.write(tarEntry('metadata.csv', Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
        res.end(TAR_END);
        await store.updateJob(job.id, { state: JOB_STATE.RUNNING });
        await service.event({ voiceId: v.id, actor: 'worker', event: 'dataset_sent', detail: { jobId: job.id, clips: n } });
    }));

    app.post('/v1/jobs/:id/heartbeat', json, wrap(async (req, res) => {
        const job = await jobFor(req);
        const b = req.body || {};
        if (job.state === JOB_STATE.CANCELLED || job.state === JOB_STATE.FAILED) return res.json({ cancel: true, reason: job.error || job.state });
        const v = await store.voiceById(job.voice_id);
        if (!v || v.status === STATUS.DELETED || v.status === STATUS.SUSPENDED) {
            await store.updateJob(job.id, { state: JOB_STATE.CANCELLED, error: 'voice gone', finished_at: 'NOW()' });
            return res.json({ cancel: true, reason: 'voice deleted' });
        }
        const delta = Math.max(0, Math.min(90, Number(b.gpu_seconds) || 0));
        await store.addGpuSeconds(today(), delta);
        const state = ['running', 'paused', 'uploading'].includes(b.state) ? b.state : job.state;
        await store.updateJob(job.id, {
            state, step: Math.max(0, Math.min(1e7, Number(b.step) || 0)), total_steps: Math.max(0, Math.min(1e7, Number(b.total_steps) || job.total_steps)),
            eta_s: Number.isFinite(Number(b.eta_s)) ? Math.max(0, Math.min(864000, Number(b.eta_s))) : null,
            pause_reason: state === 'paused' ? String(b.pause_reason || 'paused').slice(0, 40) : null, gpu_seconds: Number(job.gpu_seconds || 0) + Math.round(delta),
        });
        await store.extendLease(job.id, LIMITS.leaseMs);
        const refusal = leaseRefusal({ now: now(), ownerLive: await isLiveSafe(), gpuSecondsToday: await store.gpuSecondsOn(today()) });
        if (refusal && state !== 'uploading') return res.json({ pause: refusal });
        return res.json({ continue: true });
    }));

    app.put('/v1/jobs/:id/artifact', express.raw({ type: () => true, limit: '200mb' }), wrap(async (req, res) => {
        const job = await jobFor(req);
        if (job.state === JOB_STATE.CANCELLED) return res.status(410).json({ error: 'cancelled' });
        const v = await store.voiceById(job.voice_id);
        if (!v || v.status !== STATUS.TRAINING) return res.status(410).json({ error: 'voice not training' });
        const part = String(req.query.part || '');
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sha = vcrypto.sha256(body);
        if (!/^[0-9a-f]{64}$/.test(String(req.get('x-sha256') || '')) || sha !== String(req.get('x-sha256'))) return res.status(422).json({ error: 'sha256 mismatch' });
        const p = parts.get(job.id) || {};
        const key = service.dataKey(v);
        if (part === 'onnx') {
            if (body.length < 1_000_000) return res.status(422).json({ error: 'model too small' });
            await files.writeModel(v.id, sha, vcrypto.seal(body, key, v.id));
            p.onnxSha = sha;
        } else if (part === 'json') {
            try { p.json = fixModelJson(body.toString('utf8'), { ownerId: v.owner_user_id, tuning: v.tuning }); } catch { return res.status(422).json({ error: 'bad model json' }); }
        } else return res.status(400).json({ error: 'part must be onnx or json' });
        parts.set(job.id, p);
        await store.updateJob(job.id, { state: JOB_STATE.UPLOADING });
        if (!p.onnxSha || !p.json) return res.json({ ok: true, waiting: p.onnxSha ? 'json' : 'onnx' });
        parts.delete(job.id);
        const check = await checkArtifact(v, p.onnxSha, p.json, key);
        if (!check.ok) {
            await files.removeOtherModels(v.id, v.model_sha256 || '-');
            await store.updateJob(job.id, { state: JOB_STATE.FAILED, error: check.error, artifact_sha256: p.onnxSha,
                artifact_score_redimnet: check.scores?.redimnet ?? null, artifact_score_ecapa: check.scores?.ecapa ?? null, finished_at: 'NOW()' });
            await store.setVoiceStatus(v.id, v.model_sha256 ? STATUS.REVIEW : STATUS.CONSENT_OK, [STATUS.TRAINING]);
            await service.event({ voiceId: v.id, actor: 'system', event: 'artifact_rejected', detail: { jobId: job.id, error: check.error, scores: check.scores || null } });
            return res.status(422).json({ error: check.error });
        }
        await files.removeOtherModels(v.id, p.onnxSha);
        await store.updateVoice(v.id, { model_sha256: p.onnxSha, model_json: p.json, trained_at: 'NOW()', status: STATUS.REVIEW, user_approved_at: null, admin_approved_at: null, approved_at: null });
        await service.evict(v.id);
        const fresh = await store.jobById(job.id);
        const done = !!fresh.purge_receipt_at;
        await store.updateJob(job.id, { state: done ? JOB_STATE.DONE : JOB_STATE.CHECKING, artifact_sha256: p.onnxSha,
            artifact_score_redimnet: check.scores.redimnet, artifact_score_ecapa: check.scores.ecapa, ...(done ? { finished_at: 'NOW()' } : {}) });
        await service.event({ voiceId: v.id, actor: 'system', event: 'artifact_accepted', detail: { jobId: job.id, sha: p.onnxSha, scores: check.scores } });
        return res.json({ ok: true, accepted: true, scores: check.scores });
    }));

    async function checkArtifact(v, sha, modelJson, key) {
        let file = null;
        let p = null;
        try {
            const onnx = vcrypto.open(await files.readModel(v.id, sha), key, v.id);
            p = await files.shmModel(`${v.id}`, `chk${sha}`, onnx, modelJson);
            file = await piper.speak(TEST_SENTENCE, p, {});
            const wav = await fs.readFile(file);
            const emb = await sidecar.embed(wav);
            const cc = service.consentCentroids(v, key)?.consent;
            const sc = service.scoresAgainstConsent(emb, cc);
            try { piper.stop(p); } catch { /* not running */ }
            await fs.rm(p, { force: true }); await fs.rm(`${p}.json`, { force: true });
            if (!service.passesLow(sc)) return { ok: false, error: 'The trained voice does not sound like you yet.', scores: sc };
            return { ok: true, scores: sc };
        } catch (err) {
            if (p) { await fs.rm(p, { force: true }); await fs.rm(`${p}.json`, { force: true }); }
            return { ok: false, error: `The trained model could not be loaded (${String(err?.message || err).slice(0, 120)}).` };
        } finally { if (file) fs.unlink(file).catch(() => {}); }
    }

    app.post('/v1/jobs/:id/fail', json, wrap(async (req, res) => {
        const job = await jobFor(req);
        const b = req.body || {};
        const error = String(b.error || 'training failed').slice(0, 300);
        const v = await store.voiceById(job.voice_id);
        if (b.retryable === true && job.attempt < LIMITS.maxJobAttempts && v && v.status === STATUS.TRAINING) {
            await store.updateJob(job.id, { state: JOB_STATE.QUEUED, error, lease_token_hash: job.lease_token_hash, leased_until: null, worker_id: null });
            await store.setVoiceStatus(v.id, STATUS.QUEUED, [STATUS.TRAINING]);
        } else {
            await store.updateJob(job.id, { state: JOB_STATE.FAILED, error, finished_at: 'NOW()' });
            if (v && v.status === STATUS.TRAINING) await store.setVoiceStatus(v.id, v.model_sha256 ? STATUS.REVIEW : STATUS.CONSENT_OK, [STATUS.TRAINING]);
        }
        await service.event({ voiceId: job.voice_id, actor: 'worker', event: 'job_failed', detail: { jobId: job.id, error, retryable: b.retryable === true } });
        res.json({ ok: true });
    }));

    app.post('/v1/jobs/:id/purged', json, wrap(async (req, res) => {
        const job = await jobFor(req);
        const b = req.body || {};
        const done = job.state === JOB_STATE.CHECKING;
        await store.updateJob(job.id, { purge_receipt_at: 'NOW()', purge_files: Math.max(0, Number(b.files_removed) || 0), purge_bytes: Math.max(0, Number(b.bytes) || 0),
            ...(done ? { state: JOB_STATE.DONE, finished_at: 'NOW()' } : {}) });
        await service.event({ voiceId: job.voice_id, actor: 'worker', event: 'worker_purged', detail: { jobId: job.id, files: Number(b.files_removed) || 0, bytes: Number(b.bytes) || 0 } });
        res.json({ ok: true, done });
    }));

    app.use((req, res) => res.status(404).json({ error: 'not found' }));

    let server = null;
    return {
        app, expireLeases,
        listen(port = WORKER_API_PORT) {
            if (!tokenBuf || tokenBuf.length < 32) { log('info', 'VOICE_WORKER_TOKEN not set: the training API stays off'); return null; }
            server = app.listen(port, '127.0.0.1', () => log('info', `listening on 127.0.0.1:${port}`));
            server.on('error', (err) => log('error', 'could not listen', { error: err?.message }));
            return server;
        },
        close() { try { server?.close(); } catch { /* closed */ } },
    };
}

export default { createWorkerApi, fixModelJson };
