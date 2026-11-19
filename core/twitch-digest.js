/**
 * Weekly Twitch analytics digest. Builds a Discord embed with the last-7d numbers for a
 * broadcaster and sends it to either a configured channel or a DM-ed user. Called by
 * core/twitch-analytics-cron.js on Mondays.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

const LOG = '[TwitchDigest]';

// Collation: alerts_config and role_sync_config may have been created with different
// charsets, so joins across them need COLLATE on the shared column. Expressed as a helper
// so every join in this module reads the same way.
const JOIN_COLLATE = 'COLLATE utf8mb4_unicode_ci';

function clientForGuild(guildId) {
    try { return globalThis.botManager?.getClientForGuild?.(guildId) || null; }
    catch { return null; }
}

/** Build and send the digest for one guild's alert config. Returns true if posted. */
export async function sendDigest(cfg) {
    const client = clientForGuild(cfg.guild_id);
    if (!client) { logger.warn(`${LOG} no client for guild ${cfg.guild_id}`); return false; }
    if (!cfg.broadcaster_id) { logger.warn(`${LOG} no broadcaster for guild ${cfg.guild_id}`); return false; }

    const bid = String(cfg.broadcaster_id);
    const sinceSql = `DATE_SUB(NOW(), INTERVAL 168 HOUR)`;

    // Window stats
    const [[windowAgg]] = await pool.query(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(duration_minutes), 0) AS live_min,
                COALESCE(MAX(peak_viewers), 0) AS peak,
                COALESCE(SUM(total_msgs), 0) AS msgs,
                COALESCE(SUM(total_follows), 0) AS follows,
                COALESCE(SUM(total_subs), 0) AS subs,
                COALESCE(SUM(total_bits), 0) AS bits
           FROM twitch_stream_sessions
          WHERE broadcaster_id = ? AND started_at > ${sinceSql}`, [bid]);

    // Previous 7-day window for delta chips
    const [[prevAgg]] = await pool.query(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(total_follows), 0) AS follows,
                COALESCE(SUM(total_subs), 0) AS subs, COALESCE(SUM(total_bits), 0) AS bits
           FROM twitch_stream_sessions
          WHERE broadcaster_id = ? AND started_at > DATE_SUB(NOW(), INTERVAL 336 HOUR) AND started_at <= DATE_SUB(NOW(), INTERVAL 168 HOUR)`, [bid]);

    // Biggest session this window
    const [[bigSession]] = await pool.query(
        `SELECT started_at, peak_viewers, duration_minutes, title_at_start, primary_category_name
           FROM twitch_stream_sessions WHERE broadcaster_id = ? AND started_at > ${sinceSql}
          ORDER BY peak_viewers DESC LIMIT 1`, [bid]);

    // Top clip this window
    const [[topClip]] = await pool.query(
        `SELECT clip_id, title, view_count, url FROM twitch_clips_catalog
          WHERE broadcaster_id = ? AND created_at_twitch > ${sinceSql}
          ORDER BY view_count DESC LIMIT 1`, [bid]);

    const delta = (now, prev) => prev > 0 ? ((now - prev) / prev * 100) : null;
    const chip = (now, prev) => {
        const d = delta(now, prev);
        if (d === null) return '';
        const sign = d >= 0 ? '↑' : '↓';
        return ` (${sign}${Math.abs(d).toFixed(0)}% WoW)`;
    };

    // Wave 372 Tier AI-2 — generate an AI narrative for the digest body when AI is enabled.
    // Falls back to the plain template line on failure.
    let aiNarrative = null;
    try {
        const { generateWeeklyDigestNarrative } = await import('./twitch-ai.js');
        const r = await generateWeeklyDigestNarrative(bid, windowAgg, prevAgg, bigSession, topClip);
        if (r?.ok && r.narrative) aiNarrative = r.narrative;
    } catch (e) { logger.warn(`${LOG} AI narrative failed: ${e.message}`); }

    const embed = new EmbedBuilder()
        .setTitle(`📊 Weekly digest — ${cfg.login || 'your channel'}`)
        .setColor(0x9146ff)
        .setDescription(aiNarrative || `Last 7 days on **twitch.tv/${cfg.login || 'channel'}**`)
        .addFields(
            { name: 'Sessions', value: `${windowAgg.sessions}${chip(windowAgg.sessions, prevAgg.sessions)}`, inline: true },
            { name: 'Live time', value: `${Math.round(windowAgg.live_min / 60 * 10) / 10}h`, inline: true },
            { name: 'Peak viewers', value: `${windowAgg.peak}`, inline: true },
            { name: 'Chat msgs', value: `${Number(windowAgg.msgs).toLocaleString()}`, inline: true },
            { name: 'Follows', value: `${windowAgg.follows}${chip(windowAgg.follows, prevAgg.follows)}`, inline: true },
            { name: 'Subs', value: `${windowAgg.subs}${chip(windowAgg.subs, prevAgg.subs)}`, inline: true },
        )
        .setTimestamp();

    if (bigSession) {
        embed.addFields({
            name: '🔥 Biggest stream',
            value: `${new Date(bigSession.started_at).toLocaleDateString()} · peak ${bigSession.peak_viewers} · ${Math.floor((bigSession.duration_minutes || 0) / 60)}h ${bigSession.duration_minutes % 60}m${bigSession.title_at_start ? '\n*' + bigSession.title_at_start.slice(0, 100) + '*' : ''}`,
        });
    }
    if (topClip) {
        embed.addFields({
            name: '🎬 Top clip',
            value: `[${(topClip.title || 'Clip').slice(0, 60)}](${topClip.url}) · ${topClip.view_count.toLocaleString()} views`,
        });
    }

    // Send to channel if configured, else DM the configured user
    try {
        if (cfg.alert_channel_id) {
            const ch = await client.channels.fetch(cfg.alert_channel_id).catch(() => null);
            if (ch?.isTextBased?.()) { await ch.send({ embeds: [embed] }); return true; }
        }
        if (cfg.weekly_digest_dm_user_id) {
            const user = await client.users.fetch(cfg.weekly_digest_dm_user_id).catch(() => null);
            if (user) { await user.send({ embeds: [embed] }); return true; }
        }
    } catch (e) {
        logger.warn(`${LOG} send failed guild=${cfg.guild_id}: ${e.message}`);
    }
    return false;
}
