/*
 * AI moderation — the shared classification layer and its Discord / Twitch / Kick stages.
 * Pure rules: core/ai-moderation-logic.js. Link names: core/link-intel-logic.js, link ages + invites: core/link-intel.js.
 *
 * WHERE IT RUNS
 *   Discord   events/messageCreate.js (after every older filter had its turn, fire-and-forget so the AI never
 *             delays the rest of the handler) and events/messageUpdate.js (a benign post edited into a scam).
 *   Twitch    core/twitch-kbd-defender.js, only when kbd_mode is detect / enforce (off by default; only the
 *             owner's channel 96189264 is on) and the KBD lists found nothing.
 *   Kick      services/certifried-bot/kick-automod.js, only with automod.ai_mode detect / enforce.
 *   Others    core/ai-judge.js judgeScamText asks classify() first (local models), so the existing "AI second
 *             opinion" surfaces get the local-first chain too.
 *
 * DATA FLOW AND PRIVACY (also in the report)
 *   1. Cheap signals are computed in process for every screened message: folding / evasion, lexical cues, link
 *      names, cached domain ages, resolved invites, account and join age, bursts, cross-channel duplicates,
 *      mentions, confirmed-scam signatures. Nothing leaves the server for this.
 *   2. Only when those are ambiguous (weighted score >= AMBIGUOUS_MIN) is a model asked. Never for: DMs, staff,
 *      exempt members, ignored channels, age-restricted channels, bots and webhooks.
 *   3. Models, in order: triage on qwen2.5:7b (server2 RTX 3050 through the 127.0.0.1:11435 tunnel, then the owner's
 *      RTX 5080 on 127.0.0.1:11434), escalation on qwen3.6:35b-a3b (5080). Both run on hardware the
 *      owner controls. Gemini is the last resort, and only when the server consents: ai_mod_cloud 'allow', or
 *      'inherit' with the existing AI second opinion switched on (ai_text_mode not 'off'). Never for members who
 *      opted out of message logging (/privacy), and never for Twitch or Kick chat.
 *   4. What a model sees: the message (mentions replaced, clipped to 1500 chars), up to four earlier messages of
 *      the channel from the bot's cache (labelled same author / someone else, no names or ids), text OCR'd from
 *      its images, the signal ids. The escalation model may also see up to two of the images. No usernames.
 *   5. Kept: verdicts are cached in memory by content hash for 6 hours. A catch is a phishing_detections row
 *      (source 'ai_moderation') like every other protection. Moderator verdicts go to ai_mod_labels with a 500-char
 *      sample (none for members who opted out). Confirmed catches become signatures (hashes, domains, invite
 *      server ids, embeddings); with network sharing on, also the network list (scope '0') and kbd_malicious_sites.
 *
 * ACTIONS
 *   Per server, per category (phishing_config.ai_mod_actions). Every category starts at "log + mod card" (a
 *   review alert with Ban / Dismiss on the evidence channel and the queue), so nobody is punished until the
 *   server opts in. Bans need model confidence >= 0.9 AND >= 8 points of independent cheap evidence, or a
 *   confirmed signature; self-harm is only ever a card. Enforcement is core/message-threats.js enforce(): holds,
 *   staff, the allowlist, the ban circuit breaker and "manual action needed" all apply.
 */
import crypto from 'node:crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { isExempt, isIgnoredChannel } from './protection-exempt.js';
import { isMessageLoggingOptedOut } from './privacy-settings.js';
import { analyzeMessage, mightContainLink } from './obfuscated-url.js';
import { CrossChannelTracker } from './spam-similarity.js';
import { parseOllamaEndpoints } from './twitch-ai.js';
import { takeSlot } from './ai-judge-logic.js';
import L, {
    CATEGORIES, CATEGORY_LABEL, ACTIONS, ACTION_LABEL, MAX_ACTION, RESPONSE_SCHEMA, SIGNAL_POINTS,
    configFrom, cleanActions, normalise, textSignals, weightsFrom, weightedScore, band, buildPrompt, parseClassification,
    shouldEscalate, decideAction, contentKey, cosine, hintedCategory, weeklyReport, fenceSafe, signalWeight,
} from './ai-moderation-logic.js';
import { linkSignalsBest, domainAgeSignal, extractInviteCodes, inviteSignals } from './link-intel-logic.js';
import { domainAgeDays, resolveInvite } from './link-intel.js';

const LOG = '[AIMod]';
const mt = () => import('./message-threats.js');
const pdm = () => import('./phishing-detection-manager.js');
const ocr = () => import('./scam-image-ocr.js');
const images = () => import('./message-images.js');

// ── providers ────────────────────────────────────────────────────────────────

// Triage runs on server2's always-on 3050 first: the 5080 cannot hold qwen2.5:7b and qwen3.6 together (16 GB), and
// swapping them cost a ~3 s reload per switch in the 2026-11-21 eval. The 5080's 7B is only the triage fallback.
const TRIAGE = parseOllamaEndpoints(process.env.AI_MOD_TRIAGE || 'http://127.0.0.1:11435#qwen2.5:7b,http://127.0.0.1:11434#qwen2.5:7b', 'qwen2.5:7b');
const ESCALATE = parseOllamaEndpoints(process.env.AI_MOD_ESCALATE || 'http://127.0.0.1:11434#qwen3.6:35b-a3b', 'qwen3.6:35b-a3b');
const EMBED = parseOllamaEndpoints(process.env.AI_MOD_EMBED || 'http://127.0.0.1:11435#nomic-embed-text,http://127.0.0.1:11434#nomic-embed-text', 'nomic-embed-text');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiKey = () => process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
const TIMEOUTS = { triage: 6000, escalate: 15000, cloud: 10000, embed: 3000 };
const PER_MINUTE = { local: Math.max(1, Number(process.env.AI_MOD_PER_MINUTE) || 90), cloud: Math.max(1, Number(process.env.AI_MOD_CLOUD_PER_MINUTE) || 20) };
const DOWN_MS = 60_000;
const CACHE_TTL_MS = 6 * 3600_000;
const CACHE_MAX = 5000;

const health = new Map();   // url -> { downUntil, lastError, lastOkAt, lastMs }
let transport = null;       // tests replace the network: async ({ kind, endpoint, body }) => replyText | throws

/** Tests only: replace every model call. */
export function _setTransport(fn) { transport = fn; cache.clear(); inflight.clear(); }

function markDown(url, err) { health.set(url, { ...(health.get(url) || {}), downUntil: Date.now() + DOWN_MS, lastError: String(err?.message || err).slice(0, 160) }); }
function markUp(url, ms) { health.set(url, { ...(health.get(url) || {}), downUntil: 0, lastOkAt: Date.now(), lastMs: ms, lastError: null }); }
const isDown = (url) => (health.get(url)?.downUntil || 0) > Date.now();

async function ollamaChat(ep, { system, user, images: imgs = [], timeoutMs }) {
    const body = {
        model: ep.model, stream: false, think: false, format: RESPONSE_SCHEMA,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user, ...(imgs.length ? { images: imgs } : {}) }],
        // One num_ctx for every caller so the model is not reloaded (core/twitch-ai.js uses the same 8192).
        options: { temperature: 0, num_predict: 220, num_ctx: 8192 },
    };
    if (transport) return transport({ kind: 'ollama', endpoint: ep, body });
    const res = await fetch(`${ep.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json?.message?.content ?? '';
}

async function geminiCall({ system, user }) {
    const body = {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
            temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA,
            ...(/2\.5-flash/i.test(GEMINI_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
    };
    if (transport) return transport({ kind: 'gemini', endpoint: { url: 'gemini', model: GEMINI_MODEL }, body });
    if (!geminiKey()) throw new Error('no Gemini key');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUTS.cloud),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.promptFeedback?.blockReason) throw new Error(`blocked: ${json.promptFeedback.blockReason}`);
    const cand = json?.candidates?.[0];
    if (!cand || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason)) throw new Error(`blocked: ${cand?.finishReason || 'empty'}`);
    return (cand.content?.parts || []).map(p => (typeof p.text === 'string' && !p.thought ? p.text : '')).join('');
}

/** Try a chain of Ollama endpoints; the first parseable answer wins. */
async function tryChain(chain, prompt, { timeoutMs, imgs = [] }) {
    for (const ep of chain) {
        if (isDown(ep.url) && !transport) continue;
        const started = Date.now();
        try {
            const reply = await ollamaChat(ep, { ...prompt, images: imgs, timeoutMs });
            const c = parseClassification(reply);
            markUp(ep.url, Date.now() - started);
            if (c) return { classification: c, provider: 'ollama', model: ep.model, endpoint: ep.url, ms: Date.now() - started };
        } catch (err) {
            // Only an unreachable endpoint is skipped for a minute; a slow answer (busy GPU) is not "down", or a
            // burst would push triage onto the 5080 and evict the escalation model there.
            if (err.name !== 'TimeoutError' && err.name !== 'AbortError' && !/HTTP 4\d\d/.test(err.message)) markDown(ep.url, err);
            logger.debug(`${LOG} ${ep.url} ${ep.model} failed: ${err.message}`);
        }
    }
    return null;
}

// ── meters (server_stats ai_mod_*) ───────────────────────────────────────────

const meters = new Map();   // guildId -> { day, local, cloud, cached, failed, flushed:{...} }
let rateLocal = [];
let rateCloud = [];
let flushTimer = null;
const dayKey = () => new Date().toISOString().slice(0, 10);

function meter(guildId) {
    const day = dayKey();
    let m = meters.get(guildId);
    if (!m || m.day !== day) {
        if (m) void flushMeter(guildId, m);
        m = { day, local: 0, cloud: 0, cached: 0, failed: 0, pending: { local: 0, cloud: 0, cached: 0, failed: 0 }, loaded: false };
        meters.set(guildId, m);
        pool.execute('SELECT ai_mod_local_calls l, ai_mod_cloud_calls c FROM server_stats WHERE guild_id = ? AND date = ?', [guildId, day])
            .then(([[r]]) => { if (r) { m.local += Number(r.l || 0); m.cloud += Number(r.c || 0); } }).catch(() => {});
    }
    if (!flushTimer) { flushTimer = setInterval(() => { for (const [g, mm] of meters) void flushMeter(g, mm); }, 60_000); flushTimer.unref?.(); }
    return m;
}
function bump(m, k) { m[k]++; m.pending[k]++; }
async function flushMeter(guildId, m) {
    const p = m.pending;
    if (!p.local && !p.cloud && !p.cached && !p.failed) return;
    m.pending = { local: 0, cloud: 0, cached: 0, failed: 0 };
    if (!/^\d{15,25}$/.test(guildId)) return;   // Twitch / Kick scopes are metered in memory only
    await pool.execute(
        `INSERT INTO server_stats (guild_id, date, ai_mod_local_calls, ai_mod_cloud_calls, ai_mod_cached, ai_mod_failed) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ai_mod_local_calls = ai_mod_local_calls + VALUES(ai_mod_local_calls), ai_mod_cloud_calls = ai_mod_cloud_calls + VALUES(ai_mod_cloud_calls),
           ai_mod_cached = ai_mod_cached + VALUES(ai_mod_cached), ai_mod_failed = ai_mod_failed + VALUES(ai_mod_failed)`,
        [guildId, m.day, p.local, p.cloud, p.cached, p.failed]).catch(() => { for (const k of Object.keys(p)) m.pending[k] += p[k]; });
}

// ── classify: the one entry point every filter can call ─────────────────────

const cache = new Map();     // key -> { at, result }
const inflight = new Map();  // key -> Promise

/**
 * Classify one piece of member text. Never throws; null classification = no verdict (fail open).
 *
 * @param {string} scopeId          guild id (Discord) or 'twitch:<id>' / 'kick:<id>' for meters and caps
 * @param {object} p
 * @param {string} p.text
 * @param {string} [p.ocrText]
 * @param {Array<{author:boolean,text:string}>} [p.context]
 * @param {Array<{id:string}>} [p.signals]
 * @param {number} [p.score]         weighted cheap score (decides triage vs straight escalation)
 * @param {'discord'|'twitch'|'kick'} [p.platform]
 * @param {boolean} [p.cloudAllowed] false by default
 * @param {string[]} [p.images]      base64 images for the escalation model only
 * @param {number} [p.dailyCap]
 * @returns {Promise<{ classification:object|null, provider:string|null, model:string|null, tier:string|null, cached:boolean, status:string, ms:number }>}
 */
export async function classify(scopeId, { text, ocrText = '', context = [], signals = [], score = 0, platform = 'discord', cloudAllowed = false, images: imgs = [], dailyCap = 400 } = {}) {
    const none = (status) => ({ classification: null, provider: null, model: null, tier: null, cached: false, status, ms: 0 });
    if (!String(text || '').trim() && !String(ocrText || '').trim()) return none('empty');
    const key = `${platform}:${contentKey(`${text}\n${ocrText}`)}`;
    const m = meter(scopeId);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) { bump(m, 'cached'); return { ...hit.result, cached: true, status: 'cached' }; }
    if (inflight.has(key)) return inflight.get(key);
    if (m.local + m.cloud >= dailyCap) return none('capped');

    const run = (async () => {
        const started = Date.now();
        const prompt = buildPrompt({ text, ocrText, context, signals, platform });
        let out = null;
        let tier = null;
        const direct = score >= L.ESCALATE_SCORE || imgs.length > 0;
        if (!direct) {
            const slot = takeSlot(rateLocal, Date.now(), PER_MINUTE.local); rateLocal = slot.times;
            if (slot.ok) {
                bump(m, 'local');
                out = await tryChain(TRIAGE, prompt, { timeoutMs: TIMEOUTS.triage });
                tier = 'triage';
            }
        }
        if (direct || shouldEscalate(out?.classification ?? null, score)) {
            const slot = takeSlot(rateLocal, Date.now(), PER_MINUTE.local); rateLocal = slot.times;
            let esc = null;
            if (slot.ok) {
                bump(m, 'local');
                esc = await tryChain(ESCALATE, prompt, { timeoutMs: TIMEOUTS.escalate, imgs: imgs.slice(0, 2) });
                if (!esc && imgs.length) esc = await tryChain(ESCALATE, prompt, { timeoutMs: TIMEOUTS.escalate });
            }
            if (!esc && cloudAllowed && platform === 'discord') {
                const cs = takeSlot(rateCloud, Date.now(), PER_MINUTE.cloud); rateCloud = cs.times;
                if (cs.ok) {
                    bump(m, 'cloud');
                    const t0 = Date.now();
                    try {
                        const c = parseClassification(await geminiCall(prompt));
                        if (c) esc = { classification: c, provider: 'gemini', model: GEMINI_MODEL, endpoint: 'gemini', ms: Date.now() - t0 };
                        markUp('gemini', Date.now() - t0);
                    } catch (err) { markDown('gemini', err); }
                }
            }
            if (esc) { out = esc; tier = 'escalate'; }
            else {
                // The strong model is unavailable (the 5080 is not on 24/7) and the cloud is not allowed: the small
                // model's answer stands, marked weak, so a flag can only ever become a mod card (decideAction).
                if (!out && direct) {
                    const s2 = takeSlot(rateLocal, Date.now(), PER_MINUTE.local); rateLocal = s2.times;
                    if (s2.ok) { bump(m, 'local'); out = await tryChain(TRIAGE, prompt, { timeoutMs: TIMEOUTS.triage }); tier = 'triage'; }
                }
                if (out?.classification) out = { ...out, classification: { ...out.classification, weak: true } };
            }
        }
        if (!out) { bump(m, 'failed'); return { ...none('no_verdict'), ms: Date.now() - started }; }
        const result = { classification: out.classification, provider: out.provider, model: out.model, tier, cached: false, status: 'ok', ms: Date.now() - started };
        // A weak answer is not cached: the strong model gets its turn on the next copy.
        if (!out.classification.weak) cache.set(key, { at: Date.now(), result });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return result;
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
}

/** Scam-only view for core/ai-judge.js: { positive, confidence, reason } or null. Local models only. */
export async function classifyScam(guildId, { text, context = [], signals = [] }) {
    const r = await classify(guildId, { text, context, signals: signals.map(s => ({ id: String(s).slice(0, 40) })), score: L.ESCALATE_SCORE, cloudAllowed: false });
    const c = r.classification;
    if (!c) return null;
    const scamCats = new Set(['scam', 'crypto_fraud', 'malicious_link', 'impersonation']);
    const best = c.labels.find(l => scamCats.has(l.category));
    return best ? { positive: true, confidence: best.confidence, reason: c.reason } : { positive: false, confidence: Math.max(0.5, 1 - (c.confidence || 0)), reason: c.reason || 'No scam found' };
}

// ── embeddings ───────────────────────────────────────────────────────────────

async function embed(text, { timeoutMs = TIMEOUTS.embed } = {}) {
    for (const ep of EMBED) {
        // Health is tracked per endpoint AND model, so a slow embedding never marks the same server's chat model down.
        const hk = `${ep.url}#embed`;
        if (isDown(hk) && !transport) continue;
        try {
            if (transport) { const v = await transport({ kind: 'embed', endpoint: ep, body: { model: ep.model, prompt: text } }); return Array.isArray(v) ? v : null; }
            const res = await fetch(`${ep.url}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ep.model, prompt: text }), signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const v = (await res.json())?.embedding;
            if (Array.isArray(v) && v.length) { markUp(hk, 0); return v; }
        } catch (err) { if (err.name !== 'TimeoutError' && err.name !== 'AbortError') markDown(hk, err); }
    }
    return null;
}

// ── semantic gate (core/ai-moderation-logic.js PROTOTYPES) ──────────────────

let protoVecs = null;
let protoLoading = null;
let protoFailedAt = 0;
const semCache = new Map();   // content key -> sims

async function prototypeVectors() {
    if (protoVecs) return protoVecs;
    if (Date.now() - protoFailedAt < 60_000) return null;
    if (protoLoading) return protoLoading;
    protoLoading = (async () => {
        // The first call may load the model (a few seconds), so the prototypes get a long timeout.
        const one = async (t) => { const v = await embed(L.embedInput(t), { timeoutMs: 30_000 }); if (!v) protoFailedAt = Date.now(); return v; };
        const categories = {};
        for (const [cat, list] of Object.entries(L.PROTOTYPES)) {
            categories[cat] = [];
            for (const t of list) { const v = await one(t); if (!v) return null; categories[cat].push(v); }
        }
        const benign = [];
        for (const t of L.BENIGN_PROTOTYPES) { const v = await one(t); if (!v) return null; benign.push(v); }
        protoVecs = { categories, benign };
        return protoVecs;
    })().finally(() => { protoLoading = null; });
    return protoLoading;
}

/** Max similarity per category for one normalised message, or null (too short, or no embedding model up). */
export async function semanticFor(n, key) {
    if (!L.wantsSemantic(n)) return null;
    if (semCache.has(key)) return semCache.get(key);
    const p = await prototypeVectors();
    if (!p) return null;
    const vec = await embed(L.embedInput(n.folded));
    if (!vec) return null;
    const sims = L.semanticSims(vec, p);
    semCache.set(key, sims);
    if (semCache.size > 5000) semCache.delete(semCache.keys().next().value);
    return sims;
}

/** Add the semantic signal when the cheap score alone would not ask the AI. Returns the sims (or null). */
export async function addSemantic(n, key, signals, score) {
    if (score >= L.AMBIGUOUS_MIN || signals.some(s => s.id === 'signature_exact')) return null;
    const sims = await semanticFor(n, key);
    if (sims) signals.push(...L.semanticSignals(sims));
    return sims;
}

// ── signatures + signal weights (cached, reloaded every 10 minutes) ─────────

const SIG_TTL_MS = 10 * 60_000;
let sigs = { at: 0, text: new Map(), domain: new Map(), invite: new Map(), vectors: [] };
let sigLoading = null;
let stats = { at: 0, byGuild: new Map() };

async function loadSignatures(force = false) {
    if (!force && Date.now() - sigs.at < SIG_TTL_MS) return sigs;
    if (sigLoading) return sigLoading;
    sigLoading = (async () => {
        try {
            const [rows] = await pool.query(
                `SELECT id, scope_guild_id, kind, value_hash, value, embedding, category FROM ai_mod_signatures
                  WHERE confirmations > false_positives ORDER BY last_hit_at DESC LIMIT 20000`);
            const next = { at: Date.now(), text: new Map(), domain: new Map(), invite: new Map(), vectors: [] };
            for (const r of rows) {
                const entry = { id: r.id, scope: r.scope_guild_id, category: r.category };
                const put = (map, k) => { const l = map.get(k) || []; l.push(entry); map.set(k, l); };
                if (r.kind === 'text') put(next.text, r.value_hash);
                else if (r.kind === 'domain') put(next.domain, String(r.value || '').toLowerCase());
                else if (r.kind === 'invite_guild') put(next.invite, String(r.value || ''));
                else if (r.kind === 'embedding' && r.embedding && next.vectors.length < 4000) {
                    try { next.vectors.push({ ...entry, vec: JSON.parse(r.embedding) }); } catch { /* bad row */ }
                }
            }
            sigs = next;
        } catch (err) {
            logger.debug(`${LOG} signatures not loaded: ${err.message}`);
            sigs = { ...sigs, at: Date.now() - SIG_TTL_MS + 60_000 };
        } finally { sigLoading = null; }
        return sigs;
    })();
    return sigLoading;
}

async function loadStats() {
    if (Date.now() - stats.at < SIG_TTL_MS) return stats;
    try {
        const [rows] = await pool.query('SELECT guild_id, signal_id, tp, fp FROM ai_mod_signal_stats');
        const byGuild = new Map();
        for (const r of rows) {
            const g = byGuild.get(r.guild_id) || {};
            g[r.signal_id] = { tp: Number(r.tp), fp: Number(r.fp) };
            byGuild.set(r.guild_id, g);
        }
        stats = { at: Date.now(), byGuild };
    } catch { stats = { ...stats, at: Date.now() - SIG_TTL_MS + 60_000 }; }
    return stats;
}

const visible = (list, scopeId, useNetwork) => (list || []).filter(e => e.scope === scopeId || (useNetwork && e.scope === '0'));

async function weightsFor(scopeId) {
    const s = await loadStats();
    return weightsFrom(s.byGuild.get(scopeId) || {}, s.byGuild.get('0') || {});
}

// ── behaviour trackers (in memory, bounded) ─────────────────────────────────

const crossChannel = new CrossChannelTracker({ windowMs: 2 * 60_000 });
const bursts = new Map();          // `${scope}:${user}` -> [ms]
const chatWaves = new Map();       // `${scope}:${key}` -> { users:Set, at }
const screened = new Map();        // guildId -> [{ messageId, userId, channelId, key, score, caught, at, sample, signals }]
const SCREENED_MAX = 400;

function noteBurst(scope, userId, now = Date.now()) {
    const k = `${scope}:${userId}`;
    const list = (bursts.get(k) || []).filter(t => now - t < 10_000);
    list.push(now);
    bursts.set(k, list);
    if (bursts.size > 20000) bursts.delete(bursts.keys().next().value);
    return list.length;
}

function noteWave(scope, key, userId, now = Date.now()) {
    const k = `${scope}:${key}`;
    let w = chatWaves.get(k);
    if (!w || now - w.at > 60_000) w = { users: new Set(), at: now };
    w.users.add(userId);
    chatWaves.set(k, w);
    if (chatWaves.size > 20000) chatWaves.delete(chatWaves.keys().next().value);
    return w.users.size;
}

function remember(guildId, entry) {
    const list = screened.get(guildId) || [];
    list.push(entry);
    while (list.length > SCREENED_MAX) list.shift();
    screened.set(guildId, list);
    if (screened.size > 5000) screened.delete(screened.keys().next().value);
}

// ── settings ─────────────────────────────────────────────────────────────────

export async function getConfig(guildId) {
    try {
        const { row } = await (await mt()).getSettings(guildId);
        const cfg = configFrom(row);
        cfg.timeoutMinutes = Math.max(1, Math.min(40320, Number(row?.ai_mod_timeout_minutes) || 60));
        cfg.hasRow = !!row;
        cfg.migrated = !!row && Object.prototype.hasOwnProperty.call(row, 'ai_mod_cloud');
        return cfg;
    } catch { return { ...configFrom(null), timeoutMinutes: 60, hasRow: false, migrated: false }; }
}

/** Save from the dashboard. patch keys: enabled, actions{}, cloud, shareNetwork, useNetwork, scanImages, dailyCap, minConfidence, timeoutMinutes */
export async function saveConfig(guild, patch = {}, by = null) {
    const values = {};
    if ('enabled' in patch) values.ai_mod_enabled = patch.enabled ? 1 : 0;
    if ('actions' in patch) {
        const a = cleanActions(patch.actions);
        if (!a.ok) return a;
        values.ai_mod_actions = JSON.stringify(a.values);
    }
    if ('cloud' in patch) {
        if (!['inherit', 'allow', 'deny'].includes(patch.cloud)) return { ok: false, error: 'Cloud must be inherit, allow or deny.' };
        values.ai_mod_cloud = patch.cloud;
    }
    for (const [k, col] of [['shareNetwork', 'ai_mod_share_network'], ['useNetwork', 'ai_mod_use_network'], ['scanImages', 'ai_mod_images']]) {
        if (k in patch) values[col] = patch[k] ? 1 : 0;
    }
    if ('dailyCap' in patch) {
        const n = Math.round(Number(patch.dailyCap));
        if (!Number.isFinite(n) || n < 10 || n > 5000) return { ok: false, error: 'The daily cap must be between 10 and 5000.' };
        values.ai_mod_daily_cap = n;
    }
    if ('minConfidence' in patch) {
        let n = Number(patch.minConfidence);
        if (n > 1) n /= 100;
        if (!Number.isFinite(n) || n < 0.5 || n > 0.99) return { ok: false, error: 'The confidence bar must be between 50% and 99%.' };
        values.ai_mod_min_confidence = Number(n.toFixed(3));
    }
    if ('timeoutMinutes' in patch) {
        const n = Math.round(Number(patch.timeoutMinutes));
        if (!Number.isFinite(n) || n < 1 || n > 40320) return { ok: false, error: 'The timeout must be between 1 minute and 28 days.' };
        values.ai_mod_timeout_minutes = n;
    }
    const cols = Object.keys(values);
    if (!cols.length) return { ok: true, changed: [] };
    await pool.execute(
        `INSERT INTO phishing_config (guild_id, enabled, ${cols.join(', ')}) VALUES (?, 0, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
        [guild.id, ...cols.map(c => values[c])]);
    (await mt()).invalidate(guild.id);
    logger.info(`${LOG} settings changed in ${guild.id} by ${by}: ${cols.join(', ')}`);
    void logFeatureEvent(() => (guild), 'automod.aiSettings', () => ({
        title: '⚙️ AI Moderation Settings Changed',
        fields: [['Changed', cols.map(c => c.replace(/^ai_mod_/, '').replace(/_/g, ' ')).join(', '), false], ['By', userLabel(by)]],
    }));
    return { ok: true, changed: cols };
}

// ── cheap signals for a Discord message ─────────────────────────────────────

const DAY = 86_400_000;

/** Everything cheap about one message. Exported for the eval harness and tests. */
export async function messageSignals(message, cfg, { ocrText = '' } = {}) {
    const guildId = message.guild.id;
    const content = message.content || '';
    const targeted = (message.mentions?.users?.size || 0) > 0 || !!message.reference;
    const n = normalise(`${content}${ocrText ? `\n${ocrText}` : ''}`);
    const { signals } = textSignals(n, { targeted });
    const add = (id, category, detail, points = SIGNAL_POINTS[id]) => signals.push({ id, points, category, ...(detail ? { detail } : {}) });

    // Links: names (pure), the phishing feeds, signatures, cached domain age.
    const links = linkSignalsBest([`${n.plain}\n${ocrText}`, ...n.forms]);
    signals.push(...links.signals);
    const sg = await loadSignatures();
    const hosts = links.hosts.map(h => h.host);
    if (hosts.length) {
        let lookup = null;
        try { lookup = (await pdm()).phishingLookup; } catch { /* manager not loaded */ }
        for (const h of hosts.slice(0, 8)) {
            const listed = lookup ? lookup(h) : null;
            if (listed) add('link_phishing_listed', 'malicious_link', listed, 10);
            const sig = visible(sg.domain.get(h) || sg.domain.get(h.split('.').slice(-2).join('.')), guildId, cfg.useNetwork);
            if (sig.length) add('signature_domain', sig[0].category, h);
            const age = domainAgeSignal(h, await domainAgeDays(h));
            if (age) signals.push(age);
        }
    }
    if (mightContainLink(content)) {
        const a = analyzeMessage(content);
        if (a?.verdict === 'confirmed' || a?.verdict === 'suspicious') add('obfuscated_link', 'scam', a.verdict);
    }
    // Invites → which server, its name and age, and whether it is a confirmed scam server.
    const codes = extractInviteCodes(`${n.plain}\n${n.folded}`);
    if (codes.length) {
        const blocked = new Set([...sg.invite.entries()].filter(([, l]) => visible(l, guildId, cfg.useNetwork).length).map(([k]) => k));
        for (const code of codes.slice(0, 3)) {
            const info = await resolveInvite(message.client, code);
            if (info?.guildId === guildId) continue;   // an invite to this same server
            signals.push(...inviteSignals(code, info, blocked));
        }
    }
    // Account and membership.
    const now = Date.now();
    const created = message.author?.createdTimestamp;
    if (created && now - created < DAY) add('new_account_day', 'spam_bot');
    else if (created && now - created < 7 * DAY) add('new_account_week', 'spam_bot');
    const joined = message.member?.joinedTimestamp;
    if (joined && now - joined < 10 * 60_000) add('joined_10min', 'spam_bot');
    else if (joined && now - joined < DAY) add('joined_day', 'spam_bot');
    // Behaviour.
    if (noteBurst(guildId, message.author.id, now) >= 5) add('burst', 'spam_bot');
    if (content.length >= 12) {
        const cc = crossChannel.add(guildId, message.author.id, message.channel.id, content, { now });
        if (cc.count >= 3) add('cross_channel_dup', 'spam_bot', `${cc.count} channels`);
    }
    if ((message.mentions?.users?.size || 0) >= 5) add('mass_mention', 'raid', `${message.mentions.users.size} members`);
    if (/@(?:everyone|here)\b/.test(content) && !message.mentions?.everyone) add('everyone_attempt', 'raid');
    try { if (message.client?.raidDetectionManager?.isRaidActive?.(guildId)) add('raid_active', 'raid'); } catch { /* optional */ }
    // Exact confirmed signature.
    const key = contentKey(`${content}\n${ocrText}`);
    const exact = visible(sg.text.get(key), guildId, cfg.useNetwork);
    if (exact.length) add('signature_exact', exact[0].category);
    return { signals, normalised: n, hosts, key };
}

async function similarSignatures(text, guildId, useNetwork) {
    const sg = await loadSignatures();
    const pool_ = sg.vectors.filter(v => v.scope === guildId || (useNetwork && v.scope === '0'));
    if (!pool_.length) return [];
    const vec = await embed(String(text).slice(0, 1000));
    if (!vec) return [];
    let best = null;
    for (const v of pool_) { const s = cosine(vec, v.vec); if (!best || s > best.s) best = { s, v }; }
    if (!best) return [];
    if (best.s >= 0.92) return [{ id: 'signature_similar_high', points: SIGNAL_POINTS.signature_similar_high, category: best.v.category, detail: best.s.toFixed(2) }];
    if (best.s >= 0.86) return [{ id: 'signature_similar', points: SIGNAL_POINTS.signature_similar, category: best.v.category, detail: best.s.toFixed(2) }];
    return [];
}

function cachedContext(message) {
    try {
        const all = [...message.channel.messages.cache.values()]
            .filter(m => m.id !== message.id && m.createdTimestamp <= message.createdTimestamp && !m.author?.bot && m.content)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp).slice(-4);
        return all.map(m => ({ author: m.author?.id === message.author?.id, text: m.content }));
    } catch { return []; }
}

const isAgeRestricted = (ch) => !!(ch?.nsfw || ch?.parent?.nsfw);
const signalText = (s) => `${s.id.replace(/_/g, ' ')}${s.detail ? ` (${String(s.detail).slice(0, 60)})` : ''}`;

// ── the Discord stage ────────────────────────────────────────────────────────

/**
 * Screen one guild message. Fire-and-forget from messageCreate / messageUpdate; never throws.
 * @returns {Promise<{ screened:boolean, band?:string, score?:number, decision?:object, outcome?:string }>}
 */
export async function screenMessage(message, { edited = false } = {}) {
    try {
        if (!message?.guild || !message.author || message.author.bot || message.webhookId || message.system) return { screened: false };
        const hasImages = (message.attachments?.size || 0) > 0;
        if (!message.content && !hasImages) return { screened: false };
        const cfg = await getConfig(message.guild.id);
        if (!cfg.enabled) return { screened: false };
        const threats = await mt();
        if (threats.isStaffMember(message.member)) return { screened: false };
        if (await isIgnoredChannel(message.channel)) return { screened: false };
        if (message.member && (await isExempt(message.member)).exempt) return { screened: false };
        const ageRestricted = isAgeRestricted(message.channel);

        // OCR only where it can matter: images from new accounts / members, or alongside other signals.
        let ocrText = '';
        let sig = await messageSignals(message, cfg);
        let score = weightedScore(sig.signals, await weightsFor(message.guild.id));
        if (hasImages && cfg.scanImages && !ageRestricted) {
            const newish = sig.signals.some(s => ['new_account_day', 'new_account_week', 'joined_10min', 'joined_day', 'cross_channel_dup', 'burst'].includes(s.id));
            if (newish || score >= 1) {
                try {
                    const imgs = (await images()).imageAttachments(message);
                    if (imgs.length) ocrText = (await (await ocr()).scanImages(imgs, { ocr: true })).text || '';
                } catch { ocrText = ''; }
                if (ocrText) {
                    sig = await messageSignals(message, cfg, { ocrText });
                    score = weightedScore(sig.signals, await weightsFor(message.guild.id));
                }
            }
        }
        if (!isAgeRestricted(message.channel) && await addSemantic(sig.normalised, sig.key, sig.signals, score)) score = weightedScore(sig.signals, await weightsFor(message.guild.id));
        let b = band(score, sig.signals);
        const entry = { messageId: message.id, userId: message.author.id, channelId: message.channel.id, key: sig.key, score, caught: false, at: Date.now(), signals: sig.signals.map(s => s.id) };
        const optedOut = await Promise.resolve().then(() => isMessageLoggingOptedOut(message.author.id)).catch(() => true);
        entry.sample = optedOut ? null : fenceSafe(`${message.content || ''}${ocrText ? ` [image text] ${ocrText}` : ''}`, 500);
        if (b === 'clean') { remember(message.guild.id, entry); return { screened: true, band: b, score }; }
        if (ageRestricted && b !== 'known') { remember(message.guild.id, entry); return { screened: true, band: 'age_restricted', score }; }

        // Similar to a confirmed scam? (one local embedding call, only for ambiguous messages)
        if (b !== 'known') {
            const sim = await similarSignatures(sig.normalised.folded, message.guild.id, cfg.useNetwork);
            if (sim.length) { sig.signals.push(...sim); score = weightedScore(sig.signals, await weightsFor(message.guild.id)); b = band(score, sig.signals); }
        }

        let ai = null;
        if (b !== 'known') {
            let imgs = [];
            if (hasImages && cfg.scanImages && ocrText && !ageRestricted) {
                try {
                    const mi = await images();
                    for (const att of mi.imageAttachments(message).slice(0, 2)) {
                        const buf = await mi.fetchImageBytes(att.url, { maxBytes: 3 * 1024 * 1024 }).catch(() => null);
                        if (buf) imgs.push(Buffer.from(buf).toString('base64'));
                    }
                } catch { imgs = []; }
            }
            ai = await classify(message.guild.id, {
                text: message.content || '', ocrText, context: cachedContext(message), signals: sig.signals, score, platform: 'discord',
                cloudAllowed: cfg.cloudAllowed && !optedOut, images: imgs, dailyCap: cfg.dailyCap,
            });
        }
        const knownCat = b === 'known' ? (sig.signals.find(s => s.id === 'signature_exact')?.category ?? null) : null;
        const decision = decideAction({ classification: ai?.classification ?? null, score, signals: sig.signals, config: cfg, known: b === 'known', knownCategory: knownCat });
        logger.info(`${LOG} ${message.guild.id} ${message.author.id} band=${b} score=${score} ai=${ai?.status ?? 'skip'}${ai?.model ? `(${ai.model})` : ''} → ${decision.catch ? `${decision.category} ${decision.action}` : 'no catch'}`);
        if (!decision.catch) { remember(message.guild.id, entry); return { screened: true, band: b, score, decision }; }

        entry.caught = true;
        remember(message.guild.id, entry);
        const label = CATEGORY_LABEL[decision.category];
        const pct = Math.round(decision.confidence * 100);
        const reasons = [
            `${label}, ${pct}%${ai?.classification?.reason ? `: ${ai.classification.reason}` : b === 'known' ? ': matches a confirmed scam' : ''}`,
            ai?.model ? `Decided by ${ai.model}${ai.tier === 'escalate' ? ' (escalated)' : ''}${ai.cached ? ', cached' : ''}` : 'Decided by a confirmed signature (no AI call)',
            ...(edited ? ['The message was edited into this'] : []),
        ];
        const res = await threats.enforce({
            guild: message.guild, member: message.member, user: message.author, message, channel: message.channel,
            source: 'ai_moderation', action: { log: 'review', delete: 'delete', timeout: 'timeout', ban: 'ban' }[decision.action] || 'review',
            timeoutMinutes: cfg.timeoutMinutes, reasonKind: 'ai_moderation', reasonExtra: `AI moderation: ${label}`,
            label: `AI: ${label}`, content: [message.content, ocrText ? `[text in the image] ${ocrText}` : ''].filter(Boolean).join('\n').slice(0, 1500),
            reasons, signals: sig.signals.slice(0, 12).map(s => ({ points: Math.round(s.points), text: signalText(s) })), score: Math.round(score),
            links: sig.hosts, attachments: hasImages ? [...message.attachments.values()].slice(0, 4).map(a => ({ name: a.name, url: a.url })) : undefined,
            evidence: { ai_mod: {
                category: decision.category, confidence: decision.confidence, action: decision.action, labels: ai?.classification?.labels ?? [],
                reason: ai?.classification?.reason ?? null, provider: ai?.provider ?? 'signature', model: ai?.model ?? null, tier: ai?.tier ?? null,
                score, band: b, signals: sig.signals.map(s => s.id), key: sig.key, platform: 'discord', edited, sample: entry.sample,
            } },
        });
        return { screened: true, band: b, score, decision, outcome: res?.outcome };
    } catch (err) {
        logger.warn(`${LOG} screen failed: ${err.message}`);
        return { screened: false, error: err.message };
    }
}

// ── Twitch / Kick chat ───────────────────────────────────────────────────────

/**
 * Screen one chat line on Twitch or Kick. Local models only (never Gemini). The caller acts:
 * returns { action:'none'|'detected'|'delete', category, confidence, reason, score }.
 * mode: 'detect' never asks for deletion; 'enforce' asks for deletion of punitive categories at >= 0.85.
 */
export async function screenChat({ platform, channelId, userId, text, mode = 'detect', isNewChatter = false }) {
    const none = { action: 'none' };
    try {
        if (!['twitch', 'kick'].includes(platform) || mode === 'off' || !String(text || '').trim()) return none;
        const scope = `${platform}:${channelId}`;
        const n = normalise(text);
        const { signals } = textSignals(n, { targeted: /@\w/.test(text) });
        signals.push(...linkSignalsBest([n.plain, ...n.forms]).signals);
        const key = contentKey(text);
        if (String(text).length >= 12 && noteWave(scope, key, userId) >= 3) signals.push({ id: 'chat_wave', points: 4, category: 'spam_bot' });
        if (noteBurst(scope, userId) >= 5) signals.push({ id: 'burst', points: SIGNAL_POINTS.burst, category: 'spam_bot' });
        if (isNewChatter) signals.push({ id: 'first_message', points: 1, category: 'spam_bot' });
        const sg = await loadSignatures();
        if ((sg.text.get(key) || []).some(e => e.scope === '0')) signals.push({ id: 'signature_exact', points: SIGNAL_POINTS.signature_exact, category: sg.text.get(key)[0].category });
        let score = weightedScore(signals, await weightsFor('0'));
        if (await addSemantic(n, key, signals, score)) score = weightedScore(signals, await weightsFor('0'));
        const b = band(score, signals);
        if (b === 'clean') return { ...none, score };
        let category = null; let confidence = 0; let reason = '';
        if (b === 'known') { category = hintedCategory(signals) || 'scam'; confidence = 0.99; reason = 'matches a confirmed scam'; }
        else {
            const r = await classify(scope, { text, signals, score, platform, cloudAllowed: false, dailyCap: 1500 });
            const top = r.classification?.labels?.find(l => l.confidence >= 0.7);
            if (!top) return { ...none, score, status: r.status };
            category = top.category; confidence = top.confidence; reason = r.classification.reason;
            if (r.classification.weak) confidence = Math.min(confidence, 0.84);   // small model only: never deletes
        }
        const punitive = !['self_harm'].includes(category) && MAX_ACTION[category] !== 'log';
        const action = mode === 'enforce' && punitive && confidence >= 0.85 ? 'delete' : 'detected';
        return { action, category, confidence, reason, score, label: CATEGORY_LABEL[category] };
    } catch (err) {
        logger.debug(`${LOG} chat screen failed: ${err.message}`);
        return none;
    }
}

// ── the learning loop ────────────────────────────────────────────────────────

const SOURCE_CATEGORY = {
    ai_moderation: null, obfuscated_url: 'scam', automod_escalation: 'spam_bot', anti_everyone: 'raid', qr: 'malicious_link', image_rule: 'scam',
    nsfw_image: 'sexual', scam_text: 'scam', word_filter: 'harassment', 'auto-list': 'malicious_link', 'image-genre': 'scam', 'image-domain': 'malicious_link',
};

async function bumpStats(guildId, signalIds, field, delta = 1) {
    const ids = [...new Set((signalIds || []).filter(Boolean).map(s => String(s).slice(0, 48)))].slice(0, 30);
    for (const g of [guildId, '0']) {
        for (const id of ids) {
            await pool.execute(
                `INSERT INTO ai_mod_signal_stats (guild_id, signal_id, ${field}) VALUES (?, ?, GREATEST(0, ?))
                 ON DUPLICATE KEY UPDATE ${field} = GREATEST(0, CAST(${field} AS SIGNED) + ?)`,
                [g, id, delta, delta]).catch(() => {});
        }
    }
    stats.at = 0;
}

async function upsertSignature(scope, kind, value, { category, embedding = null, sourceGuildId }) {
    const v = String(value ?? '').slice(0, 500);
    const hash = kind === 'text' ? v : crypto.createHash('sha256').update(v.toLowerCase()).digest('hex');
    await pool.execute(
        `INSERT INTO ai_mod_signatures (scope_guild_id, kind, value_hash, value, embedding, category, source_guild_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE confirmations = confirmations + 1, category = VALUES(category), last_hit_at = NOW(),
           embedding = COALESCE(VALUES(embedding), embedding)`,
        [scope, kind, hash, kind === 'text' ? null : v, embedding ? JSON.stringify(embedding) : null, category, sourceGuildId]).catch(err => logger.debug(`${LOG} signature not saved: ${err.message}`));
}

async function learnConfirmed(guildId, ev, cfg) {
    const category = ev.category || 'scam';
    const scopes = [guildId, ...(cfg.shareNetwork ? ['0'] : [])];
    const harmful = ['scam', 'crypto_fraud', 'malicious_link', 'impersonation', 'spam_bot', 'raid'].includes(category);
    if (!harmful) return;   // insults and self-harm are not "signatures": the same words are fine in another context
    for (const scope of scopes) {
        if (ev.key) await upsertSignature(scope, 'text', ev.key, { category, sourceGuildId: guildId });
        for (const h of (ev.hosts || []).slice(0, 5)) await upsertSignature(scope, 'domain', h, { category: 'malicious_link', sourceGuildId: guildId });
    }
    if (ev.sample && ev.key) {
        const vec = await embed(normalise(ev.sample).folded.slice(0, 1000));
        if (vec) for (const scope of scopes) await upsertSignature(scope, 'embedding', `${ev.key}`, { category, embedding: vec.map(x => Number(x.toFixed(5))), sourceGuildId: guildId });
    }
    // The KBD network list Twitch and Kick read, for domains a sharing server confirmed.
    if (cfg.shareNetwork) for (const h of (ev.hosts || []).slice(0, 5)) {
        await pool.execute('INSERT IGNORE INTO kbd_malicious_sites (uri) VALUES (?)', [String(h).toLowerCase().slice(0, 512)]).catch(() => {});
    }
    await loadSignatures(true);
}

async function learnFine(guildId, ev) {
    if (ev.key) {
        await pool.execute(
            "UPDATE ai_mod_signatures SET false_positives = false_positives + 1 WHERE kind IN ('text','embedding') AND value_hash IN (?, ?) AND scope_guild_id IN (?, '0')",
            [ev.key, crypto.createHash('sha256').update(String(ev.key).toLowerCase()).digest('hex'), guildId]).catch(() => {});
        await loadSignatures(true);
    }
}

/**
 * Record a verdict on a detection (any source) and learn from it. Re-labelling a detection replaces the old
 * label and reverses its effect on the signal weights.
 * @param {'confirmed'|'fine'} label
 * @param {'card'|'dashboard'|'ban'|'delete'|'auto'} source
 */
export async function labelDetection(guild, detectionId, label, { by = null, source = 'dashboard' } = {}) {
    if (!['confirmed', 'fine'].includes(label)) return { ok: false, error: 'Label must be confirmed or fine.' };
    const [[d]] = await pool.execute('SELECT id, user_id, message_id, source, content, evidence, matched_url FROM phishing_detections WHERE id = ? AND guild_id = ?', [detectionId, guild.id]);
    if (!d) return { ok: false, error: 'No such detection in this server.' };
    let ev = {};
    try { ev = JSON.parse(d.evidence || '{}')?.ai_mod || {}; } catch { ev = {}; }
    const category = ev.category || SOURCE_CATEGORY[d.source] || null;
    const signals = ev.signals?.length ? ev.signals : [`detector:${d.source}`];
    const [[prev]] = await pool.execute('SELECT label FROM ai_mod_labels WHERE guild_id = ? AND detection_id = ?', [guild.id, d.id]);
    if (prev?.label === label) return { ok: true, unchanged: true };
    const optedOut = await Promise.resolve().then(() => isMessageLoggingOptedOut(d.user_id)).catch(() => true);
    const sample = optedOut ? null : (ev.sample ?? fenceSafe(d.content || '', 500)) || null;
    await pool.execute(
        `INSERT INTO ai_mod_labels (guild_id, platform, detection_id, message_id, user_id, content_key, text_sample, detector, category, label, source, signals, labelled_by)
         VALUES (?, 'discord', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label), source = VALUES(source), labelled_by = VALUES(labelled_by), created_at = NOW()`,
        [guild.id, d.id, d.message_id, d.user_id, ev.key || null, sample, String(d.source || 'unknown').slice(0, 50), category, label, source, signals.join(',').slice(0, 1000), by]);
    if (prev) await bumpStats(guild.id, signals, prev.label === 'confirmed' ? 'tp' : 'fp', -1);
    await bumpStats(guild.id, signals, label === 'confirmed' ? 'tp' : 'fp', 1);
    const cfg = await getConfig(guild.id);
    const hosts = String(d.matched_url || '').split(/\s+/).filter(h => /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(h));
    if (d.source === 'ai_moderation' || ev.key) {
        if (label === 'confirmed') await learnConfirmed(guild.id, { ...ev, category, hosts, sample }, cfg);
        else await learnFine(guild.id, ev);
    }
    void logFeatureEvent(() => (guild), 'automod.aiVerdict', () => ({
        title: label === 'confirmed' ? '✅ AI Moderation: Catch Confirmed' : '↩️ AI Moderation: Marked As Fine',
        description: `Detection #${d.id}${category ? ` (${CATEGORY_LABEL[category] || category})` : ''}. ${label === 'fine' ? 'The signals behind it now count for less.' : 'Similar messages will be caught faster.'}`,
        fields: [['By', by ? userLabel(by) : source], ['Member', userLabel(d.user_id)]],
    }));
    return { ok: true, category };
}

/** core/message-threats.js decideReviews: Ban = confirmed, Dismiss = fine, for every detection behind the reviews. */
export async function onReviewDecision(guild, userIds, decision, actorId) {
    try {
        if (!userIds?.length) return;
        const [rows] = await pool.query(
            `SELECT filter_id FROM name_filter_reviews WHERE guild_id = ? AND kind = 'message' AND user_id IN (${userIds.map(() => '?').join(',')}) AND filter_id IS NOT NULL`,
            [guild.id, ...userIds]);
        for (const r of rows) await labelDetection(guild, r.filter_id, decision === 'ban' ? 'confirmed' : 'fine', { by: actorId, source: 'card' }).catch(() => {});
    } catch (err) { logger.debug(`${LOG} review labels failed: ${err.message}`); }
}

async function addMissed(guildId, e, source) {
    await pool.execute(
        `INSERT INTO ai_mod_labels (guild_id, platform, message_id, user_id, content_key, text_sample, detector, label, source, signals)
         SELECT ?, 'discord', ?, ?, ?, ?, 'ai_moderation', 'missed', ?, ? FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM ai_mod_labels WHERE guild_id = ? AND message_id = ?)`,
        [guildId, e.messageId, e.userId, e.key, e.sample, source, (e.signals || []).join(',').slice(0, 1000), guildId, e.messageId]).catch(() => {});
}

/**
 * events/guildBanAdd.js: a moderator (not this bot) banned someone. Their uncaught AI catches become confirmed,
 * and their last screened messages of the past two hours that were NOT caught become "missed" (recall).
 */
export async function onMemberBanned(guild, userId, executorId = null) {
    try {
        if (!guild || !userId || executorId === guild.client?.user?.id) return;
        const [dets] = await pool.execute(
            `SELECT d.id FROM phishing_detections d LEFT JOIN ai_mod_labels l ON l.guild_id = d.guild_id AND l.detection_id = d.id
              WHERE d.guild_id = ? AND d.user_id = ? AND d.source = 'ai_moderation' AND d.created_at > NOW() - INTERVAL 1 DAY AND l.id IS NULL`, [guild.id, String(userId)]);
        for (const d of dets) await labelDetection(guild, d.id, 'confirmed', { by: executorId, source: 'ban' });
        const recent = (screened.get(guild.id) || []).filter(e => e.userId === String(userId) && !e.caught && Date.now() - e.at < 2 * 3600_000 && (e.score > 0 || e.signals?.length));
        for (const e of recent.slice(-3)) await addMissed(guild.id, e, 'ban');
    } catch (err) { logger.debug(`${LOG} ban labels failed: ${err.message}`); }
}

/**
 * events/messageDelete.js: when a screened message is removed by a moderator (audit log says someone other than
 * the author or this bot), a catch left up becomes confirmed and an uncaught message becomes "missed".
 * Only messages that carried a signal are looked at, so ordinary self-deletes cost nothing.
 */
export async function onMessageDeleted(message) {
    try {
        if (!message?.guild) return;
        const list = screened.get(message.guild.id) || [];
        const e = list.find(x => x.messageId === message.id);
        if (!e || (!e.caught && !(e.score > 0))) return;
        await new Promise(r => setTimeout(r, 1500).unref?.());
        const { AuditLogEvent } = await import('discord.js');
        const logs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 }).catch(() => null);
        const entry = logs?.entries?.find(x => x.target?.id === e.userId && x.extra?.channel?.id === e.channelId && Date.now() - x.createdTimestamp < 60_000);
        const executor = entry?.executor?.id;
        if (!executor || executor === message.client.user.id || executor === e.userId) return;
        if (e.caught) {
            const [[d]] = await pool.execute("SELECT id FROM phishing_detections WHERE guild_id = ? AND message_id = ? AND source = 'ai_moderation' ORDER BY id DESC LIMIT 1", [message.guild.id, message.id]);
            if (d) await labelDetection(message.guild, d.id, 'confirmed', { by: executor, source: 'delete' });
        } else await addMissed(message.guild.id, e, 'delete');
    } catch (err) { logger.debug(`${LOG} delete labels failed: ${err.message}`); }
}

// ── dashboard reads ──────────────────────────────────────────────────────────

export async function listCatches(guildId, { limit = 50, status = 'all' } = {}) {
    const where = status === 'unreviewed' ? 'AND l.id IS NULL' : status === 'confirmed' ? "AND l.label = 'confirmed'" : status === 'fine' ? "AND l.label = 'fine'" : '';
    const [rows] = await pool.execute(
        `SELECT d.id, d.user_id, d.channel_id, d.message_id, d.action_taken, d.content, d.evidence, d.score, d.created_at, l.label, l.labelled_by, l.created_at AS labelled_at
           FROM phishing_detections d LEFT JOIN ai_mod_labels l ON l.guild_id = ? AND l.detection_id = d.id
          WHERE d.guild_id = ? AND d.source = 'ai_moderation' ${where}
          ORDER BY d.id DESC LIMIT ${Math.max(1, Math.min(200, Number(limit) || 50))}`, [guildId, guildId]);
    return rows.map(r => {
        let ev = {};
        try { ev = JSON.parse(r.evidence || '{}')?.ai_mod || {}; } catch { ev = {}; }
        return {
            id: r.id, userId: r.user_id, channelId: r.channel_id, messageId: r.message_id, outcome: r.action_taken, content: String(r.content || '').slice(0, 600),
            score: r.score, at: r.created_at, label: r.label || null, labelledBy: r.labelled_by || null,
            category: ev.category || null, categoryLabel: CATEGORY_LABEL[ev.category] || ev.category || null, confidence: ev.confidence ?? null,
            reason: ev.reason || null, model: ev.model || null, provider: ev.provider || null, tier: ev.tier || null, signals: (ev.signals || []).slice(0, 14),
        };
    });
}

/** Weekly precision / recall for the dashboard: AI catches and the older detectors side by side. */
export async function report(guildId, weeks = 8) {
    const w = Math.max(1, Math.min(26, Number(weeks) || 8));
    const [rows] = await pool.execute(
        `SELECT DATE_FORMAT(DATE_SUB(DATE(created_at), INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d') AS week, detector, COALESCE(category, 'other') AS category,
                SUM(label = 'confirmed') confirmed, SUM(label = 'fine') fine, SUM(label = 'missed') missed
           FROM ai_mod_labels WHERE guild_id = ? AND created_at > NOW() - INTERVAL ${w} WEEK GROUP BY 1, 2, 3`, [guildId]);
    const [caught] = await pool.execute(
        `SELECT DATE_FORMAT(DATE_SUB(DATE(created_at), INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d') AS week, COUNT(*) n
           FROM phishing_detections WHERE guild_id = ? AND source = 'ai_moderation' AND created_at > NOW() - INTERVAL ${w} WEEK GROUP BY 1`, [guildId]);
    const ai = weeklyReport(rows.filter(r => r.detector === 'ai_moderation'));
    const older = weeklyReport(rows.filter(r => r.detector !== 'ai_moderation'));
    const caughtBy = Object.fromEntries(caught.map(r => [r.week, Number(r.n)]));
    return { ai: ai.map(x => ({ ...x, caught: caughtBy[x.week] || 0 })), caughtByWeek: caughtBy, older };
}

export async function signalTable(guildId) {
    const s = await loadStats();
    const g = s.byGuild.get(guildId) || {};
    const net = s.byGuild.get('0') || {};
    const weights = weightsFrom(g, net);
    return Object.entries(weights).map(([id, weight]) => ({ id, weight, tp: g[id]?.tp ?? 0, fp: g[id]?.fp ?? 0, netTp: net[id]?.tp ?? 0, netFp: net[id]?.fp ?? 0 }))
        .sort((a, b) => a.weight - b.weight).slice(0, 40);
}

export function providerStatus() {
    const row = (ep, role) => ({ role, url: ep.url.replace(/^https?:\/\//, ''), model: ep.model, ...(health.get(ep.url) || {}), down: isDown(ep.url) });
    return {
        triage: TRIAGE.map(e => row(e, 'triage')), escalate: ESCALATE.map(e => row(e, 'escalate')), embed: EMBED.map(e => ({ ...row(e, 'embed'), ...(health.get(`${e.url}#embed`) || {}), down: isDown(`${e.url}#embed`) })),
        cloud: { configured: !!geminiKey(), model: GEMINI_MODEL, ...(health.get('gemini') || {}), down: isDown('gemini') },
    };
}

export async function usage(guildId) {
    const m = meter(guildId);
    return { today: { local: m.local, cloud: m.cloud, cached: m.cached, failed: m.failed } };
}

/** The dashboard's "try a message" box: signals and the model's answer, no action, no record. */
export async function dryRun(guild, text) {
    const cfg = await getConfig(guild.id);
    const n = normalise(text);
    const { signals } = textSignals(n);
    signals.push(...linkSignalsBest([n.plain, ...n.forms]).signals);
    for (const code of extractInviteCodes(`${n.plain}\n${n.folded}`)) signals.push(...inviteSignals(code, null).filter(s => s.id !== 'invite_unresolved'));
    let score = weightedScore(signals, await weightsFor(guild.id));
    if (await addSemantic(n, contentKey(text), signals, score)) score = weightedScore(signals, await weightsFor(guild.id));
    const b = band(score, signals);
    const r = await classify(guild.id, { text, signals, score: Math.max(score, L.AMBIGUOUS_MIN), cloudAllowed: cfg.cloudAllowed, dailyCap: cfg.dailyCap });
    const decision = decideAction({ classification: r.classification, score, signals, config: cfg });
    return { folded: n.folded, evasion: n.evasion, signals, score, band: b, ai: r, decision };
}

export function weightsDescription() {
    return { example: { none: signalWeight(0, 0), fiveFalse: signalWeight(0, 5), tenConfirmed: signalWeight(10, 0) } };
}

export { CATEGORIES, CATEGORY_LABEL, ACTIONS, ACTION_LABEL, MAX_ACTION };

export default {
    classify, classifyScam, screenMessage, screenChat, getConfig, saveConfig, labelDetection, onReviewDecision, onMemberBanned, onMessageDeleted,
    listCatches, report, signalTable, providerStatus, usage, dryRun, messageSignals, semanticFor, addSemantic, _setTransport,
    CATEGORIES, CATEGORY_LABEL, ACTIONS, ACTION_LABEL, MAX_ACTION,
};
