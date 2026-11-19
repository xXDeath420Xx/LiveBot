/**
 * Weekly Recap — per-server digest of the last 7 days.
 *
 * Posts a single embed to the configured channel:
 *   - total messages + daily average
 *   - active members (sent >= 1 message in the window)
 *   - new members (guildMemberAdd events in the window)
 *   - top 5 channels by message volume
 *   - top 5 members by message volume
 *   - moderation summary (infractions logged, bans / kicks / timeouts)
 *   - stream highlights (count of unique streamers who went live)
 *
 * All data sourced from existing tables — no new schema beyond weekly_recap_config.
 * Opt-in per guild via `/weekly-recap enable|disable` (command in commands/admin/weekly-recap.js).
 *
 * Called by jobs/weekly-recap-scheduler.js on a 60-min cron; the scheduler decides which
 * guilds are due and calls `postRecapIfDue(guildId)` for each.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import botManager from './bot-manager.js';

const LOG = '[WeeklyRecap]';

/** Return the UTC Date that marks the start of "this week's recap window" — i.e. 7 days before
 *  the configured post time. For a Monday-9UTC schedule, Monday 09:00 UTC covers Mon-Mon.
 */
function windowStart(config) {
    const now = new Date();
    const start = new Date(now);
    start.setUTCHours(Number(config.hour) || 9, 0, 0, 0);
    // Walk back to the configured day of this week.
    const dayDiff = (now.getUTCDay() - (Number(config.day_of_week) || 1) + 7) % 7;
    start.setUTCDate(now.getUTCDate() - dayDiff);
    // Window is the 7 days ending at `start`.
    const windowFrom = new Date(start);
    windowFrom.setUTCDate(start.getUTCDate() - 7);
    return { windowFrom, scheduledAt: start };
}

/** Build the digest payload for a guild. Returns an EmbedBuilder or null if there's nothing
 *  worth posting (zero activity + zero moderation). */
/** Ask Gemini for a 1–2 sentence human summary of the week's numbers.
 *  Returns null on any failure — the recap just doesn't include the AI field.
 *  Rate: one call per guild per week, no cost concern. */
async function aiRecapSummary(statSnapshot) {
    try {
        const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_KEY;
        if (!key) return null;
        const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
        const prompt = `Write ONE sentence (max 40 words) summarising this Discord server's week in plain English. Be concrete, upbeat, and NEVER make up numbers — only use what's in the data.\n\nDATA (JSON): ${JSON.stringify(statSnapshot).slice(0, 2000)}\n\nSENTENCE:`;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 80 } }),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const body = await res.json();
        const text = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        return text ? text.slice(0, 300) : null;
    } catch { return null; }
}

/**
 * A recap count that could not be read is logged and shown as 0 (the recap still posts). Before
 * 2026-11-18 these queries named columns the tables do not have and the errors were swallowed, so
 * new members and moderation were always 0 (register H-301).
 */
function countFailed(what, guildId, fallback) {
    return (e) => {
        logger.warn(`[WeeklyRecap] ${what} count failed for guild ${guildId}: ${e.message}`);
        return [[fallback]];
    };
}

/** Infraction types the Moderation line counts (infractions.type; timeouts are recorded as Mute). */
const AUTOMATIC_INFRACTIONS = ['AdaptiveSpam', 'AntiSpam', 'SelfbotDetection', 'RaidDetection'];

export async function buildRecap(guildId, windowFrom, scheduledAt) {
    const fromStr = windowFrom.toISOString().slice(0, 10);
    const toStr = scheduledAt.toISOString().slice(0, 10);

    const [[totals]] = await pool.execute(
        `SELECT SUM(message_count) AS messages,
                COUNT(DISTINCT user_id) AS active_members
           FROM message_stats
          WHERE guild_id = ? AND stat_date >= ?`,
        [String(guildId), fromStr]);
    const totalMessages = Number(totals?.messages) || 0;
    const activeMembers = Number(totals?.active_members) || 0;
    const dailyAvg = Math.round(totalMessages / 7);

    // Every join is recorded in member_join_history (events/guildMemberAdd.js, core/join-history.js),
    // whatever the server's logging settings. Someone who left and came back counts once; bots do not count.
    const [[newMemberRow]] = await pool.execute(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM member_join_history
          WHERE guild_id = ? AND joined_at >= ? AND COALESCE(was_bot_user, 0) = 0`,
        [String(guildId), windowFrom]).catch(countFailed('new member', guildId, { cnt: 0 }));
    const newMembers = Number(newMemberRow?.cnt) || 0;

    const [topChannels] = await pool.execute(
        `SELECT channel_id, SUM(message_count) AS c FROM message_stats
          WHERE guild_id = ? AND stat_date >= ?
          GROUP BY channel_id ORDER BY c DESC LIMIT 5`,
        [String(guildId), fromStr]);
    const [topMembers] = await pool.execute(
        `SELECT user_id, SUM(message_count) AS c FROM message_stats
          WHERE guild_id = ? AND stat_date >= ?
          GROUP BY user_id ORDER BY c DESC LIMIT 5`,
        [String(guildId), fromStr]);

    // infractions.type is Ban / Kick / Mute (a timeout) / Warn for moderator actions; automod and
    // anti-raid entries are counted separately so B/K/T/W add up to the total.
    const [[modCounts]] = await pool.execute(
        `SELECT SUM(type IN ('Ban', 'Kick', 'Mute', 'Warn')) AS total,
                SUM(type = 'Ban') AS bans,
                SUM(type = 'Kick') AS kicks,
                SUM(type = 'Mute') AS timeouts,
                SUM(type = 'Warn') AS warns,
                SUM(type IN (${AUTOMATIC_INFRACTIONS.map(() => '?').join(', ')})) AS automatic
           FROM infractions WHERE guild_id = ? AND created_at >= ?`,
        [...AUTOMATIC_INFRACTIONS, String(guildId), windowFrom])
        .catch(countFailed('moderation', guildId, { total: 0, bans: 0, kicks: 0, timeouts: 0, warns: 0, automatic: 0 }));

    const [[streamRow]] = await pool.execute(
        `SELECT COUNT(DISTINCT u.streamer_id) AS unique_streamers,
                COUNT(*) AS sessions
           FROM stream_uptime u
          WHERE u.stream_start >= ?
            AND EXISTS (SELECT 1 FROM subscriptions s
                         WHERE s.streamer_id = u.streamer_id AND s.guild_id = ? AND s.departed_at IS NULL)`,
        [windowFrom, String(guildId)]).catch((e) => { logger.warn(`[WeeklyRecap] stream count failed: ${e.message}`); return [[{ unique_streamers: 0, sessions: 0 }]]; });

    // Nothing to say? Skip rather than spam a dead-air embed.
    if (totalMessages === 0 && newMembers === 0 && !Number(modCounts?.total) && !Number(modCounts?.automatic) && !Number(streamRow?.sessions)) {
        return null;
    }

    const fmt = n => { try { return new Intl.NumberFormat('en-US').format(Number(n) || 0); } catch { return String(n); } };
    const channelList = topChannels.map((r, i) => `${i + 1}. <#${r.channel_id}> — ${fmt(r.c)}`).join('\n') || '—';
    const memberList  = topMembers.map((r, i) => `${i + 1}. <@${r.user_id}> — ${fmt(r.c)}`).join('\n') || '—';

    const automaticLine = Number(modCounts?.automatic) > 0 ? ` · ${fmt(modCounts.automatic)} by automod` : '';
    const modTotal = Number(modCounts?.total) || 0;
    const modSummary = modTotal > 0
        ? `${fmt(modTotal)} action${modTotal === 1 ? '' : 's'} — ${fmt(modCounts.bans)}B / ${fmt(modCounts.kicks)}K / ${fmt(modCounts.timeouts)}T / ${fmt(modCounts.warns)}W${automaticLine}`
        : (automaticLine ? `No moderator actions${automaticLine}` : 'No moderation actions — quiet week');
    const streamSummary = Number(streamRow?.sessions) > 0
        ? `${fmt(streamRow.unique_streamers)} streamer(s) · ${fmt(streamRow.sessions)} session(s)`
        : 'No streams tracked';

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Weekly recap')
        .setDescription(`Activity from **${fromStr}** to **${toStr}** (UTC).`)
        .addFields(
            { name: 'Messages',       value: `${fmt(totalMessages)} total · ${fmt(dailyAvg)}/day`, inline: true },
            { name: 'Active members', value: fmt(activeMembers), inline: true },
            { name: 'New members',    value: fmt(newMembers), inline: true },
            { name: 'Top channels',   value: channelList, inline: false },
            { name: 'Top members',    value: memberList, inline: false },
            { name: 'Moderation',     value: modSummary, inline: false },
            { name: 'Streams',        value: streamSummary, inline: false },
        )
        .setFooter({ text: 'CertiFried Weekly Recap' })
        .setTimestamp();

    // AI summary field (P3.6). Best-effort: silently omitted on any failure, including
    // Gemini being unavailable or GOOGLE_API_KEY unset. Reuses the same numbers the
    // numeric fields are built from so the sentence cannot drift from what the embed shows.
    try {
        const snapshot = {
            window: { from: fromStr, to: toStr },
            messages: totalMessages, daily_avg: dailyAvg,
            active_members: activeMembers, new_members: newMembers,
            top_channel_counts: topChannels.map(r => Number(r.c)),
            top_member_counts: topMembers.map(r => Number(r.c)),
            moderation: { total: Number(modCounts?.total || 0), bans: Number(modCounts?.bans || 0), kicks: Number(modCounts?.kicks || 0), timeouts: Number(modCounts?.timeouts || 0), warns: Number(modCounts?.warns || 0), automod: Number(modCounts?.automatic || 0) },
            streams: { unique: Number(streamRow?.unique_streamers || 0), sessions: Number(streamRow?.sessions || 0) },
        };
        const ai = await aiRecapSummary(snapshot);
        if (ai) embed.addFields({ name: 'The week in one sentence', value: ai, inline: false });
    } catch { /* non-fatal */ }

    return embed;
}

/** Decide if `guildId` is due for a recap and post one if so. Marks last_posted_at on success
 *  so the next scheduler tick doesn't double-post.
 */
export async function postRecapIfDue(guildId) {
    const [rows] = await pool.execute(
        `SELECT guild_id, channel_id, enabled, day_of_week, hour, last_posted_at
           FROM weekly_recap_config WHERE guild_id = ? AND enabled = 1`,
        [String(guildId)]);
    if (!rows.length) return { posted: false, reason: 'not_configured' };
    const cfg = rows[0];

    const { windowFrom, scheduledAt } = windowStart(cfg);
    const now = new Date();
    // Due = we're at or past this week's scheduled time AND haven't posted since the window start.
    if (now < scheduledAt) return { posted: false, reason: 'not_yet' };
    if (cfg.last_posted_at && new Date(cfg.last_posted_at) >= scheduledAt) {
        return { posted: false, reason: 'already_posted_this_week' };
    }

    const client = botManager.getClientForGuild(cfg.guild_id);
    if (!client) return { posted: false, reason: 'no_client' };
    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return { posted: false, reason: 'channel_unreachable' };

    const embed = await buildRecap(cfg.guild_id, windowFrom, scheduledAt);
    if (!embed) {
        // Still mark posted — nothing worth saying this week; don't re-check every hour.
        await pool.execute(
            `UPDATE weekly_recap_config SET last_posted_at = ? WHERE guild_id = ?`,
            [scheduledAt, cfg.guild_id]).catch(() => {});
        return { posted: false, reason: 'nothing_to_say' };
    }

    try {
        await channel.send({ embeds: [embed] });
        await pool.execute(
            `UPDATE weekly_recap_config SET last_posted_at = ? WHERE guild_id = ?`,
            [scheduledAt, cfg.guild_id]);
        logger.info(`${LOG} posted recap in ${cfg.guild_id} → ${cfg.channel_id}`);
        return { posted: true };
    } catch (err) {
        logger.warn(`${LOG} post failed`, { guildId: cfg.guild_id, err: err.message });
        return { posted: false, reason: 'send_failed', error: err.message };
    }
}

/** Called by the scheduler every hour. Walks all enabled guild configs. */
export async function runRecapCycle() {
    try {
        const [rows] = await pool.execute(
            `SELECT guild_id FROM weekly_recap_config WHERE enabled = 1`);
        if (!rows.length) return;
        logger.info(`${LOG} cycle: ${rows.length} enabled guild(s)`);
        for (const r of rows) {
            await postRecapIfDue(r.guild_id).catch(err =>
                logger.warn(`${LOG} postRecapIfDue failed for ${r.guild_id}`, { err: err.message }));
        }
    } catch (err) {
        logger.error(`${LOG} runRecapCycle failed`, { err: err.message });
    }
}

export default { postRecapIfDue, runRecapCycle };
