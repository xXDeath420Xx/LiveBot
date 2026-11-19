/*
 * Member activity — when each member last posted and last joined voice, per server (table
 * member_activity, migration 332). The inactivity prune (core/inactivity-prune.js) reads it; the activity
 * audit's live re-check (core/activity-audit-actions.js) consults it too.
 *
 * Why its own table: the activity the bot already keeps cannot answer "when was this member last here"
 * for a year back. activity_logs is purged after 180 days (data_retention_policy) and only writes voice
 * when a session ENDS; message_stats is per channel per day (analytics, owned by core/server-stats-manager.js)
 * and voice_activity is per finished session; user_levels only moves when XP is awarded (leveling servers,
 * cooldown, monthly resets) and its timestamp is ON UPDATE. Migration 332 backfills this table from
 * message_stats, voice_activity and activity_logs, so the history those kept is not lost.
 *
 *   write   noteMessage / noteVoiceJoin (events/messageCreate.js, events/voiceStateUpdate.js) only touch an
 *           in-memory map; flushActivity() writes it in batches every 60 s (started by the reaper,
 *           jobs/temp-access-reaper.js) and on shutdown. A busy channel costs one upsert per member per
 *           minute, never one per message.
 *   read    activityFor(guildId) — every row for a server, with anything not yet flushed merged in.
 *   since   trackingSince(guild) — when tracking began for the server (guilds.activity_tracked_since,
 *           back-dated by the migration; set to now the first time it is missing). Nobody is judged on
 *           time before it.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const FLUSH_MS = 60_000;
const MAX_PENDING = 50_000;     // early flush past this many members
const CHUNK = 500;

/** `${guildId}:${userId}` -> { g, u, msg: ms|null, voice: ms|null, mc, mm, vc } (channel / message ids of the latest of each) */
const pending = new Map();
let timer = null;
let flushing = null;

function note(guildId, userId, kind, at = Date.now(), channelId = null, messageId = null) {
    if (!guildId || !userId) return;
    const k = `${guildId}:${userId}`;
    let e = pending.get(k);
    if (!e) {
        if (pending.size >= MAX_PENDING) void flushActivity();
        e = { g: String(guildId), u: String(userId), msg: null, voice: null, mc: null, mm: null, vc: null };
        pending.set(k, e);
    }
    if (kind === 'voice') {
        if (at >= (e.voice ?? 0)) { e.voice = at; e.vc = channelId ? String(channelId) : null; }
    } else if (at >= (e.msg ?? 0)) {
        e.msg = at; e.mc = channelId ? String(channelId) : null; e.mm = messageId ? String(messageId) : null;
    }
}

/** A member posted in a server. Cheap: memory only. */
export function noteMessage(guildId, userId, channelId = null, messageId = null) { note(guildId, userId, 'message', Date.now(), channelId, messageId); }

/** A member joined (or moved into) a voice channel. Cheap: memory only. */
export function noteVoiceJoin(guildId, userId, channelId = null) { note(guildId, userId, 'voice', Date.now(), channelId); }

const asDate = (v) => (v == null ? null : new Date(v));

/** The ON DUPLICATE clause: keep the later of the stored and the new time; first activity never moves. */
export const UPSERT_SQL = `INSERT INTO member_activity (guild_id, user_id, first_active_at, last_message_at, last_voice_at,
       last_message_channel_id, last_message_id, last_voice_channel_id) VALUES ?
     ON DUPLICATE KEY UPDATE
       last_message_channel_id = IF(VALUES(last_message_at) IS NOT NULL AND (last_message_at IS NULL OR VALUES(last_message_at) >= last_message_at),
                                    VALUES(last_message_channel_id), last_message_channel_id),
       last_message_id = IF(VALUES(last_message_at) IS NOT NULL AND (last_message_at IS NULL OR VALUES(last_message_at) >= last_message_at),
                            VALUES(last_message_id), last_message_id),
       last_voice_channel_id = IF(VALUES(last_voice_at) IS NOT NULL AND (last_voice_at IS NULL OR VALUES(last_voice_at) >= last_voice_at),
                                  VALUES(last_voice_channel_id), last_voice_channel_id),
       first_active_at = COALESCE(first_active_at, VALUES(first_active_at)),
       last_message_at = IF(VALUES(last_message_at) IS NULL, last_message_at,
                            GREATEST(COALESCE(last_message_at, VALUES(last_message_at)), VALUES(last_message_at))),
       last_voice_at   = IF(VALUES(last_voice_at) IS NULL, last_voice_at,
                            GREATEST(COALESCE(last_voice_at, VALUES(last_voice_at)), VALUES(last_voice_at)))`;

/** Pending entries as upsert rows. */
export function toRows(entries) {
    return entries.map(e => {
        const first = Math.min(...[e.msg, e.voice].filter(Number.isFinite));
        return [e.g, e.u, asDate(first), asDate(e.msg), asDate(e.voice), e.mc ?? null, e.mm ?? null, e.vc ?? null];
    });
}

/** Write everything noted so far. Safe to call any time; concurrent calls share one flush. */
export async function flushActivity() {
    if (flushing) return flushing;
    if (!pending.size) return;
    const entries = [...pending.values()];
    pending.clear();
    flushing = (async () => {
        for (let i = 0; i < entries.length; i += CHUNK) {
            const part = entries.slice(i, i + CHUNK);
            try {
                await pool.query(UPSERT_SQL, [toRows(part)]);
            } catch (err) {
                if (err?.code === 'ER_NO_SUCH_TABLE') return;   // migration 332 not applied yet
                logger.error(`[MemberActivity] flush failed (${part.length} members, kept for the next flush): ${err.message}`);
                // Put them back (merged with anything newer) rather than lose the activity.
                for (const e of part) {
                    const k = `${e.g}:${e.u}`;
                    const cur = pending.get(k);
                    if (!cur) pending.set(k, e);
                    else {
                        if ((e.msg ?? 0) > (cur.msg ?? 0)) { cur.msg = e.msg; cur.mc = e.mc; cur.mm = e.mm; }
                        if ((e.voice ?? 0) > (cur.voice ?? 0)) { cur.voice = e.voice; cur.vc = e.vc; }
                    }
                }
            }
        }
    })().finally(() => { flushing = null; });
    return flushing;
}

export function startActivityFlush() {
    if (timer) return;
    timer = setInterval(() => { flushActivity().catch(() => {}); }, FLUSH_MS);
    timer.unref?.();
}

/** Stop the timer and write what is left (shutdown). */
export async function stopActivityFlush() {
    if (timer) { clearInterval(timer); timer = null; }
    await flushActivity().catch(() => {});
}

const toMs = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : Date.parse(v)) || null);

/**
 * Every member_activity row for a server, as a Map userId -> { firstActiveMs, lastMessageMs, lastVoiceMs,
 * warnedAtMs, loggedAtMs }, with unflushed activity merged in.
 */
export async function activityFor(guildId) {
    const map = new Map();
    const [rows] = await pool.execute(
        `SELECT user_id, first_active_at, last_message_at, last_voice_at, inactivity_warned_at, inactivity_logged_at
           FROM member_activity WHERE guild_id = ?`, [String(guildId)]);
    for (const r of rows) {
        map.set(String(r.user_id), {
            firstActiveMs: toMs(r.first_active_at), lastMessageMs: toMs(r.last_message_at), lastVoiceMs: toMs(r.last_voice_at),
            warnedAtMs: toMs(r.inactivity_warned_at), loggedAtMs: toMs(r.inactivity_logged_at),
        });
    }
    const prefix = `${guildId}:`;
    for (const [k, e] of pending) {
        if (!k.startsWith(prefix)) continue;
        const cur = map.get(e.u) || { firstActiveMs: null, lastMessageMs: null, lastVoiceMs: null, warnedAtMs: null, loggedAtMs: null };
        if (e.msg) cur.lastMessageMs = Math.max(cur.lastMessageMs ?? 0, e.msg);
        if (e.voice) cur.lastVoiceMs = Math.max(cur.lastVoiceMs ?? 0, e.voice);
        if (cur.firstActiveMs == null) cur.firstActiveMs = Math.min(...[e.msg, e.voice].filter(Boolean));
        map.set(e.u, cur);
    }
    return map;
}

/** One member's row (or null), unflushed activity included. */
export async function activityOf(guildId, userId) {
    const [[r]] = await pool.execute(
        `SELECT first_active_at, last_message_at, last_voice_at, inactivity_warned_at, inactivity_logged_at
           FROM member_activity WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    const e = pending.get(`${guildId}:${userId}`);
    if (!r && !e) return null;
    const out = {
        firstActiveMs: toMs(r?.first_active_at), lastMessageMs: toMs(r?.last_message_at), lastVoiceMs: toMs(r?.last_voice_at),
        warnedAtMs: toMs(r?.inactivity_warned_at), loggedAtMs: toMs(r?.inactivity_logged_at),
    };
    if (e?.msg) out.lastMessageMs = Math.max(out.lastMessageMs ?? 0, e.msg);
    if (e?.voice) out.lastVoiceMs = Math.max(out.lastVoiceMs ?? 0, e.voice);
    return out;
}

/** Members of a server with activity at or after `since` (Date), unflushed included. */
export async function activeSinceIds(guildId, since) {
    const set = new Set();
    const [rows] = await pool.execute(
        `SELECT user_id FROM member_activity WHERE guild_id = ? AND (last_message_at >= ? OR last_voice_at >= ?)`,
        [String(guildId), since, since]);
    for (const r of rows) set.add(String(r.user_id));
    const t = since instanceof Date ? since.getTime() : Date.parse(since);
    const prefix = `${guildId}:`;
    for (const [k, e] of pending) if (k.startsWith(prefix) && Math.max(e.msg ?? 0, e.voice ?? 0) >= t) set.add(e.u);
    return set;
}

/** Record that a member was warned / logged by the inactivity prune (the row is created if missing). */
export async function markInactivity(guildId, userId, what, at = new Date()) {
    const col = what === 'warned' ? 'inactivity_warned_at' : 'inactivity_logged_at';
    await pool.execute(
        `INSERT INTO member_activity (guild_id, user_id, ${col}) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})`, [String(guildId), String(userId), at]);
}

/**
 * When activity tracking began for this server (ms). Missing (a server the bot joined after migration
 * 332) means "from now": it is set to now and returned, so nobody is judged on time before it.
 */
export async function trackingSince(guildId) {
    const [[row]] = await pool.execute('SELECT activity_tracked_since FROM guilds WHERE guild_id = ?', [String(guildId)]);
    const t = toMs(row?.activity_tracked_since);
    if (t) return t;
    const now = new Date();
    await pool.execute(
        `INSERT INTO guilds (guild_id, activity_tracked_since) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE activity_tracked_since = COALESCE(activity_tracked_since, VALUES(activity_tracked_since))`,
        [String(guildId), now]);
    const [[again]] = await pool.execute('SELECT activity_tracked_since FROM guilds WHERE guild_id = ?', [String(guildId)]);
    return toMs(again?.activity_tracked_since) ?? now.getTime();
}

/** For tests: what is waiting to be flushed. */
export const _pending = pending;

export default {
    noteMessage, noteVoiceJoin, flushActivity, startActivityFlush, stopActivityFlush, activityFor, activityOf,
    activeSinceIds, markInactivity, trackingSince, toRows, UPSERT_SQL,
};
