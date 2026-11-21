/*
 * Stream bot: what CertiFried Studio 0.2.13 learns about how the streamer says each voice command, saved on the voice
 * automation's trigger_config (text only; no audio ever reaches the server):
 *
 *   aliases    [{ text, count, at }]   how Whisper wrote the command when they said it ("heard as"): from Studio's
 *                                      "Teach Studio how you say it" takes and from "This was ..." in the voice log.
 *                                      count goes up each time the same words are taught again; the most frequent go into
 *                                      Whisper's prompt in Studio.
 *   negatives  [{ text, at }]          things they said that were not this command ("Not a command", "Wrong, undo
 *                                      learning"); Studio scores close matches to these lower.
 *   trained    { at, takes }           when "Teach Studio how you say it" last saved, and from how many takes
 *   confidence                         the command's own threshold, which training sets (0.6 to 0.95)
 *
 *   normaliseVoiceText(s)                the same words Studio compares (voice-match.js normalise): lower case, apostrophes
 *                                        dropped, anything but letters and digits a space, filler words removed
 *   cleanVoiceExamples(cfg)              { aliases, negatives, trained } from a stored or posted trigger_config, cleaned and capped
 *   applyVoiceLearning(cfg, ops, now)    a new trigger_config with ops applied:
 *                                          { add: { aliases: [text], negatives: [text] }, remove: { aliases, negatives },
 *                                            confidence, trained: { takes } }
 *                                        Adding an alias removes the same words from the negatives and the other way round;
 *                                        a phrase's own words are never stored as "not a command". Throws VoiceLearnError.
 *   learnVoice(store, profileId, automationId, ops)   load, check (an existing voice command of this profile), apply, save;
 *                                        resolves { automationId, aliases, negatives, confidence, trained }
 *
 * Used by core/stream-bot/studio.js (voice.learn, from Studio) and dashboard/routes/stream-bot.js (/stream/bot/api/voice/learn
 * and /unlearn, from the voice log and the automation page). Tested in tests/stream-bot-voice-learn.test.js.
 */

export const VOICE_LEARN_LIMITS = Object.freeze({ aliases: 50, negatives: 100, text: 100, perCall: 50 });

export class VoiceLearnError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
}

const FILLERS = new Set(['uh', 'um', 'umm', 'erm', 'er', 'hmm', 'mm', 'ah']);

export function normaliseVoiceText(text) {
    return String(text ?? '')
        .slice(0, 400)
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[‘’ʼ'`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w && !FILLERS.has(w))
        .join(' ')
        .slice(0, VOICE_LEARN_LIMITS.text)
        .trim();
}

const isoOrNull = (v) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

export function cleanVoiceExamples(cfg = {}) {
    const aliases = [];
    const seenA = new Set();
    for (const x of Array.isArray(cfg?.aliases) ? cfg.aliases : []) {
        const text = normaliseVoiceText(typeof x === 'string' ? x : x?.text);
        if (!text || seenA.has(text) || aliases.length >= VOICE_LEARN_LIMITS.aliases) continue;
        seenA.add(text);
        const n = Number(x?.count);
        aliases.push({ text, count: Number.isInteger(n) && n > 0 ? Math.min(1000, n) : 1, at: isoOrNull(x?.at) });
    }
    const negatives = [];
    const seenN = new Set();
    for (const x of Array.isArray(cfg?.negatives) ? cfg.negatives : []) {
        const text = normaliseVoiceText(typeof x === 'string' ? x : x?.text);
        if (!text || seenN.has(text) || seenA.has(text) || negatives.length >= VOICE_LEARN_LIMITS.negatives) continue;
        seenN.add(text);
        negatives.push({ text, at: isoOrNull(x?.at) });
    }
    const t = cfg?.trained;
    const takes = Number(t?.takes);
    const trained = t && typeof t === 'object' ? { at: isoOrNull(t.at), takes: Number.isInteger(takes) && takes > 0 ? Math.min(100, takes) : null } : null;
    return { aliases, negatives, trained };
}

const texts = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).slice(0, VOICE_LEARN_LIMITS.perCall).map((x) => normaliseVoiceText(typeof x === 'string' ? x : x?.text)).filter(Boolean);

export function applyVoiceLearning(cfg = {}, ops = {}, nowMs = Date.now()) {
    const at = new Date(nowMs).toISOString();
    const cur = cleanVoiceExamples(cfg);
    const phrases = new Set((Array.isArray(cfg.phrases) ? cfg.phrases : []).map(normaliseVoiceText).filter(Boolean));
    let aliases = cur.aliases;
    let negatives = cur.negatives;
    const addA = texts(ops?.add?.aliases);
    const addN = texts(ops?.add?.negatives);
    const remA = new Set(texts(ops?.remove?.aliases));
    const remN = new Set(texts(ops?.remove?.negatives));
    if (!addA.length && !addN.length && !remA.size && !remN.size && ops?.confidence == null && !ops?.trained) throw new VoiceLearnError('bad_params', 'Nothing to learn.');
    for (const t of addN) if (phrases.has(t)) throw new VoiceLearnError('is_phrase', `"${t}" is one of this command's own phrases, so it cannot be marked as not a command.`);
    aliases = aliases.filter((a) => !remA.has(a.text));
    negatives = negatives.filter((n) => !remN.has(n.text));
    for (const t of addA) {
        negatives = negatives.filter((n) => n.text !== t);
        if (phrases.has(t)) continue;   // the phrase itself needs no alias
        const had = aliases.find((a) => a.text === t);
        if (had) { had.count = Math.min(1000, had.count + 1); had.at = at; } else aliases.push({ text: t, count: 1, at });
    }
    for (const t of addN) {
        aliases = aliases.filter((a) => a.text !== t);
        negatives = negatives.filter((n) => n.text !== t);
        negatives.push({ text: t, at });
    }
    // over the caps: the least used (then oldest) aliases and the oldest negatives go first
    if (aliases.length > VOICE_LEARN_LIMITS.aliases) aliases = [...aliases].sort((a, b) => b.count - a.count || String(b.at).localeCompare(String(a.at))).slice(0, VOICE_LEARN_LIMITS.aliases);
    if (negatives.length > VOICE_LEARN_LIMITS.negatives) negatives = negatives.slice(-VOICE_LEARN_LIMITS.negatives);
    const next = { ...cfg, aliases, negatives };
    if (!aliases.length) delete next.aliases;
    if (!negatives.length) delete next.negatives;
    if (ops?.confidence != null && ops.confidence !== '') {
        const c = Number(ops.confidence);
        // training sets this command's own threshold; the same range the editor allows, and never under 60% from Studio
        if (!Number.isFinite(c) || c < 0.6 || c > 0.95) throw new VoiceLearnError('bad_params', 'The threshold from training must be from 60% to 95%.');
        next.confidence = Math.round(c * 100) / 100;
    }
    if (ops?.trained) {
        const n = Number(ops.trained.takes);
        next.trained = { at, takes: Number.isInteger(n) && n > 0 ? Math.min(100, n) : null };
    }
    return next;
}

export async function learnVoice(store, profileId, automationId, ops, nowMs = Date.now()) {
    const id = Number(automationId);
    if (!Number.isInteger(id) || id <= 0) throw new VoiceLearnError('bad_params', 'Which voice command? automationId is required.');
    const a = await store.getAutomation(profileId, id);
    if (!a) throw new VoiceLearnError('not_found', 'That automation does not exist.');
    if (a.trigger_type !== 'voice.phrase') throw new VoiceLearnError('bad_params', 'That automation is not a voice command.');
    const trigger_config = applyVoiceLearning(a.trigger_config || {}, ops, nowMs);
    await store.updateAutomation(profileId, id, { name: a.name, enabled: a.enabled, trigger_type: a.trigger_type, trigger_config, conditions: a.conditions, actions: a.actions });
    const out = cleanVoiceExamples(trigger_config);
    return { automationId: id, aliases: out.aliases, negatives: out.negatives, confidence: trigger_config.confidence ?? null, trained: out.trained };
}

/**
 * The dashboard's /stream/bot/api/voice/learn (adding) and /unlearn routes, without Express:
 *   body { automationId, kind: 'alias' | 'negative', text, entryId?, undo?: { kind, text } }
 *   learn adds the words (and with `undo` removes one at the same time: "Wrong, undo learning" forgets the alias that
 *   matched and keeps the words as not it; Undo of that puts the alias back); unlearn removes them.
 * → { result (learnVoice), entryId, learned } where `learned` is what the log line should remember (null after unlearn).
 */
const VOICE_KINDS = Object.freeze({ alias: 'aliases', negative: 'negatives' });
export async function teachFromDashboard(store, profileId, body, adding, nowMs = Date.now()) {
    const b = body && typeof body === 'object' ? body : {};
    const list = VOICE_KINDS[b.kind];
    const text = normaliseVoiceText(b.text);
    if (!list || !text) throw new VoiceLearnError('bad_params', 'Say which words, and whether they are how you say the command or not a command.');
    const ops = { add: {}, remove: {} };
    (adding ? ops.add : ops.remove)[list] = [text];
    const undoList = adding && b.undo && VOICE_KINDS[b.undo.kind];
    const undoText = undoList ? normaliseVoiceText(b.undo.text) : '';
    if (undoList && undoText) ops.remove[undoList] = [...(ops.remove[undoList] || []), undoText];
    const result = await learnVoice(store, profileId, b.automationId, ops, nowMs);
    const entryId = typeof b.entryId === 'string' && /^[0-9a-z-]{1,40}$/i.test(b.entryId) ? b.entryId : null;
    const learned = adding ? { kind: b.kind, automationId: result.automationId, text, ...(undoText ? { undid: { kind: b.undo.kind, text: undoText } } : {}) } : null;
    return { result, entryId, learned };
}

export default { normaliseVoiceText, cleanVoiceExamples, applyVoiceLearning, learnVoice, teachFromDashboard, VoiceLearnError, VOICE_LEARN_LIMITS };
