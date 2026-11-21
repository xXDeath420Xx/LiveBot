/*
 * AI second opinion — the live side (prompts, parsing and decisions in core/ai-judge-logic.js). Hashbot's
 * /set-ai and its PFP "AI review", on the Gemini integration the bot already has (core/ai-assistant.js:
 * GOOGLE_API_KEY / GOOGLE_AI_KEY, GEMINI_MODEL, the generateContent REST endpoint) — no new SDK, provider or
 * dependency. Three surfaces, each plugged into the protection that already found the borderline case:
 *
 *   avatar   core/avatar-protection.js: a near-match between the review and act thresholds sends the member's
 *            avatar and the protected picture (both the 96px thumbnails the fingerprints already keep) and asks
 *            "same person / brand?". advise: the verdict goes on the review row and the log. act: the server's
 *            avatar action is carried out when the AI agrees at or above the configured confidence (the hash
 *            score is past the review bar by construction).
 *   text     core/message-threats.js (obfuscated-URL review tier, AutoMod escalation review tier) and
 *            core/phishing-detection-manager.js (image text one signal group short of the scam bar): the text
 *            plus a few earlier messages of the channel. advise: review card + queue entry with the verdict.
 *            act: the stage's own action when the AI agrees.
 *   nsfw     core/nsfw-protection.js: borderline review-queue items only. Advise only; it never acts.
 *
 * Safety:
 *   - Off everywhere until a server turns a surface on (phishing_config ai_*, migration 331).
 *   - A hard per-server daily cap (ai_daily_cap) and a process-wide per-minute limit (AI_JUDGE_PER_MINUTE,
 *     default 30), metered per server per UTC day in server_stats ai_* (calls per surface, cached, skipped,
 *     failed), the same pattern as the NSFW scan meter.
 *   - 10 s timeout. Any error, timeout, block, refusal, cap or unparseable reply is "no verdict", and no verdict
 *     means the protection does exactly what it does with AI off (fail open).
 *   - Verdicts are cached by image / text hash for 24 h, so a raid of one picture or one pasted scam is one call.
 *   - Never: DMs (guild messages only), anything from an age-restricted channel, anything a model labelled as
 *     possibly showing a minor, usernames other than the author's display name. The key only ever travels in
 *     the request header; prompts with member content are logged at debug level only.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import {
    aiSettingsFrom, cleanAiPatch, AVATAR_PROMPT, TEXT_PROMPT, NSFW_PROMPT, buildTextPayload, parseVerdict, replyText,
    verdictWord, verdictLine, decide, textKey, bytesKey, takeSlot, capAllows, dataUriPart, sniffImage, scrubText,
    STATS_COLUMNS, TIMEOUT_MS, DEFAULT_PER_MINUTE, MAX_CONTEXT_MESSAGES,
} from './ai-judge-logic.js';

// message-threats imports this module; importing it back lazily keeps the cycle out of module load.
const messageThreats = () => import('./message-threats.js');
// Local models first (core/ai-moderation.js), and the server's cloud opt-out (phishing_config.ai_mod_cloud = 'deny').
const aiModeration = () => import('./ai-moderation.js');
async function cloudDenied(guildId) {
    try { return (await (await aiModeration()).getConfig(guildId)).cloudSetting === 'deny'; } catch { return false; }
}

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const apiKey = () => process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
const PER_MINUTE = Math.max(1, Number(process.env.AI_JUDGE_PER_MINUTE) || DEFAULT_PER_MINUTE);
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 5000;
const FLUSH_MS = 60_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SURFACE_COLUMN = { avatar: 'ai_avatar_calls', text: 'ai_text_calls', nsfw: 'ai_nsfw_calls' };
const SURFACE_LABEL = { avatar: 'Avatar impersonation', text: 'Scam text', nsfw: 'NSFW third opinion' };

export function isConfigured() { return !!apiKey(); }
export const model = () => MODEL;

// ── settings (phishing_config ai_*) ──────────────────────────────────────────

export async function getSettings(guildId) {
    try {
        const mt = await messageThreats();
        const { row } = await mt.getSettings(guildId);
        return aiSettingsFrom(row);
    } catch {
        return aiSettingsFrom(null);
    }
}

/** Save a change. A phishing_config row created here starts with phishing detection OFF. */
export async function saveSettings(guild, patch, by = null) {
    const check = cleanAiPatch(patch);
    if (!check.ok) return check;
    const cols = Object.keys(check.values);
    if (!cols.length) return { ok: true, changed: [] };
    await pool.execute(
        `INSERT INTO phishing_config (guild_id, enabled, ${cols.join(', ')}) VALUES (?, 0, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
        [guild.id, ...cols.map(c => check.values[c])]);
    (await messageThreats()).invalidate(guild.id);
    logger.info(`[AIJudge] settings changed in ${guild.id} by ${by}: ${cols.join(', ')}`);
    void logFeatureEvent(() => (guild), 'automod.aiSettings', () => ({
        title: '⚙️ AI Second Opinion Settings Changed',
        fields: [['Changed', cols.map(c => `${c.replace(/^ai_/, '').replace(/_/g, ' ')}: ${check.values[c]}`).join('\n'), false], ['By', userLabel(by)]],
    }));
    return { ok: true, changed: cols };
}

// ── metering (server_stats ai_*) ─────────────────────────────────────────────

const meters = new Map();   // guildId -> { day, used, inflight, pending:{col:n}, loaded }
let flushTimer = null;
const dayKey = () => new Date().toISOString().slice(0, 10);
const emptyPending = () => Object.fromEntries(STATS_COLUMNS.map(c => [c, 0]));

async function meterFor(guildId) {
    const day = dayKey();
    let m = meters.get(guildId);
    if (m && m.day !== day) {
        await flushOne(guildId, m).catch(() => {});
        m = null;
    }
    if (!m) {
        m = { day, used: 0, inflight: 0, pending: emptyPending(), loaded: false };
        meters.set(guildId, m);
    }
    if (!m.loaded) {
        m.loaded = true;
        try {
            const [[row]] = await pool.execute(
                'SELECT ai_avatar_calls, ai_text_calls, ai_nsfw_calls FROM server_stats WHERE guild_id = ? AND date = ?', [guildId, day]);
            m.used += Number(row?.ai_avatar_calls ?? 0) + Number(row?.ai_text_calls ?? 0) + Number(row?.ai_nsfw_calls ?? 0);
        } catch { /* columns not there yet: count from zero */ }
    }
    if (!flushTimer) {
        flushTimer = setInterval(() => { flushAll().catch(() => {}); }, FLUSH_MS);
        flushTimer.unref?.();
    }
    return m;
}

const count = (m, col, n = 1) => { m.pending[col] = (m.pending[col] || 0) + n; };

async function flushOne(guildId, m) {
    const cols = STATS_COLUMNS.filter(c => m.pending[c]);
    if (!cols.length) return;
    const taken = m.pending;
    m.pending = emptyPending();
    try {
        await pool.execute(
            `INSERT INTO server_stats (guild_id, date, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = ${c} + VALUES(${c})`).join(', ')}`,
            [guildId, m.day, ...cols.map(c => taken[c])]);
    } catch (err) {
        for (const c of cols) m.pending[c] += taken[c];
        logger.debug(`[AIJudge] meter flush failed for ${guildId}: ${err.message}`);
    }
}

export async function flushAll() {
    for (const [guildId, m] of meters) await flushOne(guildId, m);
}

// ── the request ──────────────────────────────────────────────────────────────

const cache = new Map();   // `${surface}:${key}` -> { at, verdict }
let rateWindow = [];

function cached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.verdict;
}

function remember(key, verdict) {
    cache.delete(key);
    cache.set(key, { at: Date.now(), verdict });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * One judged question. Never throws.
 * @returns {Promise<{ verdict:object|null, status:'ok'|'cached'|'not_configured'|'capped'|'rate_limited'|'failed'|'no_verdict' }>}
 */
async function ask(guildId, surface, { system, parts, cacheKey }) {
    if (!isConfigured()) return { verdict: null, status: 'not_configured' };
    const key = `${surface}:${cacheKey}`;
    if (await cloudDenied(guildId)) return { verdict: null, status: 'not_configured' };
    const m = await meterFor(guildId);
    const hit = cached(key);
    if (hit) { count(m, 'ai_cached'); return { verdict: hit, status: 'cached' }; }

    const s = await getSettings(guildId);
    if (!capAllows(m.used + m.inflight, s.dailyCap)) { count(m, 'ai_skipped'); return { verdict: null, status: 'capped' }; }
    const slot = takeSlot(rateWindow, Date.now(), PER_MINUTE);
    rateWindow = slot.times;
    if (!slot.ok) { count(m, 'ai_skipped'); return { verdict: null, status: 'rate_limited' }; }

    m.inflight++;
    try {
        const generationConfig = { temperature: 0, maxOutputTokens: /flash/i.test(MODEL) ? 300 : 1024, responseMimeType: 'application/json' };
        // 2.5 Flash thinks by default, which spends the output budget before the JSON; a yes/no needs none.
        if (/2\.5-flash/i.test(MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
            body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        m.used++;
        count(m, SURFACE_COLUMN[surface]);
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            count(m, 'ai_failed');
            logger.warn(`[AIJudge] ${surface} request failed in ${guildId}: HTTP ${res.status} ${String(json?.error?.status ?? '').slice(0, 40)}`);
            return { verdict: null, status: 'failed' };
        }
        const verdict = parseVerdict(replyText(json), surface);
        if (!verdict) {
            count(m, 'ai_failed');
            logger.debug(`[AIJudge] ${surface} reply in ${guildId} was not a verdict`);
            return { verdict: null, status: 'no_verdict' };
        }
        remember(key, verdict);
        return { verdict, status: 'ok' };
    } catch (err) {
        count(m, 'ai_failed');
        logger.warn(`[AIJudge] ${surface} request failed in ${guildId}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
        return { verdict: null, status: 'failed' };
    } finally {
        m.inflight--;
    }
}

// ── the three questions ──────────────────────────────────────────────────────

/**
 * Avatar impersonation. Both pictures as data URIs (the fingerprints' 96px thumbnails) or buffers.
 * @param {{ memberImage:string|Buffer, protectedImage:string|Buffer, cacheKey?:string }} p
 */
export async function judgeAvatar(guildId, { memberImage, protectedImage, cacheKey = null }) {
    const a = imagePart(memberImage);
    const b = imagePart(protectedImage);
    if (!a || !b) return { verdict: null, status: 'failed' };
    return ask(guildId, 'avatar', {
        system: AVATAR_PROMPT,
        parts: [{ text: 'Image 1 (the member):' }, { inline_data: a }, { text: 'Image 2 (protected):' }, { inline_data: b }],
        cacheKey: cacheKey || `${bytesKey(String(a.data))}:${bytesKey(String(b.data))}`,
    });
}

/**
 * Scam text. context: [{ author:boolean, text }] oldest first (contextFor()).
 * @param {{ text:string, authorName?:string, detector?:string, signals?:string[], context?:object[] }} p
 */
export async function judgeScamText(guildId, { text, authorName = null, detector = null, signals = [], context = [] }) {
    if (!String(text ?? '').trim()) return { verdict: null, status: 'failed' };
    const payload = buildTextPayload({ text, authorName, detector, signals, context });
    // The owner's GPUs answer first; Gemini is only asked when neither local model gives a verdict.
    // (No key configured still means the feature is off, as before: no request of any kind.)
    if (!isConfigured()) return { verdict: null, status: 'not_configured' };
    try {
        const local = await (await aiModeration()).classifyScam(guildId, { text, context: (context || []).map(c => ({ author: !!c.author, text: c.text })), signals });
        if (local) return { verdict: local, status: 'ok' };
    } catch (err) { logger.debug(`[AIJudge] local check failed: ${err.message}`); }
    logger.debug(`[AIJudge] text check in ${guildId}: ${payload.slice(0, 500)}`);
    // Cached on the flagged text alone: the same scam pasted in a new channel gets the same answer.
    return ask(guildId, 'text', { system: TEXT_PROMPT, parts: [{ text: payload }], cacheKey: textKey(text) });
}

/** NSFW third opinion on one borderline image. Never for anything a model thought might show a minor. */
export async function judgeNsfw(guildId, { buffer, minorSuspected = false }) {
    if (minorSuspected) return { verdict: null, status: 'failed' };
    const part = imagePart(buffer);
    if (!part) return { verdict: null, status: 'failed' };
    return ask(guildId, 'nsfw', { system: NSFW_PROMPT, parts: [{ inline_data: part }], cacheKey: bytesKey(Buffer.from(part.data, 'base64')) });
}

function imagePart(img) {
    if (!img) return null;
    if (typeof img === 'string') return dataUriPart(img);
    if (!Buffer.isBuffer(img) || img.length > MAX_IMAGE_BYTES) return null;
    const mime = sniffImage(img);
    return mime ? { mime_type: mime, data: img.toString('base64') } : null;
}

// ── helpers for the protections ──────────────────────────────────────────────

/** Age-restricted (NSFW) channel, or one inside an age-restricted category. */
export function isAgeRestricted(channel) {
    if (!channel) return false;
    return !!(channel.nsfw || channel.parent?.nsfw);
}

/**
 * A few earlier messages of the same channel, oldest first: { author: same author?, text }. No names, no ids.
 * Empty for age-restricted channels or when the bot cannot read history.
 */
export async function contextFor(message, n = MAX_CONTEXT_MESSAGES) {
    try {
        if (!message?.guild || !message.channel?.messages?.fetch || isAgeRestricted(message.channel)) return [];
        const before = await message.channel.messages.fetch({ limit: Math.min(10, n), ...(message.id ? { before: message.id } : {}) });
        return [...before.values()]
            .filter(m => !m.author?.bot && m.content)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .slice(-n)
            .map(m => ({ author: m.author?.id === message.author?.id, text: m.content }));
    } catch {
        return [];
    }
}

/**
 * The text second opinion for a message in a guild channel, when the server has it on.
 * @returns {Promise<{ decision:'off'|'none'|'advise'|'act', verdict:object|null, status:string, confidence:number }>}
 */
export async function textOpinion(message, { text = null, detector, signals = [] } = {}) {
    const off = { decision: 'off', verdict: null, status: 'off', confidence: 0 };
    try {
        if (!message?.guild || isAgeRestricted(message.channel)) return off;
        const s = await getSettings(message.guild.id);
        if (s.text.mode === 'off') return off;
        const body = text ?? message.content ?? '';
        const context = await contextFor(message);
        const r = await judgeScamText(message.guild.id, {
            text: body, authorName: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? null,
            detector, signals, context,
        });
        return { decision: decide({ mode: s.text.mode, verdict: r.verdict, confidence: s.text.confidence }), verdict: r.verdict, status: r.status, confidence: s.text.confidence };
    } catch (err) {
        logger.debug(`[AIJudge] text opinion failed: ${err.message}`);
        return { ...off, decision: 'none', status: 'failed' };
    }
}

/** Put a verdict on a review row (name_filter_reviews ai_*). */
export async function saveReviewVerdict(guildId, userId, kind, surface, verdict) {
    if (!verdict) return;
    await pool.execute(
        'UPDATE name_filter_reviews SET ai_verdict = ?, ai_confidence = ?, ai_reason = ?, ai_at = NOW() WHERE guild_id = ? AND user_id = ? AND kind = ?',
        [verdictWord(surface, verdict), verdict.confidence, verdict.reason ? verdict.reason.slice(0, 200) : null, guildId, userId, kind],
    ).catch(err => logger.debug(`[AIJudge] verdict not saved on ${kind} review ${userId}: ${err.message}`));
}

/** Log a verdict to the server log (one line, no picture). */
export function logVerdict(guild, surface, { member = null, userId = null, verdict, outcome = 'advise', detail = null }) {
    void logFeatureEvent(() => (guild), 'automod.aiVerdict', () => ({
        title: `🤖 AI Second Opinion: ${SURFACE_LABEL[surface] || surface}`,
        description: verdictLine(surface, verdict),
        fields: [['Member', userLabel(member ?? userId)],
            ['Outcome', outcome === 'act' ? 'Confirmed: the protection acted' : 'Advice only: waiting in the review queue'],
            ['Detail', detail ? scrubText(detail, 200) : null, false]],
    }));
}

// ── dashboard ────────────────────────────────────────────────────────────────

/** Settings, today's use against the cap and a daily chart for the dashboard. */
export async function usage(guildId, days = 30) {
    const s = await getSettings(guildId);
    const m = await meterFor(guildId);
    const d = Math.min(90, Math.max(1, Number(days) || 30));
    let rows = [];
    try {
        [rows] = await pool.execute(
            `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, ${STATS_COLUMNS.join(', ')} FROM server_stats
              WHERE guild_id = ? AND date >= DATE_SUB(UTC_DATE(), INTERVAL ${d - 1} DAY) ORDER BY date`, [guildId]);
    } catch { rows = []; }
    const byDate = new Map(rows.map(r => [r.date, r]));
    const series = [];
    for (let i = d - 1; i >= 0; i--) {
        const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        const r = byDate.get(date) || {};
        const live = date === m.day ? m.pending : {};
        const v = (c) => Number(r[c] ?? 0) + Number(live[c] ?? 0);
        series.push({ date, avatar: v('ai_avatar_calls'), text: v('ai_text_calls'), nsfw: v('ai_nsfw_calls'), cached: v('ai_cached'), skipped: v('ai_skipped'), failed: v('ai_failed') });
    }
    return {
        configured: isConfigured(), model: MODEL, perMinute: PER_MINUTE, settings: s,
        today: { used: m.used, cap: s.dailyCap }, series,
    };
}

export { decide, verdictLine, verdictWord };

export default {
    isConfigured, model, getSettings, saveSettings, judgeAvatar, judgeScamText, judgeNsfw, textOpinion, contextFor,
    saveReviewVerdict, logVerdict, usage, flushAll, isAgeRestricted, decide, verdictLine, verdictWord,
};
