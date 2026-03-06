import pool from './utils/db.js';
import logger from './utils/logger.js';

export async function cleanupStreamSpam(client) {
    try {
        logger.info('[Auto Cleanup] Starting automatic stream spam cleanup...');

        // Get channels with multiple announcements (indicating spam)
        const [spamChannels] = await pool.execute(`
            SELECT channel_id, COUNT(*) as count
            FROM live_announcements
            GROUP BY channel_id
            HAVING count > 0
        `);

        for (const row of spamChannels) {
            const channelId = row.channel_id;

            try {
                // Try to fetch channel (works for all bot instances)
                const channel = await client.channels.fetch(channelId).catch(() => null);

                // If main bot can't access, try custom bots
                if (!channel && global.botManager) {
                    const [guildData] = await pool.execute(
                        'SELECT guild_id FROM live_announcements WHERE channel_id = ? LIMIT 1',
                        [channelId]
                    );

                    if (guildData.length > 0) {
                        const guildClient = global.botManager.getClientForGuild(guildData[0].guild_id);
                        if (guildClient) {
                            const customChannel = await guildClient.channels.fetch(channelId).catch(() => null);
                            if (customChannel) {
                                await cleanupChannel(customChannel);
                            }
                        }
                    }
                } else if (channel) {
                    await cleanupChannel(channel);
                }
            } catch (error) {
                logger.error(`[Auto Cleanup] Error processing channel ${channelId}:`, error);
            }
        }

        logger.info('[Auto Cleanup] Spam cleanup completed');
    } catch (error) {
        logger.error('[Auto Cleanup] Fatal error during spam cleanup:', error);
    }
}

async function cleanupChannel(channel) {
    try {
        logger.info(`[Auto Cleanup] Cleaning channel: ${channel.name} (${channel.id})`);

        const messages = await channel.messages.fetch({ limit: 100 });

        // Get valid announcements from database
        const [dbAnnouncements] = await pool.execute(
            'SELECT message_id FROM live_announcements WHERE channel_id = ?',
            [channel.id]
        );

        const validMessageIds = new Set(dbAnnouncements.map(a => a.message_id));
        const seenStreamers = new Map();
        let deletedCount = 0;

        for (const [messageId, message] of messages) {
            if (!message.author.bot) continue;

            const hasStreamEmbed = message.embeds.some(e =>
                e.description?.toLowerCase().includes('is now live') ||
                e.title?.toLowerCase().includes('is now live') ||
                e.author?.name?.toLowerCase().includes('is now live')
            );

            if (!hasStreamEmbed) continue;

            let streamerKey = null;
            for (const embed of message.embeds) {
                if (embed.url) {
                    streamerKey = embed.url;
                    break;
                }
                if (embed.author?.name) {
                    streamerKey = embed.author.name;
                }
            }

            const isDuplicate = streamerKey && seenStreamers.has(streamerKey);
            const notInDatabase = !validMessageIds.has(messageId);

            if (isDuplicate || notInDatabase) {
                try {
                    await message.delete();
                    deletedCount++;
                    logger.info(`[Auto Cleanup] Deleted spam message ${messageId}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                    logger.error(`[Auto Cleanup] Failed to delete message ${messageId}:`, error.message);
                }
            } else if (streamerKey) {
                seenStreamers.set(streamerKey, messageId);
            }
        }

        logger.info(`[Auto Cleanup] Deleted ${deletedCount} spam messages from ${channel.name}`);
    } catch (error) {
        logger.error(`[Auto Cleanup] Error cleaning channel ${channel.id}:`, error);
    }
}
