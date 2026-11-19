/**
 * Twitch analytics alert dispatcher.
 *
 * Reads twitch_analytics_alerts_config and posts a Discord embed to the configured channel
 * for the matching trigger. Called from inside the EventSub notification handler (and from
 * cron for record-peak detection). Fire-and-forget — never blocks the caller.
 *
 * Trigger→config mapping:
 *   channel.hype_train.begin       → notify_hype_train
 *   channel.goal.end (achieved)    → notify_goal_reached
 *   channel.charity_campaign.donate (milestone cross) → notify_charity_milestone
 *   channel.raid (incoming)        → notify_raid_in
 *   channel.chat.notification (first_time_message) → notify_first_time_chatter
 *   anomaly severity=critical      → notify_anomaly_critical
 *   peak viewer new record         → notify_record_peak (polled from stream-session rollup)
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

const LOG = '[TwitchAnalyticsAlerts]';

async function configsForBroadcaster(broadcasterId) {
    const [rows] = await pool.execute(
        `SELECT c.*, r.broadcaster_twitch_username AS broadcaster_login
           FROM twitch_analytics_alerts_config c
           LEFT JOIN twitch_role_sync_config r
                 ON r.guild_id = c.guild_id COLLATE utf8mb4_unicode_ci
          WHERE c.broadcaster_id = ? AND c.alert_channel_id IS NOT NULL`,
        [String(broadcasterId)],
    );
    return rows;
}

/**
 * Resolve the right Discord client for a guild. The main-bot entrypoint registers a
 * global botManager that routes to the main bot or a custom branded bot — this is the same
 * pattern core/schedule-manager.js uses for guild-scoped sends.
 */
function clientForGuild(guildId) {
    try { return globalThis.botManager?.getClientForGuild?.(guildId) || null; }
    catch { return null; }
}

async function sendEmbed(guildId, channelId, embed) {
    if (!channelId) return;
    const client = clientForGuild(guildId);
    if (!client) { logger.warn(`${LOG} no client for guild ${guildId} — skipping alert`); return; }
    try {
        const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (!ch?.isTextBased?.()) {
            logger.warn(`${LOG} channel ${channelId} not text-based or unreachable`);
            return;
        }
        await ch.send({ embeds: [embed] });
    } catch (e) {
        logger.warn(`${LOG} send failed to ${channelId}: ${e.message}`);
    }
}

/** Dispatcher called from inside eventsub-manager handleNotification. */
export async function dispatch(_ignoredClient, subType, event) {
    const bid = event?.broadcaster_user_id || event?.to_broadcaster_user_id;
    if (!bid) return;
    try {
        const cfgs = await configsForBroadcaster(bid);
        if (!cfgs.length) return;

        for (const cfg of cfgs) {
            // Hype train
            if (subType === 'channel.hype_train.begin' && cfg.notify_hype_train) {
                const e = new EmbedBuilder()
                    .setTitle('🚂 Hype train started')
                    .setColor(0x9146ff)
                    .setDescription(`A hype train just started on **${cfg.broadcaster_login}**'s channel.`)
                    .addFields({ name: 'Goal', value: String(event.goal || '?'), inline: true },
                               { name: 'Started by', value: event.last_contribution?.user_name || 'unknown', inline: true })
                    .setTimestamp();
                await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
            }
            // Goal reached
            else if (subType === 'channel.goal.end' && cfg.notify_goal_reached && event.is_achieved) {
                const e = new EmbedBuilder()
                    .setTitle('🎯 Goal reached')
                    .setColor(0x4ade80)
                    .setDescription(`**${cfg.broadcaster_login}** hit their goal: *${event.description || event.type}*`)
                    .addFields({ name: 'Current', value: String(event.current_amount), inline: true },
                               { name: 'Target', value: String(event.target_amount), inline: true })
                    .setTimestamp();
                await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
            }
            // Charity milestone — fire when crossing a $100 multiple (de-duplicate via cross-check)
            else if (subType === 'channel.charity_campaign.donate' && cfg.notify_charity_milestone) {
                const current = event.current_amount?.value || 0;
                const prev = current - (event.amount?.value || 0);
                const hundred = Math.floor(current / 10000) * 10000; // cents to dollars /100
                if (prev < hundred && current >= hundred && hundred > 0) {
                    const e = new EmbedBuilder()
                        .setTitle('💝 Charity milestone')
                        .setColor(0xec4899)
                        .setDescription(`${cfg.broadcaster_login}'s charity campaign crossed $${(hundred / 100).toLocaleString()}.`)
                        .addFields({ name: 'Charity', value: event.charity_name || '?', inline: true })
                        .setTimestamp();
                    await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
                }
            }
            // Incoming raid
            else if (subType === 'channel.raid' && cfg.notify_raid_in && event.to_broadcaster_user_id === String(bid)) {
                const e = new EmbedBuilder()
                    .setTitle('⚔️ Incoming raid')
                    .setColor(0xf97316)
                    .setDescription(`**${event.from_broadcaster_user_name}** is raiding **${cfg.broadcaster_login}** with ${event.viewers} viewers.`)
                    .setTimestamp();
                await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
            }
            // First-time chatter — only when the chat.notification carries that specific notice type
            else if (subType === 'channel.chat.notification' && cfg.notify_first_time_chatter
                     && event.notice_type === 'shared_chat_first_message') {
                const e = new EmbedBuilder()
                    .setTitle('👋 First-time chatter')
                    .setColor(0x22d3ee)
                    .setDescription(`${event.chatter_user_name} sent their first message in ${cfg.broadcaster_login}'s chat.`)
                    .setTimestamp();
                await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
            }
        }
    } catch (e) {
        logger.warn(`${LOG} dispatch error for ${subType}: ${e.message}`);
    }
}

/** Called from the anomaly detector when severity='critical' fires. */
export async function dispatchAnomaly(client, broadcasterId, alertType, severity, score, interpretation) {
    if (severity !== 'critical') return;
    const cfgs = await configsForBroadcaster(broadcasterId).catch(() => []);
    for (const cfg of cfgs) {
        if (!cfg.notify_anomaly_critical) continue;
        const e = new EmbedBuilder()
            .setTitle(`🚨 Critical anomaly: ${alertType}`)
            .setColor(0xe35858)
            .setDescription(interpretation || `Score ${score}`)
            .setFooter({ text: `${cfg.broadcaster_login} · ${alertType}` })
            .setTimestamp();
        await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
    }
}

/** Called from eventsub-manager handleChatMessage when a chatter_watch user shows up. */
export async function dispatchChatterWatch(broadcasterId, login, displayName, label) {
    const cfgs = await configsForBroadcaster(broadcasterId).catch(() => []);
    for (const cfg of cfgs) {
        if (!cfg.notify_chatter_watch) continue;
        const e = new EmbedBuilder()
            .setTitle('👀 Watched chatter online')
            .setColor(0x22d3ee)
            .setDescription(`**${displayName || login}** just posted in **${cfg.broadcaster_login}**'s chat.`)
            .addFields(label ? [{ name: 'Label', value: label, inline: true }] : [])
            .setTimestamp();
        await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
    }
}

/** Called from the session-rollup cron when a new peak viewer record is set. */
export async function dispatchRecordPeak(client, broadcasterId, newPeak, previousPeak) {
    if (newPeak <= previousPeak) return;
    const cfgs = await configsForBroadcaster(broadcasterId).catch(() => []);
    for (const cfg of cfgs) {
        if (!cfg.notify_record_peak) continue;
        const e = new EmbedBuilder()
            .setTitle('📈 New peak viewer record')
            .setColor(0x4ade80)
            .setDescription(`**${cfg.broadcaster_login}** just hit **${newPeak.toLocaleString()}** viewers — up from ${previousPeak.toLocaleString()}.`)
            .setTimestamp();
        await sendEmbed(cfg.guild_id, cfg.alert_channel_id, e);
    }
}

/**
 * Unfollows from the hourly follower diff → the server's unfollow channel. Twitch gives no
 * unfollow time, so the embed states the window the change happened in.
 * list: [{ user_id, login, name, followed_at }]
 */
export async function dispatchUnfollows(broadcasterId, list, { since = null, until = new Date() } = {}) {
    if (!list?.length) return;
    const [cfgs] = await pool.query(
        `SELECT c.guild_id, c.unfollow_channel_id, r.broadcaster_twitch_username AS broadcaster_login
           FROM twitch_analytics_alerts_config c
           LEFT JOIN twitch_role_sync_config r ON r.guild_id = c.guild_id COLLATE utf8mb4_unicode_ci
          WHERE c.broadcaster_id = ? AND c.unfollow_channel_id IS NOT NULL`, [String(broadcasterId)]);
    if (!cfgs.length) return;

    const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>`;
    const lines = list.map((u) => {
        const who = u.login
            ? `[${u.name || u.login}](https://twitch.tv/${u.login})${u.name && u.name.toLowerCase() !== u.login ? ` (${u.login})` : ''}`
            : `Account deleted or suspended (ID ${u.user_id})`;
        const since2 = u.followed_at ? ` · followed since <t:${Math.floor(new Date(u.followed_at).getTime() / 1000)}:D>` : '';
        return `• ${who}${since2}`;
    });
    let desc = '';
    let shown = 0;
    for (const l of lines) {
        if ((desc + l + '\n').length > 3800) break;
        desc += l + '\n'; shown++;
    }
    if (shown < lines.length) desc += `…and ${lines.length - shown} more (full list on the Twitch analytics page)`;

    for (const cfg of cfgs) {
        const e = new EmbedBuilder()
            .setTitle(list.length === 1 ? 'Twitch unfollow' : `${list.length} Twitch unfollows`)
            .setColor(0xf87171)
            .setDescription(desc.trim())
            .addFields({ name: 'Between', value: since ? `${ts(since)} and ${ts(until)}` : `before ${ts(until)}`, inline: false })
            .setFooter({ text: cfg.broadcaster_login ? `twitch.tv/${cfg.broadcaster_login} · checked hourly` : 'Checked hourly' })
            .setTimestamp(until);
        await sendEmbed(cfg.guild_id, cfg.unfollow_channel_id, e);
    }
}
