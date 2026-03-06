import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';
import {
    performMonthlyRotation, cleanupExpiredShoutouts, getLeaderboard
} from '../core/community-support-manager.js';

let rotationTask = null;

/**
 * Post the monthly leaderboard summary to the shoutout channel
 */
async function postLeaderboardSummary(client, guildId, shoutoutChannelId, entries, monthKey) {
    try {
        let guild = client.guilds.cache.get(guildId);

        // Search through all bot clients if not found
        if (!guild && global.botManager?.clients) {
            for (const [, botClient] of global.botManager.clients.entries()) {
                guild = botClient.guilds.cache.get(guildId);
                if (guild) break;
            }
        }

        if (!guild) return;

        const channel = guild.channels.cache.get(shoutoutChannelId);
        if (!channel) return;

        const [year, month] = monthKey.split('-');
        const monthName = new Date(year, parseInt(month) - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

        const leaderLines = entries.map((e, i) => {
            const medal = i === 0 ? '\uD83E\uDD47' : i === 1 ? '\uD83E\uDD48' : i === 2 ? '\uD83E\uDD49' : `**#${i + 1}**`;
            const twitch = e.twitchUsername ? ` ([${e.twitchUsername}](https://twitch.tv/${e.twitchUsername}))` : '';
            return `${medal} <@${e.userId}>${twitch} - **${e.totalPoints} points**`;
        });

        const embed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle(`\uD83C\uDFC6 Top Supporters - ${monthName}`)
            .setDescription(
                `These community members went above and beyond last month!\n\n${leaderLines.join('\n')}\n\n` +
                `These users have been added to the **auto-shoutout rotation** for this month. ` +
                `When they go live on Twitch, they'll be featured right here!`
            )
            .setFooter({ text: 'Community Support Tracker | Rankings reset on the 1st of each month' })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
        logger.info(`[CommunitySupport] Posted monthly leaderboard to ${shoutoutChannelId}`);
    } catch (error) {
        logger.error(`[CommunitySupport] Failed to post leaderboard summary:`, {
            error: error.message
        });
    }
}

/**
 * Run monthly rotation for all configured guilds
 */
async function runMonthlyRotation(client) {
    try {
        logger.info('[CommunitySupport] Starting monthly rotation check');

        const [configs] = await pool.execute(
            'SELECT * FROM community_support_config WHERE enabled = 1'
        );

        for (const config of configs) {
            try {
                // Cleanup expired shoutouts first
                await cleanupExpiredShoutouts(config.guild_id);

                // Perform rotation
                const entries = await performMonthlyRotation(config.guild_id, client);

                if (entries && entries.length > 0 && config.shoutout_channel_id) {
                    const now = new Date();
                    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    const monthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

                    await postLeaderboardSummary(client, config.guild_id, config.shoutout_channel_id, entries, monthKey);
                }
            } catch (error) {
                logger.error(`[CommunitySupport] Rotation failed for guild ${config.guild_id}:`, {
                    error: error.message
                });
            }
        }

        logger.info('[CommunitySupport] Monthly rotation check complete');
    } catch (error) {
        logger.error('[CommunitySupport] Monthly rotation error:', { error: error.message });
    }
}

/**
 * Start the monthly rotation scheduler
 * Runs at 00:05 on the 1st of every month
 */
export function startCommunityRotation(client) {
    if (rotationTask) {
        logger.warn('[CommunitySupport] Rotation scheduler already running');
        return;
    }

    // Run at 00:05 UTC on the 1st of each month
    rotationTask = cron.schedule('5 0 1 * *', async () => {
        logger.info('[CommunitySupport] Running monthly rotation');
        const defaultClient = global.botManager?.getDefaultClient() || client;
        if (defaultClient) {
            await runMonthlyRotation(defaultClient);
        }
    });

    logger.info('[CommunitySupport] Monthly rotation scheduler started (1st of each month at 00:05 UTC)');

    // Check on startup if rotation is needed (in case bot was down on the 1st)
    setTimeout(async () => {
        const defaultClient = global.botManager?.getDefaultClient() || client;
        if (defaultClient) {
            await runMonthlyRotation(defaultClient);
        }
    }, 60000); // 1 minute after startup
}

/**
 * Stop the rotation scheduler
 */
export function stopCommunityRotation() {
    if (rotationTask) {
        rotationTask.stop();
        rotationTask = null;
        logger.info('[CommunitySupport] Monthly rotation scheduler stopped');
    }
}

export default { startCommunityRotation, stopCommunityRotation };
