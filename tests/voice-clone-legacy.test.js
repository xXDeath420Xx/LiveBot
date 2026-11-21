/*
 * Pre-existing own voices (core/voice-clone/legacy.js, migration 477; owner decisions 2026-11-21): a written consent on file
 * instead of the live check, the owner's 18+ / residence attestation on the person's behalf, training gated on both, the
 * person's existing recordings imported, a voice-owner-supplied model with a licence attestation, the opt-ins (who set
 * them), the channel reader's rules ("I said", other people only with the opt-in in the owner's own server), and deletion
 * removing the piper_models voice. Throwaway tables and folders; the sidecar and Piper are fakes.
 */
import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pool from '../utils/db.js';
import { voiceCloneDdl, VOICE_CLONE_TABLES } from '../migrations/476_voice_clone.js';
import { applyLegacy } from '../migrations/477_voice_clone_legacy.js';
import { applyRegionException } from '../migrations/478_voice_clone_region_exception.js';
import { createVoiceCloneStore } from '../core/voice-clone/store.js';
import { createVoiceFiles } from '../core/voice-clone/files.js';
import { createVoiceCloneService } from '../core/voice-clone/service.js';
import { createLegacy } from '../core/voice-clone/legacy.js';
import { ownVoiceUsable, introFor, setOwnVoiceRulesForTests } from '../core/voice-reader-manager.js';
import { getVoiceInfo } from '../utils/piper-tts.js';

const ENV = { VOICE_KEK: crypto.randomBytes(32).toString('hex') };
const prefix = `vcl${crypto.randomBytes(3).toString('hex')}_`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcl-test-'));
const piperModelsDir = path.join(tmp, 'piper_models');
const evidenceDir = path.join(tmp, 'evidence');
const files = createVoiceFiles({ dataDir: path.join(tmp, 'data'), shmDir: path.join(tmp, 'shm') });
const store = createVoiceCloneStore({ db: pool, prefix });
const TH = () => ({ version: 'test', redimnet: { tHi: 0.6142, tLo: 0.3717 }, ecapa: { tHi: 0.5652, tLo: 0.3613 } });

function unitVec(seed, dim = 192) {
    const out = [];
    let i = 0;
    while (out.length < dim) { const b = crypto.createHash('sha256').update(`${seed}:${i++}`).digest(); for (let j = 0; j < b.length && out.length < dim; j += 2) out.push((b.readUInt16LE(j) / 65535) - 0.5); }
    const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    return out.map((x) => x / n);
}
const mix = (a, b) => { const v = a.map((x, i) => x + 0.35 * b[i]); const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const embFor = (spk, n) => ({ redimnet: mix(unitVec(`r:${spk}`), unitVec(`r:${spk}:${n}`)), ecapa: mix(unitVec(`e:${spk}`), unitVec(`e:${spk}:${n}`)) });
const clip = (o) => Buffer.from(JSON.stringify({ dur: 4, wm: false, clip: 0, rms: -20, ...o }));
const sidecar = {
    async health() { return true; },
    async embed(buf) { const o = JSON.parse(buf.toString()); return { duration_s: o.dur, rms_db: o.rms, peak: 0.5, clip_ratio: o.clip, ...embFor(o.spk, o.n) }; },
    async detect(buf) { let o = {}; try { o = JSON.parse(buf.toString()); } catch { /* wav */ } return { prob: o.wm ? 1 : 0, message: 0 }; },
    async watermark(wav, id) { return Buffer.concat([wav, Buffer.from(`WM:${id}`)]); },
};
const piper = { async speak(text, modelPath) { const f = path.join(tmp, `p${crypto.randomBytes(4).toString('hex')}.wav`); fs.writeFileSync(f, `SPOKEN:${path.basename(modelPath)}:${text}`); return f; }, stop() {} };
const service = createVoiceCloneService({ store, files, sidecar, transcribe: async () => '', decode: async (b) => b, prompts: ['x'], thresholds: TH, env: ENV, ownerLive: async () => false });
const legacy = createLegacy({ service, store, files, sidecar, piper, decode: async (b) => b, piperModelsDir, env: ENV, evidenceDir });

const OWNER = '100000000000000009';
const BEAR = '685127470625980501';   // the real Bear id: utils/piper-tts.js knows the live 'bear' voice with this ownerId
const OTHER = '100000000000000077';

test.before(async () => {
    for (const sql of voiceCloneDdl(prefix)) await pool.query(sql);
    await applyLegacy(pool, prefix);
    await applyRegionException(pool, prefix);
    fs.mkdirSync(path.join(piperModelsDir, 'en_GB', 'bear', 'medium'), { recursive: true });
    fs.writeFileSync(path.join(piperModelsDir, 'en_GB', 'bear', 'medium', 'en_GB-bear-medium.onnx'), 'fake onnx');
    fs.mkdirSync(path.join(piperModelsDir, 'previews'), { recursive: true });
    fs.writeFileSync(path.join(piperModelsDir, 'previews', 'bear.wav'), 'preview');
});
test.after(async () => {
    for (const n of [...VOICE_CLONE_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${prefix}${n}\``);
    fs.rmSync(tmp, { recursive: true, force: true });
    setOwnVoiceRulesForTests(async () => null);
});

let voiceId;

test('a written consent on file: pending, then stored verbatim with screenshot hashes; no live check; training held until attested', async () => {
    const r = await legacy.createLegacyVoice(OWNER, { userId: BEAR, legacyVoiceId: 'bear', displayName: 'Bear', espeakVoice: 'en-gb-x-rp', tuning: { speed: 'slower', clarity: 'clean' } });
    voiceId = r.voiceId;
    assert.equal((await store.getInvite(BEAR)).invited_by, OWNER, 'invited by the owner');
    let c = await store.consentById(r.consentId);
    assert.equal(c.consent_method, 'written_on_file');
    assert.equal(c.verified_at, null, 'pending');
    assert.equal((await legacy.queueLegacyTraining(OWNER, voiceId)).queued, false);
    const shot = Buffer.from('fake jpeg bytes');
    await legacy.recordWrittenConsent(OWNER, voiceId, { text: 'I\'ll train the models and send \'em', givenAt: '2026-10-13 03:58', channel: 'Discord DM to the owner',
        evidence: [{ name: 'a.jpg', buf: shot }], note: 'Deletion and withdrawal rights apply as for any voice.' });
    c = await store.consentById(r.consentId);
    assert.ok(c.verified_at, 'complete');
    assert.equal(c.consent_text, 'I\'ll train the models and send \'em', 'verbatim');
    assert.equal(c.recorded_by, OWNER);
    assert.equal(c.evidence[0].sha256, crypto.createHash('sha256').update(shot).digest('hex'));
    assert.ok(fs.existsSync(path.join(evidenceDir, c.evidence[0].file)));
    const v = await store.voiceById(voiceId);
    assert.equal(v.status, 'draft', 'no residence declared yet');
    const st = await service.state({ id: BEAR, username: 'bear' });
    assert.equal(st.voice.legacy, true);
    assert.equal(st.voice.consentMethod, 'written_on_file');
    await assert.rejects(service.startChallenge({ id: BEAR }), (e) => e.status === 409, 'the live check is not used');
    const held = await legacy.queueLegacyTraining(OWNER, voiceId);
    assert.equal(held.queued, false);
    assert.ok(held.waitingFor.some((w) => /18\+/.test(w)));
});

test('attestation on the person\'s behalf: 18+ required; the region rule applies (US only, not IL or TX)', async () => {
    await assert.rejects(legacy.attestLegacy(OWNER, voiceId, { state: 'WA', age18: false }), (e) => e.status === 400);
    await assert.rejects(legacy.attestLegacy(OWNER, voiceId, { state: 'IL', age18: true }), (e) => e.status === 403);
    await assert.rejects(legacy.attestLegacy(OWNER, voiceId, { state: 'TX', age18: true }), (e) => e.status === 403);
    await assert.rejects(legacy.attestLegacy(OWNER, voiceId, { state: 'GB', age18: true }), (e) => e.status === 403, 'outside the US');
    const r = await legacy.attestLegacy(OWNER, voiceId, { state: 'WA', age18: true });
    assert.equal(r.queued, false, 'still no recordings');
    const c = await store.consentById((await store.voiceById(voiceId)).consent_id);
    assert.equal(c.attested_by, OWNER);
    assert.equal(c.residence_state, 'WA');
    assert.equal((await store.voiceById(voiceId)).status, 'consent_ok');
});

test('existing recordings: one speaker kept, others and watermarked clips dropped; then the job is queued and handed out', async () => {
    const items = [];
    for (let i = 0; i < 90; i++) items.push({ name: `r1_${i}.wav`, wav: clip({ spk: 'bear', n: i, dur: 4 }), text: `Line ${i}.` });
    items.push({ name: 'stranger.wav', wav: clip({ spk: 'someone-else', n: 1 }), text: 'x' });
    items.push({ name: 'ours.wav', wav: clip({ spk: 'bear', n: 999, wm: true }), text: 'x' });
    const r = await legacy.importLegacySamples(OWNER, voiceId, items);
    assert.equal(r.kept, 90);
    assert.ok(r.rejected.some((x) => x.name === 'stranger.wav'));
    assert.ok(r.rejected.some((x) => x.name === 'ours.wav'));
    const q = await legacy.queueLegacyTraining(OWNER, voiceId);
    assert.equal(q.queued, true, JSON.stringify(q));
    assert.equal((await store.nextQueued())?.id, q.jobId, 'the worker gets it');
    // the gate in the lease query: a withdrawn consent is never handed out
    await store.revokeConsents({ voiceId, reason: 'test' });
    assert.equal(await store.nextQueued(), null);
    await store.updateConsent((await store.voiceById(voiceId)).consent_id, { revoked_at: null, revoke_reason: null });
    assert.equal((await store.nextQueued())?.id, q.jobId);
});

test('opt-ins: only the voice owner or an admin, recorded with who; "I said" defaults to the opt-in', async () => {
    await assert.rejects(legacy.setOptIn({ userId: OTHER, role: 'user' }, voiceId, 'viewerText', true), (e) => e.status === 403);
    let rules = await legacy.rulesFor('bear');
    assert.equal(rules.viewerText, false, 'off by default');
    await legacy.setOptIn({ userId: OWNER, role: 'admin' }, voiceId, 'iSaid', true);
    rules = await legacy.rulesFor('bear');
    assert.equal(rules.iSaid, true);
    const v = await store.voiceById(voiceId);
    assert.equal(v.features.iSaid.by, OWNER);
    assert.equal(v.features.iSaid.role, 'admin');
    await legacy.setOptIn({ userId: BEAR, role: 'user' }, voiceId, 'viewerText', true);
    assert.equal((await store.voiceById(voiceId)).features.viewerText.role, 'voice_owner');
    await legacy.setOptIn({ userId: BEAR, role: 'user' }, voiceId, 'viewerText', false);
});

test('the channel reader: own messages always; others only with the opt-in in the owner\'s server; "I said" per toggle', async (t) => {
    if (getVoiceInfo('bear')?.ownerId !== BEAR) { t.skip('the live bear voice is not installed here'); return; }
    let rules = { ownerUserId: BEAR, status: 'active', viewerText: false, iSaid: true };
    setOwnVoiceRulesForTests(async () => rules);
    const msg = (author, guildOwner, managed = false) => ({ author: { id: author }, guild: { ownerId: guildOwner, members: { cache: new Map(managed ? [[BEAR, { permissions: { has: () => true } }]] : []), fetch: async () => null } }, member: { displayName: 'x' } });
    assert.equal(await ownVoiceUsable(msg(BEAR, OTHER), 'bear'), true, 'Bear\'s own message');
    assert.equal(await ownVoiceUsable(msg(OTHER, BEAR), 'bear'), false, 'others: off by default');
    rules = { ...rules, viewerText: true };
    assert.equal(await ownVoiceUsable(msg(OTHER, BEAR), 'bear'), true, 'opted in, Bear owns the server');
    assert.equal(await ownVoiceUsable(msg(OTHER, OWNER, true), 'bear'), true, 'opted in, Bear manages the server');
    assert.equal(await ownVoiceUsable(msg(OTHER, OWNER, false), 'bear'), false, 'opted in, someone else\'s server');
    rules = { ...rules, status: 'suspended' };
    assert.equal(await ownVoiceUsable(msg(BEAR, BEAR), 'bear'), false, 'a suspended voice reads nothing');
    rules = { ...rules, status: 'active', iSaid: true };
    assert.equal(await introFor(msg(BEAR, OTHER), 'bear'), 'I said');
    rules = { ...rules, iSaid: false };
    assert.notEqual(await introFor(msg(BEAR, OTHER), 'bear'), 'I said');
    assert.equal(await ownVoiceUsable(msg(OTHER, OTHER), 'ryan'), true, 'stock voices are untouched');
});

test('region exception: super-admin only, recorded with basis, who and when; the US-only rule still blocks everyone else', async () => {
    // a second legacy voice for someone else, outside the US, without an exception: refused
    const other = await legacy.createLegacyVoice(OWNER, { userId: OTHER, legacyVoiceId: 'someone', displayName: 'Someone' });
    await legacy.recordWrittenConsent(OWNER, other.voiceId, { text: 'yes', givenAt: 'today' });
    await assert.rejects(legacy.attestLegacy(OWNER, other.voiceId, { state: 'GB', age18: true }), (e) => e.status === 403);
    await assert.rejects(legacy.attestLegacy(OWNER, other.voiceId, { age18: true, regionException: { region: 'UK' } }), (e) => e.status === 400, 'the basis is required');
    await legacy.attestLegacy(OWNER, other.voiceId, { age18: true, regionException: { region: 'UK (exception approved by owner)', basis: 'explicit written consent (UK GDPR Art. 9(2)(a))' } });
    const c = await store.consentById((await store.voiceById(other.voiceId)).consent_id);
    assert.equal(c.region_exception, 'UK (exception approved by owner)');
    assert.equal(c.region_exception_basis, 'explicit written consent (UK GDPR Art. 9(2)(a))');
    assert.equal(c.region_exception_by, OWNER);
    assert.ok(c.region_exception_at && c.attested_at);
    assert.equal(c.residence_state, null);
    assert.equal(await store.countEvents({ userId: OTHER, event: 'region_exception_granted', hours: 1 }), 1);
    // ordinary sign-up still refuses non-US people: the exception is not a gate setting
    const { regionGate } = await import('../core/voice-clone/gate.js');
    assert.equal(regionGate({ state: 'GB' }).ok, false);
    // reader servers the owner adds for a voice, audited
    await legacy.setReaderGuilds(OWNER, other.voiceId, ['111111111111111111', 'bad']);
    assert.deepEqual((await store.voiceById(other.voiceId)).features.readerGuilds.ids, ['111111111111111111']);
    await service.deleteVoice(other.voiceId, { actor: 'admin', reason: 'test' });
});

test('the channel reader: an owner-approved server counts as the voice owner\'s own (with the opt-in)', async (t) => {
    if (getVoiceInfo('bear')?.ownerId !== BEAR) { t.skip('the live bear voice is not installed here'); return; }
    const G = '222222222222222222';
    setOwnVoiceRulesForTests(async () => ({ ownerUserId: BEAR, status: 'active', viewerText: true, iSaid: true, readerGuilds: [G] }));
    const msg = (gid) => ({ author: { id: OTHER }, guild: { id: gid, ownerId: OWNER, members: { cache: new Map(), fetch: async () => null } } });
    assert.equal(await ownVoiceUsable(msg(G), 'bear'), true);
    assert.equal(await ownVoiceUsable(msg('333333333333333333'), 'bear'), false);
    setOwnVoiceRulesForTests(async () => ({ ownerUserId: BEAR, status: 'active', viewerText: false, iSaid: true, readerGuilds: [G] }));
    assert.equal(await ownVoiceUsable(msg(G), 'bear'), false, 'the server list alone is not the opt-in');
});

test('a voice-owner-supplied model needs a base-model and licence attestation; A/B samples are watermarked', async () => {
    const onnx = crypto.randomBytes(1_100_000);
    await assert.rejects(legacy.uploadOwnerModel(OWNER, voiceId, { onnx, json: '{}', attestation: {} }), (e) => e.status === 400);
    const r = await legacy.uploadOwnerModel(OWNER, voiceId, { onnx, json: JSON.stringify({ phoneme_id_map: { a: [1], aɪ: [2] } }),
        attestation: { baseModel: 'en_US-libritts_r-medium', licence: 'CC BY 4.0', tool: 'TextyMcSpeechy' } });
    const v = await store.voiceById(voiceId);
    assert.equal(v.model_source, 'owner_supplied');
    assert.equal(v.model_attestation.licence, 'CC BY 4.0');
    assert.equal(v.model_attestation.attestedBy, OWNER);
    assert.equal(v.model_sha256, r.sha256);
    assert.equal(v.status, 'review', 'needs both approvals');
    const cur = await legacy.adminSample(voiceId, 'current', 'hello');
    assert.ok(cur.toString().includes('en_GB-bear-medium.onnx') && cur.toString().includes(`WM:${v.wm_id}`), 'current = the live file, watermarked');
    const nw = await legacy.adminSample(voiceId, 'new', 'hello');
    assert.ok(!nw.toString().includes('en_GB-bear-medium.onnx') && nw.toString().includes(`WM:${v.wm_id}`), 'new = the uploaded model');
});

test('withdrawal or deletion removes the piper_models voice and its preview too; the consent record stays, withdrawn', async () => {
    const v = await store.voiceById(voiceId);
    await service.deleteVoice(voiceId, { actor: 'user', reason: 'withdrawn', byUserId: BEAR });
    assert.ok(!fs.existsSync(path.join(piperModelsDir, 'en_GB', 'bear')), 'the live voice files are gone');
    assert.ok(!fs.existsSync(path.join(piperModelsDir, 'previews', 'bear.wav')));
    const c = await store.consentById(v.consent_id);
    assert.ok(c.revoked_at, 'withdrawn, kept as proof');
    assert.ok(c.consent_text, 'the written consent stays with the record');
    assert.equal(await legacy.rulesFor('bear'), null, 'the reader no longer finds a record');
});
