/*
 * @mention AI assistant — natural language over the bot's real capabilities.
 *
 *   "@bot what's the weather today?"  → calls the REAL weather manager with the user's saved
 *                                       location and answers from live data, not a guess.
 *
 * WHY FUNCTION CALLING RATHER THAN A PLAIN PROMPT:
 *   A bare LLM would happily invent a forecast. Gemini's tool calling lets the model choose one of
 *   OUR functions, we execute it against real services, and the model then phrases the actual result.
 *   The model never sees a credential and never touches Discord directly.
 *
 * SECURITY MODEL — the important part:
 *   Tools that DO something declare `permission`, and we check it against the INVOKING MEMBER before
 *   executing. The assistant therefore acts strictly *as the user who mentioned it* and can never be
 *   talked into exceeding them: a member who cannot ban cannot get the bot to ban, no matter how the
 *   request is phrased. Prompt injection buys an attacker nothing they did not already have.
 *   Read-only tools carry `permission: null`.
 *
 * Opt-in per guild (ai_config.enabled), with a per-guild daily cap so a busy server cannot burn the
 * whole Gemini quota, and a per-user cooldown so mentions cannot be spammed.
 *
 * CONVERSATION MEMORY (chatgpt_memory, migration 315):
 *   ai_config.memory_mode  'user'    — each member's own recent exchanges in that channel (default)
 *                          'channel' — one shared conversation per channel, speakers named
 *                          'off'     — stateless, as before
 *   Bounded by memory_turns (exchanges) and memory_ttl_minutes, plus a character budget
 *   (ai-memory-utils.js). Rows carry the scope they were written under, so switching a server from
 *   per-user to shared memory never exposes anyone's earlier private exchanges. Members who opted
 *   out of message logging (user_privacy_settings.opt_out_message_logging) are never stored, and
 *   anyone can say "@bot forget" to wipe their own memory in a channel. Admins clear more via /manage ai.
 *
 * CHANNEL PERSONA (chatgpt_persona): an admin-set name/voice/style for one channel, validated by
 *   validatePersona() and appended BELOW the fixed rules — it cannot change tools or permissions.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import {
  MEMORY_LIMITS,
  clampMemorySettings,
  buildHistory,
  clipForStorage,
  isForgetRequest,
  validatePersona,
  personaInstruction,
  memoryInstruction,
} from './ai-memory-utils.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const apiKey = () => process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
const USER_COOLDOWN_MS = 8000;
const MAX_PROMPT = 800;
const lastUse = new Map(); // `${guild}:${user}` -> ts

export function isConfigured() { return !!apiKey(); }

// ── config ───────────────────────────────────────────────────────────────────
export async function getConfig(guildId) {
  const [[row]] = await pool.execute('SELECT * FROM ai_config WHERE guild_id = ?', [guildId]);
  return row || null;
}

export async function setEnabled(guildId, enabled, { allowActions } = {}) {
  await pool.execute(
    `INSERT INTO ai_config (guild_id, enabled, allow_actions) VALUES (?, ?, COALESCE(?, 1))
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
       allow_actions = COALESCE(?, allow_actions)`,
    [guildId, enabled ? 1 : 0, allowActions === undefined ? null : (allowActions ? 1 : 0),
      allowActions === undefined ? null : (allowActions ? 1 : 0)]);
}

/**
 * Save the memory knobs. `mode` 'off' also deletes the server's stored memory — turning memory
 * off should not leave old conversations lying around.
 */
export async function setMemorySettings(guildId, { mode, turns, ttlMinutes } = {}) {
  const current = clampMemorySettings(await getConfig(guildId) || {});
  const next = clampMemorySettings({
    memory_mode: mode ?? current.mode,
    memory_turns: turns ?? current.turns,
    memory_ttl_minutes: ttlMinutes ?? current.ttlMinutes,
  });
  await pool.execute(
    `INSERT INTO ai_config (guild_id, enabled, memory_mode, memory_turns, memory_ttl_minutes) VALUES (?, 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE memory_mode = VALUES(memory_mode), memory_turns = VALUES(memory_turns),
       memory_ttl_minutes = VALUES(memory_ttl_minutes)`,
    [guildId, next.mode, next.turns, next.ttlMinutes]);
  let cleared = 0;
  if (next.mode === 'off') cleared = await clearMemory({ guildId });
  else if (next.mode !== current.mode) {
    // Rows written under the other scope are never read again; drop them now rather than at TTL.
    const [res] = await pool.execute('DELETE FROM chatgpt_memory WHERE guild_id = ? AND scope <> ?', [guildId, next.mode]);
    cleared = res.affectedRows || 0;
  }
  return { ...next, cleared };
}

// ── memory ───────────────────────────────────────────────────────────────────
let lastGlobalSweep = 0;
let optOutTableMissing = false;

/** Has this member opted out of message logging? (privacy settings are global per user) */
async function isOptedOut(userId) {
  if (optOutTableMissing) return false;
  try {
    const [[row]] = await pool.execute(
      'SELECT opt_out_message_logging FROM user_privacy_settings WHERE user_id = ?', [userId]);
    return !!row?.opt_out_message_logging;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') { optOutTableMissing = true; return false; }
    // Fail closed: if we cannot tell, do not store their words.
    logger.warn(`[AI] privacy lookup failed for ${userId}: ${e.message}`, { category: 'ai' });
    return true;
  }
}

/**
 * Delete stored memory. Any combination of guildId / channelId / userId narrows it;
 * at least one must be given. Returns the number of rows removed.
 */
export async function clearMemory({ guildId = null, channelId = null, userId = null } = {}) {
  const where = [];
  const params = [];
  if (guildId) { where.push('guild_id = ?'); params.push(guildId); }
  if (channelId) { where.push('channel_id = ?'); params.push(channelId); }
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  if (!where.length) throw new Error('clearMemory needs a guild, channel or user');
  const [res] = await pool.execute(`DELETE FROM chatgpt_memory WHERE ${where.join(' AND ')}`, params);
  return res.affectedRows || 0;
}

/** How many stored messages a guild currently holds (for /ai status). */
export async function countMemory(guildId) {
  const [[row]] = await pool.execute('SELECT COUNT(*) AS n FROM chatgpt_memory WHERE guild_id = ?', [guildId]);
  return Number(row?.n || 0);
}

/**
 * Expire old rows: this guild's past its own TTL on every use, and — at most every 10 minutes —
 * anything older than the 24h hard ceiling across all guilds (covers guilds that went quiet or
 * disabled the assistant). Bounded batches; failures are logged, never thrown.
 */
async function pruneMemory(guildId, ttlMinutes) {
  try {
    await pool.execute(
      `DELETE FROM chatgpt_memory WHERE guild_id = ? AND timestamp < DATE_SUB(NOW(), INTERVAL ${Number(ttlMinutes)} MINUTE)`,
      [guildId]);
    if (Date.now() - lastGlobalSweep > 10 * 60 * 1000) {
      lastGlobalSweep = Date.now();
      await pool.query(
        `DELETE FROM chatgpt_memory WHERE timestamp < DATE_SUB(NOW(), INTERVAL ${MEMORY_LIMITS.maxTtlMinutes} MINUTE) LIMIT 5000`);
    }
  } catch (e) {
    logger.warn(`[AI] memory prune failed for ${guildId}: ${e.message}`, { category: 'ai' });
  }
}

async function loadMemory({ guildId, channelId, userId, mode, turns, ttlMinutes }) {
  const limit = Math.max(2, Math.min(MEMORY_LIMITS.maxTurns * 2, turns * 2 + 2));
  const params = [guildId, channelId, mode];
  let sql = `SELECT role, message FROM chatgpt_memory
              WHERE guild_id = ? AND channel_id = ? AND scope = ?
                AND timestamp >= DATE_SUB(NOW(), INTERVAL ${Number(ttlMinutes)} MINUTE)`;
  if (mode === 'user') { sql += ' AND user_id = ?'; params.push(userId); }
  sql += ` ORDER BY id DESC LIMIT ${limit}`;
  const [rows] = await pool.execute(sql, params);
  return rows.reverse();
}

async function saveExchange({ guildId, channelId, userId, mode, userText, modelText }) {
  await pool.execute(
    `INSERT INTO chatgpt_memory (guild_id, user_id, channel_id, scope, role, message) VALUES
       (?, ?, ?, ?, 'user', ?), (?, ?, ?, ?, 'model', ?)`,
    [guildId, userId, channelId, mode, clipForStorage(userText),
      guildId, userId, channelId, mode, clipForStorage(modelText)]);
}

// ── persona ──────────────────────────────────────────────────────────────────
const personaCache = new Map(); // channelId -> { persona, at }
const PERSONA_CACHE_MS = 60 * 1000;

export async function getPersona(channelId) {
  const hit = personaCache.get(channelId);
  if (hit && Date.now() - hit.at < PERSONA_CACHE_MS) return hit.persona;
  const [[row]] = await pool.execute('SELECT persona FROM chatgpt_persona WHERE channel_id = ?', [channelId]);
  const persona = row?.persona || null;
  personaCache.set(channelId, { persona, at: Date.now() });
  if (personaCache.size > 2000) personaCache.clear();
  return persona;
}

/** Validate and save a channel persona. Returns { ok, persona } or { ok: false, error }. */
export async function setPersona(guildId, channelId, text, setBy) {
  const v = validatePersona(text);
  if (!v.ok) return v;
  await pool.execute(
    `INSERT INTO chatgpt_persona (channel_id, guild_id, persona, set_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id), persona = VALUES(persona), set_by = VALUES(set_by)`,
    [channelId, guildId, v.persona, setBy || null]);
  personaCache.delete(channelId);
  return v;
}

export async function clearPersona(channelId) {
  const [res] = await pool.execute('DELETE FROM chatgpt_persona WHERE channel_id = ?', [channelId]);
  personaCache.delete(channelId);
  return (res.affectedRows || 0) > 0;
}

/** Personas set in this guild (for /ai status). */
export async function listPersonas(guildId) {
  const [rows] = await pool.execute(
    'SELECT channel_id, LEFT(persona, 120) AS preview, updated_at FROM chatgpt_persona WHERE guild_id = ? ORDER BY updated_at DESC LIMIT 25',
    [guildId]);
  return rows;
}

/** Reserve one request against today's cap. Returns false when the guild is out. */
async function consumeQuota(guildId, cap) {
  const [res] = await pool.execute(
    `UPDATE ai_config
        SET used_today = IF(usage_date = CURDATE(), used_today + 1, 1),
            usage_date = CURDATE()
      WHERE guild_id = ? AND (usage_date <> CURDATE() OR used_today < ?)`,
    [guildId, cap]);
  return res.affectedRows === 1;
}

// ── tools ────────────────────────────────────────────────────────────────────
/**
 * `permission` is a PermissionFlagsBits value the INVOKING member must hold, or null for read-only.
 * `handler(args, ctx)` returns a plain object the model will phrase; throw to report a failure.
 */
const TOOLS = [
  {
    name: 'get_weather',
    description: "Current weather. Omit `location` to use the user's own saved location.",
    permission: null,
    parameters: { type: 'OBJECT', properties: { location: { type: 'STRING', description: 'City name or US ZIP. Omit to use the saved location.' } } },
    handler: async ({ location }, ctx) => {
      const wm = ctx.client.weatherManager;
      if (!wm) throw new Error('the weather service is not available');
      let target = location;
      if (!target) {
        const saved = await wm.getUserLocation(ctx.userId).catch(() => null);
        target = saved?.zip_code || saved?.location || saved?.city || null;
        if (!target) return { error: 'no_saved_location', hint: 'Ask the user to run /weather check setlocation with their ZIP code, or to name a place.' };
      }
      const w = await wm.getCurrentWeather(target);
      if (!w) return { error: 'not_found', location: target };
      return { location: target, weather: w };
    },
  },
  {
    name: 'get_time',
    description: "The current time, in the user's own timezone if they have set one.",
    permission: null,
    parameters: { type: 'OBJECT', properties: { timezone: { type: 'STRING', description: 'IANA timezone, e.g. America/New_York. Omit for the user\'s saved zone.' } } },
    handler: async ({ timezone }, ctx) => {
      let zone = timezone;
      if (!zone) {
        const [[row]] = await pool.execute('SELECT time_zone FROM tz_users WHERE user_id = ?', [ctx.userId]);
        zone = row?.time_zone || null;
      }
      if (!zone) {
        const [[g]] = await pool.execute('SELECT time_zone FROM tz_guild_config WHERE guild_id = ?', [ctx.guildId]);
        zone = g?.time_zone || 'UTC';
      }
      return { timezone: zone, now: new Date().toLocaleString('en-US', { timeZone: zone }) };
    },
  },
  {
    name: 'get_server_info',
    description: 'Facts about the current Discord server: name, member count, channel count, owner.',
    permission: null,
    parameters: { type: 'OBJECT', properties: {} },
    handler: async (_a, ctx) => ({
      name: ctx.guild.name,
      members: ctx.guild.memberCount,
      channels: ctx.guild.channels.cache.size,
      created: ctx.guild.createdAt.toISOString().slice(0, 10),
    }),
  },
  {
    name: 'play_music',
    description: 'Play a song, album or playlist — including Spotify, YouTube and SoundCloud links. '
      + 'The user must already be in a voice channel.',
    permission: null, // anyone may play; the VC requirement is the real gate
    action: true,
    parameters: { type: 'OBJECT', required: ['query'], properties: { query: { type: 'STRING', description: 'Song name, artist, or a Spotify/YouTube/SoundCloud URL' } } },
    handler: async ({ query }, ctx) => {
      const vc = ctx.member?.voice?.channel;
      if (!vc) return { error: 'not_in_voice', hint: 'Tell the user to join a voice channel first.' };

      // Reuse the REAL /music play handler rather than calling player.play() directly.
      // That handler resolves Spotify playlists/albums through our own Spotify API (the bundled
      // extractor caps playlists and can return nothing), applies the go-librespot
      // onBeforeCreateStream hook, de-duplicates, and bridges to YouTube/SoundCloud on failure.
      // Reimplementing any of that here is how "playlist not found" happened.
      const { MessageContextAdapter } = await import('./message-context-adapter.js');
      const { handlePlay } = await import('../handlers/music/player.js');

      const adapter = new MessageContextAdapter(ctx.message, 'music', { query });
      let replyText = null;
      // Capture what the handler would have said instead of letting it post its own message —
      // the model phrases the final answer.
      adapter.reply = adapter.editReply = adapter.followUp = async (opts) => {
        replyText = typeof opts === 'string' ? opts : (opts?.content || replyText);
        return null;
      };
      adapter.deferReply = async () => { await ctx.message.channel.sendTyping().catch(() => {}); };

      await handlePlay(adapter);
      return { result: replyText || 'Started playback.', voice_channel: vc.name };
    },
  },
  {
    name: 'skip_track',
    description: 'Skip the song currently playing.',
    permission: null,
    action: true,
    parameters: { type: 'OBJECT', properties: {} },
    handler: async (_a, ctx) => {
      const player = ctx.client.player || global.player;
      const queue = player?.nodes?.get(ctx.guildId);
      if (!queue?.isPlaying()) return { error: 'nothing_playing' };
      if (!ctx.member?.voice?.channel) return { error: 'not_in_voice' };
      const title = queue.currentTrack?.title;
      queue.node.skip();
      return { skipped: title };
    },
  },
  {
    name: 'set_my_timezone',
    description: "Save the user's timezone so times and weather use it.",
    permission: null,
    action: true,
    parameters: { type: 'OBJECT', required: ['timezone'], properties: { timezone: { type: 'STRING', description: 'IANA timezone, e.g. America/New_York' } } },
    handler: async ({ timezone }, ctx) => {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
      catch { return { error: 'invalid_timezone', got: timezone }; }
      await pool.execute(
        `INSERT INTO tz_users (user_id, time_zone) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE time_zone = VALUES(time_zone)`, [ctx.userId, timezone]);
      return { saved: timezone };
    },
  },
  {
    name: 'purge_messages',
    description: 'Bulk-delete recent messages in this channel. Requires Manage Messages.',
    permission: PermissionFlagsBits.ManageMessages,
    action: true,
    parameters: { type: 'OBJECT', required: ['count'], properties: { count: { type: 'NUMBER', description: 'How many messages, 1-100' } } },
    handler: async ({ count }, ctx) => {
      const n = Math.max(1, Math.min(100, Math.floor(count)));
      const deleted = await ctx.message.channel.bulkDelete(n, true).catch((e) => { throw new Error(e.message); });
      return { deleted: deleted.size };
    },
  },
];

/**
 * Web search, as a function the model can ASK for.
 *
 * Gemini refuses to combine its built-in `google_search` grounding with function calling in one
 * request ("Built-in tools and Function Calling cannot be combined" — HTTP 400). So instead of
 * guessing which mode a message needs, we declare search as a normal tool: when the model wants the
 * web it calls `search_web`, and we answer that call with a SECOND, grounding-enabled request.
 * Chit-chat and Discord actions therefore still cost one request; only genuine web questions pay for
 * two, and the model itself decides which is which.
 */
const SEARCH_TOOL = {
  name: 'search_web',
  description: 'Search the live web with Google. Use this for anything current, factual, or outside '
    + 'your own knowledge — news, sport, prices, people, "what is X", release dates, or anything you '
    + 'are unsure about. Do NOT guess when you could search.',
  permission: null,
  parameters: { type: 'OBJECT', required: ['query'], properties: { query: { type: 'STRING', description: 'What to search for' } } },
};

/** Run a grounded Google-Search request and return the answer plus its sources. */
async function groundedSearch(query) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `search failed (${r.status})`);
  const cand = j.candidates?.[0];
  const answer = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join(' ').trim();
  const sources = (cand?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web?.title).filter(Boolean).slice(0, 3);
  return { answer: answer || 'No result found.', sources };
}

const byName = new Map(TOOLS.map(t => [t.name, t]));

function declarationsFor(allowActions) {
  const list = TOOLS.filter(t => allowActions || !t.action);
  return [...list, SEARCH_TOOL].map(({ name, description, parameters }) => ({ name, description, parameters }));
}

// ── main entry ───────────────────────────────────────────────────────────────
/**
 * Answer an @mention. Returns a string to send, or null when the assistant should stay silent
 * (disabled, not configured, rate limited, out of quota).
 */
export async function handleMention(message, prompt) {
  if (!isConfigured() || !message.guild) return null;

  const cfg = await getConfig(message.guild.id);
  if (!cfg?.enabled) return null;                     // opt-in only

  if (cfg.channel_ids) {                              // optional channel allow-list
    try {
      const allowed = JSON.parse(cfg.channel_ids);
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(message.channel.id)) return null;
    } catch { /* malformed list = no restriction */ }
  }

  const text = String(prompt || '').trim().slice(0, MAX_PROMPT);
  if (!text) return null;

  // "@bot forget" — a member wiping their own conversation memory here. Free: no quota, no cooldown.
  if (isForgetRequest(text)) {
    try {
      const n = await clearMemory({ guildId: message.guild.id, channelId: message.channel.id, userId: message.author.id });
      logger.info(`[AI] ${message.author.id} cleared ${n} memory row(s) in ${message.channel.id}`, { category: 'ai' });
      return n > 0
        ? '🧹 Done — I\'ve forgotten our conversation in this channel.'
        : 'There was nothing to forget — I don\'t have any saved conversation with you in this channel.';
    } catch (e) {
      logger.error(`[AI] forget failed for ${message.author.id} in ${message.guild.id}: ${e.message}`, { category: 'ai' });
      return 'Sorry — I couldn\'t clear our conversation just now. Please try again in a moment.';
    }
  }

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < USER_COOLDOWN_MS) return null;   // silent, not chatty
  lastUse.set(key, now);
  if (lastUse.size > 5000) lastUse.clear();

  if (!await consumeQuota(message.guild.id, cfg.daily_cap)) {
    logger.warn(`[AI] daily cap reached for guild ${message.guild.id}`, { category: 'ai' });
    return "I've hit my AI limit for today in this server — try again tomorrow.";
  }

  const allowActions = !!cfg.allow_actions;
  const ctx = {
    message, client: message.client, guild: message.guild, guildId: message.guild.id,
    member: message.member, userId: message.author.id, channelId: message.channel.id,
  };
  const speaker = message.member?.displayName || message.author.username;

  // Conversation memory + channel persona. Either failing must not stop the answer.
  const memory = clampMemorySettings(cfg);
  let history = [];
  let persona = null;
  let optedOut = false;
  if (memory.mode !== 'off') {
    try {
      await pruneMemory(ctx.guildId, memory.ttlMinutes);
      optedOut = await isOptedOut(ctx.userId);
      const rows = await loadMemory({ ...ctx, mode: memory.mode, turns: memory.turns, ttlMinutes: memory.ttlMinutes });
      history = buildHistory(rows, { maxTurns: memory.turns, maxChars: MEMORY_LIMITS.maxHistoryChars });
    } catch (e) {
      logger.warn(`[AI] could not load memory for ${ctx.channelId}: ${e.message}`, { category: 'ai' });
      history = [];
    }
  }
  try {
    persona = await getPersona(ctx.channelId);
  } catch (e) {
    logger.warn(`[AI] could not load persona for ${ctx.channelId}: ${e.message}`, { category: 'ai' });
  }
  // In a shared channel conversation the model needs to know who is speaking.
  const userTurn = memory.mode === 'channel' ? `${speaker}: ${text}` : text;

  try {
    const model = new GoogleGenerativeAI(apiKey()).getGenerativeModel({
      model: MODEL,
      tools: [{ functionDeclarations: declarationsFor(allowActions) }],
      systemInstruction:
        `Today is ${new Date().toDateString()}. Your own knowledge is out of date — you have live tools, use them.\n`
        + `You are ${message.client.user.username}, a helpful assistant in the Discord server "${message.guild.name}", `
        + `talking to ${speaker}.\n`
        + 'RULES:\n'
        + '- Any question about facts, events, people, prices, sport, news, products, or anything after your '
        + 'training cutoff: you MUST call search_web. Never claim something has not happened yet, and never say '
        + 'you cannot browse — you can, via search_web.\n'
        + '- Weather: call get_weather. Omit the location to use the user\'s own saved location; do not ask for '
        + 'a location first.\n'
        + '- Anything actionable (playing music, skipping, purging): use the matching tool.\n'
        + '- Answer directly only for opinions, creative writing, reasoning, coding help and chit-chat — you are '
        + 'a general assistant, not limited to Discord features.\n'
        + 'Keep replies conversational and reasonably short for a chat message. Plain text, no markdown headings. '
        + 'If a tool reports an error, explain it plainly and say what the user should do next.'
        + (history.length ? memoryInstruction(memory.mode) : '')
        + personaInstruction(persona),
    });

    const chat = model.startChat(history.length ? { history } : undefined);
    let res = await chat.sendMessage(userTurn);

    // Tool loop. Two rounds is plenty for "look something up, then answer"; the bound stops a model
    // that keeps calling tools from looping forever on our quota.
    for (let round = 0; round < 2; round++) {
      const calls = res.response.functionCalls?.() || [];
      if (!calls.length) break;

      const replies = [];
      for (const call of calls) {
        // Web search is answered by a second, grounding-enabled request (see groundedSearch).
        if (call.name === SEARCH_TOOL.name) {
          try {
            const { answer, sources } = await groundedSearch(String(call.args?.query || text).slice(0, 400));
            logger.info(`[AI] ${ctx.userId} searched the web in ${ctx.guildId}`, { category: 'ai' });
            replies.push({ functionResponse: { name: call.name, response: { answer, sources } } });
          } catch (e) {
            replies.push({ functionResponse: { name: call.name, response: { error: String(e.message).slice(0, 160) } } });
          }
          continue;
        }

        const tool = byName.get(call.name);
        if (!tool) { replies.push({ functionResponse: { name: call.name, response: { error: 'unknown_tool' } } }); continue; }

        // Authorisation happens HERE, against the human who typed — not against the bot's own powers.
        if (tool.permission && !ctx.member?.permissions?.has(tool.permission)) {
          logger.info(`[AI] ${ctx.userId} denied ${tool.name} (missing permission) in ${ctx.guildId}`, { category: 'ai' });
          replies.push({ functionResponse: { name: call.name, response: { error: 'missing_permission', hint: 'Tell the user they do not have permission for that.' } } });
          continue;
        }
        if (tool.action && !allowActions) {
          replies.push({ functionResponse: { name: call.name, response: { error: 'actions_disabled' } } });
          continue;
        }

        try {
          const out = await tool.handler(call.args || {}, ctx);
          logger.info(`[AI] ${ctx.userId} ran ${tool.name} in ${ctx.guildId}`, { category: 'ai' });
          replies.push({ functionResponse: { name: call.name, response: out } });
        } catch (e) {
          replies.push({ functionResponse: { name: call.name, response: { error: String(e.message).slice(0, 200) } } });
        }
      }
      res = await chat.sendMessage(replies);
    }

    const answer = (res.response.text() || '').trim();
    if (!answer) return null;
    const reply = answer.slice(0, 1900);

    // Remember the exchange (text only — tool calls and results are not stored).
    if (memory.mode !== 'off' && !optedOut) {
      try {
        await saveExchange({ ...ctx, mode: memory.mode, userText: userTurn, modelText: reply });
      } catch (e) {
        logger.warn(`[AI] could not save memory for ${ctx.channelId}: ${e.message}`, { category: 'ai' });
      }
    }
    return reply;
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('429') || /quota/i.test(msg)) {
      logger.warn(`[AI] provider quota exhausted: ${msg.slice(0, 120)}`, { category: 'ai' });
      return "My AI provider is rate-limited right now — try again shortly.";
    }
    logger.error(`[AI] failed for ${message.author.id} in ${message.guild.id}: ${msg.slice(0, 200)}`, { category: 'ai' });
    return null;
  }
}

export default {
  handleMention, getConfig, setEnabled, isConfigured,
  setMemorySettings, clearMemory, countMemory, getPersona, setPersona, clearPersona, listPersonas,
};
