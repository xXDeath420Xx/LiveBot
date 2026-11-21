import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrigger } from '../core/stream-bot/conditions.js';
import { createStudioServices, sanitiseVoiceLogEntry } from '../core/stream-bot/studio.js';
import { normaliseVoiceText, cleanVoiceExamples, applyVoiceLearning, learnVoice, teachFromDashboard, VoiceLearnError, VOICE_LEARN_LIMITS } from '../core/stream-bot/voice-learn.js';

/*
 * Server side of CertiFried Studio 0.2.13 (2026-11-21): learning how the streamer says each voice command.
 *   voice-learn.js   the same words as Studio, aliases with counts, negatives, conflicts, the phrase itself, caps, threshold
 *   validateTrigger  keeps what was learned through an editor save
 *   voice.phrases    sends aliases (most frequent first), negatives and trained to Studio (sync)
 *   voice.learn      Studio only, its own profile's voice automations, rate limited; the change is what voice.phrases sends
 *   voice.log        the 0.2.13 fields (id, closest, via, alias, words on any outcome); what was learned stays on a line
 *   routes           /voice/learn and /voice/unlearn: teach, Wrong + undo learning, Undo, Remove; the editor keeps them
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.UTC(2026, 10, 21, 3, 0, 0);

function fakeStore(rows) {
    const automations = rows.map((a) => JSON.parse(JSON.stringify(a)));
    return {
        automations,
        updates: 0,
        async getAutomation(pid, id) { const a = automations.find((x) => x.id === id && x.profileId === pid); return a ? JSON.parse(JSON.stringify(a)) : null; },
        async updateAutomation(pid, id, v) { const a = automations.find((x) => x.id === id && x.profileId === pid); if (!a) return false; Object.assign(a, JSON.parse(JSON.stringify(v))); this.updates += 1; return true; },
        async enabledAutomationsFor(pid, type) { return automations.filter((a) => a.profileId === pid && a.enabled && a.trigger_type === type).map((a) => JSON.parse(JSON.stringify(a))); },
        async getProfile(id) { return { id, enabled: true }; },
        async getSettingsKey() { return null; },
        async setSettingsKey() {},
    };
}
const voiceRows = () => [
    { id: 1, profileId: 7, name: 'Run', enabled: true, trigger_type: 'voice.phrase', trigger_config: { phrases: ['Run Bitch Run!'], cooldownSec: 5 }, conditions: [], actions: [{ type: 'sound.play' }] },
    { id: 2, profileId: 7, name: 'Discord audio', enabled: true, trigger_type: 'voice.phrase', trigger_config: { phrases: ['Toggle Discord Audio'] }, conditions: [], actions: [] },
    { id: 3, profileId: 7, name: 'Chat', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: 'hi' } }, conditions: [], actions: [] },
    { id: 4, profileId: 8, name: 'Other profile', enabled: true, trigger_type: 'voice.phrase', trigger_config: { phrases: ['hello'] }, conditions: [], actions: [] },
];

test('voice-learn: the same words as Studio (voice-match.js normalise)', () => {
    assert.equal(normaliseVoiceText("  Let's  GET into the game!! "), 'lets get into the game');
    assert.equal(normaliseVoiceText('Uh, pokey check.'), 'pokey check');
    assert.equal(normaliseVoiceText('Café’s déjà vu'), 'cafes deja vu');
    assert.equal(normaliseVoiceText('x'.repeat(300)).length, VOICE_LEARN_LIMITS.text);
    assert.equal(normaliseVoiceText(null), '');
});

test('voice-learn: aliases count up, negatives and aliases never hold the same words, the phrase is never "not a command"', () => {
    const cfg = { phrases: ['Run Bitch Run!'], cooldownSec: 5 };
    let c = applyVoiceLearning(cfg, { add: { aliases: ['Ron, beach, Ron.', 'ran bitch ron'] } }, T0);
    assert.deepEqual(c.aliases.map((a) => [a.text, a.count]), [['ron beach ron', 1], ['ran bitch ron', 1]]);
    assert.equal(c.cooldownSec, 5, 'other settings kept');
    c = applyVoiceLearning(c, { add: { aliases: ['ron beach ron'] } }, T0 + 1);
    assert.equal(c.aliases[0].count, 2, 'taught again: counted');
    c = applyVoiceLearning(c, { add: { negatives: ['ron beach ron', 'run to the shop'] } }, T0 + 2);
    assert.deepEqual(c.aliases.map((a) => a.text), ['ran bitch ron'], 'marked not a command: no longer an alias');
    assert.deepEqual(c.negatives.map((n) => n.text), ['ron beach ron', 'run to the shop']);
    c = applyVoiceLearning(c, { add: { aliases: ['run to the shop'] } }, T0 + 3);
    assert.deepEqual(c.negatives.map((n) => n.text), ['ron beach ron'], 'taught as the command: no longer a negative');
    assert.throws(() => applyVoiceLearning(c, { add: { negatives: ['run, bitch, run'] } }), (e) => e instanceof VoiceLearnError && e.code === 'is_phrase');
    const same = applyVoiceLearning(c, { add: { aliases: ['Run Bitch Run'] } });
    assert.equal(same.aliases.some((a) => a.text === 'run bitch run'), false, 'the phrase itself needs no alias');
    c = applyVoiceLearning(c, { remove: { aliases: ['ran bitch ron', 'run to the shop'], negatives: ['ron beach ron'] } });
    assert.equal('aliases' in c, false);
    assert.equal('negatives' in c, false);
    assert.throws(() => applyVoiceLearning(c, {}), (e) => e.code === 'bad_params');
    // training: threshold 60 to 95 %, and when
    const t = applyVoiceLearning(cfg, { add: { aliases: ['ron beach ron'] }, confidence: 0.724, trained: { takes: 8 } }, T0);
    assert.equal(t.confidence, 0.72);
    assert.deepEqual(t.trained, { at: new Date(T0).toISOString(), takes: 8 });
    assert.throws(() => applyVoiceLearning(cfg, { confidence: 0.4 }), /60% to 95%/);
    // caps
    let big = cfg;
    for (let i = 0; i < 60; i++) big = applyVoiceLearning(big, { add: { aliases: [`word ${i}`] } }, T0 + i);
    big = applyVoiceLearning(big, { add: { aliases: ['word 59'] } }, T0 + 100);
    assert.equal(big.aliases.length, VOICE_LEARN_LIMITS.aliases);
    assert.ok(big.aliases.some((a) => a.text === 'word 59' && a.count === 2), 'the most used stays');
    for (let i = 0; i < 120; i++) big = applyVoiceLearning(big, { add: { negatives: [`not ${i}`] } }, T0 + i);
    assert.equal(big.negatives.length, VOICE_LEARN_LIMITS.negatives);
    assert.equal(big.negatives.at(-1).text, 'not 119', 'the oldest go first');
});

test('validateTrigger: an editor save keeps what Studio learned, cleaned', () => {
    const v = validateTrigger('voice.phrase', { phrases: ['Pokeycheck'], confidence: 72, aliases: [{ text: 'Pokey Check!', count: 3 }, 'poke check', { text: '' }], negatives: ['poker chips', 'poke check'], trained: { at: new Date(T0).toISOString(), takes: 8 } });
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.value.aliases.map((a) => [a.text, a.count]), [['pokey check', 3], ['poke check', 1]]);
    assert.deepEqual(v.value.negatives.map((n) => n.text), ['poker chips'], 'never both an alias and a negative');
    assert.equal(v.value.trained.takes, 8);
    const plain = validateTrigger('voice.phrase', { phrases: ['Pokeycheck'] });
    assert.equal('aliases' in plain.value || 'negatives' in plain.value || 'trained' in plain.value, false);
    assert.deepEqual(cleanVoiceExamples({}), { aliases: [], negatives: [], trained: null });
});

test('voice.learn from Studio, then voice.phrases carries it back (sync)', async () => {
    const store = fakeStore(voiceRows());
    const s = createStudioServices({ store, engine: {}, ingest: {}, now: () => T0 });
    const conn = { profileId: 7, kind: 'studio' };
    const r = await s.onRequest(conn, 'voice.learn', { automationId: 1, add: { aliases: ['ron beach ron', 'ran bitch ron', 'ron beach ron'] }, confidence: 0.7, trained: { takes: 8 } });
    assert.deepEqual(r.aliases.map((a) => a.text), ['ron beach ron', 'ran bitch ron']);
    assert.equal(r.confidence, 0.7);
    await s.onRequest(conn, 'voice.learn', { automationId: 1, add: { aliases: ['ran bitch ron'], negatives: ['run to the shop'] } });
    const p = await s.onRequest(conn, 'voice.phrases', {});
    const run = p.phrases.find((x) => x.automationId === 1);
    assert.deepEqual(run.aliases, [{ text: 'ron beach ron', count: 2 }, { text: 'ran bitch ron', count: 2 }], 'each take counts, also twice in one call');
    await s.onRequest(conn, 'voice.learn', { automationId: 1, add: { aliases: ['ran bitch ron'] } });
    assert.deepEqual((await s.onRequest(conn, 'voice.phrases', {})).phrases.find((x) => x.automationId === 1).aliases.map((a) => a.text), ['ran bitch ron', 'ron beach ron'], 'most frequent first');
    assert.deepEqual(run.negatives, ['run to the shop']);
    assert.equal(run.trained.takes, 8);
    assert.equal(run.confidence, 0.7);
    const other = p.phrases.find((x) => x.automationId === 2);
    assert.deepEqual(Object.keys(other).sort(), ['automationId', 'automationName', 'confidence', 'cooldownSec', 'text'], 'nothing extra without learning');
    // refusals
    await assert.rejects(() => s.onRequest({ profileId: 7, kind: 'overlay' }, 'voice.learn', { automationId: 1, add: { aliases: ['x'] } }), (e) => e.code === 'bad_params');
    await assert.rejects(() => s.onRequest(conn, 'voice.learn', { automationId: 3, add: { aliases: ['x'] } }), (e) => e.code === 'bad_params', 'not a voice command');
    await assert.rejects(() => s.onRequest(conn, 'voice.learn', { automationId: 4, add: { aliases: ['x'] } }), (e) => e.code === 'not_found', 'another profile\'s automation');
    await assert.rejects(() => s.onRequest(conn, 'voice.learn', { automationId: 1, add: { negatives: ['Run Bitch Run'] } }), (e) => e.code === 'is_phrase');
    const c2 = { profileId: 7, kind: 'studio' };
    for (let i = 0; i < 30; i++) await s.onRequest(c2, 'voice.learn', { automationId: 2, add: { aliases: [`t ${i}`] } });
    await assert.rejects(() => s.onRequest(c2, 'voice.learn', { automationId: 2, add: { aliases: ['one more'] } }), (e) => e.code === 'rate');
    assert.equal(store.automations.find((a) => a.id === 1).actions[0].type, 'sound.play', 'the rest of the automation is untouched');
});

test('voice.log 0.2.13 fields; what the dashboard learned stays on a line when Studio sends its list again', async () => {
    const t = T0;
    const e = sanitiseVoiceLogEntry({ id: '1763694000000-ab12c', t, phrase: null, confidence: 0.45, threshold: null, outcome: 'noise', heard: 'ron beach ron', closest: 'Run Bitch Run!', closestAutomationId: 1, via: 'phrase' }, t);
    assert.deepEqual(e, { t, phrase: null, confidence: 0.45, threshold: null, outcome: 'noise', automationId: null, heard: 'ron beach ron', id: '1763694000000-ab12c', closest: 'Run Bitch Run!', closestAutomationId: 1, via: 'phrase' });
    const f = sanitiseVoiceLogEntry({ id: 'bad id!', t, phrase: 'Run Bitch Run!', confidence: 0.93, threshold: 0.7, outcome: 'fired', automationId: 1, heard: 'ron beach ron', via: 'alias', alias: 'ron beach ron', closest: 'Run Bitch Run!', closestAutomationId: 1 }, t);
    assert.equal(f.id, undefined, 'an id that is not Studio\'s shape is dropped');
    assert.equal(f.alias, 'ron beach ron');
    assert.equal(f.heard, 'ron beach ron');
    const s = createStudioServices({ store: fakeStore(voiceRows()), engine: {}, ingest: {}, now: () => t });
    const conn = { profileId: 7, kind: 'studio' };
    const line = { id: 'a-1', t, confidence: 0.45, outcome: 'noise', heard: 'ron beach ron', closest: 'Run Bitch Run!', closestAutomationId: 1 };
    await s.onRequest(conn, 'voice.log', { entries: [line], replace: true });
    assert.equal(s.markVoiceLog(7, 'a-1', { kind: 'alias', automationId: 1, text: 'ron beach ron' }), true);
    assert.equal(s.markVoiceLog(7, 'nope', { kind: 'alias' }), false);
    await s.onRequest(conn, 'voice.log', { entries: [line], replace: true });
    assert.deepEqual(s.voiceLog(7)[0].learned, { kind: 'alias', automationId: 1, text: 'ron beach ron' });
    s.markVoiceLog(7, 'a-1', null);
    assert.equal('learned' in s.voiceLog(7)[0], false);
});

test('routes: learn, Wrong + undo learning, Undo and Remove (teachFromDashboard), and the editor keeps what was learned', async () => {
    const store = fakeStore(voiceRows());
    // "This was Run" on a near miss
    let r = await teachFromDashboard(store, 7, { automationId: 1, kind: 'alias', text: 'Ron, beach, Ron!', entryId: 'a-1' }, true, T0);
    assert.deepEqual(r.result.aliases.map((a) => a.text), ['ron beach ron']);
    assert.deepEqual(r.learned, { kind: 'alias', automationId: 1, text: 'ron beach ron' });
    assert.equal(r.entryId, 'a-1');
    // Undo of that line
    r = await teachFromDashboard(store, 7, { automationId: 1, kind: 'alias', text: 'ron beach ron', entryId: 'a-1' }, false, T0);
    assert.deepEqual(r.result.aliases, []);
    assert.equal(r.learned, null);
    // a wrong run through an alias: forget the alias, keep the words as not it
    await teachFromDashboard(store, 7, { automationId: 1, kind: 'alias', text: 'run to the shop' }, true, T0);
    r = await teachFromDashboard(store, 7, { automationId: 1, kind: 'negative', text: 'run to the shop now', undo: { kind: 'alias', text: 'run to the shop' }, entryId: 'b-2' }, true, T0);
    assert.deepEqual(r.result.aliases, []);
    assert.deepEqual(r.result.negatives.map((n) => n.text), ['run to the shop now']);
    assert.deepEqual(r.learned.undid, { kind: 'alias', text: 'run to the shop' });
    // Undo of the wrong run puts the alias back and drops the negative
    r = await teachFromDashboard(store, 7, { automationId: 1, kind: 'alias', text: 'run to the shop', undo: { kind: 'negative', text: 'run to the shop now' } }, true, T0);
    assert.deepEqual(r.result.aliases.map((a) => a.text), ['run to the shop']);
    assert.deepEqual(r.result.negatives, []);
    await assert.rejects(() => teachFromDashboard(store, 7, { automationId: 1, kind: 'maybe', text: 'x' }, true), (e) => e.code === 'bad_params');
    await assert.rejects(() => teachFromDashboard(store, 7, { automationId: 1, kind: 'alias', text: ' !! ' }, true), (e) => e.code === 'bad_params');
    await assert.rejects(() => teachFromDashboard(store, 7, { automationId: 4, kind: 'alias', text: 'x' }, true), (e) => e.code === 'not_found');
    assert.ok(await learnVoice(store, 7, 2, { add: { negatives: ['what a lovely day'] } }));
    // the route file: both routes, the editor PUT keeps learned fields it was not sent, and the pages have the controls
    const routes = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot.js'), 'utf8');
    assert.match(routes, /router\.post\('\/stream\/bot\/api\/voice\/learn', needApi/);
    assert.match(routes, /router\.post\('\/stream\/bot\/api\/voice\/unlearn', needApi/);
    assert.match(routes, /for \(const k of \['aliases', 'negatives', 'trained'\]\) if \(!\(k in sent\)/);
    assert.match(routes, /automationsChanged\(sb, profile\.id\);\n        logger\.info\(`\$\{LOG\} voice command taught`/, 'Studio is told to sync');
    const js = fs.readFileSync(path.join(root, 'dashboard/public/js/stream-bot.js'), 'utf8');
    for (const s of ["'This was ' + cmdName(cid)", "'This was...'", "'Not a command'", "'Wrong, undo learning'", "'Heard as'", '/stream/bot/api/voice/unlearn', 'NEAR_MISS = 0.4']) assert.ok(js.includes(s), s);
    const ejs = fs.readFileSync(path.join(root, 'dashboard/views/stream-bot/automations.ejs'), 'utf8');
    assert.match(ejs, /<th scope="col">Closest command<\/th>/);
    assert.doesNotMatch(js + ejs, /impediment|[\u{1F300}-\u{1FAFF}]/iu, 'plain wording, no emoji');
    assert.doesNotMatch(js.match(/VOICE_OUTCOME = \{[^}]*\}/)[0], /'Noise'/, 'shown as "Not a command"');
});
