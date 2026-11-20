/*
 * Stream bot timers: the existing Kick timed messages (tokes_timers, jobs/kick-timer-scheduler.js) extended, not
 * copied (migration 456). One table and one minute job serve both kinds of timer:
 *
 *   Kick channel page timers   channel_id → tokes_channels (Kick), as before; they post on that channel
 *   stream bot timers          profile_id → stream_bot_profiles; they post on the profile's linked Twitch and/or Kick channels,
 *                              and on YouTube when the streamer picks it (platforms 'youtube' or 'everywhere'; design §13.10)
 *
 * New options for both: more than one message (rotate or random), "only while live", "only after N chat lines
 * since the last post", running a stream bot automation instead of a message (stream bot timers only), and the
 * stream bot template variables ({stream.title}, {stream.uptime}, {random:1-6}, {sdb:get:deaths} ...). The old
 * {{channel_name}} keeps working. Twitch messages are sent by the CertiFried bot account (as the chat action does);
 * Kick messages through the Kick Defender sign-in (sendChannelMessage).
 *
 *   noteChatLine / chatLinesSince / resetChatLines   per-channel chat line counts (ingest counts every viewer line;
 *                                                    memory only, so a restart starts every count at 0)
 *   validateTimer(body, ctx)                         → { ok, errors[], value }  (dashboard saves)
 *   pickMessage(timer, rng)                          → { text, index, nextIndex }
 *   fireTimer(timer, deps)                           → { sent, detail, nextIndex }  (one due timer; deps are injected)
 *   createTimerStore({ db, table?, channelsTable? }) SQL for the Timers page and the job
 *
 * Tested in tests/stream-bot-timers.test.js.
 */
import { renderTemplate } from '../custom-command-vars.js';
import { streamValues } from './stream-info.js';

export const TIMER_LIMITS = Object.freeze({ perProfile: 50, messages: 10, messageMax: 500, intervalMin: 1, intervalMax: 1440, linesMax: 1000, nameMax: 100 });
/**
 * Where a stream bot timer posts. 'all' stays Twitch and Kick (timers made before YouTube existed must not start spending
 * YouTube quota); 'youtube' and 'everywhere' (Twitch, Kick and YouTube) need YouTube set up on the server (youtube/config.js).
 */
export const TIMER_PLATFORMS = Object.freeze(['twitch', 'kick', 'all', 'youtube', 'everywhere']);
export const TIMER_WHERE = Object.freeze({ all: 'Twitch and Kick', twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', everywhere: 'Twitch, Kick and YouTube' });
const PLATFORM_NAME = Object.freeze({ twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' });
/** Quota guard levels (youtube/quota.js) at which timers stop posting on YouTube: reading chat matters more than a timed message. */
export const YOUTUBE_TIMER_HOLD = Object.freeze(['critical', 'exhausted']);

/**
 * The linked channels a stream bot timer posts in.
 * @param {string|null} platforms  the timer's platforms column
 * @param {object[]} channels       stream_bot_channels rows ({ platform, platform_user_id, login })
 * @param {object} opts             { youtube: YouTube is set up, youtubeLevel: the quota guard's level now }
 */
export function timerTargets(platforms, channels, { youtube = false, youtubeLevel = 'normal' } = {}) {
    const p = platforms || 'all';
    const wanted = (c) => {
        if (c.platform === 'youtube') return !!youtube && (p === 'youtube' || p === 'everywhere') && !YOUTUBE_TIMER_HOLD.includes(youtubeLevel);
        if (c.platform !== 'twitch' && c.platform !== 'kick') return false;
        return p === 'all' || p === 'everywhere' || p === c.platform;
    };
    return (channels || []).filter(wanted).map((c) => ({ platform: c.platform, channelId: String(c.platform_user_id), login: c.login || '' }));
}

// ── chat line counts ─────────────────────────────────────────────────────────────────────────

const lineCounts = new Map();   // 'platform:channelId' -> lines since the last timer post there

export function noteChatLine(platform, channelId) {
    const k = `${platform}:${channelId}`;
    lineCounts.set(k, Math.min(1_000_000, (lineCounts.get(k) || 0) + 1));
    if (lineCounts.size > 50_000) lineCounts.clear();
}
export const chatLinesSince = (platform, channelId) => lineCounts.get(`${platform}:${channelId}`) || 0;
export function resetChatLines(platform, channelId) { lineCounts.set(`${platform}:${channelId}`, 0); }
export function _resetAllChatLines() { lineCounts.clear(); }

// ── validation ───────────────────────────────────────────────────────────────────────────────

const int = (v, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/**
 * @param {object} b    the form body
 * @param {object} ctx  { automationIds: Set<number>, kickPage: boolean (a Kick channel page timer: no platforms, no automation),
 *                       linkedPlatforms: string[], youtube: boolean (YouTube is set up on this server) }
 */
export function validateTimer(b = {}, ctx = {}) {
    const errors = [];
    const kickPage = !!ctx.kickPage;
    const name = String(b.name ?? '').trim().slice(0, TIMER_LIMITS.nameMax);
    const raw = Array.isArray(b.messages) ? b.messages : String(b.messages ?? '').split(/\r?\n/);
    const messages = raw.map((m) => String(m ?? '').trim()).filter(Boolean);
    if (messages.some((m) => m.length > TIMER_LIMITS.messageMax)) errors.push(`Each message can be at most ${TIMER_LIMITS.messageMax} characters.`);
    if (messages.length > TIMER_LIMITS.messages) errors.push(`At most ${TIMER_LIMITS.messages} messages.`);
    let automationId = null;
    if (!kickPage && b.automationId !== undefined && b.automationId !== null && b.automationId !== '') {
        automationId = int(b.automationId, 1, Number.MAX_SAFE_INTEGER);
        if (!automationId || (ctx.automationIds && !ctx.automationIds.has(automationId))) { errors.push('Pick one of your automations.'); automationId = null; }
    }
    if (!messages.length && !automationId) errors.push(kickPage ? 'Enter a message.' : 'Enter a message, or pick an automation to run.');
    const interval = int(b.intervalMin, TIMER_LIMITS.intervalMin, TIMER_LIMITS.intervalMax);
    if (interval == null) errors.push(`The interval is ${TIMER_LIMITS.intervalMin} to ${TIMER_LIMITS.intervalMax} minutes, in whole minutes.`);
    const lines = b.minChatLines === '' || b.minChatLines == null ? 0 : int(b.minChatLines, 0, TIMER_LIMITS.linesMax);
    if (lines == null) errors.push(`Chat lines is a whole number from 0 to ${TIMER_LIMITS.linesMax}.`);
    const platforms = kickPage ? null : (TIMER_PLATFORMS.includes(b.platforms) ? b.platforms : 'all');
    const onYouTube = platforms === 'youtube' || platforms === 'everywhere';
    if (!kickPage && onYouTube && !ctx.youtube) errors.push('YouTube is not set up on this server yet, so timers cannot post there.');
    else if (!kickPage && ctx.linkedPlatforms) {
        const need = platforms === 'all' ? [] : platforms === 'everywhere' ? ['youtube'] : [platforms];
        for (const p of need) if (!ctx.linkedPlatforms.includes(p)) errors.push(`Link a ${PLATFORM_NAME[p]} channel first (Connections).`);
    }
    const value = {
        name: name || null,
        message: messages[0] ? messages[0].slice(0, TIMER_LIMITS.messageMax) : '',
        extraMessages: messages.slice(1, TIMER_LIMITS.messages).map((m) => m.slice(0, TIMER_LIMITS.messageMax)),
        rotation: b.rotation === 'random' ? 'random' : 'rotate',
        intervalMin: interval ?? 30,
        onlyLive: !!b.onlyLive && b.onlyLive !== 'false',
        minChatLines: lines ?? 0,
        automationId,
        platforms,
        enabled: b.enabled === undefined ? true : !!b.enabled && b.enabled !== 'false',
    };
    return { ok: !errors.length, errors: [...new Set(errors)], value };
}

// ── one timer ─────────────────────────────────────────────────────────────────────────────────

const parseList = (v) => {
    if (Array.isArray(v)) return v;
    if (v == null || v === '') return [];
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
};

/** All of a timer's messages, in order: `message` first, then extra_messages. */
export function timerMessages(t) {
    return [t.message, ...parseList(t.extra_messages)].map((m) => String(m ?? '').trim()).filter(Boolean);
}

export function pickMessage(t, rng = Math.random) {
    const list = timerMessages(t);
    if (!list.length) return { text: '', index: -1, nextIndex: 0 };
    if (t.rotation === 'random') {
        const index = Math.min(list.length - 1, Math.floor(rng() * list.length));
        return { text: list[index], index, nextIndex: Number(t.next_index) || 0 };
    }
    const index = Math.abs(Number(t.next_index) || 0) % list.length;
    return { text: list[index], index, nextIndex: (index + 1) % list.length };
}

/** {{channel_name}} (the Kick page's old form) as {channel.name}. */
export const legacyTokens = (text) => String(text ?? '').replace(/\{\{channel_name\}\}/gi, '{channel.name}');

/** Text for a timer without a stream bot profile (Kick channel page): channel name, stream info, random and choice. */
export async function renderPlain(text, { channelName = '', info = null } = {}) {
    const values = { 'channel.name': channelName, 'channel.mention': channelName, ...streamValues(info) };
    const extraVars = new Set(['channel.name', 'channel.mention', 'stream.title', 'stream.category', 'stream.uptime', 'stream.viewers', 'stream.live']);
    const { text: out } = await renderTemplate(legacyTokens(text), { values, args: [] }, null, null, { extraVars });
    return out;
}

/**
 * Fire one due timer.
 * @param {object} t     the tokes_timers row (+ joined kick channel for Kick page timers)
 * @param {object} deps  {
 *     targets: [{ platform, channelId, login }],                    where it may post
 *     streamInfo(platform, channelId) → { live, ... } | null,        only while live (and {stream.*})
 *     render(text, target, info) → Promise<string>,
 *     send({ platform, channelId, login, text }) → Promise<boolean>,
 *     runAutomation(target) → Promise<{ status }>,                   when the timer runs an automation
 *     rng?, linesSince?, resetLines? }
 */
export async function fireTimer(t, deps) {
    const linesSince = deps.linesSince || chatLinesSince;
    const resetLines = deps.resetLines || resetChatLines;
    const notes = [];
    const eligible = [];
    for (const target of deps.targets || []) {
        let info = null;
        if (Number(t.only_live)) {
            info = await deps.streamInfo(target.platform, target.channelId).catch(() => null);
            if (!info?.live) { notes.push(`${target.platform}: not live`); continue; }
        }
        const need = Number(t.min_chat_lines) || 0;
        if (need > 0 && linesSince(target.platform, target.channelId) < need) {
            notes.push(`${target.platform}: ${linesSince(target.platform, target.channelId)} of ${need} chat lines`);
            continue;
        }
        eligible.push({ target, info });
    }
    if (!eligible.length) return { sent: false, detail: notes.join('; ') || 'no channel to post in', nextIndex: Number(t.next_index) || 0 };

    if (t.automation_id) {
        const { target } = eligible[0];
        const r = await deps.runAutomation(target).catch((err) => ({ status: 'failed', error: err?.message }));
        const ok = r && ['ok', 'partial', 'running'].includes(r.status);
        if (ok) for (const e of eligible) resetLines(e.target.platform, e.target.channelId);
        return { sent: !!ok, detail: `automation ${t.automation_id}: ${r?.status || 'failed'}`, nextIndex: Number(t.next_index) || 0 };
    }

    const pick = pickMessage(t, deps.rng || Math.random);
    if (!pick.text) return { sent: false, detail: 'no message', nextIndex: pick.nextIndex };
    let sent = false;
    for (const { target, info } of eligible) {
        let text = '';
        try { text = String(await deps.render(pick.text, target, info)).trim(); } catch { text = ''; }
        if (!text) { notes.push(`${target.platform}: the message came out empty`); continue; }
        const ok = await deps.send({ ...target, text: text.slice(0, 500) }).catch(() => false);
        if (ok) { sent = true; resetLines(target.platform, target.channelId); notes.push(`${target.platform}: sent`); }
        else notes.push(`${target.platform}: not sent`);
    }
    return { sent, detail: notes.join('; '), nextIndex: sent ? pick.nextIndex : Number(t.next_index) || 0 };
}

// ── SQL ───────────────────────────────────────────────────────────────────────────────────────

const COLS = `t.id, t.channel_id, t.profile_id, t.name, t.message, t.extra_messages, t.rotation, t.next_index, t.interval_min, t.is_enabled,
    t.only_live, t.min_chat_lines, t.automation_id, t.platforms, t.last_sent_at, t.send_count, t.created_at`;

export function timerView(r) {
    return {
        id: Number(r.id), kind: r.profile_id ? 'stream_bot' : 'kick_page', name: r.name || null, messages: timerMessages(r),
        rotation: r.rotation === 'random' ? 'random' : 'rotate', intervalMin: Number(r.interval_min), enabled: !!Number(r.is_enabled),
        onlyLive: !!Number(r.only_live), minChatLines: Number(r.min_chat_lines) || 0, automationId: r.automation_id == null ? null : Number(r.automation_id),
        platforms: r.platforms || (r.profile_id ? 'all' : 'kick'), channelName: r.channel_name || null,
        lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null, sendCount: Number(r.send_count) || 0,
    };
}

export function createTimerStore({ db, table = 'tokes_timers', channelsTable = 'tokes_channels' } = {}) {
    if (!/^[a-z0-9_]{1,64}$/.test(table) || !/^[a-z0-9_]{1,64}$/.test(channelsTable)) throw new Error('bad table name');
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const T = `\`${table}\``;
    const C = `\`${channelsTable}\``;

    /** Kick channel page rows (tokes_channels ids) for the profile's linked Kick channels. */
    async function kickPageChannels(kickIds) {
        if (!kickIds?.length) return [];
        return q(`SELECT id, channel_id, channel_name FROM ${C} WHERE platform = 'kick' AND channel_id IN (?)`, [kickIds.map(String)]);
    }

    return {
        kickPageChannels,
        async listForProfile(profileId, kickIds = []) {
            const own = await q(`SELECT ${COLS} FROM ${T} t WHERE t.profile_id = ? ORDER BY t.id`, [profileId]);
            const pages = await kickPageChannels(kickIds);
            const kick = pages.length
                ? await q(`SELECT ${COLS}, c.channel_name FROM ${T} t JOIN ${C} c ON c.id = t.channel_id WHERE t.profile_id IS NULL AND t.channel_id IN (?) ORDER BY t.id`, [pages.map((p) => p.id)])
                : [];
            return { own, kick };
        },
        async countForProfile(profileId) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T} WHERE profile_id = ?`, [profileId]))[0].n);
        },
        /** One timer the profile may edit: its own, or a Kick page timer on one of its linked Kick channels. */
        async getForProfile(profileId, id, kickIds = []) {
            const r = (await q(`SELECT ${COLS}, c.platform AS c_platform, c.channel_id AS c_channel_id, c.channel_name FROM ${T} t LEFT JOIN ${C} c ON c.id = t.channel_id WHERE t.id = ?`, [id]))[0];
            if (!r) return null;
            if (r.profile_id != null) return Number(r.profile_id) === Number(profileId) ? r : null;
            return r.c_platform === 'kick' && kickIds.map(String).includes(String(r.c_channel_id)) ? r : null;
        },
        async create(profileId, v, createdBy = null) {
            const r = await q(`INSERT INTO ${T} (channel_id, profile_id, name, message, extra_messages, rotation, interval_min, is_enabled, only_live, min_chat_lines, automation_id, platforms, created_by)
                               VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [profileId, v.name, v.message, JSON.stringify(v.extraMessages || []), v.rotation, v.intervalMin, v.enabled ? 1 : 0, v.onlyLive ? 1 : 0,
                    v.minChatLines, v.automationId, v.platforms || 'all', createdBy ? String(createdBy).slice(0, 64) : null]);
            return Number(r.insertId);
        },
        /** Update (the caller checked ownership). Kick page timers keep their channel and get no automation or platforms. */
        async update(id, v, { kickPage = false } = {}) {
            await q(`UPDATE ${T} SET name = ?, message = ?, extra_messages = ?, rotation = ?, next_index = 0, interval_min = ?, is_enabled = ?, only_live = ?, min_chat_lines = ?,
                     automation_id = ?, platforms = ? WHERE id = ?`,
                [v.name, v.message, JSON.stringify(v.extraMessages || []), v.rotation, v.intervalMin, v.enabled ? 1 : 0, v.onlyLive ? 1 : 0, v.minChatLines,
                    kickPage ? null : v.automationId, kickPage ? null : (v.platforms || 'all'), id]);
        },
        async setEnabled(id, enabled) { await q(`UPDATE ${T} SET is_enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]); },
        async remove(id) { return (await q(`DELETE FROM ${T} WHERE id = ?`, [id])).affectedRows > 0; },

        /** Every due timer: Kick page timers on an enrolled Kick channel (as before), and every stream bot timer. */
        async due() {
            return q(`SELECT ${COLS}, c.channel_id AS kick_channel_id, c.channel_name
                      FROM ${T} t LEFT JOIN ${C} c ON c.id = t.channel_id
                      WHERE t.is_enabled = 1
                        AND (t.last_sent_at IS NULL OR t.last_sent_at <= (NOW() - INTERVAL t.interval_min MINUTE))
                        AND ((t.profile_id IS NULL AND c.platform = 'kick' AND c.is_enabled = 1 AND c.defender_enabled = 1) OR t.profile_id IS NOT NULL)
                      ORDER BY t.id LIMIT 500`);
        },
        async markSent(id, nextIndex) {
            await q(`UPDATE ${T} SET last_sent_at = NOW(), send_count = send_count + 1, next_index = ? WHERE id = ?`, [Number(nextIndex) || 0, id]);
        },
        /** /privacy export: the profile's own timers. */
        async exportProfile(profileId) {
            return (await q(`SELECT ${COLS} FROM ${T} t WHERE t.profile_id = ?`, [profileId])).map(timerView);
        },
        async deleteProfile(profileId) {
            return (await q(`DELETE FROM ${T} WHERE profile_id = ?`, [profileId])).affectedRows;
        },
    };
}

export default { TIMER_LIMITS, TIMER_PLATFORMS, TIMER_WHERE, YOUTUBE_TIMER_HOLD, timerTargets, noteChatLine, chatLinesSince, resetChatLines, validateTimer, timerMessages, pickMessage, fireTimer, renderPlain, legacyTokens, timerView, createTimerStore };
