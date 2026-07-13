import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import platformCache from '../utils/platformCache.js';
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as youtubeApi from '../utils/platforms/youtube.js';

const apiModules = { twitch: twitchApi, kick: kickApi, youtube: youtubeApi };

/**
 * Cross-Network Live Notification Scheduler
 *
 * Mirrors live announcements from across all guilds into configured target channels.
 * Reads from live_announcements (source of truth) — no subscriptions needed in target guild.
 * Managed by cross_network_notifications config table.
 *
 * Each cycle:
 *   1. Load configs from cross_network_notifications
 *   2. Query live_announcements for all currently-live streamers across all guilds
 *   3. For each config, post/update/delete messages in the target channel
 *   4. Track messages in cross_network_messages table for cleanup
 */

let schedulerTask = null;
let syncRunning = false;
let cycleCount = 0;
const EMBED_UPDATE_INTERVAL = 5; // Refresh embeds every 5th cycle (5 minutes)

const platformColors = { twitch: 0x9146FF, kick: 0x52E252, youtube: 0xFF0000, tiktok: 0x000000, trovo: 0x30C67C, facebook: 0x1877F2, instagram: 0xE4405F };
const platformUrls = {
    twitch: u => `https://twitch.tv/${u}`,
    kick: u => `https://kick.com/${u}`,
    youtube: u => `https://youtube.com/channel/${u}`,
    tiktok: u => `https://tiktok.com/@${u}`,
    trovo: u => `https://trovo.live/s/${u}`,
    facebook: u => `https://facebook.com/gaming/${u}`,
    instagram: u => `https://instagram.com/${u}`
};

/**
 * Build an embed for a live streamer.
 */
async function buildStreamEmbed(streamer) {
    const platformName = streamer.platform.charAt(0).toUpperCase() + streamer.platform.slice(1);
    const url = platformUrls[streamer.platform]?.(streamer.username) || '';

    const api = apiModules[streamer.platform];
    let streamData = null;
    if (api?.getStreamDetails) {
        try {
            streamData = await platformCache.get(streamer.platform, 'getDetails', streamer.username, () => api.getStreamDetails(streamer.username));
        } catch { /* use minimal embed */ }
    }

    const embed = new EmbedBuilder()
        .setColor(platformColors[streamer.platform] || 0xa78bfa)
        .setAuthor({ name: `${streamer.username} is LIVE on ${platformName}!`, url })
        .setURL(url)
        .setTimestamp();

    if (streamData?.title) embed.setTitle(streamData.title);
    else embed.setTitle('Live Stream');

    if (streamData?.game_name) embed.addFields({ name: 'Playing', value: streamData.game_name, inline: true });
    if (streamData?.viewer_count) embed.addFields({ name: 'Viewers', value: streamData.viewer_count.toLocaleString(), inline: true });
    if (streamData?.thumbnail_url) {
        embed.setImage(streamData.thumbnail_url.replace('{width}', '440').replace('{height}', '248'));
    }
    if (streamer.profile_image_url) embed.setThumbnail(streamer.profile_image_url);
    embed.setFooter({ text: 'CertiFried Network' });

    return embed;
}

async function runCrossNetworkSync(client) {
    if (syncRunning) return;
    syncRunning = true;
    try {
        cycleCount++;
        const shouldUpdateEmbeds = cycleCount % EMBED_UPDATE_INTERVAL === 0;

        // 1. Load configs
        const [configs] = await pool.execute('SELECT * FROM cross_network_notifications WHERE enabled = 1');
        if (!configs.length) return;

        for (const config of configs) {
            try {
                await syncConfig(client, config, shouldUpdateEmbeds);
            } catch (err) {
                logger.error(`[Cross-Network] Error syncing config ${config.id}: ${err.message}`, { category: 'streams' });
            }
        }
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('[Cross-Network] Scheduler error:', { error: err.message, category: 'streams' });
        }
    } finally {
        syncRunning = false;
    }
}

async function syncConfig(client, config, shouldUpdateEmbeds) {
    const excludeGuilds = new Set(JSON.parse(config.exclude_guild_ids || '[]'));
    const excludeUsernames = new Set((JSON.parse(config.exclude_streamer_usernames || '[]')).map(u => u.toLowerCase()));

    // 2. Get all currently-live streamers from the ENTIRE network
    // Group by discord_user_id to deduplicate cross-platform (same person on Twitch + Kick = 1 entry)
    const [liveStreamers] = await pool.execute(`
        SELECT la.platform, la.username, la.guild_id, la.streamer_id, la.discord_user_id,
               s.profile_image_url
        FROM live_announcements la
        JOIN streamers s ON la.streamer_id = s.streamer_id
        WHERE la.offline_check_count < 6
    `);

    // Deduplicate by PERSON — use discord_user_id when available, else streamer_id
    // Same person on Twitch + Kick = 1 message (prefer Twitch for display)
    const uniqueLive = new Map();
    for (const row of liveStreamers) {
        if (excludeUsernames.has(row.username.toLowerCase())) continue;
        if (excludeGuilds.has(row.guild_id)) {
            // Check if they appear in ANY non-excluded guild
            const inOtherGuild = liveStreamers.some(lr =>
                lr.streamer_id === row.streamer_id && !excludeGuilds.has(lr.guild_id)
            );
            if (!inOtherGuild) continue;
        }

        // Person key: discord_user_id > username (handles c00kiesays vs cookiesays)
        const personKey = row.discord_user_id || row.username.toLowerCase();
        if (!uniqueLive.has(personKey)) {
            uniqueLive.set(personKey, row);
        } else if (row.platform === 'twitch' && uniqueLive.get(personKey).platform !== 'twitch') {
            uniqueLive.set(personKey, row);
        }
    }

    // 3. Get currently tracked cross-network messages for this config
    const [tracked] = await pool.execute(
        'SELECT id, platform, username, person_key, message_id FROM cross_network_messages WHERE config_id = ?',
        [config.id]
    );
    const trackedMap = new Map(tracked.map(t => [t.person_key || t.username.toLowerCase(), t]));

    // Get the bot client for the target guild
    const guildClient = global.botManager
        ? (global.botManager.getClientForGuild(config.target_guild_id) || client)
        : client;

    const channel = await guildClient.channels.fetch(config.target_channel_id).catch(() => null);
    if (!channel?.isTextBased()) {
        logger.warn(`[Cross-Network] Target channel ${config.target_channel_id} not accessible`, { category: 'streams' });
        return;
    }

    // 4a. POST new messages for streamers that went live since last sync
    let posted = 0;
    for (const [personKey, streamer] of uniqueLive) {
        if (trackedMap.has(personKey)) continue; // Already have a message for this person

        try {
            const embed = await buildStreamEmbed(streamer);
            const msg = await channel.send({ embeds: [embed] });

            await pool.execute(
                'INSERT INTO cross_network_messages (config_id, platform, username, person_key, message_id, source_guild_id) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)',
                [config.id, streamer.platform, streamer.username, personKey, msg.id, streamer.guild_id]
            );
            posted++;
            await new Promise(r => setTimeout(r, 300)); // Rate limit safety
        } catch (err) {
            logger.warn(`[Cross-Network] Failed to post ${personKey}: ${err.message}`, { category: 'streams' });
        }
    }

    // 4b. DELETE messages for streamers that went offline
    let deleted = 0;
    for (const [personKey, tracked_msg] of trackedMap) {
        if (uniqueLive.has(personKey)) continue; // Still live — keep the message

        try {
            let discordDeleted = true;
            if (config.delete_on_end) {
                const msg = await channel.messages.fetch(tracked_msg.message_id).catch(() => null);
                if (msg) {
                    try {
                        await msg.delete();
                    } catch (delErr) {
                        logger.warn(`[Cross-Network] Failed to delete Discord message ${tracked_msg.message_id}: ${delErr.message}`, { category: 'streams' });
                        discordDeleted = false;
                    }
                }
                // msg was null = already deleted from Discord, treat as success
            }

            if (discordDeleted) {
                await pool.execute('DELETE FROM cross_network_messages WHERE id = ?', [tracked_msg.id]);
                deleted++;
            } else {
                // Keep DB row so we can retry next cycle
                logger.warn(`[Cross-Network] Keeping tracking row for ${tracked_msg.username} — Discord delete failed, will retry`, { category: 'streams' });
            }
        } catch (err) {
            logger.error(`[Cross-Network] Error cleaning up ${tracked_msg.username}: ${err.message}`, { category: 'streams' });
        }
    }

    // 4c. UPDATE embeds for still-live streamers (keeps timestamps fresh, updates viewer counts/titles)
    let updated = 0;
    if (shouldUpdateEmbeds) {
        for (const [personKey, streamer] of uniqueLive) {
            const trackedMsg = trackedMap.get(personKey);
            if (!trackedMsg) continue; // New — already posted above

            try {
                const msg = await channel.messages.fetch(trackedMsg.message_id).catch(() => null);
                if (!msg) {
                    // Message was deleted externally — clean up DB row
                    await pool.execute('DELETE FROM cross_network_messages WHERE id = ?', [trackedMsg.id]);
                    logger.warn(`[Cross-Network] Message ${trackedMsg.message_id} for ${streamer.username} missing — removed tracking`, { category: 'streams' });
                    continue;
                }

                const embed = await buildStreamEmbed(streamer);
                await msg.edit({ embeds: [embed] });
                updated++;
                await new Promise(r => setTimeout(r, 300)); // Rate limit safety
            } catch (err) {
                logger.warn(`[Cross-Network] Failed to update embed for ${streamer.username}: ${err.message}`, { category: 'streams' });
            }
        }
    }

    if (posted > 0 || deleted > 0 || updated > 0) {
        logger.info(`[Cross-Network] Config ${config.id}: posted ${posted}, deleted ${deleted}, updated ${updated} (${uniqueLive.size} live)`, { category: 'streams' });
    }
}

/**
 * Start the cross-network scheduler.
 * Runs every 60 seconds alongside the stream checker.
 */
export function startCrossNetworkScheduler(client) {
    if (schedulerTask) return;

    schedulerTask = cron.schedule('* * * * *', async () => {
        const defaultClient = global.botManager?.getDefaultClient() || client;
        if (defaultClient) {
            await runCrossNetworkSync(defaultClient).catch(err => {
                logger.error('[Cross-Network] Scheduler error:', { error: err.message, category: 'streams' });
            });
        }
    });

    logger.info('[Cross-Network] Scheduler started (every 60 seconds)', { category: 'streams' });
}

export function stopCrossNetworkScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[Cross-Network] Scheduler stopped', { category: 'streams' });
    }
}
