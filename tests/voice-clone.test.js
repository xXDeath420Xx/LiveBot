/*
 * Own-voice feature (invite-only; core/voice-clone, migration 476). Runs on throwaway tables (voiceCloneDdl(prefix)) and a
 * temp folder; the sidecar, speech recognition, ffmpeg and Piper are fakes. A fake "recording" is JSON naming the speaker
 * and what they said, so the speaker checks are exercised for real against embeddings made from it.
 *
 * Covers: consent gating, the invite gate, the region block, the deletion path, "no cloned voice for viewer TTS", the
 * worker API's refusal conditions, the challenge maths, crypto, tar, the model JSON fix, migration and retention rows.
 */
import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pool from '../utils/db.js';
import { voiceCloneDdl, VOICE_CLONE_TABLES, RETENTION_ROWS } from '../migrations/476_voice_clone.js';
import { applyLegacy } from '../migrations/477_voice_clone_legacy.js';
import { applyRegionException } from '../migrations/478_voice_clone_region_exception.js';
import { createVoiceCloneStore } from '../core/voice-clone/store.js';
import { createVoiceFiles } from '../core/voice-clone/files.js';
import { createVoiceCloneService } from '../core/voice-clone/service.js';
import { createOwnVoiceSynth } from '../core/voice-clone/synth.js';
import { createWorkerApi, fixModelJson } from '../core/voice-clone/worker-api.js';
import { inviteGate, regionGate, validateConsentForm } from '../core/voice-clone/gate.js';
import { makeChallenge, checkReading, digitsSpoken, wer, normaliseWords } from '../core/voice-clone/challenge.js';
import { mayUseOwnVoice, ownVoiceStepError, withOwnVoiceOption, hasTemplateVars, VIEWER_TEXT_FEATURES, readerVoiceAllowed, iSaidOn } from '../core/voice-clone/policy.js';
import { leaseRefusal, inWindow } from '../core/voice-clone/gpu-window.js';
import { tarHeader, tarEntry } from '../core/voice-clone/tar.js';
import * as vcrypto from '../core/voice-clone/crypto.js';
import { CONSENT_VERSION, CONSENT_SHA256, consentPlainText } from '../core/voice-clone/consent-text.js';
import { OWN_VOICE_ID, LIMITS } from '../core/voice-clone/constants.js';
import { sweepGuard } from '../jobs/retention-sweeper.js';
import { ttsAction } from '../core/stream-bot/community/register.js';
import { createMediaShare } from '../core/stream-bot/community/media.js';

const ENV = { VOICE_KEK: crypto.randomBytes(32).toString('hex') };
const prefix = `vct${crypto.randomBytes(3).toString('hex')}_`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-test-'));
const files = createVoiceFiles({ dataDir: path.join(tmp, 'data'), shmDir: path.join(tmp, 'shm') });
const store = createVoiceCloneStore({ db: pool, prefix });
const TH = () => ({ version: 'test', redimnet: { tHi: 0.6142, tLo: 0.3717 }, ecapa: { tHi: 0.5652, tLo: 0.3613 } });
const PROMPTS = ['The kettle sang softly on the stove.', 'A fox ran over the frozen hill.', 'Bright lanterns hung above the narrow street.'];

// ── fakes ──
function unitVec(seed, dim = 192) {
    const h = crypto.createHash('sha512');
    const out = [];
    let i = 0;
    while (out.length < dim) { const b = crypto.createHash('sha256').update(`${seed}:${i++}`).digest(); for (let j = 0; j < b.length && out.length < dim; j += 2) out.push((b.readUInt16LE(j) / 65535) - 0.5); }
    void h;
    const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    return out.map((x) => x / n);
}
function embFor(spk, noise = 'n') {
    const base = { redimnet: unitVec(`r:${spk}`), ecapa: unitVec(`e:${spk}`) };
    const jitter = { redimnet: unitVec(`r:${spk}:${noise}`), ecapa: unitVec(`e:${spk}:${noise}`) };
    const mix = (a, b) => { const v = a.map((x, i) => x + 0.35 * b[i]); const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
    return { redimnet: mix(base.redimnet, jitter.redimnet), ecapa: mix(base.ecapa, jitter.ecapa) };
}
const clip = (o) => Buffer.from(JSON.stringify({ dur: 4, wm: false, clip: 0, rms: -20, ...o }));
let sidecarUp = true;
let watermarkFails = false;
const sidecar = {
    async health() { return sidecarUp; },
    async embed(buf) { const o = JSON.parse(buf.toString()); return { duration_s: o.dur, rms_db: o.rms, peak: 0.5, clip_ratio: o.clip, ...embFor(o.spk, o.text) }; },
    async detect(buf) { let o = {}; try { o = JSON.parse(buf.toString()); } catch { o = { wm: buf.toString().includes('WM:') }; } return { prob: o.wm ? 1 : 0, message: o.wmId || 0 }; },
    async watermark(wav, id) { if (watermarkFails) throw new Error('down'); return wavBytes(`WM:${id}`); },
};
function wavBytes(tag = '') {
    const data = Buffer.alloc(22050 * 2);   // one second of silence
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data, Buffer.from(tag)]);
}
const transcribe = async (buf) => JSON.parse(buf.toString()).text || '';
const decode = async (buf) => buf;
const evicted = [];
let live = false;
const service = createVoiceCloneService({ store, files, sidecar, transcribe, decode, prompts: PROMPTS, thresholds: TH, env: ENV, ownerLive: async () => live });
service.onEvict(async (id) => { evicted.push(id); });
const spoken = [];
const piper = {
    async speak(text, modelPath) { spoken.push({ text, modelPath }); const f = path.join(tmp, `p${crypto.randomBytes(4).toString('hex')}.wav`); fs.writeFileSync(f, clip({ spk: currentSpeaker, text })); return f; },
    stop() {},
};
let currentSpeaker = 'alice';

const user = (id) => ({ id, username: `u${id}` });
const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const MALLORY = '100000000000000003';
const OWNER = '100000000000000009';
const form = (o = {}) => ({ typedName: 'Alice Example', state: 'WA', agree: true, ageAttested: true, ownVoice: true, keepSamples: false, textVersion: CONSENT_VERSION, ...o });

async function passLiveCheck(u, spk) {
    const c = await service.startChallenge(u);
    const ch = service._challenges.get(String(u.id));
    let r = null;
    for (let i = 0; i < 3; i++) r = await service.submitChallengeClip(u, i, clip({ spk, text: `${ch.sentences[i].words} ${ch.sentences[i].digits.split('').join(' ')}` }));
    assert.equal(c.sentences.length, 3);
    return r;
}
async function recordMinutes(u, spk, minutes) {
    // each fake take lasts 30 s
    const n = Math.ceil((minutes * 60) / 30);
    for (let i = 0; i < n; i++) {
        const p = await service.nextPrompt(u);
        const r = await service.addTake(u, p.index, clip({ spk, text: p.text, dur: 30 }));
        assert.equal(r.ok, true, r.reason);
    }
}

test.before(async () => { for (const sql of voiceCloneDdl(prefix)) await pool.query(sql); await applyLegacy(pool, prefix); await applyRegionException(pool, prefix); });
test.after(async () => {
    for (const n of [...VOICE_CLONE_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${prefix}${n}\``);
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ── pure parts ──

test('challenge: three new sentences, digits read any way Whisper writes them, WER of the words', () => {
    const c = makeChallenge();
    assert.equal(c.sentences.length, 3);
    for (const s of c.sentences) assert.match(s.digits, /^\d{4}$/);
    assert.equal(digitsSpoken('four seven one nine'), '4719');
    assert.equal(digitsSpoken('4719.'), '4719');
    assert.equal(digitsSpoken('47 19'), '4719');
    assert.equal(digitsSpoken('forty seven nineteen'), '4719');
    assert.equal(digitsSpoken('oh two three four'), '0234');
    const s = { words: 'purple lanterns drift past the old station', digits: '4719' };
    assert.equal(checkReading(s, 'Purple lanterns drift past the old station, 4, 7, 1, 9.').ok, true);
    assert.equal(checkReading(s, 'Purple lanterns drift past the old station, 4 7 1 8').ok, false, 'a wrong number fails');
    assert.equal(checkReading(s, 'Some other words entirely, four seven one nine').ok, false, 'other words fail');
    assert.equal(wer(normaliseWords('a b c d e'), normaliseWords('a b c d e')), 0);
    assert.equal(wer(normaliseWords('a b c d e'), normaliseWords('a b x d e')), 0.2);
});

test('the invite gate and the region block', () => {
    assert.equal(inviteGate(null).ok, false);
    assert.equal(inviteGate({ user_id: ALICE, revoked_at: new Date() }).ok, false);
    assert.equal(inviteGate({ user_id: ALICE, revoked_at: null }).ok, true);
    assert.equal(regionGate({ state: 'WA' }).ok, true);
    assert.equal(regionGate({ state: 'IL' }).code, 'blocked_state');
    assert.equal(regionGate({ state: 'TX' }).code, 'blocked_state');
    assert.equal(regionGate({ state: 'il' }).code, 'blocked_state', 'case does not matter');
    assert.equal(regionGate({ state: 'ON' }).code, 'state', 'not a US state');
    assert.equal(regionGate({ state: '' }).ok, false);
    assert.equal(regionGate({ state: 'WA', cfCountry: 'GB' }).code, 'country');
    assert.equal(regionGate({ state: 'WA', cfCountry: 'T1' }).code, 'country', 'Tor blocks');
    assert.equal(regionGate({ state: 'CA', cfCountry: 'US', cfRegion: 'IL' }).code, 'blocked_region');
    assert.equal(regionGate({ state: 'CA', cfCountry: 'US', cfRegion: 'TX' }).code, 'blocked_region');
    assert.equal(regionGate({ state: 'CA', cfCountry: 'US', cfRegion: 'CA' }).ok, true);
    const bad = validateConsentForm({ ...form(), ageAttested: false, agree: false, typedName: 'x', textVersion: 'old' });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 4);
    assert.equal(validateConsentForm(form()).ok, true);
});

test("policy: other people's text only with the voice owner's opt-in, in their own places; bot replies never", () => {
    for (const feature of VIEWER_TEXT_FEATURES) {
        assert.equal(mayUseOwnVoice({ feature, text: 'hi', profileOwnerId: ALICE, voiceOwnerId: ALICE }).ok, false, `${feature}: off by default`);
        assert.equal(mayUseOwnVoice({ feature, text: 'hi', profileOwnerId: ALICE, voiceOwnerId: ALICE, viewerTextAllowed: true }).ok, true, `${feature}: owner opted in`);
        assert.equal(mayUseOwnVoice({ feature, text: 'hi', profileOwnerId: BOB, voiceOwnerId: ALICE, viewerTextAllowed: true }).ok, false, `${feature}: never in someone else's profile`);
    }
    assert.equal(mayUseOwnVoice({ feature: 'bot_reply', text: 'hi', profileOwnerId: ALICE, voiceOwnerId: ALICE, viewerTextAllowed: true }).ok, false, 'bot replies never');
    assert.equal(mayUseOwnVoice({ feature: 'automation', text: 'Welcome in', profileOwnerId: ALICE, voiceOwnerId: ALICE }).ok, true);
    assert.equal(mayUseOwnVoice({ feature: 'automation', text: '{message}', profileOwnerId: ALICE, voiceOwnerId: ALICE }).ok, false, 'variables need the opt-in');
    assert.equal(mayUseOwnVoice({ feature: 'automation', text: '{message}', profileOwnerId: ALICE, voiceOwnerId: ALICE, viewerTextAllowed: true }).ok, true);
    assert.equal(mayUseOwnVoice({ feature: 'something_new', text: 'hi', profileOwnerId: ALICE, voiceOwnerId: ALICE, viewerTextAllowed: true }).ok, false, 'unknown places are refused');
    assert.equal(ownVoiceStepError({ voice: OWN_VOICE_ID, text: '' }), 'enter what your voice should say.');
    assert.equal(ownVoiceStepError({ voice: OWN_VOICE_ID, text: '{user.name} says {message}' }), null, 'decided at run time by the opt-in');
    assert.equal(hasTemplateVars('plain'), false);
    assert.equal(readerVoiceAllowed({ voiceOwnerId: ALICE, authorId: ALICE }), true, 'own messages always');
    assert.equal(readerVoiceAllowed({ voiceOwnerId: ALICE, authorId: BOB }), false, 'others: off by default');
    assert.equal(readerVoiceAllowed({ voiceOwnerId: ALICE, authorId: BOB, viewerTextAllowed: true, ownerManagesGuild: false }), false, "not the owner's server");
    assert.equal(readerVoiceAllowed({ voiceOwnerId: ALICE, authorId: BOB, viewerTextAllowed: true, ownerManagesGuild: true }), true);
    assert.equal(iSaidOn({}), false);
    assert.equal(iSaidOn({ viewerText: { on: true } }), true, 'defaults on for an opted-in voice');
    assert.equal(iSaidOn({ viewerText: { on: true }, iSaid: { on: false } }), false, 'the toggle wins');
    assert.equal(iSaidOn({ iSaid: { on: true } }), true);
    const cat = { actions: [{ type: 'tts.say', fields: [{ name: 'voice', options: ['', 'ryan'], optionLabels: { '': 'Default' } }] }] };
    assert.deepEqual(withOwnVoiceOption(cat, false), cat);
    assert.ok(withOwnVoiceOption(cat, true).actions[0].fields[0].options.includes(OWN_VOICE_ID));
    assert.ok(!cat.actions[0].fields[0].options.includes(OWN_VOICE_ID), 'the shared catalogue is not changed');
});

test('"Speak text on stream" and Media Share: other people\'s words reach the own voice only with the opt-in', async () => {
    const calls = [];
    let optedIn = false;
    const ownVoice = { available: async () => true, allowsViewerText: async () => optedIn, synthesize: async (owner, words, opts) => { calls.push({ owner, words, opts }); return { wav: wavBytes() }; } };
    const settings = new Map([['tts', { voice: OWN_VOICE_ID }]]);
    const fakeStore = { getSettingsKey: async (pid, k) => settings.get(k) || null, setSettingsKey: async () => {} };
    const media = createMediaShare({ store: fakeStore, cstore: {}, synthesize: async () => wavBytes(), ownVoice, timers: false });
    const profile = { id: 1, ownerDiscordId: ALICE };
    const viaDefault = await media.say(profile, { text: 'viewer says hello' });
    assert.match(viaDefault.detail, /not allowed for other people/, '!tts through a default: stock voice without the opt-in');
    const rendered = await media.say(profile, { text: 'viewer says hello', voice: OWN_VOICE_ID });
    assert.match(rendered.detail, /not allowed for other people/);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(calls.length, 0, 'the cloned voice never spoke without the opt-in');
    const step = ttsAction({ current: { media } });
    const r = await step.execute({ text: 'Be right back', voice: OWN_VOICE_ID }, { render: async () => { throw new Error('must not render'); }, ev: { type: 'chat', message: '!brb' }, profile });
    assert.notEqual(r.status, 'failed', r.detail);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.feature, 'automation');
    optedIn = true;
    await step.execute({ text: '{message}', voice: OWN_VOICE_ID }, { render: async () => 'hello from a viewer', ev: { type: 'chat', message: '!tts hello from a viewer' }, profile });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(calls.length, 2, "opted in: the owner's own profile reads other people in their voice");
    assert.equal(calls[1].opts.feature, 'viewer_tts');
    const other = createMediaShare({ store: fakeStore, cstore: {}, synthesize: async () => wavBytes(), ownVoice: { ...ownVoice, allowsViewerText: async (o) => o === ALICE && optedIn }, timers: false });
    await other.say({ id: 2, ownerDiscordId: BOB }, { text: 'hello', voice: OWN_VOICE_ID });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(calls.length, 2, "never in someone else's profile");
    const off = createMediaShare({ store: { getSettingsKey: async () => ({ voice: 'ryan' }), setSettingsKey: async () => {} }, cstore: {}, synthesize: async () => wavBytes(),
        ownVoice: { available: async () => false, allowsViewerText: async () => false, synthesize: async () => { throw new Error('no'); } }, timers: false });
    const fb = await off.say(profile, { text: 'Be right back', voice: OWN_VOICE_ID, fixedText: true });
    assert.match(fb.detail, /default voice/);
});

test('crypto, tar and the model JSON fix', () => {
    const key = vcrypto.newDataKey();
    const sealed = vcrypto.seal(Buffer.from('hello'), key, 'vcaaaaaaaa');
    assert.equal(vcrypto.open(sealed, key, 'vcaaaaaaaa').toString(), 'hello');
    assert.throws(() => vcrypto.open(sealed, key, 'vcbbbbbbbb'), 'bound to its voice');
    const w = vcrypto.wrapKey(key, 'vcaaaaaaaa', ENV);
    assert.ok(vcrypto.unwrapKey(w, 'vcaaaaaaaa', ENV).equals(key));
    assert.throws(() => vcrypto.unwrapKey(w, 'vcaaaaaaaa', { VOICE_KEK: crypto.randomBytes(32).toString('hex') }));
    assert.throws(() => vcrypto.wrapKey(key, 'vcaaaaaaaa', {}), /VOICE_KEK/);
    const hdr = tarHeader('wavs/1.wav', 1234);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : hdr[i];
    assert.equal(parseInt(hdr.toString('ascii', 148, 154), 8), sum);
    assert.equal(tarEntry('metadata.csv', Buffer.from('x')).length, 1024);
    const fixed = JSON.parse(fixModelJson({ phoneme_id_map: { a: [1], aɪ: [161], eɪ: [164] }, audio: { sample_rate: 22050 } }, { ownerId: ALICE, tuning: { speed: 'slower' } }));
    assert.deepEqual(Object.keys(fixed.phoneme_id_map), ['a']);
    assert.equal(fixed.certifried.ownerId, ALICE);
    assert.equal(fixed.certifried.lengthScale, 1.15);
    assert.equal(CONSENT_SHA256, crypto.createHash('sha256').update(consentPlainText()).digest('hex'));
    assert.match(consentPlainText(), /RCW 19\.375/);
    assert.match(consentPlainText(), /My Health My Data Act/);
    assert.match(consentPlainText(), /withdraw/i);
});

test('migration: retention rows and sweep guards', () => {
    const t = new Map(RETENTION_ROWS.map(([table, col, days]) => [table, { col, days }]));
    assert.deepEqual(t.get('voice_clone_samples'), { col: 'created_at', days: 30 });
    assert.deepEqual(t.get('voice_clone_voices'), { col: 'last_used_at', days: 365 });
    assert.deepEqual(t.get('voice_clone_consents'), { col: 'revoked_at', days: 1825 });
    assert.equal(t.get('voice_clone_jobs').days, 400);
    assert.equal(t.get('voice_clone_events').days, 400);
    assert.match(sweepGuard('voice_clone_samples'), /purged/);
    assert.match(sweepGuard('voice_clone_voices'), /deleted/);
});

// ── the service on real (throwaway) tables ──

test('consent gating: nothing happens without an invite, a complete consent and a passed live check', async () => {
    await assert.rejects(service.signConsent(user(ALICE), form()), (e) => e.status === 403 && e.code === 'not_invited');
    const s0 = await service.state(user(ALICE));
    assert.equal(s0.invited, false);
    await service.invite(OWNER, ALICE, 'test');
    await assert.rejects(service.startChallenge(user(ALICE)), (e) => e.status === 404, 'no voice before consent');
    await assert.rejects(service.signConsent(user(ALICE), form({ agree: false })), (e) => e.status === 400);
    await assert.rejects(service.signConsent(user(ALICE), form({ ageAttested: false })), (e) => e.status === 400);
    await assert.rejects(service.signConsent(user(ALICE), form({ textVersion: 'v0' })), (e) => e.status === 400);
    const signed = await service.signConsent(user(ALICE), form(), { ip: '203.0.113.9', cfCountry: 'US', cfRegion: 'WA' });
    const v = await store.voiceById(signed.voiceId);
    assert.equal(v.status, 'draft');
    const c = await store.consentById(signed.consentId);
    assert.equal(c.text_version, CONSENT_VERSION);
    assert.equal(c.text_sha256, CONSENT_SHA256);
    assert.equal(c.residence_state, 'WA');
    assert.equal(c.verified_at, null);
    assert.ok(!c.typed_name_encrypted.includes('Alice'), 'the typed name is encrypted');
    assert.equal(vcrypto.openJson(c.typed_name_encrypted, service.dataKey(v), v.id).name, 'Alice Example');
    await assert.rejects(service.signConsent(user(ALICE), form()), (e) => e.status === 409, 'one voice per person');
    await assert.rejects(service.addTake(user(ALICE), 0, clip({ spk: 'alice', text: PROMPTS[0] })), (e) => e.status === 409, 'no recording before the live check');
    await assert.rejects(service.startTraining(user(ALICE)), (e) => e.status === 409);

    // a live check with the wrong number fails and counts
    await service.startChallenge(user(ALICE));
    const ch = service._challenges.get(ALICE);
    for (let i = 0; i < 3; i++) await service.submitChallengeClip(user(ALICE), i, clip({ spk: 'alice', text: `${ch.sentences[i].words} one one one one` }));
    assert.equal((await store.voiceById(v.id)).status, 'draft');
    // a replay of an old recording does not know the new sentences
    await service.startChallenge(user(ALICE));
    const replay = await service.submitChallengeClip(user(ALICE), 0, clip({ spk: 'alice', text: `${ch.sentences[0].words} ${ch.sentences[0].digits}` }));
    assert.equal(replay.ok, false);
    service._challenges.delete(ALICE);
    // three different people reading the three sentences fail the consistency check
    await service.startChallenge(user(ALICE));
    const ch2 = service._challenges.get(ALICE);
    let mixed = null;
    for (let i = 0; i < 3; i++) mixed = await service.submitChallengeClip(user(ALICE), i, clip({ spk: ['alice', 'bob', 'carol'][i], text: `${ch2.sentences[i].words} ${ch2.sentences[i].digits}` }));
    assert.equal(mixed.passed, false);
    assert.ok(mixed.reasons.some((r) => /one person/.test(r)));
    // our own watermarked output is refused
    await service.startChallenge(user(ALICE));
    const ch3 = service._challenges.get(ALICE);
    let wm = null;
    for (let i = 0; i < 3; i++) wm = await service.submitChallengeClip(user(ALICE), i, clip({ spk: 'alice', wm: true, text: `${ch3.sentences[i].words} ${ch3.sentences[i].digits}` }));
    assert.equal(wm.passed, false);
    assert.ok(wm.reasons.some((r) => /watermark/.test(r)));
    // 4 failed checks today: 3 in a row locks for a day
    await assert.rejects(service.startChallenge(user(ALICE)), (e) => e.status === 429);
});

test('a passed live check unlocks recording; takes that are not the same speaker are rejected', async () => {
    await service.invite(OWNER, BOB, null);
    await service.signConsent(user(BOB), form({ typedName: 'Bob Example', state: 'OR' }));
    const r = await passLiveCheck(user(BOB), 'bob');
    assert.equal(r.passed, true, JSON.stringify(r));
    const v = await store.liveVoiceOf(BOB);
    assert.equal(v.status, 'consent_ok');
    assert.ok(v.centroid_encrypted && !v.centroid_encrypted.includes('redimnet'), 'the voiceprint is encrypted');
    const c = await store.consentById(v.consent_id);
    assert.ok(c.verified_at);
    const p = await service.nextPrompt(user(BOB));
    const other = await service.addTake(user(BOB), p.index, clip({ spk: 'mallory', text: p.text }));
    assert.equal(other.ok, false);
    assert.match(other.reason, /does not sound like your live check/);
    const misread = await service.addTake(user(BOB), p.index, clip({ spk: 'bob', text: 'something else entirely different here' }));
    assert.equal(misread.ok, false);
    const loud = await service.addTake(user(BOB), p.index, clip({ spk: 'bob', text: p.text, clip: 0.05 }));
    assert.match(loud.reason, /Too loud/);
    const good = await service.addTake(user(BOB), p.index, clip({ spk: 'bob', text: p.text }));
    assert.equal(good.ok, true);
    const files0 = fs.readdirSync(path.join(files.voiceDir(v.id), 'samples'));
    assert.equal(files0.length, 1, 'only the accepted take is stored');
    assert.ok(!fs.readFileSync(path.join(files.voiceDir(v.id), 'samples', files0[0])).toString().includes('bob'), 'stored encrypted');
    await assert.rejects(service.startTraining(user(BOB)), /at least 15 minutes/);
    // cross-account: Mallory cannot enrol Bob's voice
    await service.invite(OWNER, MALLORY, null);
    await service.signConsent(user(MALLORY), form({ typedName: 'Mallory Example', state: 'NV' }));
    const copy = await passLiveCheck(user(MALLORY), 'bob');
    assert.equal(copy.passed, false);
    assert.ok(copy.reasons.some((x) => /another account/.test(x)));
});

test('training queue, the worker API and its refusal conditions', async () => {
    const u = user(BOB);
    await recordMinutes(u, 'bob', 15);
    const { jobId } = await service.startTraining(u);
    assert.equal((await store.liveVoiceOf(BOB)).status, 'queued');
    const token = crypto.randomBytes(32).toString('hex');
    const INSIDE = new Date('2026-11-20T18:00:00Z');    // 10:00 Pacific
    const OUTSIDE = new Date('2026-11-20T23:30:00Z');   // 15:30 Pacific
    let clock = OUTSIDE;
    const api = createWorkerApi({ service, store, files, sidecar, piper, ownerLive: async () => live, token, env: ENV, now: () => clock });
    const srv = api.app.listen(0, '127.0.0.1');
    await new Promise((res) => srv.once('listening', res));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { ...auth, ...h }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    try {
        assert.equal((await fetch(`${base}/v1/lease`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' })).status, 401, 'bad token');
        assert.equal((await post('/v1/lease', { worker_id: 'pc', local: { scratch_encrypted: false } })).body.refusal, 'scratch', 'no encrypted owner-only scratch, no work');
        assert.equal((await post('/v1/lease', { worker_id: 'pc', local: { bitlocker: true } })).body.refusal, 'scratch', 'the old BitLocker field no longer counts');
        live = true;
        assert.equal((await post('/v1/lease', { worker_id: 'pc', local: { scratch_encrypted: true } })).body.refusal, 'owner_live');
        live = false;
        assert.equal((await post('/v1/lease', { worker_id: 'pc', local: { scratch_encrypted: true } })).body.refusal, 'outside_window', 'outside 02:00-14:00 Pacific');
        assert.equal(inWindow(INSIDE), true);
        clock = INSIDE;
        const leased = await post('/v1/lease', { worker_id: 'pc', local: { scratch_encrypted: true } });
        assert.equal(leaseRefusal({ now: new Date('2026-11-20T18:00:00Z'), ownerLive: false, gpuSecondsToday: 0 }), null, '10:00 Pacific is inside');
        assert.equal(leaseRefusal({ now: new Date('2026-11-20T23:30:00Z'), ownerLive: false }), 'outside_window', '15:30 Pacific');
        assert.equal(leaseRefusal({ now: new Date('2026-11-20T18:00:00Z'), ownerLive: false, gpuSecondsToday: 4 * 3600 }), 'daily_cap');
        assert.equal(leaseRefusal({ now: new Date('2026-11-20T18:00:00Z'), ownerLive: undefined }), 'owner_live', 'unknown live state counts as live');
        const job = leased.body.job;
        assert.equal(job.job_id, jobId);
        const lt = { 'x-lease-token': job.lease_token };
        assert.equal((await post(`/v1/jobs/${jobId}/heartbeat`, { state: 'running' }, { 'x-lease-token': 'nope' })).status, 404, 'lease token required');
        const tar = Buffer.from(await (await fetch(`${base}/v1/jobs/${jobId}/dataset`, { headers: { ...auth, ...lt } })).arrayBuffer());
        assert.ok(tar.includes(Buffer.from('metadata.csv')));
        live = true;
        assert.equal((await post(`/v1/jobs/${jobId}/heartbeat`, { state: 'running', step: 10, gpu_seconds: 30 }, lt)).body.pause, 'owner_live', 'going live pauses training');
        live = false;
        // the artifact: a bad hash is refused
        const onnx = crypto.randomBytes(1_200_000);
        const put = (part, body, sha) => fetch(`${base}/v1/jobs/${jobId}/artifact?part=${part}`, { method: 'PUT', headers: { authorization: auth.authorization, ...lt, 'x-sha256': sha }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
        assert.equal((await put('onnx', onnx, '0'.repeat(64))).status, 422);
        currentSpeaker = 'bob';
        assert.equal((await put('onnx', onnx, vcrypto.sha256(onnx))).status, 200);
        const j = Buffer.from(JSON.stringify({ phoneme_id_map: { a: [1], aɪ: [161] }, audio: { sample_rate: 22050 } }));
        const acc = await put('json', j, vcrypto.sha256(j));
        assert.equal(acc.body.accepted, true, JSON.stringify(acc.body));
        assert.equal((await store.jobById(jobId)).state, 'checking', 'not done before the purge receipt');
        await post(`/v1/jobs/${jobId}/purged`, { files_removed: 300, bytes: 1000 }, lt);
        assert.equal((await store.jobById(jobId)).state, 'done');
        assert.equal((await store.liveVoiceOf(BOB)).status, 'review');
        // two approvals make it active
        await service.approve(u);
        assert.equal((await store.liveVoiceOf(BOB)).status, 'review');
        await service.adminApprove(OWNER, (await store.liveVoiceOf(BOB)).id);
        assert.equal((await store.liveVoiceOf(BOB)).status, 'active');
    } finally { srv.close(); }
});

test('synthesis: watermarked, owner only, fails closed', async () => {
    const v = await store.liveVoiceOf(BOB);
    assert.equal(v?.status, 'active', 'the worker test above made it active');
    const synth = createOwnVoiceSynth({ service, store, files, sidecar, piper });
    try {
        await assert.rejects(synth.synthesize(BOB, 'Be right back', { feature: 'automation' }), /not switched on/, 'automations toggle is off by default');
        await service.saveSettings(user(BOB), { automations: true });
        const r = await synth.synthesize(BOB, 'Be right back', { feature: 'automation' });
        assert.ok(r.wav.includes(Buffer.from(`WM:${v.wm_id}`)), 'carries the voice watermark');
        await assert.rejects(synth.synthesize(BOB, 'hi', { feature: 'viewer_tts' }), (e) => e.code === 'policy');
        await assert.rejects(synth.synthesize(BOB, 'hi', { feature: 'automation', profileOwnerId: ALICE }), (e) => e.code === 'policy');
        await assert.rejects(synth.synthesize(BOB, '{message}', { feature: 'automation' }), (e) => e.code === 'policy');
        watermarkFails = true;
        await assert.rejects(synth.synthesize(BOB, 'Be right back', { feature: 'automation' }), /watermarked/, 'no mark, no audio');
        watermarkFails = false;
    } finally { synth.stop(); }
});

test('deletion: the voice stops at once; files, key, voiceprint go; consent kept as withdrawn; a running job is cancelled', async () => {
    // Alice is locked; use a fresh person with a queued job
    const CAROL = '100000000000000004';
    await service.invite(OWNER, CAROL, null);
    await service.signConsent(user(CAROL), form({ typedName: 'Carol Example', state: 'NY' }));
    assert.equal((await passLiveCheck(user(CAROL), 'carol')).passed, true);
    await recordMinutes(user(CAROL), 'carol', 15);
    const { jobId } = await service.startTraining(user(CAROL));
    const v = await store.liveVoiceOf(CAROL);
    assert.ok(fs.existsSync(files.voiceDir(v.id)));
    await assert.rejects(service.deleteOwn(user(CAROL), { confirm: 'yes' }), /Type delete/);
    const r = await service.deleteOwn(user(CAROL), { confirm: 'delete' });
    assert.ok(r.backupsExpireBy > r.deletedAt);
    const after = await store.voiceById(v.id);
    assert.equal(after.status, 'deleted');
    assert.equal(after.data_key_encrypted, null);
    assert.equal(after.centroid_encrypted, null);
    assert.ok(after.files_removed_at);
    assert.ok(!fs.existsSync(files.voiceDir(v.id)), 'the folder is gone');
    assert.ok(evicted.includes(v.id), 'warm copies evicted');
    assert.equal((await store.jobById(jobId)).state, 'cancelled');
    const samples = await store.listSamples(v.id);
    assert.ok(samples.every((s) => s.status === 'purged' && !s.file_name && !s.checks), 'no embeddings left on the rows');
    const c = await store.consentById(v.consent_id);
    assert.ok(c.revoked_at, 'consent marked withdrawn, kept');
    assert.equal(await store.liveVoiceOf(CAROL), null);
    assert.equal((await store.voiceById(v.id)).wm_id, v.wm_id, 'the tombstone keeps its watermark id so it is not reused');
    assert.equal(await store.wmTaken(v.wm_id), true);
    await assert.rejects(Promise.resolve().then(() => service.dataKey(after)), (e) => e.status === 410);
    // /privacy delete for a person with a voice, and the export never has the model or voiceprint
    const ex = await service.exportFor(BOB);
    assert.ok(ex.voice && !JSON.stringify(ex).includes('centroid') && !JSON.stringify(ex).includes('data_key'));
    const pd = await service.deleteAllForUser(BOB, 'privacy_delete');
    assert.equal(pd.voices, 1);
    assert.equal(await store.liveVoiceOf(BOB), null);
    // withdrawing an invite deletes the voice too
    const DAVE = '100000000000000005';
    await service.invite(OWNER, DAVE, null);
    await service.signConsent(user(DAVE), form({ typedName: 'Dave Example', state: 'CA' }));
    const rv = await service.revokeInvite(OWNER, DAVE);
    assert.ok(rv.deleted);
    assert.equal((await service.state(user(DAVE))).invited, false);
});

test('signing from a blocked state is refused and recorded', async () => {
    const ERIN = '100000000000000006';
    await service.invite(OWNER, ERIN, null);
    await assert.rejects(service.signConsent(user(ERIN), form({ state: 'IL' })), (e) => e.status === 403 && /Illinois/.test(e.message));
    await assert.rejects(service.signConsent(user(ERIN), form({ state: 'TX' })), (e) => e.status === 403 && /Texas/.test(e.message));
    await assert.rejects(service.signConsent(user(ERIN), form({ state: 'CA' }), { cfCountry: 'DE' }), (e) => e.status === 403 && e.code === 'country');
    assert.equal(await store.liveVoiceOf(ERIN), null, 'no voice row');
    assert.equal(await store.countEvents({ userId: ERIN, event: 'consent_region_blocked', hours: 1 }), 3);
    assert.equal(LIMITS.voicesPerUser, 1);
    assert.equal(LIMITS.voicesTotal, 500);
});

