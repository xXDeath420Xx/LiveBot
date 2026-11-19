/**
 * Twitch analytics AI — provider abstraction + feature functions.
 *
 * PROVIDERS:
 *   - gemini : existing CertiFried integration (@google/generative-ai, GOOGLE_API_KEY env)
 *   - ollama : local LLM endpoint (default http://localhost:11434), user picks model
 *              (Qwen 2.5 7B / 14B / 32B all work; 14B is a nice balance on a workstation)
 *   - fallback_chain : try ollama first (free, local), fall back to gemini if ollama is unreachable
 *
 * EACH FEATURE FUNCTION:
 *   generateSessionRecap(sessionId)       — narrative summary of one stream
 *   scoreSentimentBatch(messages[])       — +1 / 0 / -1 per message in a batch call
 *   suggestClipTitles(clipId)             — 3 title suggestions for a clip
 *   suggestStreamTitle(context)           — 3 title suggestions for stream going live
 *   analyzeHarassment(samples[])          — pattern report over flagged messages
 *   verifyRaid(raidEvent)                 — likely-fake vs likely-legit classification
 *   analyzeChatterPersona(chatterId)      — one-paragraph "who is this chatter" summary
 *   tuneAutoMod(automodStats)             — "raise swearing to 3" style suggestions
 *
 * Every call:
 *   1. Checks per-guild ai_enabled + ai_daily_call_cap
 *   2. Logs to twitch_ai_provider_log
 *   3. Caches to twitch_ai_insights where appropriate
 *   4. Returns { ok, text/json, provider, model, duration_ms, error? }
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
// Bot/system lines (follow alerts, Pokémon game, wzbot status) were scored -1 and flagged
// "high" by qwen2.5 — keep them out of sentiment and moderation input.
import { sqlNotBot } from '../utils/twitch-chat-bots.js';

const LOG = '[TwitchAI]';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_KEY_ENV = () => process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;

/** Load the first alerts_config row for this broadcaster so provider preference / caps apply. */
async function configForBroadcaster(broadcasterId) {
    const [[row]] = await pool.execute(
        `SELECT guild_id, ai_enabled, ai_provider_preference, ai_ollama_url, ai_ollama_model,
                ai_daily_call_cap
           FROM twitch_analytics_alerts_config WHERE broadcaster_id = ? LIMIT 1`,
        [String(broadcasterId)]);
    return row || null;
}

/** Did this broadcaster hit the daily AI call cap? */
async function overCap(broadcasterId, cap) {
    const [[r]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM twitch_ai_provider_log
          WHERE broadcaster_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        [String(broadcasterId)]);
    return Number(r.n || 0) >= cap;
}

async function logCall(broadcasterId, guildId, provider, model, feature, promptChars, respChars, durationMs, ok, errorMessage) {
    try {
        await pool.execute(
            `INSERT INTO twitch_ai_provider_log
             (broadcaster_id, guild_id, provider, model, feature, prompt_chars, response_chars, duration_ms, ok, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [broadcasterId, guildId, provider, model, feature, promptChars, respChars, durationMs, ok ? 1 : 0, (errorMessage || '').slice(0, 500)]);
        // Wave 373 — tally budget usage + alert when approaching cap.
        if (broadcasterId) updateBudget(broadcasterId).catch(() => {});
    } catch (e) { logger.warn(`${LOG} log insert failed: ${e.message}`); }
}

// ─── Provider implementations ────────────────────────────────────────────────

async function callGemini(prompt, { feature, broadcasterId, guildId, schema, temperature }) {
    const key = GEMINI_KEY_ENV();
    if (!key) return { ok: false, error: 'GOOGLE_API_KEY not set' };
    const started = Date.now();
    try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL,
            // Response schema for structured output when the caller provided one.
            generationConfig: (schema || temperature !== undefined) ? {
                ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
                ...(temperature !== undefined ? { temperature } : {}),
            } : undefined,
        });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const duration = Date.now() - started;
        await logCall(broadcasterId, guildId, 'gemini', GEMINI_MODEL, feature, prompt.length, text.length, duration, true, null);
        return { ok: true, text, provider: 'gemini', model: GEMINI_MODEL, duration_ms: duration };
    } catch (e) {
        const duration = Date.now() - started;
        await logCall(broadcasterId, guildId, 'gemini', GEMINI_MODEL, feature, prompt.length, 0, duration, false, e.message);
        return { ok: false, error: e.message, provider: 'gemini' };
    }
}

/**
 * Parse the ai_ollama_url chain. Entries are comma/pipe separated; each may pin its own model
 * with "url#model" (2026-11-16: desktop 5080 runs qwen3.6:35b-a3b, server2's 6 GB 3050 can only
 * hold qwen2.5:7b, so one shared ai_ollama_model sent the wrong model to one of them).
 * Entries without "#model" use defaultModel. "!feature" suffixes keep a feature off that endpoint,
 * e.g. "http://127.0.0.1:11435#qwen2.5:7b!chat_moderate": in the 2026-11-16 eval the 7B caught
 * 2 of 14 must-flag messages (missed threats, doxxing, "kys"), so moderation skips it for Gemini.
 */
export function parseOllamaEndpoints(raw, defaultModel) {
    return String(raw || '').split(/[,|]/).map(s => s.trim()).filter(Boolean).map(entry => {
        const hash = entry.indexOf('#');
        const url = (hash === -1 ? entry : entry.slice(0, hash)).trim().replace(/\/+$/, '');
        const [model, ...skip] = (hash === -1 ? '' : entry.slice(hash + 1)).split('!').map(x => x.trim());
        const out = { url, model: model || defaultModel };
        if (skip.filter(Boolean).length) out.skip = skip.filter(Boolean);
        return out;
    }).filter(e => e.url);
}

async function callOllama(prompt, { feature, broadcasterId, guildId, url, model, schema, maxTokens, temperature }) {
    // url may be a single endpoint OR a comma/pipe-separated chain. We try each in order
    // (short connect timeout per candidate) so a down endpoint doesn't block the chain.
    const defaultModel = model || process.env.OLLAMA_MODEL || 'qwen2.5:14b';
    const endpoints = parseOllamaEndpoints(url || process.env.OLLAMA_URL || '', defaultModel)
        .filter(e => !(e.skip || []).includes(feature));
    if (!endpoints.length) {
        const err = 'ollama not configured (no URL set)';
        await logCall(broadcasterId, guildId, 'ollama', model || 'none', feature, prompt.length, 0, 0, false, err);
        return { ok: false, error: err, provider: 'ollama' };
    }
    const lastErrors = [];
    for (let i = 0; i < endpoints.length; i++) {
        const { url: u, model: m } = endpoints[i];
        const started = Date.now();
        try {
            const body = {
                model: m,
                prompt,
                stream: false,
                ...(schema ? { format: 'json' } : {}),
                // Thinking models (qwen3.x) spend num_predict on hidden reasoning and cut the JSON
                // off; non-thinking models (qwen2.5) ignore this flag (checked on 0.40.12 and 0.40.16).
                think: false,
                // Classifiers pass a low temperature (scored better and steadier in the 2026-11-16 eval);
                // creative features (recaps, titles) keep 0.7.
                // num_ctx: Ollama defaults to 4096, and a 50-message batch (up to ~3.4k tokens) plus a
                // 2048-token answer does not fit; Ollama then silently cuts the prompt, instructions included.
                // One fixed value for every feature so the model is never reloaded for a different size.
                options: { temperature: temperature ?? 0.7, num_predict: maxTokens || 1024, num_ctx: 8192 },
            };
            const res = await axios.post(`${u}/api/generate`, body, { timeout: 60_000, connectTimeout: 3000 });
            const text = res.data?.response || '';
            const duration = Date.now() - started;
            await logCall(broadcasterId, guildId, 'ollama', m, feature, prompt.length, text.length, duration, true, null);
            return { ok: true, text, provider: 'ollama', model: m, duration_ms: duration, endpoint: u, endpoint_index: i };
        } catch (e) {
            const duration = Date.now() - started;
            const err = `${u}: ${e.message}`;
            lastErrors.push(err);
            await logCall(broadcasterId, guildId, 'ollama', m, feature, prompt.length, 0, duration, false, err);
            // Keep trying remaining endpoints in the chain.
        }
    }
    return { ok: false, error: `all ollama endpoints failed: ${lastErrors.join(' | ')}`, provider: 'ollama' };
}

/**
 * Core dispatcher. Resolves the broadcaster's provider preference and runs the appropriate
 * provider (with fallback for `fallback_chain`).
 */
async function callAI(promptOrBuilder, { feature, broadcasterId, schema, maxTokens, temperature }) {
    const promptFor = typeof promptOrBuilder === 'function' ? promptOrBuilder : () => promptOrBuilder;
    const cfg = await configForBroadcaster(broadcasterId);
    if (!cfg) return { ok: false, error: 'no AI config row (configure Alerts first)' };
    if (!cfg.ai_enabled) return { ok: false, error: 'AI disabled for this guild' };
    if (await overCap(broadcasterId, cfg.ai_daily_call_cap || 200)) {
        return { ok: false, error: `daily cap of ${cfg.ai_daily_call_cap} AI calls reached` };
    }
    const pref = cfg.ai_provider_preference || 'gemini';
    const ollamaOpts = { feature, broadcasterId, guildId: cfg.guild_id, url: cfg.ai_ollama_url, model: cfg.ai_ollama_model, schema, maxTokens, temperature };
    const geminiOpts = { feature, broadcasterId, guildId: cfg.guild_id, schema, temperature };

    if (pref === 'gemini') return callGemini(promptFor('gemini'), geminiOpts);
    if (pref === 'ollama') return callOllama(promptFor('ollama'), ollamaOpts);
    // fallback_chain: if Ollama is configured, try it first (free + private); otherwise go straight to Gemini.
    if (cfg.ai_ollama_url) {
        const ollamaRes = await callOllama(promptFor('ollama'), ollamaOpts);
        if (ollamaRes.ok) return ollamaRes;
    }
    return callGemini(promptFor('gemini'), geminiOpts);
}

// ─── Feature functions ───────────────────────────────────────────────────────

export async function generateSessionRecap(sessionId) {
    // Pull the full session + its events + top chatters + clips created during.
    const [[session]] = await pool.execute(`SELECT * FROM twitch_stream_sessions WHERE id = ?`, [sessionId]);
    if (!session) return { ok: false, error: 'session not found' };
    const bid = session.broadcaster_id;

    const [[cached]] = await pool.execute(`SELECT recap_text FROM twitch_ai_session_recaps WHERE session_id = ?`, [sessionId]);
    if (cached?.recap_text) return { ok: true, cached: true, text: cached.recap_text };

    const startedAt = new Date(session.started_at).toISOString();
    const endedAt = session.ended_at ? new Date(session.ended_at).toISOString() : 'still live';
    // CAST + CONVERT USING utf8mb4 on every string column so the UNION doesn't blow up on
    // the collation mismatch across our four event tables (unicode_ci vs general_ci).
    const [events] = await pool.execute(
        `(SELECT 'hype' AS kind, CONVERT(event_type USING utf8mb4) AS detail, CONVERT(CAST(level AS CHAR) USING utf8mb4) AS note, occurred_at FROM twitch_hype_train_events WHERE broadcaster_id = ? AND occurred_at BETWEEN ? AND COALESCE(?, NOW()))
         UNION ALL
         (SELECT 'poll' AS kind, CONVERT(title USING utf8mb4) AS detail, CONVERT(status USING utf8mb4) AS note, occurred_at FROM twitch_poll_events WHERE broadcaster_id = ? AND occurred_at BETWEEN ? AND COALESCE(?, NOW()))
         UNION ALL
         (SELECT 'prediction' AS kind, CONVERT(title USING utf8mb4) AS detail, CONVERT(status USING utf8mb4) AS note, occurred_at FROM twitch_prediction_events WHERE broadcaster_id = ? AND occurred_at BETWEEN ? AND COALESCE(?, NOW()))
         UNION ALL
         (SELECT 'raid' AS kind, CONVERT('incoming' USING utf8mb4) AS detail, CONVERT(CAST(viewer_count AS CHAR) USING utf8mb4) AS note, occurred_at FROM twitch_shoutout_events WHERE broadcaster_id = ? AND direction = 'received' AND occurred_at BETWEEN ? AND COALESCE(?, NOW()))
         ORDER BY occurred_at ASC`,
        [bid, session.started_at, session.ended_at, bid, session.started_at, session.ended_at, bid, session.started_at, session.ended_at, bid, session.started_at, session.ended_at]);
    const [clips] = await pool.execute(
        `SELECT title, view_count FROM twitch_clips_catalog
          WHERE broadcaster_id = ? AND created_at_twitch BETWEEN ? AND COALESCE(?, NOW())
          ORDER BY view_count DESC LIMIT 5`, [bid, session.started_at, session.ended_at]);

    const prompt = [
        'Write a brief, friendly recap of a Twitch stream for the broadcaster to post on their Discord.',
        'Use 3-5 bullet points plus a one-line headline. Focus on what happened — not generic praise.',
        'Keep it under 160 words. Second-person ("you did X") voice.',
        '',
        `STREAM: ${startedAt} → ${endedAt}`,
        `Duration: ${session.duration_minutes || '?'} min`,
        `Peak viewers: ${session.peak_viewers}`,
        `Avg viewers: ${Math.round(Number(session.avg_viewers) || 0)}`,
        `Chat messages: ${session.total_msgs}`,
        `Unique chatters: ${session.unique_chatters}`,
        `New follows: ${session.total_follows}`,
        `New subs: ${session.total_subs} (${session.total_gift_subs} gifted)`,
        `Bits: ${session.total_bits}`,
        `Primary category: ${session.primary_category_name || 'unspecified'}`,
        `Title at start: "${session.title_at_start || ''}"`,
        '',
        'EVENTS:',
        ...events.map(e => `  ${e.kind}: ${e.detail} (${e.note || '-'}) at ${e.occurred_at}`),
        '',
        'TOP CLIPS DURING STREAM:',
        ...clips.map(c => `  "${c.title}" — ${c.view_count} views`),
        '',
        'Respond with JSON: { "headline": "...", "bullets": ["...", "..."], "mood": "hype|chill|rough|celebratory|focused" }',
    ].join('\n');

    const schema = {
        type: 'object',
        properties: {
            headline: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            mood: { type: 'string' },
        },
        required: ['headline', 'bullets'],
    };
    const r = await callAI(prompt, { feature: 'session_recap', broadcasterId: bid, schema });
    if (!r.ok) return r;

    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { parsed = null; }
    const recapText = parsed ? `**${parsed.headline}**\n\n${(parsed.bullets || []).map(b => `• ${b}`).join('\n')}` : r.text;

    await pool.execute(
        `INSERT INTO twitch_ai_session_recaps
         (session_id, broadcaster_id, provider, model, recap_text, headline, bullets_json, mood, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE provider=VALUES(provider), model=VALUES(model),
             recap_text=VALUES(recap_text), headline=VALUES(headline), bullets_json=VALUES(bullets_json),
             mood=VALUES(mood), duration_ms=VALUES(duration_ms)`,
        [sessionId, bid, r.provider, r.model, recapText, parsed?.headline || null,
         parsed ? JSON.stringify(parsed.bullets || []) : null, parsed?.mood || null, r.duration_ms]);

    return { ok: true, provider: r.provider, model: r.model, headline: parsed?.headline, bullets: parsed?.bullets, mood: parsed?.mood, text: recapText };
}

/**
 * Score sentiment for a batch of up to 50 chat messages. Returns { scores: [...], ok: true }.
 * Uses structured JSON output so we never have to regex-parse.
 */
export async function scoreSentimentBatch(broadcasterId, samples) {
    if (!samples?.length) return { ok: true, scored: 0 };
    const limited = samples.slice(0, 50);
    // Prompt + temperature chosen by the 2026-11-16 eval (487 hand-labelled messages): 99% agreement and
    // 2 false "hostile" vs 7 for the old prompt at 0.7, which called "!so @x" lines and emotes hostile.
    const prompt = [
        'Score each Twitch chat message for sentiment.',
        '+1 = clearly positive: hype, praise, thanks, love, warm welcomes, excitement, hype or heart emotes.',
        '0 = neutral: questions, chit-chat, !commands (!so, !lurk, ...), info, personal news, sadness, tiredness, complaints about games, tech or life, jokes and banter.',
        '-1 = ONLY hostility aimed at a person: insults, harassment, slurs, threats, sexual demands, telling someone to leave or die.',
        'Swearing, LOL, caps and memes are not hostile on their own. Being sad or annoyed about a game is 0, not -1. If unsure between 0 and -1, answer 0.',
        'Tokens like "wolfzg2Hyped" or "devolu6LOVE" are channel emotes (prefix + name); judge them by the name.',
        '',
        'MESSAGES:',
        ...limited.map((m, i) => `${i}: ${(m.message_text || '').slice(0, 300)}`),
        '',
        `Return JSON with exactly ${limited.length} entries, one per message in order: {"scores":[{"i":0,"s":0},{"i":1,"s":1}]}`,
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            scores: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { i: { type: 'number' }, s: { type: 'number' } },
                    required: ['i', 's'],
                },
            },
        },
        required: ['scores'],
    };
    // 50 scores pretty-printed by qwen3.6 run 800-1000 tokens; 1024 truncated 2 of 4 test batches.
    const r = await callAI(prompt, { feature: 'sentiment_batch', broadcasterId, schema, maxTokens: 2048, temperature: 0.2 });
    if (!r.ok) return r;
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { return { ok: false, error: 'parse failed' }; }
    const results = [];
    for (const sc of (parsed?.scores || [])) {
        const sample = limited[sc.i];
        if (!sample) continue;
        const sentiment = Math.max(-1, Math.min(1, Math.round(Number(sc.s) || 0)));
        results.push({ sample_id: sample.id, sentiment });
        await pool.execute(
            `INSERT INTO twitch_ai_message_sentiments (sample_id, broadcaster_id, sentiment, provider)
             VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE sentiment = VALUES(sentiment), provider = VALUES(provider)`,
            [sample.id, broadcasterId, sentiment, r.provider]).catch(() => {});
    }
    return { ok: true, scored: results.length, provider: r.provider };
}

export async function suggestClipTitles(clipId) {
    const [[clip]] = await pool.execute(`SELECT * FROM twitch_clips_catalog WHERE clip_id = ?`, [clipId]);
    if (!clip) return { ok: false, error: 'clip not found' };
    const prompt = `Suggest 3 catchy, non-clickbait Twitch clip titles for this moment.\n\nCurrent title: "${clip.title || ''}"\nGame: ${clip.game_name || '?'}\nCreator: ${clip.creator_name || '?'}\n\nReturn JSON: { "titles": ["...", "...", "..."] }`;
    const schema = { type: 'object', properties: { titles: { type: 'array', items: { type: 'string' } } }, required: ['titles'] };
    const r = await callAI(prompt, { feature: 'clip_titles', broadcasterId: clip.broadcaster_id, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed?.titles) {
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'clip_titles', ?, ?, ?, ?)`,
            [clip.broadcaster_id, clipId, JSON.stringify(parsed.titles), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, titles: parsed?.titles || [], provider: r.provider };
}

export async function analyzeHarassment(broadcasterId) {
    const [samples] = await pool.execute(
        `SELECT id, chatter_user_login, message_text, is_caps, has_link, occurred_at
           FROM twitch_chat_message_samples
          WHERE broadcaster_id = ? AND occurred_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND (is_caps = 1 OR CHAR_LENGTH(message_text) > 200)
          ORDER BY occurred_at DESC LIMIT 60`, [broadcasterId]);
    if (!samples.length) return { ok: true, report: 'No potentially-flagged messages in last 24h.' };
    const prompt = [
        'Analyze these flagged Twitch chat messages (last 24h, caps-heavy or long). Produce a brief report:',
        '1. Is there a coordinated harassment pattern? (yes/no + reason)',
        '2. Which users (if any) are repeat offenders?',
        '3. Which words/phrases are being used to attack?',
        '4. Recommended moderator action.',
        '',
        'Keep it under 200 words. Return JSON: { "pattern_detected": bool, "repeat_offenders": ["login", ...], "key_phrases": ["...", ...], "recommendation": "..." }',
        '',
        'MESSAGES:',
        ...samples.map(s => `  [${s.chatter_user_login}] ${s.message_text}`),
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            pattern_detected: { type: 'boolean' },
            repeat_offenders: { type: 'array', items: { type: 'string' } },
            key_phrases: { type: 'array', items: { type: 'string' } },
            recommendation: { type: 'string' },
        },
        required: ['pattern_detected', 'recommendation'],
    };
    const r = await callAI(prompt, { feature: 'harassment', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    await pool.execute(
        `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
         VALUES (?, 'harassment', ?, ?, ?, ?)`,
        [broadcasterId, new Date().toISOString().slice(0, 10), r.text, r.provider, r.model]).catch(() => {});
    return { ok: true, parsed, raw: r.text, provider: r.provider };
}

// ─── Tier AI-6 — governance helpers (defined early so later features can use them) ─────

/**
 * Scan AI output for PII and redact. Lightweight regex pass — not perfect, but catches
 * the common cases (emails, phone numbers, URLs, long numeric strings).
 */
export function redactPII(text) {
    if (!text) return text;
    return String(text)
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
        .replace(/https?:\/\/[^\s<>")]+/g, '[url]')
        .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[card]');
}

/**
 * Daily budget tally. Called after every logged AI call to update the budget_history row
 * and trigger a super-admin DM when the broadcaster is at ≥ their configured threshold.
 */
export async function updateBudget(broadcasterId) {
    const day = new Date().toISOString().slice(0, 10);
    const [[cfg]] = await pool.execute(
        `SELECT ai_daily_call_cap, ai_budget_alert_threshold FROM twitch_analytics_alerts_config
          WHERE broadcaster_id = ? LIMIT 1`, [String(broadcasterId)]);
    if (!cfg) return;
    const [[r]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM twitch_ai_provider_log
          WHERE broadcaster_id = ? AND DATE(created_at) = ?`, [String(broadcasterId), day]);
    const count = Number(r.n) || 0;
    const cap = Number(cfg.ai_daily_call_cap) || 200;
    const threshold = Number(cfg.ai_budget_alert_threshold) || 80;
    await pool.execute(
        `INSERT INTO twitch_ai_budget_history (broadcaster_id, day, calls_count, cap_at_time)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE calls_count = VALUES(calls_count), cap_at_time = VALUES(cap_at_time)`,
        [broadcasterId, day, count, cap]);
    // At threshold %, alert once per day.
    if ((count / cap) * 100 >= threshold) {
        const [[row]] = await pool.execute(
            `SELECT alerted_at FROM twitch_ai_budget_history WHERE broadcaster_id = ? AND day = ?`,
            [String(broadcasterId), day]);
        if (!row?.alerted_at) {
            await pool.execute(
                `UPDATE twitch_ai_budget_history SET alerted_at = NOW() WHERE broadcaster_id = ? AND day = ?`,
                [String(broadcasterId), day]);
            // Non-blocking DM to the configured channel.
            import('./twitch-analytics-alerts.js').then(({ dispatchAnomaly }) => {
                dispatchAnomaly(null, broadcasterId, 'ai_budget_near_cap', 'critical', count / cap,
                    `AI usage at ${count}/${cap} today (${Math.round((count/cap)*100)}%).`).catch(() => {});
            }).catch(() => {});
        }
    }
}

/** Return the cached recap (no AI call) or null if none generated yet. */
export async function getCachedRecap(sessionId) {
    const [[row]] = await pool.execute(`SELECT * FROM twitch_ai_session_recaps WHERE session_id = ?`, [sessionId]);
    return row || null;
}

// ─── Tier AI-2 feature functions ─────────────────────────────────────────────

/**
 * Stream title suggestions — pulls the broadcaster's recent category history + top-viewed
 * sessions to inform the model, returns 3 options. Called from the Stream Controls tab.
 */
export async function suggestStreamTitles(broadcasterId, { desiredCategory, moodHint } = {}) {
    const [recentTitles] = await pool.execute(
        `SELECT DISTINCT title_at_start AS title, primary_category_name AS category, peak_viewers
           FROM twitch_stream_sessions
          WHERE broadcaster_id = ? AND title_at_start IS NOT NULL AND title_at_start != ''
          ORDER BY peak_viewers DESC LIMIT 15`, [String(broadcasterId)]);
    const prompt = [
        'Suggest 3 Twitch stream titles for the broadcaster going live now.',
        'Make them specific, non-clickbait, and consistent with the broadcaster\'s voice.',
        'Each title must be <= 140 characters.',
        '',
        desiredCategory ? `TARGET CATEGORY: ${desiredCategory}` : '',
        moodHint ? `MOOD HINT: ${moodHint}` : '',
        '',
        'TOP-VIEWED PAST TITLES (sample of voice):',
        ...recentTitles.map(t => `  [${t.category || '?'}, peak ${t.peak_viewers}] ${t.title}`),
        '',
        'Return JSON: { "titles": ["...", "...", "..."], "reasoning": "one sentence why these work" }',
    ].filter(Boolean).join('\n');
    const schema = {
        type: 'object',
        properties: {
            titles: { type: 'array', items: { type: 'string' } },
            reasoning: { type: 'string' },
        },
        required: ['titles'],
    };
    const r = await callAI(prompt, { feature: 'stream_titles', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed?.titles) {
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'stream_titles', ?, ?, ?, ?)`,
            [broadcasterId, new Date().toISOString(), JSON.stringify(parsed), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, titles: parsed?.titles || [], reasoning: parsed?.reasoning, provider: r.provider };
}

/**
 * Chatter persona — one-paragraph "who is this user" generated from their chat message
 * history. Useful before pulling the trigger on ban/warn.
 */
export async function analyzeChatterPersona(broadcasterId, chatterLogin) {
    const [[sighting]] = await pool.execute(
        `SELECT sightings, sessions_seen, first_seen_at, last_seen_at FROM twitch_chatter_sightings
          WHERE broadcaster_id = ? AND LOWER(chatter_user_login) = LOWER(?) LIMIT 1`,
        [String(broadcasterId), String(chatterLogin)]);
    const [messages] = await pool.execute(
        `SELECT message_text, occurred_at FROM twitch_chat_message_samples
          WHERE broadcaster_id = ? AND LOWER(chatter_user_login) = LOWER(?)
          ORDER BY occurred_at DESC LIMIT 30`,
        [String(broadcasterId), String(chatterLogin)]);
    if (!messages.length && !sighting) return { ok: false, error: 'no data for this chatter' };
    const prompt = [
        `Write a one-paragraph profile of a Twitch chat user. Describe tone, interests, likely intent.`,
        `Do NOT invent facts — stay grounded in the messages. If data is thin, say so.`,
        `Keep under 100 words. Return JSON: { "persona": "...", "vibe": "positive|neutral|negative|unclear" }`,
        '',
        `USER: ${chatterLogin}`,
        sighting ? `Seen ${sighting.sightings} times across ${sighting.sessions_seen} sessions (first ${sighting.first_seen_at}, last ${sighting.last_seen_at})` : 'No sightings data.',
        '',
        'RECENT MESSAGES:',
        ...messages.map(m => `  ${m.message_text}`),
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            persona: { type: 'string' },
            vibe: { type: 'string' },
        },
        required: ['persona'],
    };
    const r = await callAI(prompt, { feature: 'chatter_persona', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed?.persona) {
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'chatter_persona', ?, ?, ?, ?)`,
            [broadcasterId, chatterLogin, JSON.stringify(parsed), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, persona: parsed?.persona, vibe: parsed?.vibe, provider: r.provider };
}

/**
 * AI narrative for the weekly digest. Replaces the template-rendered body with a short
 * generated recap of the week's stats. Called from core/twitch-digest.js.
 */
export async function generateWeeklyDigestNarrative(broadcasterId, agg, prevAgg, bigSession, topClip) {
    const prompt = [
        'Write a weekly Twitch recap for the broadcaster. Second-person voice. 3 sentences.',
        'Focus on momentum vs previous week + the one biggest moment.',
        'Return JSON: { "narrative": "..." }',
        '',
        `THIS WEEK: ${agg.sessions} sessions, ${Math.round(agg.live_min / 60 * 10) / 10}h live, peak ${agg.peak}, ${agg.msgs} msgs, +${agg.follows} follows, +${agg.subs} subs, ${agg.bits} bits.`,
        `LAST WEEK: ${prevAgg.sessions || 0} sessions, +${prevAgg.follows || 0} follows, +${prevAgg.subs || 0} subs.`,
        bigSession ? `BIGGEST STREAM: ${new Date(bigSession.started_at).toLocaleDateString()}, peak ${bigSession.peak_viewers}, "${bigSession.title_at_start || ''}".` : '',
        topClip ? `TOP CLIP: "${topClip.title || ''}" — ${topClip.view_count} views.` : '',
    ].filter(Boolean).join('\n');
    const schema = {
        type: 'object',
        properties: { narrative: { type: 'string' } },
        required: ['narrative'],
    };
    const r = await callAI(prompt, { feature: 'digest_narrative', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    return { ok: true, narrative: parsed?.narrative || r.text, provider: r.provider };
}

/**
 * AutoMod tuning — reads automod_settings + how many messages have been AutoMod-held in
 * the last 7 days. Suggests level adjustments.
 */
export async function tuneAutoMod(broadcasterId) {
    const [[settings]] = await pool.execute(`SELECT * FROM twitch_automod_settings WHERE broadcaster_id = ?`, [String(broadcasterId)]);
    const [heldCounts] = await pool.execute(
        `SELECT category, COUNT(*) AS n FROM twitch_automod_held
          WHERE broadcaster_id = ? AND occurred_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
          GROUP BY category`, [String(broadcasterId)]);
    if (!settings && !heldCounts.length) return { ok: false, error: 'no automod data (needs the automod_held EventSub + a backfill)' };
    const prompt = [
        'Review this Twitch broadcaster\'s AutoMod configuration and recent held-message counts.',
        'Suggest one or two specific level changes if any category is seeing too many held or too few.',
        'If settings look fine, say so.',
        '',
        'CURRENT LEVELS (0 = off, 4 = strictest):',
        ...(settings ? Object.entries(settings)
            .filter(([k, v]) => !['broadcaster_id', 'as_of', 'updated_at'].includes(k) && v !== null)
            .map(([k, v]) => `  ${k}: level ${v}`) : ['  (no settings pulled yet)']),
        '',
        'MESSAGES HELD BY AUTOMOD (last 7 days, by category):',
        ...heldCounts.map(c => `  ${c.category || '?'}: ${c.n}`),
        '',
        'Return JSON: { "verdict": "fine|tune_up|tune_down", "suggestions": ["raise X from N to N+1 because...", ...], "notes": "..." }',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            verdict: { type: 'string' },
            suggestions: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
        },
        required: ['verdict'],
    };
    const r = await callAI(prompt, { feature: 'automod_tune', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed) {
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'automod_tune', ?, ?, ?, ?)`,
            [broadcasterId, new Date().toISOString().slice(0, 10), JSON.stringify(parsed), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, ...parsed, provider: r.provider };
}

/**
 * Raid verification — classifies an incoming raid as likely-legit vs likely-fake view-bot
 * based on the raider's channel profile (followers, created_at, viewer count vs size).
 */
// ─── Tier AI-3 feature functions ─────────────────────────────────────────────

/**
 * Highlight reel detection — scans a session's stream_snapshots for chat-velocity spikes
 * (indicator that something hype happened) and cross-references with hype_train / goal /
 * raid events to produce ranked "clip this moment" candidates.
 *
 * Pure algorithmic scoring (no LLM) because the signal is quantitative. We only call AI
 * if the caller asks for `withAiCaptions`, in which case we have the model name each moment.
 */
export async function detectHighlightMoments(sessionId, { withAiCaptions = false } = {}) {
    const [[session]] = await pool.execute(`SELECT * FROM twitch_stream_sessions WHERE id = ?`, [sessionId]);
    if (!session) return { ok: false, error: 'session not found' };
    const bid = session.broadcaster_id;
    const startedAt = session.started_at;
    const endedAt = session.ended_at || new Date();

    // Pull per-minute snapshots during the session.
    const [snaps] = await pool.execute(
        `SELECT UNIX_TIMESTAMP(recorded_at) AS t, viewer_count, msg_count
           FROM twitch_stream_snapshots WHERE broadcaster_id = ? AND recorded_at BETWEEN ? AND ?
          ORDER BY recorded_at ASC`, [bid, startedAt, endedAt]);
    if (snaps.length < 5) return { ok: true, moments: [], note: 'not enough snapshot data' };

    // Compute median + MAD on msg_count to find spikes.
    const msgs = snaps.map(s => Number(s.msg_count) || 0).sort((a, b) => a - b);
    const median = msgs[Math.floor(msgs.length / 2)];
    const mad = (() => {
        const dev = msgs.map(m => Math.abs(m - median)).sort((a, b) => a - b);
        return dev[Math.floor(dev.length / 2)] || 1;
    })();
    const threshold = median + Math.max(3 * mad, 10); // require real deviation

    // Flag spike windows (consecutive minutes above threshold).
    const moments = [];
    let current = null;
    for (const s of snaps) {
        const n = Number(s.msg_count) || 0;
        if (n > threshold) {
            if (current) current.end_t = s.t, current.peak = Math.max(current.peak, n);
            else current = { start_t: s.t, end_t: s.t, peak: n, viewer_count: s.viewer_count };
        } else if (current) {
            moments.push(current);
            current = null;
        }
    }
    if (current) moments.push(current);

    // Enrich each moment with any event that fired within ±2 minutes.
    const [events] = await pool.execute(
        `(SELECT 'hype' AS kind, CONVERT(event_type USING utf8mb4) AS detail, UNIX_TIMESTAMP(occurred_at) AS t FROM twitch_hype_train_events WHERE broadcaster_id = ? AND occurred_at BETWEEN ? AND ?)
         UNION ALL
         (SELECT 'shoutout' AS kind, CONVERT(counterpart_user_login USING utf8mb4) AS detail, UNIX_TIMESTAMP(occurred_at) AS t FROM twitch_shoutout_events WHERE broadcaster_id = ? AND direction = 'received' AND occurred_at BETWEEN ? AND ?)
         UNION ALL
         (SELECT 'goal' AS kind, CONVERT(event_type USING utf8mb4) AS detail, UNIX_TIMESTAMP(occurred_at) AS t FROM twitch_goal_events WHERE broadcaster_id = ? AND occurred_at BETWEEN ? AND ?)
         UNION ALL
         (SELECT 'sub_msg' AS kind, CONVERT(user_login USING utf8mb4) AS detail, UNIX_TIMESTAMP(occurred_at) AS t FROM twitch_resub_messages WHERE broadcaster_id = ? AND occurred_at BETWEEN ? AND ?)`,
        [bid, startedAt, endedAt, bid, startedAt, endedAt, bid, startedAt, endedAt, bid, startedAt, endedAt]);
    for (const m of moments) {
        m.events = events.filter(e => e.t >= m.start_t - 120 && e.t <= m.end_t + 120);
        m.score = m.peak + (m.events.length * 20); // event-adjacency boosts score
    }
    moments.sort((a, b) => b.score - a.score);
    const top = moments.slice(0, 10);

    // Optional: ask the LLM to name each moment in one phrase.
    if (withAiCaptions && top.length) {
        const prompt = [
            'Name each Twitch stream moment with one short phrase (3-6 words).',
            'Base it on the metrics + nearby events. Avoid generic names like "hype moment".',
            '',
            ...top.map((m, i) => `${i}: chat spike peak=${m.peak}, viewers=${m.viewer_count}, events=${m.events.map(e => e.kind + ':' + e.detail).join(',') || 'none'}`),
            '',
            'Return JSON: { "captions": ["phrase 0", "phrase 1", ...] }',
        ].join('\n');
        const schema = {
            type: 'object',
            properties: { captions: { type: 'array', items: { type: 'string' } } },
            required: ['captions'],
        };
        const r = await callAI(prompt, { feature: 'highlight_captions', broadcasterId: bid, schema });
        if (r.ok) {
            try { const p = JSON.parse(r.text); top.forEach((m, i) => { m.caption = p.captions?.[i] || null; }); } catch {}
        }
    }
    return { ok: true, moments: top, threshold, median };
}

/**
 * Big-moment live DM — detects unusual activity in the last 5 min window compared to the
 * broadcaster's historical hourly baseline. Called every 5 min from the cron while stream
 * is live. DMs the configured user when something crosses the threshold.
 */
export async function detectBigMoments(broadcasterId) {
    const bid = String(broadcasterId);
    // Is she live right now?
    const [[current]] = await pool.execute(
        `SELECT is_live, viewer_count, msg_count, recorded_at FROM twitch_stream_snapshots
          WHERE broadcaster_id = ? ORDER BY recorded_at DESC LIMIT 1`, [bid]);
    if (!current?.is_live) return { ok: true, live: false };

    // Compute rolling baseline — median of last 90 days' msg_count during streaming.
    const [[baseline]] = await pool.execute(
        `SELECT AVG(msg_count) AS avg_c, STDDEV(msg_count) AS sd_c
           FROM twitch_stream_snapshots
          WHERE broadcaster_id = ? AND is_live = 1 AND recorded_at > DATE_SUB(NOW(), INTERVAL 90 DAY)`,
        [bid]);
    // Compare current 5-min window.
    const [[recent]] = await pool.execute(
        `SELECT AVG(viewer_count) AS v, AVG(msg_count) AS c, MAX(viewer_count) AS peak_v, MAX(msg_count) AS peak_c
           FROM twitch_stream_snapshots
          WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)`, [bid]);

    const baseAvg = Number(baseline?.avg_c) || 1;
    const baseSd = Number(baseline?.sd_c) || 1;
    const curC = Number(recent?.c) || 0;
    const zScore = (curC - baseAvg) / Math.max(1, baseSd);

    // z >= 3 is "unusual" — the model will decide if it's worth DMing.
    if (zScore < 3) return { ok: true, live: true, zScore, note: 'nothing unusual' };

    // Check we haven't already alerted in the last 30 min — in-memory dedup.
    if (!detectBigMoments._lastAlert) detectBigMoments._lastAlert = new Map();
    const lastKey = `${bid}:bigmoment`;
    if (detectBigMoments._lastAlert.get(lastKey) && (Date.now() - detectBigMoments._lastAlert.get(lastKey)) < 1_800_000) {
        return { ok: true, live: true, zScore, note: 'dedup — recent alert' };
    }

    const prompt = [
        'Classify a Twitch stream event. The broadcaster is live right now and something is unusual.',
        'Decide: is this moment worth DMing the broadcaster about? Return a short DM-ready message if so.',
        '',
        `Historical avg chat msgs/min: ${Math.round(baseAvg)} (sd ${Math.round(baseSd)})`,
        `Right now: chat ${Math.round(curC)}/min, viewers ${Math.round(recent?.v || 0)}, peak this 5-min window chat ${recent?.peak_c}, peak viewers ${recent?.peak_v}`,
        `Deviation from baseline: ${zScore.toFixed(2)} standard deviations above normal.`,
        '',
        'Return JSON: { "worth_alerting": bool, "message": "..." }',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: { worth_alerting: { type: 'boolean' }, message: { type: 'string' } },
        required: ['worth_alerting'],
    };
    const r = await callAI(prompt, { feature: 'big_moment', broadcasterId: bid, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed?.worth_alerting && parsed?.message) {
        detectBigMoments._lastAlert.set(lastKey, Date.now());
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'big_moment', ?, ?, ?, ?)`,
            [bid, new Date().toISOString(), JSON.stringify({ ...parsed, z: zScore }), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, live: true, zScore, ...parsed };
}

/**
 * Streamer feedback coach — post-stream analysis. Looks at chat gaps (long periods with
 * low chat velocity), category changes, and sub pacing to generate actionable feedback.
 */
export async function generateStreamerCoach(sessionId) {
    const [[session]] = await pool.execute(`SELECT * FROM twitch_stream_sessions WHERE id = ?`, [sessionId]);
    if (!session) return { ok: false, error: 'session not found' };
    const bid = session.broadcaster_id;
    const [snaps] = await pool.execute(
        `SELECT UNIX_TIMESTAMP(recorded_at) AS t, viewer_count, msg_count FROM twitch_stream_snapshots
          WHERE broadcaster_id = ? AND recorded_at BETWEEN ? AND COALESCE(?, NOW())
          ORDER BY recorded_at ASC`, [bid, session.started_at, session.ended_at]);
    if (snaps.length < 10) return { ok: false, error: 'not enough per-minute data' };

    // Identify chat gaps (contiguous 10+ min windows where msg_count stays below median/4).
    const chatCounts = snaps.map(s => Number(s.msg_count) || 0);
    const med = chatCounts.slice().sort((a, b) => a - b)[Math.floor(chatCounts.length / 2)];
    const gapThreshold = Math.max(1, Math.floor(med / 4));
    const gaps = [];
    let currentGap = null;
    for (const s of snaps) {
        const n = Number(s.msg_count) || 0;
        if (n <= gapThreshold) {
            if (currentGap) currentGap.end_t = s.t;
            else currentGap = { start_t: s.t, end_t: s.t };
        } else if (currentGap) {
            if (currentGap.end_t - currentGap.start_t >= 10 * 60) gaps.push(currentGap);
            currentGap = null;
        }
    }
    if (currentGap && currentGap.end_t - currentGap.start_t >= 10 * 60) gaps.push(currentGap);

    const prompt = [
        'Analyze a Twitch streamer\'s session and give 3 specific coaching tips. Second-person voice.',
        'Be concrete — reference actual numbers / timing. No generic advice. No excessive praise.',
        '',
        `SESSION STATS: duration ${session.duration_minutes}min, peak ${session.peak_viewers}, avg ${Math.round(Number(session.avg_viewers) || 0)}, chat msgs ${session.total_msgs}, unique chatters ${session.unique_chatters}, follows ${session.total_follows}, subs ${session.total_subs}, bits ${session.total_bits}.`,
        `Title: "${session.title_at_start || ''}"  |  Category: ${session.primary_category_name || '?'}`,
        `Title changes: ${session.title_change_count}, category changes: ${session.category_change_count}`,
        '',
        `CHAT GAPS (10+ min with very low chat): ${gaps.length}`,
        ...gaps.map(g => `  gap ${Math.round((g.end_t - g.start_t) / 60)}min starting at offset ${Math.round((g.start_t - new Date(session.started_at).getTime() / 1000) / 60)}min from start`),
        '',
        'Return JSON: { "tips": ["tip 1", "tip 2", "tip 3"], "overall": "one-sentence verdict" }',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            tips: { type: 'array', items: { type: 'string' } },
            overall: { type: 'string' },
        },
        required: ['tips'],
    };
    const r = await callAI(prompt, { feature: 'streamer_coach', broadcasterId: bid, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed) {
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'streamer_coach', ?, ?, ?, ?)`,
            [bid, String(sessionId), JSON.stringify(parsed), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, ...parsed, gaps_detected: gaps.length, provider: r.provider };
}

/**
 * Follower-sub journey — which streams correlate most strongly with sub conversions. Looks
 * at chatter_sightings to find users who first appeared in a stream, then subsequently
 * subbed (via resub_messages or sub tier breakdown).
 */
export async function analyzeFollowerSubJourney(broadcasterId) {
    const bid = String(broadcasterId);
    // For each session in last 90 days, count unique chatters that FIRST appeared during that
    // session (per sightings.first_seen_at) AND later became subs (appear in resub_messages).
    const [rows] = await pool.execute(
        `SELECT s.id AS session_id, s.started_at, s.ended_at, s.title_at_start, s.primary_category_name,
                s.peak_viewers,
                (SELECT COUNT(DISTINCT cs.chatter_user_login)
                   FROM twitch_chatter_sightings cs
                  WHERE cs.broadcaster_id = s.broadcaster_id
                    AND cs.first_seen_at BETWEEN s.started_at AND COALESCE(s.ended_at, s.started_at)
                    AND LOWER(cs.chatter_user_login) IN (
                        SELECT DISTINCT LOWER(user_login) FROM twitch_resub_messages WHERE broadcaster_id = s.broadcaster_id
                    )) AS first_seen_subbed
           FROM twitch_stream_sessions s
          WHERE s.broadcaster_id = ? AND s.started_at > DATE_SUB(NOW(), INTERVAL 90 DAY)
            AND s.ended_at IS NOT NULL
          ORDER BY first_seen_subbed DESC LIMIT 10`, [bid]);
    const prompt = [
        'Analyze a Twitch streamer\'s best "convert first-time chatters to subs" streams.',
        'The numbers show how many new chatters first appeared in each stream and later subscribed.',
        'What patterns do you see? What should they do more of?',
        '',
        ...rows.filter(r => r.first_seen_subbed > 0).map(r =>
            `  ${r.started_at.toISOString ? r.started_at.toISOString().slice(0,10) : r.started_at} · ${r.primary_category_name || '?'} · peak ${r.peak_viewers} · ${r.first_seen_subbed} first-chatter→sub conversions`),
        '',
        'Return JSON: { "insight": "...", "action_item": "..." }',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: { insight: { type: 'string' }, action_item: { type: 'string' } },
        required: ['insight'],
    };
    const r = await callAI(prompt, { feature: 'follower_sub_journey', broadcasterId: bid, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    return { ok: true, ...parsed, rows, provider: r.provider };
}

/**
 * Category pivot analysis — look at consecutive category changes within sessions and
 * compute viewer-count deltas across each pivot.
 */
export async function analyzeCategoryPivots(broadcasterId) {
    const bid = String(broadcasterId);
    const [pivots] = await pool.execute(
        `SELECT category_name, UNIX_TIMESTAMP(changed_at) AS t FROM twitch_category_history
          WHERE broadcaster_id = ? AND changed_at > DATE_SUB(NOW(), INTERVAL 60 DAY)
            AND category_name IS NOT NULL AND category_name != ''
          ORDER BY changed_at ASC`, [bid]);
    const transitions = {}; // "A→B" => { count, viewers_before_avg, viewers_after_avg }
    for (let i = 0; i < pivots.length - 1; i++) {
        const from = pivots[i].category_name, to = pivots[i + 1].category_name;
        if (from === to) continue;
        const key = `${from}→${to}`;
        if (!transitions[key]) transitions[key] = { from, to, count: 0, deltas: [] };
        transitions[key].count++;
        // Pull viewer_count 5 min before + 5 min after the pivot.
        const [[before]] = await pool.execute(
            `SELECT AVG(viewer_count) AS v FROM twitch_stream_snapshots WHERE broadcaster_id = ? AND recorded_at BETWEEN FROM_UNIXTIME(? - 300) AND FROM_UNIXTIME(?)`,
            [bid, pivots[i + 1].t, pivots[i + 1].t]);
        const [[after]] = await pool.execute(
            `SELECT AVG(viewer_count) AS v FROM twitch_stream_snapshots WHERE broadcaster_id = ? AND recorded_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(? + 300)`,
            [bid, pivots[i + 1].t, pivots[i + 1].t]);
        const b = Number(before?.v) || 0;
        const a = Number(after?.v) || 0;
        if (b > 0) transitions[key].deltas.push({ before: b, after: a, pct: ((a - b) / b) * 100 });
    }
    const summary = Object.values(transitions).filter(t => t.deltas.length)
        .map(t => ({ ...t, avg_pct: t.deltas.reduce((s, d) => s + d.pct, 0) / t.deltas.length }))
        .sort((a, b) => b.count - a.count).slice(0, 10);
    const prompt = [
        'Analyze a Twitch streamer\'s category pivots. Which transitions help, hurt, or stay neutral for viewer count?',
        'Each row shows the before→after category pivot and the average % change in viewers over the ±5-min window.',
        '',
        ...summary.map(t => `  ${t.from} → ${t.to}: ${t.count}× pivots, avg viewer change ${t.avg_pct.toFixed(1)}%`),
        '',
        'Return JSON: { "key_insight": "...", "best_pivot": "A→B", "worst_pivot": "C→D" }',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: { key_insight: { type: 'string' }, best_pivot: { type: 'string' }, worst_pivot: { type: 'string' } },
        required: ['key_insight'],
    };
    const r = await callAI(prompt, { feature: 'category_pivots', broadcasterId: bid, schema });
    if (!r.ok) return { ok: false, error: r.error, rows: summary };
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    return { ok: true, ...parsed, rows: summary, provider: r.provider };
}

// ─── Tier AI-4 — chat moderator, auto-clip, prediction commentary ────────────

/**
 * AI chat moderator — scans unmoderated recent chat samples and flags toxic/harmful ones
 * for human review. Writes to twitch_ai_mod_queue. Human moderators review via dashboard;
 * no automated bans happen (false-positive risk is too high for autonomous action).
 */
/**
 * Map a moderation flag back to its sample. The model's "quote" must match the start of the
 * message at flag.i; if it matches a different message instead, use that one; if it matches
 * none, drop the flag rather than queue an innocent message. Flags without a quote fall back
 * to the index.
 */
export function resolveFlaggedSample(samples, flag) {
    const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const byIndex = samples[Number(flag?.i)];
    const q = norm(flag?.quote).slice(0, 20);
    if (!q) return byIndex || null;
    const hit = s => s && norm(s.message_text).startsWith(q);
    if (hit(byIndex)) return byIndex;
    return samples.find(hit) || null;
}

/**
 * Classify a batch of chat messages with the tuned moderation prompt (2026-11-16 eval).
 * samples: [{ id, chatter_user_login, chatter_user_id, message_text }]
 * Returns { ok, flags: [{ sample, severity, category, reason, confidence, provider }], provider }.
 *
 * Provider safety refusals (Gemini "PROHIBITED_CONTENT" / "SAFETY") used to lose the whole batch. Now the
 * batch is split in half and retried; a single message that is still refused is returned as a flag for a
 * human to look at, because a refused message is almost always one a moderator wants to see.
 */
export async function classifyChatBatch(broadcasterId, samples, depth = 0) {
    const bid = String(broadcasterId);
    if (!samples?.length) return { ok: true, flags: [] };
    // Wording chosen by the 2026-11-16 eval (471 real messages + 16 probes). Old prompt: qwen3.6 12/14
    // must-flag with 8-11 false flags, Gemini 14/14 with 29. This one: qwen3.6 14/14 with 1-2, Gemini
    // 14/14 with 6-7. The two providers need slightly different wording about affection: qwen3.6 missed
    // sweet-sounding advances without "even friendly-sounding", Gemini then flagged "hey wifey".
    const sexualRule = provider => provider === 'gemini'
        ? 'sexual comments about the streamer\u2019s or a chatter\u2019s body, sexual demands, or unwanted physical or sexual advances such as kissing or touching someone (even if phrased sweetly)'
        : 'sexual comments about the streamer\u2019s or a chatter\u2019s body, sexual demands, or unwanted romantic or sexual advances (even friendly-sounding ones)';
    const prompt = provider => [
        'You help a Twitch moderator. Flag ONLY messages a human mod would actually want to act on.',
        `FLAG: ${sexualRule(provider)}; insults or harassment aimed at the streamer or a chatter; slurs or hate; threats; sharing another person\u2019s personal info (names, addresses, workplaces); scams, advertising, or selling followers, viewers or accounts.`,
        `DO NOT FLAG: greetings, channel-emote spam, !commands, raid or shoutout messages, swearing not aimed at anyone, jokes and banter between regulars, ${provider === 'gemini' ? 'affectionate nicknames and greetings (wifey, cutie, love you, miss you), ' : ''}complaints about games or tech, talk about health, drugs or drinking, game violence ("kill this boss", "headshot").`,
        'Most batches contain nothing to flag. An empty list is the normal answer.',
        'severity: low (borderline, worth a glance), medium (clearly rude or inappropriate), high (slurs, targeted or sexual harassment), critical (threats, doxxing).',
        'category: harassment, sexual, slurs, threats, doxxing, spam, toxicity, other.',
        'For every flag, copy the first few words of the flagged message into "quote" exactly as written.',
        '',
        'MESSAGES:',
        ...samples.map((s, i) => `${i}: [${s.chatter_user_login}] ${(s.message_text || '').slice(0, 200)}`),
        '',
        'Return JSON: {"flags":[{"i":0,"quote":"first words","severity":"low","category":"harassment","reason":"short reason","confidence":0.0}]} or {"flags":[]}',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            flags: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        i: { type: 'number' }, quote: { type: 'string' }, severity: { type: 'string' },
                        category: { type: 'string' }, reason: { type: 'string' },
                        confidence: { type: 'number' },
                    },
                    required: ['i', 'severity'],
                },
            },
        },
        required: ['flags'],
    };
    const r = await callAI(prompt, { feature: 'chat_moderate', broadcasterId: bid, schema, temperature: 0.2 });
    if (!r.ok) {
        const refused = /PROHIBITED|SAFETY|blocked/i.test(String(r.error || ''));
        if (refused && samples.length > 1 && depth < 8) {
            const mid = Math.ceil(samples.length / 2);
            const a = await classifyChatBatch(bid, samples.slice(0, mid), depth + 1);
            const b = await classifyChatBatch(bid, samples.slice(mid), depth + 1);
            if (!a.ok && !b.ok) return a;
            return { ok: true, flags: [...(a.flags || []), ...(b.flags || [])], provider: a.provider || b.provider };
        }
        if (refused && samples.length === 1) {
            return { ok: true, provider: r.provider, flags: [{
                sample: samples[0], severity: 'high', category: 'other', confidence: null, provider: r.provider,
                reason: 'The AI provider refused to read this message (safety block). Review it yourself.',
            }] };
        }
        return r;
    }
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    const flags = [];
    for (const flag of (parsed?.flags || [])) {
        const sample = resolveFlaggedSample(samples, flag);
        if (!sample) continue;
        flags.push({
            sample,
            severity: ['low', 'medium', 'high', 'critical'].includes(flag.severity) ? flag.severity : 'medium',
            category: String(flag.category || 'other').slice(0, 64),
            reason: String(flag.reason || '').slice(0, 500),
            confidence: flag.confidence || null,
            provider: r.provider,
        });
    }
    return { ok: true, flags, provider: r.provider };
}

export async function moderateChat(broadcasterId) {
    const bid = String(broadcasterId);
    const [[cfg]] = await pool.execute(
        `SELECT ai_chat_mod_enabled FROM twitch_analytics_alerts_config WHERE broadcaster_id = ? LIMIT 1`, [bid]);
    if (!cfg?.ai_chat_mod_enabled) return { ok: false, error: 'ai_chat_mod_enabled is off' };

    // Pull up to 50 recent chat samples NOT already in the mod queue.
    const [samples] = await pool.execute(
        `SELECT m.id, m.chatter_user_id, m.chatter_user_login, m.message_text
           FROM twitch_chat_message_samples m
           LEFT JOIN twitch_ai_mod_queue q ON q.sample_id = m.id
          WHERE m.broadcaster_id = ? AND q.id IS NULL
            AND m.occurred_at > DATE_SUB(NOW(), INTERVAL 2 HOUR)
            AND ${sqlNotBot('m.chatter_user_login')}
          ORDER BY m.id DESC LIMIT 50`, [bid]);
    if (!samples.length) return { ok: true, flagged: 0, scanned: 0 };
    if (!samples.length) return { ok: true, flagged: 0 };

    const c = await classifyChatBatch(bid, samples);
    if (!c.ok) return c;
    let count = 0;
    for (const flag of c.flags) {
        const sample = flag.sample;
        await pool.execute(
            `INSERT INTO twitch_ai_mod_queue
             (broadcaster_id, sample_id, chatter_user_login, chatter_user_id, message_text,
              severity, category, reason, confidence, provider)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [bid, sample.id, sample.chatter_user_login, sample.chatter_user_id,
             (sample.message_text || '').slice(0, 2000), flag.severity,
             flag.category, flag.reason, flag.confidence, flag.provider || c.provider]).catch(() => {});
        count++;
    }
    return { ok: true, flagged: count, scanned: samples.length, provider: c.provider };
}

/**
 * Auto-clip on hype_train.end — called from the hype-train handler. If the broadcaster
 * has ai_auto_clip_hype enabled AND the Tier B clips:edit scope is granted, create a clip
 * capturing the end moment.
 */
export async function autoClipOnHypeEnd(broadcasterId, hypeEvent) {
    const bid = String(broadcasterId);
    const [[cfg]] = await pool.execute(
        `SELECT ai_auto_clip_hype FROM twitch_analytics_alerts_config WHERE broadcaster_id = ? LIMIT 1`, [bid]);
    if (!cfg?.ai_auto_clip_hype) return { ok: false, error: 'auto-clip disabled' };
    const { createClip } = await import('./twitch-write.js');
    const r = await createClip(bid, false, {
        triggeredByDiscordId: null, triggeredByDiscordUsername: 'AI auto-clipper',
    });
    if (r.ok) {
        logger.info(`${LOG} auto-clip created on hype_train.end for ${bid} (level ${hypeEvent?.level})`);
    }
    return r;
}

/**
 * Prediction outcome commentary — called from channel.prediction.end. Narrates the result
 * and posts to the configured alert channel.
 */
export async function commentaryForPrediction(broadcasterId, predictionEvent) {
    const bid = String(broadcasterId);
    const [[cfg]] = await pool.execute(
        `SELECT ai_prediction_commentary, alert_channel_id, guild_id FROM twitch_analytics_alerts_config
          WHERE broadcaster_id = ? LIMIT 1`, [bid]);
    if (!cfg?.ai_prediction_commentary || !cfg?.alert_channel_id) return { ok: false, error: 'disabled' };

    const outcomes = predictionEvent.outcomes || [];
    const winner = outcomes.find(o => o.id === predictionEvent.winning_outcome_id);
    const totalPoints = outcomes.reduce((s, o) => s + (o.channel_points || 0), 0);
    const prompt = [
        'Write a short, fun recap of this Twitch channel-point prediction result.',
        'Keep under 80 words. Second-person voice.',
        '',
        `Title: ${predictionEvent.title}`,
        `Winner: ${winner?.title || 'canceled/refunded'} ${winner ? `(${winner.channel_points || 0} points on this side)` : ''}`,
        `Total pot: ${totalPoints} channel points across ${outcomes.length} outcomes`,
        `Status: ${predictionEvent.status}`,
        '',
        'Return JSON: { "commentary": "..." }',
    ].join('\n');
    const schema = { type: 'object', properties: { commentary: { type: 'string' } }, required: ['commentary'] };
    const r = await callAI(prompt, { feature: 'prediction_commentary', broadcasterId: bid, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    const text = parsed?.commentary || r.text;
    try {
        const client = globalThis.botManager?.getClientForGuild?.(cfg.guild_id);
        if (client) {
            const ch = client.channels.cache.get(cfg.alert_channel_id) || await client.channels.fetch(cfg.alert_channel_id).catch(() => null);
            if (ch?.isTextBased?.()) {
                const { EmbedBuilder } = await import('discord.js');
                const embed = new EmbedBuilder()
                    .setTitle('🎲 Prediction result')
                    .setColor(0xe2b23a)
                    .setDescription(text)
                    .addFields({ name: 'Title', value: predictionEvent.title || '?', inline: false })
                    .setTimestamp();
                await ch.send({ embeds: [embed] });
            }
        }
    } catch (e) { logger.warn(`${LOG} prediction commentary post failed: ${e.message}`); }
    return { ok: true, commentary: text, provider: r.provider };
}

// ─── Tier AI-5 — embeddings + semantic search + overlay copy ─────────────────

/**
 * Compute embeddings for text(s) via Ollama. Returns an array with one vector (or null on
 * failure) per input. Uses /api/embeddings with OLLAMA_EMBED_MODEL (default nomic-embed-text)
 * on every endpoint, NOT the per-endpoint chat model.
 *
 * ai_ollama_url is a chain ("url#model,url#model!feature", see parseOllamaEndpoints), so it is
 * parsed the same way callOllama does and each text tries the endpoints in order, starting from
 * the last one that worked. Before 2026-11-18 the raw chain string was used as a single URL, so
 * every embedding call failed for broadcasters with more than one endpoint configured.
 */
export async function embedTexts(broadcasterId, texts) {
    if (!texts?.length) return [];
    const cfg = await configForBroadcaster(broadcasterId);
    const model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
    const endpoints = parseOllamaEndpoints(cfg?.ai_ollama_url || process.env.OLLAMA_URL || 'http://localhost:11434', model);
    if (!endpoints.length) return texts.map(() => null);
    let start = 0;
    const out = [];
    for (const text of texts) {
        let vector = null;
        for (let k = 0; k < endpoints.length && !vector; k++) {
            const i = (start + k) % endpoints.length;
            try {
                const r = await axios.post(`${endpoints[i].url}/api/embeddings`, { model, prompt: text }, { timeout: 20_000 });
                if (Array.isArray(r.data?.embedding) && r.data.embedding.length) {
                    vector = r.data.embedding;
                    start = i;
                }
            } catch (e) {
                logger.warn(`${LOG} embed failed on endpoint ${i + 1}/${endpoints.length}: ${e.message}`);
            }
        }
        out.push(vector);
    }
    return out;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Semantic clip search — embed all clip titles for this broadcaster if not already cached,
 * then embed the query and return top-K by cosine similarity.
 */
export async function semanticClipSearch(broadcasterId, query, { limit = 10 } = {}) {
    const bid = String(broadcasterId);
    query = String(query || '').trim().slice(0, 300);
    if (!query) return { ok: false, error: 'Type something to search for.' };
    // Fetch clips without an embedding yet, embed them, cache. Capped per call so one search
    // stays quick; the rest are indexed by later searches (see indexed/total in the result).
    const [missing] = await pool.execute(
        `SELECT c.clip_id, c.title FROM twitch_clips_catalog c
           LEFT JOIN twitch_ai_embeddings e ON e.type = 'clip' AND e.subject_id = c.clip_id COLLATE utf8mb4_unicode_ci
          WHERE c.broadcaster_id = ? AND e.id IS NULL AND c.title IS NOT NULL AND c.title != ''
          LIMIT 150`, [bid]);
    if (missing.length) {
        const vectors = await embedTexts(bid, missing.map(m => m.title));
        for (let i = 0; i < missing.length; i++) {
            const v = vectors[i];
            if (!v) continue;
            await pool.execute(
                `INSERT IGNORE INTO twitch_ai_embeddings
                 (broadcaster_id, type, subject_id, text_snippet, embedding_json, embedding_dims, provider, model)
                 VALUES (?, 'clip', ?, ?, ?, ?, 'ollama', ?)`,
                [bid, missing[i].clip_id, missing[i].title.slice(0, 500), JSON.stringify(v), v.length, process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text']);
        }
    }
    // Embed the query, score every cached clip.
    const [qVec] = await embedTexts(bid, [query]);
    if (!qVec) return { ok: false, error: 'embedding provider unreachable (Ollama)' };
    const [rows] = await pool.execute(
        `SELECT e.subject_id AS clip_id, e.embedding_json, c.title, c.view_count, c.url
           FROM twitch_ai_embeddings e
           JOIN twitch_clips_catalog c ON c.clip_id = e.subject_id COLLATE utf8mb4_unicode_ci
          WHERE e.broadcaster_id = ? AND e.type = 'clip'`, [bid]);
    const scored = rows.map(r => {
        let v = null; try { v = JSON.parse(r.embedding_json); } catch {}
        return { clip_id: r.clip_id, title: r.title, view_count: r.view_count, url: r.url, score: cosineSim(qVec, v) };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
    const [[{ total }]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM twitch_clips_catalog
          WHERE broadcaster_id = ? AND title IS NOT NULL AND title != ''`, [bid]);
    return { ok: true, results: scored, indexed: rows.length, total: Number(total) };
}

/**
 * AI-generated OBS overlay copy — a one-liner / three-liner for a specific context (ad
 * running, hype train active, big raid incoming, chill moment). Rendered on the OBS
 * overlay variant layout=ai-copy.
 */
export async function generateOverlayCopy(broadcasterId, context = 'default') {
    const prompt = [
        'Write one short on-stream caption appropriate for the context. Max 40 chars.',
        'No emoji. Confident but not hype-y. Fits in a transparent OBS overlay.',
        '',
        `CONTEXT: ${context}`,
        '',
        'Return JSON: { "caption": "..." }',
    ].join('\n');
    const schema = { type: 'object', properties: { caption: { type: 'string' } }, required: ['caption'] };
    const r = await callAI(prompt, { feature: 'overlay_copy', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    return { ok: true, caption: parsed?.caption || r.text, provider: r.provider };
}

// ─── Sentiment deltas (SQL-only, no AI call) ─────────────────────────────────

export async function sentimentByCategory(broadcasterId) {
    const [rows] = await pool.execute(
        `SELECT ch.category_name,
                AVG(s.sentiment) AS avg_sentiment, COUNT(*) AS n
           FROM twitch_ai_message_sentiments s
           JOIN twitch_chat_message_samples m ON m.id = s.sample_id
           JOIN twitch_category_history ch ON ch.broadcaster_id = m.broadcaster_id
                   AND m.occurred_at >= ch.changed_at
                   AND m.occurred_at < COALESCE(
                       (SELECT MIN(ch2.changed_at) FROM twitch_category_history ch2
                         WHERE ch2.broadcaster_id = ch.broadcaster_id AND ch2.changed_at > ch.changed_at),
                       NOW())
          WHERE s.broadcaster_id = ? AND ch.category_name IS NOT NULL
          GROUP BY ch.category_name
         HAVING n >= 10
          ORDER BY avg_sentiment DESC`, [String(broadcasterId)]);
    return { ok: true, rows };
}

/**
 * AI narrative over anonymized peer context — turns the percentile numbers into a
 * human-readable "compared to similar channels" paragraph. The prompt NEVER includes any
 * other broadcaster's identifying data; only aggregates + the caller's own percentile.
 */
export async function generatePeerInsight(broadcasterId) {
    const { getPeerContext } = await import('./twitch-peer-insights.js');
    const ctx = await getPeerContext(broadcasterId);
    if (!ctx) return { ok: false, error: 'not opted into peer pool, or no snapshot yet' };
    if (ctx.hidden) return { ok: false, error: `peer bucket has fewer than k=${ctx.k} broadcasters — comparison hidden for privacy` };

    const prompt = [
        'Write a short peer-comparison paragraph for a Twitch broadcaster. Second-person voice.',
        'You are given MEDIAN and PERCENTILE data from a pool of similar-sized channels.',
        'NEVER reference specific other channels, usernames, or identifiers — you only know aggregates.',
        'Highlight 2-3 strengths and 1-2 opportunities. Keep under 120 words.',
        '',
        `BUCKET: ${ctx.bucket} (${ctx.member_count} peer channels)`,
        '',
        'PEER MEDIANS (last 7 days where applicable):',
        `  Followers: ${ctx.medians.follower?.toLocaleString() || '?'}`,
        `  Subscribers: ${ctx.medians.sub?.toLocaleString() || '?'}`,
        `  Hours live: ${ctx.medians.hours_live_7d?.toFixed(1) || '?'}`,
        `  Peak viewers: ${ctx.medians.peak_viewers_7d?.toLocaleString() || '?'}`,
        `  Chat msgs: ${ctx.medians.msgs_7d?.toLocaleString() || '?'}`,
        `  Bits total: ${ctx.medians.bits_total?.toLocaleString() || '?'}`,
        '',
        'YOUR PERCENTILE WITHIN THE BUCKET (0 = lowest, 100 = highest):',
        `  Followers: ${ctx.your_percentiles.follower}th`,
        `  Subscribers: ${ctx.your_percentiles.sub}th`,
        `  Hours live: ${ctx.your_percentiles.hours_live}th`,
        `  Peak viewers: ${ctx.your_percentiles.peak_viewers}th`,
        `  Chat msgs: ${ctx.your_percentiles.msgs}th`,
        `  Bits: ${ctx.your_percentiles.bits}th`,
        '',
        'Return JSON: { "narrative": "...", "strengths": ["...", ...], "opportunities": ["...", ...] }',
    ].join('\n');
    const schema = {
        type: 'object',
        properties: {
            narrative: { type: 'string' },
            strengths: { type: 'array', items: { type: 'string' } },
            opportunities: { type: 'array', items: { type: 'string' } },
        },
        required: ['narrative'],
    };
    const r = await callAI(prompt, { feature: 'peer_insight', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    return {
        ok: true,
        narrative: parsed?.narrative || r.text,
        strengths: parsed?.strengths || [],
        opportunities: parsed?.opportunities || [],
        bucket: ctx.bucket,
        peer_count: ctx.member_count,
        your_percentiles: ctx.your_percentiles,
        provider: r.provider,
    };
}

export async function sentimentBySubTier(broadcasterId) {
    const [rows] = await pool.execute(
        `SELECT r.tier,
                AVG(s.sentiment) AS avg_sentiment, COUNT(*) AS n
           FROM twitch_ai_message_sentiments s
           JOIN twitch_chat_message_samples m ON m.id = s.sample_id
           JOIN twitch_resub_messages r ON LOWER(r.user_login) = LOWER(m.chatter_user_login)
                                        AND r.broadcaster_id = m.broadcaster_id
          WHERE s.broadcaster_id = ?
          GROUP BY r.tier
         HAVING n >= 10
          ORDER BY r.tier`, [String(broadcasterId)]);
    return { ok: true, rows };
}

export async function verifyRaid(broadcasterId, raidEvent) {
    // Fetch raider profile via app token (public Helix).
    let raiderProfile = null;
    try {
        const { getAccessToken } = await import('../utils/platforms/twitch-api.js');
        const appToken = await getAccessToken();
        const [u, f] = await Promise.all([
            axios.get(`https://api.twitch.tv/helix/users?id=${raidEvent.from_broadcaster_user_id}`, {
                headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${appToken}` },
            }).catch(() => ({ data: {} })),
            axios.get(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${raidEvent.from_broadcaster_user_id}&first=1`, {
                headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${appToken}` },
            }).catch(() => ({ data: {} })),
        ]);
        raiderProfile = { user: u.data?.data?.[0], follower_total: f.data?.total };
    } catch {}

    const raiderCreatedDays = raiderProfile?.user?.created_at
        ? Math.floor((Date.now() - new Date(raiderProfile.user.created_at).getTime()) / 86400000) : null;
    const prompt = [
        'Classify this incoming Twitch raid as likely-legit, likely-fake, or unclear.',
        'Fake raid indicators: raider has very few followers but sending hundreds of viewers, or very new account, or no profile_image.',
        'Return JSON: { "classification": "likely_legit|likely_fake|unclear", "confidence": 0.0-1.0, "reasoning": "one sentence" }',
        '',
        `RAIDING CHANNEL: ${raidEvent.from_broadcaster_user_name || '?'}`,
        `Viewers being brought: ${raidEvent.viewers || '?'}`,
        raiderProfile?.user ? `Raider's follower count: ${raiderProfile.follower_total ?? '?'}` : '',
        raiderCreatedDays !== null ? `Raider's account age: ${raiderCreatedDays} days` : '',
        raiderProfile?.user ? `Raider description: "${(raiderProfile.user.description || '').slice(0, 200)}"` : '',
        raiderProfile?.user ? `Raider broadcaster_type: ${raiderProfile.user.broadcaster_type || 'none'}` : '',
    ].filter(Boolean).join('\n');
    const schema = {
        type: 'object',
        properties: {
            classification: { type: 'string' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
        },
        required: ['classification', 'reasoning'],
    };
    const r = await callAI(prompt, { feature: 'raid_verify', broadcasterId, schema });
    if (!r.ok) return r;
    let parsed = null; try { parsed = JSON.parse(r.text); } catch {}
    if (parsed) {
        await pool.execute(
            `INSERT INTO twitch_ai_insights (broadcaster_id, type, subject_id, payload_json, provider, model)
             VALUES (?, 'raid_verify', ?, ?, ?, ?)`,
            [broadcasterId, raidEvent.from_broadcaster_user_id || 'unknown', JSON.stringify(parsed), r.provider, r.model]).catch(() => {});
    }
    return { ok: true, ...parsed, provider: r.provider };
}
