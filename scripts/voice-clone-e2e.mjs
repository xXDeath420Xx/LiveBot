/*
 * End-to-end check of the own-voice pipeline with the REAL sidecar (ReDimNet, ECAPA, AudioSeal), whisper.cpp, ffmpeg
 * and Piper, on throwaway tables and a temp folder. No person's voice is used: two stock Piper voices stand in for
 * "the person" (ryan) and "someone else" (amy), and the stock ryan model stands in for a trained voice.
 *
 *   node scripts/voice-clone-e2e.mjs
 * Prints each step's result; exits 1 on the first failure. Drops its tables and folder at the end.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pool from '../utils/db.js';
import { voiceCloneDdl, VOICE_CLONE_TABLES } from '../migrations/476_voice_clone.js';
import { createVoiceCloneStore } from '../core/voice-clone/store.js';
import { createVoiceFiles } from '../core/voice-clone/files.js';
import { createSidecar, toWav, transcribe } from '../core/voice-clone/audio.js';
import { createVoiceCloneService } from '../core/voice-clone/service.js';
import { createOwnVoiceSynth } from '../core/voice-clone/synth.js';
import { createWorkerApi } from '../core/voice-clone/worker-api.js';
import { CONSENT_VERSION } from '../core/voice-clone/consent-text.js';
import * as vcrypto from '../core/voice-clone/crypto.js';
import * as pw from '../utils/piper-worker.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MODEL = (v, q) => path.join(ROOT, 'piper_models', 'en_US', v, q, `en_US-${v}-${q}.onnx`);
const prefix = `vce${crypto.randomBytes(3).toString('hex')}_`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-e2e-'));
const ENV = { VOICE_KEK: crypto.randomBytes(32).toString('hex') };
const prompts = JSON.parse(fs.readFileSync(path.join(ROOT, 'core/voice-clone/prompts.json'), 'utf8')).sentences.slice(0, 40);
const files = createVoiceFiles({ dataDir: path.join(tmp, 'data'), shmDir: path.join(tmp, 'shm') });
const store = createVoiceCloneStore({ db: pool, prefix });
const sidecar = createSidecar();
const service = createVoiceCloneService({ store, files, sidecar, transcribe: (w) => transcribe(w), decode: (b, o) => toWav(b, o), prompts, env: ENV, ownerLive: async () => false });
const piper = { speak: (t, m, o) => pw.synthesizeWithModel(t, m, o), stop: (m) => pw.stopWorkersFor(m) };
const ME = '199999999999999901';
const u = { id: ME, username: 'e2e' };
let failed = false;
const step = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); if (!ok) failed = true; };

/** Speak with a stock voice and encode like a browser would (WebM/Opus 64 kbps, 48 kHz). */
async function browserClip(text, voice = 'ryan', q = 'high') {
    const wavPath = await pw.synthesizeWithModel(text, MODEL(voice, q), {});
    const out = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', wavPath, '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
    fs.unlinkSync(wavPath);
    return out.stdout;
}

try {
    for (const sql of voiceCloneDdl(prefix)) await pool.query(sql);
    await files.init();
    step('sidecar is up', await sidecar.health());
    await service.invite('199999999999999900', ME, 'e2e');
    const { voiceId } = await service.signConsent(u, { typedName: 'Test Person', state: 'WA', agree: true, ageAttested: true, ownVoice: true, keepSamples: false, textVersion: CONSENT_VERSION });
    step('consent signed', !!voiceId);

    // live check with the right speaker
    const c = await service.startChallenge(u);
    let r = null;
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) r = await service.submitChallengeClip(u, i, await browserClip(c.sentences[i]));
    step('live check passes for the same speaker reading the sentences', r.passed === true, `${JSON.stringify(r.reasons || [])} ${Date.now() - t0} ms for 3 clips`);
    const ev = (await store.listEvents({ voiceId })).find((e) => e.event === 'consent_check_passed');
    console.log('      consent scores (lowest clip vs the other two):', JSON.stringify(ev?.detail?.minPair), 'WER', ev?.detail?.wer);

    // takes: same speaker ok, another speaker rejected, wrong sentence rejected
    let p = await service.nextPrompt(u);
    const t1 = Date.now();
    const good = await service.addTake(u, p.index, await browserClip(p.text));
    step('a take by the same speaker is accepted', good.ok === true, `${good.reason || ''} ${Date.now() - t1} ms`);
    p = await service.nextPrompt(u);
    const other = await service.addTake(u, p.index, await browserClip(p.text, 'amy', 'medium'));
    step('a take by another speaker is rejected', other.ok === false && /does not sound like/.test(other.reason || ''), other.reason || '');
    const wrong = await service.addTake(u, p.index, await browserClip('Completely different words that are not on the screen at all.'));
    step('a take of the wrong sentence is rejected', wrong.ok === false, wrong.reason || '');
    const rows = await store.listSamples(voiceId);
    for (const s of rows) console.log(`      take ${s.id}: ${s.status} redimnet ${s.score_redimnet} ecapa ${s.score_ecapa} wer ${s.asr_wer} ${s.reason || ''}`);

    // pretend 15 minutes were recorded (copies of the good take), then train with the stock ryan model as the "artifact"
    const ok = rows.find((s) => s.status === 'ok');
    for (let i = 0; i < 40; i++) {
        const id = await store.addSample({ voiceId, kind: 'recorded', promptIndex: i % prompts.length, promptText: prompts[i % prompts.length], durationMs: 25_000, sha256: ok.sha256, checks: ok.checks, status: 'ok' });
        const sealed = await files.readSample(voiceId, ok.file_name);
        await store.setSampleFile(voiceId, id, await files.writeSample(voiceId, id, sealed));
    }
    const { jobId } = await service.startTraining(u);
    step('training queued after 15 minutes', !!jobId);
    const token = crypto.randomBytes(32).toString('hex');
    const api = createWorkerApi({ service, store, files, sidecar, piper, ownerLive: async () => false, token, env: ENV, now: () => new Date('2026-11-20T18:00:00Z') });
    const srv = api.app.listen(0, '127.0.0.1');
    await new Promise((res) => srv.once('listening', res));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const H = { authorization: `Bearer ${token}` };
    const lease = await (await fetch(`${base}/v1/lease`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'e2e', local: { scratch_encrypted: true } }) })).json();
    step('worker lease inside the window', !!lease.job, JSON.stringify(lease.refusal));
    const LT = { ...H, 'x-lease-token': lease.job.lease_token };
    const tar = Buffer.from(await (await fetch(`${base}/v1/jobs/${jobId}/dataset`, { headers: LT })).arrayBuffer());
    step('dataset tar streams decrypted WAVs and metadata.csv', tar.includes(Buffer.from('metadata.csv')) && tar.includes(Buffer.from('RIFF')), `${tar.length} bytes`);
    const onnx = fs.readFileSync(MODEL('ryan', 'high'));
    const json = fs.readFileSync(`${MODEL('ryan', 'high')}.json`);
    const put = async (part, body) => (await fetch(`${base}/v1/jobs/${jobId}/artifact?part=${part}`, { method: 'PUT', headers: { ...LT, 'content-type': 'application/octet-stream', 'x-sha256': vcrypto.sha256(body) }, body })).json();
    await put('onnx', onnx);
    const acc = await put('json', json);
    step('artifact accepted after the real similarity check', acc.accepted === true, JSON.stringify(acc.scores || acc.error));
    await fetch(`${base}/v1/jobs/${jobId}/purged`, { method: 'POST', headers: { ...LT, 'content-type': 'application/json' }, body: JSON.stringify({ files_removed: 41, bytes: 1 }) });
    srv.close();
    await service.approve(u);
    await service.adminApprove('199999999999999900', voiceId);
    await service.saveSettings(u, { automations: true });
    const v = await store.voiceById(voiceId);
    step('voice active after both approvals', v.status === 'active');

    // real synthesis, real watermark, real detection
    const synth = createOwnVoiceSynth({ service, store, files, sidecar, piper });
    const t2 = Date.now();
    const out = await synth.synthesize(ME, 'Thanks for watching, see you next time.', { feature: 'automation' });
    const ms = Date.now() - t2;
    const det = await sidecar.detect(await toWav(out.wav, { rate: 16000 }));
    step('synthesised clip carries this voice\'s watermark', det.prob >= 0.5 && det.message === v.wm_id, `prob ${det.prob}, message ${det.message}, wm_id ${v.wm_id}, ${ms} ms first render`);
    const opus = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1'], { input: out.wav, maxBuffer: 32 * 1024 * 1024 }).stdout;
    const det2 = await sidecar.detect(await toWav(opus, { rate: 16000 }));
    step('watermark survives Opus 64 kbps', det2.prob >= 0.5 && det2.message === v.wm_id, `prob ${det2.prob}`);
    const admin = await service.detectClip(opus);
    step('owner detection tool resolves the voice', admin.voice?.id === voiceId);
    let refused = false;
    try { await synth.synthesize(ME, 'hello', { feature: 'viewer_tts' }); } catch (e) { refused = e.code === 'policy'; }
    step('viewer TTS refused', refused);
    const shmBefore = fs.readdirSync(path.join(tmp, 'shm')).length;
    await service.deleteOwn(u, { confirm: 'delete' });
    let stopped = false;
    try { await synth.synthesize(ME, 'hello', { feature: 'automation' }); } catch { stopped = true; }
    step('after delete: synthesis stops, /dev/shm copy and folder gone', stopped && fs.readdirSync(path.join(tmp, 'shm')).length === 0 && !fs.existsSync(files.voiceDir(voiceId)), `shm files before ${shmBefore}`);
    synth.stop();
} catch (err) {
    console.log('FAIL  crashed:', err?.stack || err);
    failed = true;
} finally {
    for (const n of [...VOICE_CLONE_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${prefix}${n}\``).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    pw.stopAllPiperWorkers();
    process.exit(failed ? 1 : 0);
}
